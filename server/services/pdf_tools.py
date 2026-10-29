from __future__ import annotations

import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import pymupdf as fitz
from PIL import Image

from server.config import FONT_DIR, PDF_TIMEOUT, UPLOAD_DIR
from server.utils import clamp, clamp_rect, parse_color

logger = logging.getLogger(__name__)

GHOSTSCRIPT = shutil.which("gs")
LATIN_FONT = FONT_DIR / "DejaVuSans.ttf"
TAMIL_FONT = FONT_DIR / "NotoSansTamil-Regular.ttf"
TAMIL_BOLD = FONT_DIR / "NotoSansTamil-Bold.ttf"

PRESETS: dict[str, dict[str, Any]] = {
    "balanced": {
        "label": "Balanced",
        "description": "Good everyday compression at 150 dpi. Keeps text selectable.",
        "settings": "ebook",
        "downsample": True,
    },
    "smallest": {
        "label": "Smallest",
        "description": "Aggressive 72 dpi compression. Best for email or quick sharing.",
        "settings": "screen",
        "downsample": True,
    },
    "print": {
        "label": "Print quality",
        "description": "300 dpi output for documents that need to look crisp.",
        "settings": "prepress",
        "downsample": True,
    },
    "text": {
        "label": "Keep text sharp",
        "description": "Lossless image handling and font subsetting. Best for text-heavy PDFs.",
        "settings": "prepress",
        "downsample": False,
    },
    "raster": {
        "label": "Maximum (flatten)",
        "description": "Rebuilds pages as compressed images. Smallest result, but text is no longer selectable.",
        "settings": None,
        "downsample": True,
    },
}


class PDFToolError(RuntimeError):
    pass


# --------------------------------------------------------------------- analysis
def analyze_pdf(data: bytes) -> dict[str, Any]:
    if not data.startswith(b"%PDF"):
        raise PDFToolError("That file does not look like a PDF.")
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise PDFToolError("The PDF could not be opened.") from exc
    if doc.needs_pass:
        doc.close()
        raise PDFToolError("Password-protected PDFs are not supported.")
    if doc.page_count == 0:
        doc.close()
        raise PDFToolError("The PDF has no pages.")

    text_chars = 0
    image_pages = 0
    sample_pages = min(doc.page_count, 8)
    for page in list(doc)[:sample_pages]:
        try:
            text_chars += len(page.get_text("text").strip())
            image_pages += 1 if page.get_images(full=True) else 0
        except Exception:
            pass
    avg_chars = text_chars / max(sample_pages, 1)
    result = {
        "size": len(data),
        "pages": doc.page_count,
        "encrypted": bool(doc.needs_pass),
        "metadata": {
            k: v
            for k, v in (doc.metadata or {}).items()
            if k in {"title", "author", "subject", "producer", "creator", "creationDate"}
            and v
        },
        "scanned": avg_chars < 25,
        "text_chars": text_chars,
        "image_pages": image_pages,
        "page_size": {
            "width": round(float(doc[0].rect.width), 1),
            "height": round(float(doc[0].rect.height), 1),
        },
        "preview": _first_page_preview(doc),
    }
    doc.close()
    result["presets"] = {
        key: {k: v for k, v in value.items() if k != "settings"}
        for key, value in PRESETS.items()
    }
    return result


def _first_page_preview(doc: fitz.Document, width: int = 240) -> str | None:
    try:
        page = doc[0]
        zoom = min(width / max(page.rect.width, 1), 0.6)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        import base64

        return "data:image/jpeg;base64," + base64.b64encode(
            pix.tobytes("jpeg")
        ).decode("ascii")
    except Exception:
        return None


