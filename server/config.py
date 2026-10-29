from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
PDF_DIR = CACHE_DIR / "pdfs"
UPLOAD_DIR = CACHE_DIR / "uploads"
TTS_CACHE_DIR = CACHE_DIR / "tts"
FONT_DIR = WEB_DIR / "assets" / "fonts"

load_dotenv(ROOT / ".env")

for folder in (DATA_DIR, CACHE_DIR, PDF_DIR, UPLOAD_DIR, TTS_CACHE_DIR):
    folder.mkdir(parents=True, exist_ok=True)

APP_NAME = "Chillian"
APP_VERSION = "0.1.0"

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8787"))

TRANSLATION_ENGINE = os.getenv("TRANSLATION_ENGINE", "auto").strip().lower()
MOZHI_HOSTS = tuple(
    host.strip().rstrip("/")
    for host in os.getenv(
        "MOZHI_HOSTS",
        "https://mozhi.aryak.me,https://mozhi.ducks.party,https://translate.projectsegfau.lt",
    ).split(",")
    if host.strip()
)
MYMEMORY_EMAIL = os.getenv("MYMEMORY_EMAIL", "").strip()
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "").strip()
SARVAM_TRANSLATE_MODEL = os.getenv("SARVAM_TRANSLATE_MODEL", "mayura:v1").strip()
SARVAM_TTS_MODEL = os.getenv("SARVAM_TTS_MODEL", "bulbul:v2").strip()
SARVAM_TTS_SPEAKER = os.getenv("SARVAM_TTS_SPEAKER", "anushka").strip()
SARVAM_TIMEOUT = float(os.getenv("SARVAM_TIMEOUT", "60"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()

MAX_TRANSLATE_CHARS = int(os.getenv("MAX_TRANSLATE_CHARS", "5000"))
MAX_TTS_CHARS = int(os.getenv("MAX_TTS_CHARS", "4500"))
MAX_PDF_MB = int(os.getenv("MAX_PDF_MB", "30"))
MAX_AUDIO_MB = int(os.getenv("MAX_AUDIO_MB", "25"))
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "80"))
PDF_SESSION_MINUTES = int(os.getenv("PDF_SESSION_MINUTES", "180"))
TRANSLATE_TIMEOUT = float(os.getenv("TRANSLATE_TIMEOUT", "22"))
PDF_TIMEOUT = int(os.getenv("PDF_TIMEOUT", "150"))

# Service status is intentionally explicit: the app never silently claims that
# an engine exists when the credential / model needed for it does not.
def online_status() -> dict:
    return {
        "translation": {
            "mozhi": True,
            "mymemory": True,
            "sarvam": bool(SARVAM_API_KEY),
        },
        "tts": {
            "google": True,
            "sarvam": bool(SARVAM_API_KEY),
        },
        "stt": {
            "browser": True,
            "sarvam": bool(SARVAM_API_KEY),
            "openai": bool(OPENAI_API_KEY),
        },
    }
