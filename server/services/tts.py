from __future__ import annotations

import base64
import hashlib
import logging
from pathlib import Path
from typing import Any

import requests
from gtts import gTTS

from server.config import (
    SARVAM_API_KEY,
    SARVAM_TTS_MODEL,
    SARVAM_TTS_SPEAKER,
    TTS_CACHE_DIR,
)
from server.utils import validate_lang

logger = logging.getLogger(__name__)

PROVIDER_LABELS = {
    "google": "Google voice",
    "sarvam": "Sarvam voice",
}
SARVAM_LANGS = {"ta": "ta-IN", "en": "en-IN", "hi": "hi-IN", "ml": "ml-IN", "te": "te-IN", "kn": "kn-IN", "bn": "bn-IN", "gu": "gu-IN", "mr": "mr-IN", "pa": "pa-IN", "od": "od-IN"}


class TTSError(RuntimeError):
    pass


class TTSService:
    def __init__(self) -> None:
        self.session = requests.Session()

    def synthesize(
        self,
        text: str,
        lang: str = "ta",
        slow: bool = False,
        engine: str = "auto",
    ) -> tuple[bytes, str, dict[str, Any]]:
        text = (text or "").strip()
        if not text:
            raise ValueError("Text is empty")
        lang = validate_lang(lang).lower()
        lang = lang.split("-")[0]
        if len(text) > 4500:
            raise ValueError("Text is too long for speech (maximum 4,500 characters)")
        preferred = (engine or "auto").lower()
        if preferred not in {"auto", "google", "sarvam"}:
            preferred = "auto"
        if preferred == "sarvam" and not SARVAM_API_KEY:
            preferred = "google"
        if preferred == "auto":
            preferred = "sarvam" if SARVAM_API_KEY else "google"

        key = hashlib.sha256(
            f"{preferred}|{lang}|{int(slow)}|{text}".encode("utf-8")
        ).hexdigest()[:32]
        extension = "wav" if preferred == "sarvam" else "mp3"
        cache_path = TTS_CACHE_DIR / f"{key}.{extension}"
        if cache_path.exists() and cache_path.stat().st_size > 0:
            return (
                cache_path.read_bytes(),
                "audio/wav" if extension == "wav" else "audio/mpeg",
                {"provider": preferred, "cached": True, "chars": len(text)},
            )

        if preferred == "sarvam":
            try:
                audio, mime = self._sarvam(text, lang)
            except Exception as exc:
                logger.warning("Sarvam TTS failed, falling back to Google: %s", exc)
                audio, mime = self._google(text, lang, slow)
                preferred = "google"
                extension = "mp3"
                cache_path = TTS_CACHE_DIR / f"{key}.mp3"
        else:
            audio, mime = self._google(text, lang, slow)

        cache_path.write_bytes(audio)
        return audio, mime, {"provider": preferred, "cached": False, "chars": len(text)}

    def _google(self, text: str, lang: str, slow: bool) -> tuple[bytes, str]:
        try:
            tts = gTTS(text=text, lang=lang, slow=slow, tld="co.in")
            import io

            buffer = io.BytesIO()
            tts.write_to_fp(buffer)
            audio = buffer.getvalue()
            if not audio:
                raise TTSError("Google returned empty audio")
            return audio, "audio/mpeg"
        except Exception as exc:
            raise TTSError(f"Google text-to-speech failed: {exc}") from exc

    def _sarvam(self, text: str, lang: str) -> tuple[bytes, str]:
        if not SARVAM_API_KEY:
            raise TTSError("Sarvam API key is not configured")
        if lang not in SARVAM_LANGS:
            raise TTSError("Sarvam does not support this language")
        response = self.session.post(
            "https://api.sarvam.ai/text-to-speech",
            headers={
                "api-subscription-key": SARVAM_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "target_language_code": SARVAM_LANGS[lang],
                "speaker": SARVAM_TTS_SPEAKER,
                "model": SARVAM_TTS_MODEL,
                "enable_preprocessing": True,
            },
            timeout=40,
        )
        if response.status_code >= 400:
            raise TTSError(f"Sarvam HTTP {response.status_code}: {response.text[:160]}")
        payload = response.json()
        audios = payload.get("audios") or []
        if not audios:
            raise TTSError("Sarvam returned no audio")
        audio = base64.b64decode(audios[0])
        if not audio:
            raise TTSError("Sarvam returned empty audio")
        return audio, "audio/wav"

    def status(self) -> dict[str, Any]:
        return {
            "available": {"google": True, "sarvam": bool(SARVAM_API_KEY)},
            "preferred": "sarvam" if SARVAM_API_KEY else "google",
            "labels": PROVIDER_LABELS,
        }


tts_service = TTSService()