# ------------------------------------------------------------------- compression
def compress_pdf(data: bytes, preset: str = "balanced") -> tuple[bytes, dict[str, Any]]:
    if not data.startswith(b"%PDF"):
        raise PDFToolError("That file does not look like a PDF.")
    preset = (preset or "balanced").lower()
    if preset not in PRESETS:
        raise PDFToolError("Unknown compression preset.")
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        if doc.needs_pass:
            raise PDFToolError("Password-protected PDFs are not supported.")
        if doc.page_count == 0:
            raise PDFToolError("The PDF has no pages.")
        doc.close()
    except PDFToolError:
        raise
    except Exception as exc:
        raise PDFToolError("The PDF could not be opened.") from exc

    started = time.perf_counter()
    if preset == "raster":
        output = _raster_compress(data)
        engine = "raster"
    elif GHOSTSCRIPT:
        output = _ghostscript_compress(data, preset)
        engine = "ghostscript"
    else:
        output = _pymupdf_compress(data)
        engine = "pymupdf"

    # Returning the smaller valid file is friendlier than producing a larger
    # "compressed" file just because the pipeline ran.
    chosen = output if len(output) < len(data) else data
    if len(output) >= len(data):
        engine = "already-optimized"
    return chosen, {
        "preset": preset,
        "preset_label": PRESETS[preset]["label"],
        "original_size": len(data),
        "compressed_size": len(chosen),
        "saved_bytes": len(data) - len(chosen),
        "saved_percent": round((1 - len(chosen) / max(len(data), 1)) * 100, 1),
        "engine": engine,
        "milliseconds": int((time.perf_counter() - started) * 1000),
        "note": (
            "This PDF was already well optimized."
            if len(output) >= len(data)
            else None
        ),
    }


def _ghostscript_compress(data: bytes, preset: str) -> bytes:
    if not GHOSTSCRIPT:
        return _pymupdf_compress(data)
    settings = PRESETS[preset]["settings"]
    with tempfile.TemporaryDirectory(dir=UPLOAD_DIR, prefix="gs-") as folder:
        input_path = Path(folder) / "in.pdf"
        output_path = Path(folder) / "out.pdf"
        input_path.write_bytes(data)
        args = [
            GHOSTSCRIPT,
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.7",
            f"-dPDFSETTINGS=/{settings}",
            "-dNOPAUSE",
            "-dBATCH",
            "-dQUIET",
            "-dSAFER",
            "-dDetectDuplicateImages=true",
            "-dCompressFonts=true",
            "-dSubsetFonts=true",
            "-dEmbedAllFonts=true",
        ]
        if not PRESETS[preset]["downsample"]:
            args.extend(
                [
                    "-dDownsampleColorImages=false",
                    "-dDownsampleGrayImages=false",
                    "-dDownsampleMonoImages=false",
                    "-dAutoFilterColorImages=false",
                    "-dAutoFilterGrayImages=false",
                    "-dColorImageFilter=/FlateEncode",
                    "-dGrayImageFilter=/FlateEncode",
                ]
            )
        args.extend([f"-sOutputFile={output_path}", str(input_path)])
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                timeout=PDF_TIMEOUT,
                check=False,
            )
            if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
                logger.warning(
                    "Ghostscript failed (%s): %s",
                    result.returncode,
                    result.stderr.decode("utf-8", "ignore")[:300],
                )
                return _pymupdf_compress(data)
            output = output_path.read_bytes()
            if not _valid_pdf(output) or _page_count(output) != _page_count(data):
                return _pymupdf_compress(data)
            return output
        except subprocess.TimeoutExpired:
            logger.warning("Ghostscript timed out")
            return _pymupdf_compress(data)


def _raster_compress(data: bytes, dpi: int = 108, quality: int = 64) -> bytes:
    doc = fitz.open(stream=data, filetype="pdf")
    out = fitz.open()
    try:
        for page in doc:
            pix = page.get_pixmap(
                matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False, annots=False
            )
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=quality, optimize=True)
            new_page = out.new_page(width=page.rect.width, height=page.rect.height)
            new_page.insert_image(new_page.rect, stream=buffer.getvalue())
        if doc.metadata:
            out.set_metadata({k: v for k, v in doc.metadata.items() if k})
        buffer = io.BytesIO()
        out.save(buffer, garbage=4, deflate=True, clean=True)
        return buffer.getvalue()
    finally:
        out.close()
        doc.close()


def _pymupdf_compress(data: bytes) -> bytes:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        buffer = io.BytesIO()
        doc.save(
            buffer,
            garbage=4,
            deflate=True,
            deflate_images=True,
            deflate_fonts=True,
            clean=True,
        )
        return buffer.getvalue()
    finally:
        doc.close()


def _valid_pdf(data: bytes) -> bool:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        ok = doc.page_count > 0 and not doc.needs_pass
        doc.close()
        return ok
    except Exception:
        return False


def _page_count(data: bytes) -> int:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        count = doc.page_count
        doc.close()
        return count
    except Exception:
        return -1


