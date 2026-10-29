from __future__ import annotations

import base64
import io
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

import pymupdf as fitz

from server.config import MAX_PDF_PAGES, PDF_DIR, PDF_SESSION_MINUTES
from server.utils import clamp

logger = logging.getLogger(__name__)

DOC_ID_RE = r"^[a-f0-9]{32}$"


class PDFStoreError(RuntimeError):
    pass


class PDFStore:
    def __init__(self) -> None:
        self.root = PDF_DIR
        self.root.mkdir(parents=True, exist_ok=True)

    # ----------------------------------------------------------------- sessions
    def create(self, data: bytes, filename: str) -> dict[str, Any]:
        if not data.startswith(b"%PDF"):
            raise PDFStoreError("That file does not look like a PDF.")
        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception as exc:
            raise PDFStoreError("The PDF could not be opened.") from exc
        if doc.needs_pass:
            doc.close()
            raise PDFStoreError("Password-protected PDFs are not supported.")
        if doc.page_count == 0:
            doc.close()
            raise PDFStoreError("The PDF has no pages.")
        if doc.page_count > MAX_PDF_PAGES:
            count = doc.page_count
            doc.close()
            raise PDFStoreError(
                f"This PDF has {count} pages. The editor supports up to {MAX_PDF_PAGES} pages."
            )
        doc_id = uuid.uuid4().hex
        folder = self.root / doc_id
        folder.mkdir(parents=True, exist_ok=True)
        source = folder / "source.pdf"
        source.write_bytes(data)

        pages = []
        for index, page in enumerate(doc):
            pages.append(
                {
                    "index": index,
                    "width": round(float(page.rect.width), 2),
                    "height": round(float(page.rect.height), 2),
                    "rotation": int(page.rotation or 0),
                }
            )
        meta = {
            "id": doc_id,
            "filename": Path(filename or "document.pdf").name,
            "created": time.time(),
            "updated": time.time(),
            "size": len(data),
            "pages": pages,
            "page_count": doc.page_count,
            "metadata": {
                key: value
                for key, value in (doc.metadata or {}).items()
                if key in {"title", "author", "subject", "producer", "creator"}
                and value
            },
        }
        (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        doc.close()
        self._cleanup(max_age_minutes=PDF_SESSION_MINUTES)
        return self.public_meta(meta)

    def public_meta(self, meta: dict[str, Any]) -> dict[str, Any]:
        doc_id = meta["id"]
        return {
            "doc_id": doc_id,
            "filename": meta["filename"],
            "size": meta["size"],
            "page_count": meta["page_count"],
            "pages": meta["pages"],
            "metadata": meta.get("metadata", {}),
            "page_url": f"/api/pdf/{doc_id}/page/{{page}}.png",
            "lines_url": f"/api/pdf/{doc_id}/lines/{{page}}",
        }

    def get_meta(self, doc_id: str) -> dict[str, Any]:
        folder = self._folder(doc_id)
        meta_path = folder / "meta.json"
        if not meta_path.exists():
            raise PDFStoreError("This PDF session has expired. Please upload it again.")
        return json.loads(meta_path.read_text(encoding="utf-8"))

    def delete(self, doc_id: str) -> None:
        folder = self._folder(doc_id, require_exists=False)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)

    def _folder(self, doc_id: str, require_exists: bool = True) -> Path:
        import re

        if not re.fullmatch(DOC_ID_RE, doc_id or ""):
            raise PDFStoreError("Invalid document identifier")
        folder = self.root / doc_id
        if require_exists and not folder.exists():
            raise PDFStoreError("This PDF session has expired. Please upload it again.")
        return folder

    def _path(self, doc_id: str) -> Path:
        return self._folder(doc_id) / "source.pdf"

    # ----------------------------------------------------------------- rendering
    def render_page(self, doc_id: str, page_number: int, zoom: float = 1.4) -> bytes:
        meta = self.get_meta(doc_id)
        if page_number < 0 or page_number >= meta["page_count"]:
            raise PDFStoreError("Page not found")
        zoom = float(clamp(zoom, 0.2, 3.0))
        doc = fitz.open(stream=self._path(doc_id).read_bytes(), filetype="pdf")
        try:
            page = doc[page_number]
            pix = page.get_pixmap(
                matrix=fitz.Matrix(zoom, zoom),
                alpha=False,
                annots=False,
            )
            return pix.tobytes("png")
        finally:
            doc.close()

    def page_preview_data_url(self, data: bytes, max_width: int = 260) -> str | None:
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            if doc.page_count == 0:
                return None
            page = doc[0]
            zoom = min(max_width / max(page.rect.width, 1), 0.8)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            doc.close()
            encoded = base64.b64encode(pix.tobytes("jpeg")).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
        except Exception:
            return None

    def extract_lines(self, doc_id: str, page_number: int) -> dict[str, Any]:
        meta = self.get_meta(doc_id)
        if page_number < 0 or page_number >= meta["page_count"]:
            raise PDFStoreError("Page not found")
        doc = fitz.open(stream=self._path(doc_id).read_bytes(), filetype="pdf")
        try:
            page = doc[page_number]
            rows = self._rows_from_page(page)
            return {
                "page": page_number,
                "width": round(float(page.rect.width), 2),
                "height": round(float(page.rect.height), 2),
                "rotation": int(page.rotation or 0),
                "lines": rows,
            }
        finally:
            doc.close()

    def _rows_from_page(self, page: fitz.Page) -> list[dict[str, Any]]:
        spans: list[dict[str, Any]] = []
        try:
            data = page.get_text("dict")
        except Exception:
            return []
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    if not text.strip():
                        continue
                    bbox = [float(v) for v in span.get("bbox", [0, 0, 0, 0])]
                    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                        continue
                    spans.append(
                        {
                            "text": text,
                            "bbox": bbox,
                            "size": float(span.get("size", 10) or 10),
                            "font": span.get("font", ""),
                            "color": span.get("color", 0),
                            "flags": span.get("flags", 0),
                        }
                    )
        if not spans:
            return []

        # Group spans into visual rows. This repairs the common case where a
        # PDF exporter splits one Tamil line into many glyph runs.
        spans.sort(key=lambda item: ((item["bbox"][1] + item["bbox"][3]) / 2, item["bbox"][0]))
        rows: list[list[dict[str, Any]]] = []
        for span in spans:
            cy = (span["bbox"][1] + span["bbox"][3]) / 2
            height = max(1.0, span["bbox"][3] - span["bbox"][1])
            placed = False
            for row in rows[-8:]:
                ref = row[0]
                ref_cy = (ref["bbox"][1] + ref["bbox"][3]) / 2
                ref_h = max(1.0, ref["bbox"][3] - ref["bbox"][1])
                if abs(cy - ref_cy) <= max(2.5, min(height, ref_h) * 0.38):
                    row.append(span)
                    placed = True
                    break
            if not placed:
                rows.append([span])

        result: list[dict[str, Any]] = []
        for row in rows:
            row.sort(key=lambda item: item["bbox"][0])
            # Drop exact duplicate glyph runs (some OCR layers contain them).
            unique: list[dict[str, Any]] = []
            for span in row:
                duplicate = False
                for existing in unique:
                    if (
                        abs(span["bbox"][0] - existing["bbox"][0]) < 1.2
                        and abs(span["bbox"][1] - existing["bbox"][1]) < 1.2
                        and span["text"] == existing["text"]
                    ):
                        duplicate = True
                        break
                if not duplicate:
                    unique.append(span)
            if not unique:
                continue
            text = self._join_spans(unique)
            if not text.strip():
                continue
            bbox = [
                min(span["bbox"][0] for span in unique),
                min(span["bbox"][1] for span in unique),
                max(span["bbox"][2] for span in unique),
                max(span["bbox"][3] for span in unique),
            ]
            size = max(span["size"] for span in unique) or 10
            color = self._color_hex(unique[0]["color"])
            result.append(
                {
                    "text": text,
                    "bbox": [round(v, 2) for v in bbox],
                    "font_size": round(size, 2),
                    "font": unique[0].get("font", ""),
                    "color": color,
                    "spans": len(unique),
                }
            )
        result.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
        for index, line in enumerate(result):
            line["id"] = f"l{index}"
        return result

    def _join_spans(self, spans: list[dict[str, Any]]) -> str:
        if not spans:
            return ""
        pieces = [spans[0]["text"]]
        combining = set("்ாிீுூெேைொோௌௗ")
        for previous, current in zip(spans, spans[1:]):
            gap = current["bbox"][0] - previous["bbox"][2]
            size = max(previous.get("size", 10), current.get("size", 10), 8)
            left = pieces[-1][-1:] if pieces else ""
            right = current["text"][:1]
            if right in {".", ",", ";", ":", "!", "?", ")"}:
                sep = ""
            elif left in combining or right in combining:
                sep = ""
            elif gap > size * 0.32:
                sep = " "
            else:
                sep = ""
            pieces.append(sep + current["text"])
        return "".join(pieces)

    def _color_hex(self, color: int) -> str:
        try:
            value = int(color)
            return f"#{value & 0xFFFFFF:06x}"
        except Exception:
            return "#171512"

    # ----------------------------------------------------------------- cleanup
    def _cleanup(self, max_age_minutes: int = PDF_SESSION_MINUTES) -> None:
        cutoff = time.time() - max_age_minutes * 60
        for folder in self.root.iterdir():
            try:
                if folder.is_dir() and folder.stat().st_mtime < cutoff:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                continue


pdf_store = PDFStore()
