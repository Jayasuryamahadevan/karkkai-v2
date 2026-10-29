from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from server.config import (
    APP_NAME,
    APP_VERSION,
    MAX_AUDIO_MB,
    MAX_PDF_MB,
    MAX_PDF_PAGES,
    MAX_TRANSLATE_CHARS,
    MAX_TTS_CHARS,
    PDF_TIMEOUT,
    WEB_DIR,
    online_status,
)
from server.services.lexicon import get_lexicon, lexicon_status
from server.services.pdf_store import PDFStoreError, pdf_store
from server.services.pdf_tools import (
    PRESETS,
    PDFToolError,
    analyze_pdf,
    compress_pdf,
    export_edited_pdf,
    safe_filename,
)
from server.services.spellcheck import spell_checker
from server.services.stt import STTError, STTService, STTUnavailable, stt_service
from server.services.translation import TranslationError, translation_service
from server.services.tts import TTSError, tts_service
from server.services.words import word_service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("chillian")

MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024
MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s %s", APP_NAME, APP_VERSION)
    # Build the dictionary in the background so the first UI paint is fast.
    asyncio.create_task(asyncio.to_thread(get_lexicon))
    yield
    logger.info("Stopped %s", APP_NAME)


app = FastAPI(
    title=f"{APP_NAME} API",
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)
app.add_middleware(GZipMiddleware, minimum_size=1200)


@app.middleware("http")
async def add_headers(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("X-Chillian-Ms", str(int((time.perf_counter() - started) * 1000)))
    return response


# ------------------------------------------------------------------- schemas
class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TRANSLATE_CHARS)
    source: str = "auto"
    target: str = "ta"
    engine: str | None = None


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TTS_CHARS)
    lang: str = "ta"
    slow: bool = False
    engine: str | None = None


class SpellcheckRequest(BaseModel):
    text: str = Field("", max_length=50000)
    extra_words: list[str] = Field(default_factory=list, max_length=500)


class ExportRequest(BaseModel):
    edits: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)
    page_order: list[int] | None = None
    rotations: dict[str, int] | None = None
    compress: str | None = "none"


# --------------------------------------------------------------------- health
@app.get("/api/health")
async def health() -> dict[str, Any]:
    status = online_status()
    runtime = translation_service.status()
    status["translation"]["sarvam"] = runtime["available"]["sarvam"]
    status["translation"]["sarvam_reason"] = runtime.get("sarvam_reason")
    lex = lexicon_status()
    lex_ready = lex.get("ready", False)
    return {
        "ok": True,
        "app": APP_NAME,
        "version": APP_VERSION,
        "online": status,
        "local": {
            "spellcheck": True,
            "word_finder": True,
            "pdf": True,
            "ghostscript": bool(Path("/usr/bin/gs").exists()),
            "tamil_font": (WEB_DIR / "assets" / "fonts" / "NotoSansTamil-Regular.ttf").exists(),
        },
        "lexicon": lex if lex_ready else {"ready": False, "status": "loading"},
        "stt": stt_service.status(),
        "tts": tts_service.status(),
        "translation": translation_service.status(),
        "limits": {
            "translate_chars": MAX_TRANSLATE_CHARS,
            "tts_chars": MAX_TTS_CHARS,
            "pdf_mb": MAX_PDF_MB,
            "audio_mb": MAX_AUDIO_MB,
            "pdf_pages": MAX_PDF_PAGES,
            "pdf_timeout_seconds": PDF_TIMEOUT,
        },
    }


@app.get("/api/languages")
async def languages() -> dict[str, Any]:
    return {
        "languages": [
            {"code": "en", "name": "English", "ta": "ஆங்கிலம்"},
            {"code": "ta", "name": "Tamil", "ta": "தமிழ்"},
            {"code": "hi", "name": "Hindi", "ta": "இந்தி"},
            {"code": "ml", "name": "Malayalam", "ta": "மலையாளம்"},
            {"code": "te", "name": "Telugu", "ta": "தெலுங்கு"},
            {"code": "kn", "name": "Kannada", "ta": "கன்னடம்"},
            {"code": "bn", "name": "Bengali", "ta": "வங்காளம்"},
            {"code": "mr", "name": "Marathi", "ta": "மராத்தி"},
            {"code": "gu", "name": "Gujarati", "ta": "குஜராத்தி"},
            {"code": "fr", "name": "French", "ta": "பிரெஞ்சு"},
            {"code": "de", "name": "German", "ta": "ஜெர்மன்"},
            {"code": "es", "name": "Spanish", "ta": "ஸ்பானிஷ்"},
            {"code": "ar", "name": "Arabic", "ta": "அரபு"},
            {"code": "zh-CN", "name": "Chinese", "ta": "சீனம்"},
            {"code": "ja", "name": "Japanese", "ta": "ஜப்பானியம்"},
        ],
        "primary": ["en", "ta"],
    }