# ----------------------------------------------------------------------- editor
def export_edited_pdf(
    source_data: bytes,
    edits: list[dict[str, Any]],
    page_order: list[int] | None = None,
    rotations: dict[str, int] | None = None,
    compress: str | None = None,
) -> tuple[bytes, dict[str, Any]]:
    if not source_data.startswith(b"%PDF"):
        raise PDFToolError("The source PDF is invalid.")
    try:
        doc = fitz.open(stream=source_data, filetype="pdf")
    except Exception as exc:
        raise PDFToolError("The PDF could not be opened.") from exc
    if doc.needs_pass:
        doc.close()
        raise PDFToolError("Password-protected PDFs are not supported.")

    total_pages = doc.page_count
    grouped: dict[int, list[dict[str, Any]]] = {}
    for edit in edits or []:
        try:
            page_index = int(edit.get("page", -1))
        except Exception:
            continue
        if 0 <= page_index < total_pages:
            grouped.setdefault(page_index, []).append(edit)

    try:
        for page_index, page_edits in grouped.items():
            page = doc[page_index]
            width, height = page.rect.width, page.rect.height
            replacements = [
                edit for edit in page_edits if edit.get("kind") == "replace"
            ]
            if replacements:
                for edit in replacements:
                    try:
                        rect = fitz.Rect(
                            clamp_rect(edit.get("rect", [0, 0, 0, 0]), width, height)
                        )
                        if rect.is_empty or rect.width < 1 or rect.height < 1:
                            continue
                        page.add_redact_annot(rect, fill=False)
                    except Exception as exc:
                        logger.warning("Invalid replacement rect: %s", exc)
                try:
                    page.apply_redactions(
                        images=fitz.PDF_REDACT_IMAGE_NONE,
                        graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                        text=fitz.PDF_REDACT_TEXT_REMOVE,
                    )
                except Exception as exc:
                    logger.warning("Redaction failed: %s", exc)

            for edit in replacements:
                try:
                    rect = fitz.Rect(
                        clamp_rect(edit.get("rect", [0, 0, 0, 0]), width, height)
                    )
                    text = str(edit.get("text") or "").strip()
                    if not text:
                        continue
                    # Give replacement text a hair more vertical room so the
                    # ascenders/descenders are not clipped by the source bbox.
                    rect = fitz.Rect(rect.x0 - 0.5, rect.y0 - 0.8, rect.x1 + 0.8, rect.y1 + 1.0)
                    _insert_text(
                        page,
                        rect,
                        text,
                        font_size=float(edit.get("font_size") or 12),
                        color=str(edit.get("color") or "#171512"),
                        align=str(edit.get("align") or "left"),
                        scale_low=0.3,
                    )
                except Exception as exc:
                    logger.warning("Replacement text failed: %s", exc)

            for edit in page_edits:
                kind = edit.get("kind")
                if kind in {"replace", "add"}:
                    if kind == "add":
                        try:
                            rect = fitz.Rect(
                                clamp_rect(edit.get("rect", [0, 0, 0, 0]), width, height)
                            )
                            text = str(edit.get("text") or "").strip()
                            if text and rect.width > 2 and rect.height > 2:
                                _insert_text(
                                    page,
                                    rect,
                                    text,
                                    font_size=float(edit.get("font_size") or 14),
                                    color=str(edit.get("color") or "#171512"),
                                    align=str(edit.get("align") or "left"),
                                    scale_low=0.3,
                                )
                        except Exception as exc:
                            logger.warning("Added text failed: %s", exc)
                elif kind in {"whiteout", "highlight"}:
                    try:
                        rect = fitz.Rect(
                            clamp_rect(edit.get("rect", [0, 0, 0, 0]), width, height)
                        )
                        if rect.is_empty:
                            continue
                        color = parse_color(
                            edit.get("color"),
                            "#ffffff" if kind == "whiteout" else "#f4c95d",
                        )
                        if kind == "whiteout":
                            page.draw_rect(
                                rect,
                                color=None,
                                fill=color,
                                overlay=True,
                                width=0,
                            )
                        else:
                            page.draw_rect(
                                rect,
                                color=None,
                                fill=color,
                                fill_opacity=0.38,
                                overlay=True,
                                width=0,
                            )
                    except Exception as exc:
                        logger.warning("Shape edit failed: %s", exc)

        # Rotate and reorder after content edits. Rotations are expressed on
        # the original page indices.
        for page_key, degrees in (rotations or {}).items():
            try:
                page_index = int(page_key)
                if 0 <= page_index < total_pages:
                    degrees = int(degrees) % 360
                    if degrees in {0, 90, 180, 270}:
                        doc[page_index].set_rotation(degrees)
            except Exception:
                continue

        order = _validate_order(page_order, total_pages)
        if order:
            doc.select(order)

        buffer = io.BytesIO()
        doc.save(buffer, garbage=4, deflate=True, clean=True)
        result = buffer.getvalue()
        pages_after = doc.page_count
    finally:
        doc.close()

    info = {
        "original_size": len(source_data),
        "size": len(result),
        "pages": pages_after,
        "edits": len(edits or []),
        "compressed": False,
    }
    if compress and compress != "none":
        try:
            compressed, stats = compress_pdf(result, compress)
            if compressed and len(compressed) > 0:
                result = compressed
                info.update(
                    {
                        "size": len(result),
                        "compressed": True,
                        "compression": stats,
                    }
                )
        except Exception as exc:
            logger.warning("Post-save compression failed: %s", exc)
            info["compression_error"] = str(exc)
    return result, info


def _validate_order(order: list[int] | None, total_pages: int) -> list[int] | None:
    if not order:
        return None
    result: list[int] = []
    for value in order:
        try:
            page = int(value)
        except Exception:
            continue
        if 0 <= page < total_pages and page not in result:
            result.append(page)
    return result or None


def _insert_text(
    page: fitz.Page,
    rect: fitz.Rect,
    text: str,
    font_size: float,
    color: str,
    align: str,
    scale_low: float,
) -> None:
    if not TAMIL_FONT.exists():
        raise PDFToolError("Tamil font is missing from web/assets/fonts.")
    align = align if align in {"left", "center", "right", "justify"} else "left"
    size = clamp(float(font_size), 4, 144)
    markup = _script_markup(text)
    css = _text_css(size, color, align)
    result = page.insert_htmlbox(
        rect,
        f'<div class="box">{markup}</div>',
        css=css,
        scale_low=scale_low,
        overlay=True,
    )
    # insert_htmlbox returns (spare_height, scale). A negative spare height
    # means some text was clipped; shrinking once more keeps the page readable.
    try:
        spare = float(result[0])
        if spare < 0:
            page.insert_htmlbox(
                rect,
                f'<div class="box">{markup}</div>',
                css=_text_css(max(size * 0.82, 4), color, align),
                scale_low=0.2,
                overlay=True,
            )
    except Exception:
        pass


def _script_markup(text: str) -> str:
    import html

    parts: list[str] = []
    for chunk in re.split(r"([\u0B80-\u0BFF]+)", text):
        if not chunk:
            continue
        escaped = html.escape(chunk, quote=False).replace("\n", "<br/>")
        cls = "ta" if re.search(r"[\u0B80-\u0BFF]", chunk) else "en"
        parts.append(f'<span class="{cls}">{escaped}</span>')
    return "".join(parts)


def _text_css(size: float, color: str, align: str) -> str:
    tamil_uri = TAMIL_FONT.resolve().as_uri()
    latin_uri = LATIN_FONT.resolve().as_uri() if LATIN_FONT.exists() else tamil_uri
    bold_uri = TAMIL_BOLD.resolve().as_uri() if TAMIL_BOLD.exists() else tamil_uri
    safe_color = color if re.fullmatch(r"#[0-9a-fA-F]{6}", color or "") else "#171512"
    return f"""
    @font-face {{ font-family: ta; src: url("{tamil_uri}"); }}
    @font-face {{ font-family: ta; font-weight: 700; src: url("{bold_uri}"); }}
    @font-face {{ font-family: en; src: url("{latin_uri}"); }}
    * {{ margin: 0; padding: 0; }}
    .box {{ font-size: {size:.2f}pt; line-height: 1.3; color: {safe_color}; text-align: {align}; white-space: pre-wrap; }}
    .ta {{ font-family: ta; }}
    .en {{ font-family: en; }}
    """


def safe_filename(name: str, suffix: str = ".pdf") -> str:
    base = Path(name or "document").stem
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-") or "document"
    return f"{base}{suffix}"