# ------------------------------------------------------------------ translate
@app.post("/api/translate")
async def translate(payload: TranslateRequest) -> dict[str, Any]:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Enter some text to translate.")
    try:
        return await run_in_threadpool(
            translation_service.translate,
            text,
            payload.source or "auto",
            payload.target or "ta",
            payload.engine,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TranslationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ------------------------------------------------------------------------- tts
@app.post("/api/tts")
async def text_to_speech(payload: TTSRequest) -> Response:
    try:
        audio, mime, info = await run_in_threadpool(
            tts_service.synthesize,
            payload.text.strip(),
            payload.lang,
            payload.slow,
            payload.engine or "auto",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TTSError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    headers = {
        "Cache-Control": "public, max-age=86400",
        "X-TTS-Provider": info.get("provider", "google"),
        "X-TTS-Cached": "1" if info.get("cached") else "0",
    }
    return Response(content=audio, media_type=mime, headers=headers)


# ------------------------------------------------------------------------- stt
@app.post("/api/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    lang: str = Form("ta"),
    provider: str = Form("auto"),
) -> dict[str, Any]:
    data = await _read_upload(file, MAX_AUDIO_BYTES, "Audio")
    if not data:
        raise HTTPException(status_code=422, detail="The audio file is empty.")
    try:
        result = await run_in_threadpool(
            stt_service.transcribe,
            data,
            file.filename or "audio.webm",
            file.content_type or "application/octet-stream",
            lang,
            provider,
        )
        return result
    except STTUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except STTError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ------------------------------------------------------------------ spellcheck
@app.post("/api/spellcheck")
async def spellcheck(payload: SpellcheckRequest) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            spell_checker.check, payload.text, payload.extra_words
        )
    except Exception as exc:
        logger.exception("Spell check failed")
        raise HTTPException(status_code=500, detail="Spell check failed.") from exc


# ----------------------------------------------------------------------- words
@app.get("/api/words/suggest")
async def word_suggest(q: str = "", limit: int = 12) -> dict[str, Any]:
    try:
        return await run_in_threadpool(word_service.suggest, q, limit)
    except Exception as exc:
        logger.exception("Word suggestion failed")
        raise HTTPException(status_code=500, detail="Could not load word suggestions.") from exc


@app.get("/api/words/explore")
async def word_explore(q: str = "") -> dict[str, Any]:
    try:
        return await run_in_threadpool(word_service.explore, q)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TranslationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Word lookup failed")
        raise HTTPException(status_code=500, detail="Could not look up that word.") from exc


@app.get("/api/words/random")
async def word_random(category: str | None = None) -> dict[str, Any]:
    return await run_in_threadpool(word_service.random_word, category)


@app.get("/api/words/browse")
async def word_browse(category: str | None = None, limit: int = 40) -> dict[str, Any]:
    return {
        "category": category,
        "words": await run_in_threadpool(word_service.browse, category, limit),
    }


@app.get("/api/words/categories")
async def word_categories() -> dict[str, Any]:
    return {"categories": word_service.lexicon.categories}


# ------------------------------------------------------------------------- pdf
@app.get("/api/pdf/presets")
async def pdf_presets() -> dict[str, Any]:
    return {
        "presets": {
            key: {k: v for k, v in value.items() if k != "settings"}
            for key, value in PRESETS.items()
        }
    }


@app.post("/api/pdf/analyze")
async def pdf_analyze(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await _read_upload(file, MAX_PDF_BYTES, "PDF")
    try:
        result = await run_in_threadpool(analyze_pdf, data)
        result["filename"] = Path(file.filename or "document.pdf").name
        return result
    except PDFToolError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/pdf/compress")
async def pdf_compress(
    file: UploadFile = File(...),
    preset: str = Form("balanced"),
) -> Response:
    if preset not in PRESETS:
        raise HTTPException(status_code=422, detail="Unknown compression preset.")
    data = await _read_upload(file, MAX_PDF_BYTES, "PDF")
    try:
        output, stats = await run_in_threadpool(compress_pdf, data, preset)
    except PDFToolError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    name = safe_filename(file.filename or "document")
    headers = _pdf_headers(output, name, stats)
    return Response(content=output, media_type="application/pdf", headers=headers)


@app.post("/api/pdf/open")
async def pdf_open(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await _read_upload(file, MAX_PDF_BYTES, "PDF")
    try:
        return await run_in_threadpool(pdf_store.create, data, file.filename or "document.pdf")
    except PDFStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/pdf/{doc_id}/page/{page}.png")
async def pdf_page(doc_id: str, page: int, zoom: float = 1.5) -> Response:
    try:
        image = await run_in_threadpool(pdf_store.render_page, doc_id, page, zoom)
    except PDFStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        content=image,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/api/pdf/{doc_id}/lines/{page}")
async def pdf_lines(doc_id: str, page: int) -> dict[str, Any]:
    try:
        return await run_in_threadpool(pdf_store.extract_lines, doc_id, page)
    except PDFStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/pdf/{doc_id}/export")
async def pdf_export(doc_id: str, payload: ExportRequest) -> Response:
    try:
        meta = pdf_store.get_meta(doc_id)
        source = (pdf_store.root / doc_id / "source.pdf").read_bytes()
        output, info = await run_in_threadpool(
            export_edited_pdf,
            source,
            payload.edits,
            payload.page_order,
            payload.rotations,
            payload.compress,
        )
    except PDFStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PDFToolError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    name = safe_filename(meta.get("filename", "document"))
    headers = _pdf_headers(output, name, info)
    headers["X-PDF-Edits"] = str(info.get("edits", 0))
    return Response(content=output, media_type="application/pdf", headers=headers)


@app.delete("/api/pdf/{doc_id}")
async def pdf_delete(doc_id: str) -> dict[str, Any]:
    try:
        await run_in_threadpool(pdf_store.delete, doc_id)
    except PDFStoreError:
        pass
    return {"ok": True}


# --------------------------------------------------------------------- helpers
def _pdf_headers(output: bytes, filename: str, stats: dict[str, Any]) -> dict[str, str]:
    original = int(stats.get("original_size") or 0)
    saved = original - len(output) if original else 0
    percent = round((saved / original * 100), 1) if original else 0
    note = str(stats.get("note") or "").replace("\n", " ")[:180]
    engine = str(stats.get("engine") or "editor").replace("\n", " ")[:60]
    return {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Length": str(len(output)),
        "X-PDF-Filename": filename,
        "X-PDF-Original-Size": str(original or len(output)),
        "X-PDF-Output-Size": str(len(output)),
        "X-PDF-Saved-Percent": str(percent),
        "X-PDF-Engine": engine,
        "X-PDF-Note": note,
        "X-PDF-Pages": str(stats.get("pages") or ""),
    }


async def _read_upload(file: UploadFile, max_bytes: int, label: str) -> bytes:
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"{label} is too large. Maximum size is {max_bytes // (1024 * 1024)} MB.",
        )
    await file.close()
    return data


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "status": exc.status_code},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Something went wrong on the local server. Check the terminal for details.",
            "status": 500,
        },
    )


# ------------------------------------------------------------------------ web
app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html", media_type="text/html")


@app.get("/favicon.ico")
async def favicon() -> Response:
    svg = WEB_DIR / "assets" / "favicon.svg"
    if svg.exists():
        return FileResponse(svg, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/{path:path}")
async def spa(path: str) -> Response:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    candidate = WEB_DIR / path
    try:
        resolved = candidate.resolve()
        if resolved.is_file() and str(resolved).startswith(str(WEB_DIR.resolve())):
            return FileResponse(resolved)
    except OSError:
        pass
    return FileResponse(WEB_DIR / "index.html", media_type="text/html")
