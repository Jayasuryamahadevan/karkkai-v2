from __future__ import annotations

import logging
from typing import Any

import requests

from server.config import OPENAI_API_KEY, SARVAM_API_KEY

logger = logging.getLogger(__name__)

PROVIDER_LABELS = {
    "sarvam": "Sarvam Saarika",
    "openai": "OpenAI Whisper",
}

LANGUAGE_CODES = {
    "ta": {"sarvam": "ta-IN", "openai": "ta"},
    "en": {"sarvam": "en-IN", "openai": "en"},
    "hi": {"sarvam": "hi-IN", "openai": "hi"},
    "ml": {"sarvam": "ml-IN", "openai": "ml"},
    "te": {"sarvam": "te-IN", "openai": "te"},
    "kn": {"sarvam": "kn-IN", "openai": "kn"},
    "bn": {"sarvam": "bn-IN", "openai": "bn"},
}


class STTUnavailable(RuntimeError):
    pass


class STTError(RuntimeError):
    pass


class STTService:
    def __init__(self) -> None:
        self.session = requests.Session()

    def providers(self) -> list[str]:
        result = []
        if SARVAM_API_KEY:
            result.append("sarvam")
        if OPENAI_API_KEY:
            result.append("openai")
        return result

    def transcribe(
        self,
        audio: bytes,
        filename: str,
        content_type: str,
        lang: str = "ta",
        provider: str = "auto",
    ) -> dict[str, Any]:
        if not audio:
            raise ValueError("The audio file is empty")
        lang = (lang or "ta").lower().split("-")[0]
        if lang not in LANGUAGE_CODES:
            lang = "ta"
        available = self.providers()
        if not available:
            raise STTUnavailable(
                "Server-side speech-to-text is not configured. Use live browser "
                "speech, or add SARVAM_API_KEY / OPENAI_API_KEY to .env."
            )
        provider = (provider or "auto").lower()
        if provider == "auto":
            provider = available[0]
        if provider not in available:
            raise STTUnavailable(f"{provider} is not configured")
        if provider == "sarvam":
            return self._sarvam(audio, filename, content_type, lang)
        return self._openai(audio, filename, content_type, lang)

    def _sarvam(
        self, audio: bytes, filename: str, content_type: str, lang: str
    ) -> dict[str, Any]:
        response = self.session.post(
            "https://api.sarvam.ai/speech-to-text",
            headers={"api-subscription-key": SARVAM_API_KEY},
            files={
                "file": (
                    filename or "audio.webm",
                    audio,
                    content_type or "application/octet-stream",
                )
            },
            data={
                "language_code": LANGUAGE_CODES[lang]["sarvam"],
                "model": "saarika:v2.5",
            },
            timeout=90,
        )
        if response.status_code >= 400:
            raise STTError(f"Sarvam HTTP {response.status_code}: {response.text[:180]}")
        payload = response.json()
        transcript = payload.get("transcript") or payload.get("text") or ""
        if not isinstance(transcript, str):
            transcript = str(transcript)
        return {
            "transcript": transcript.strip(),
            "language": lang,
            "provider": "sarvam",
            "provider_label": PROVIDER_LABELS["sarvam"],
            "segments": [],
        }

    def _openai(
        self, audio: bytes, filename: str, content_type: str, lang: str
    ) -> dict[str, Any]:
        response = self.session.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={
                "file": (
                    filename or "audio.webm",
                    audio,
                    content_type or "application/octet-stream",
                )
            },
            data={
                "model": "whisper-1",
                "language": LANGUAGE_CODES[lang]["openai"],
                "response_format": "json",
            },
            timeout=120,
        )
        if response.status_code >= 400:
            raise STTError(f"OpenAI HTTP {response.status_code}: {response.text[:180]}")
        payload = response.json()
        transcript = payload.get("text") or ""
        return {
            "transcript": transcript.strip(),
            "language": lang,
            "provider": "openai",
            "provider_label": PROVIDER_LABELS["openai"],
            "segments": [],
        }

    def status(self) -> dict[str, Any]:
        available = self.providers()
        return {
            "server_available": available,
            "browser": True,
            "labels": PROVIDER_LABELS,
            "hint": (
                None
                if available
                else "Live speech-to-text in Chrome/Edge works now. Add a Sarvam or OpenAI key to transcribe uploaded audio."
            ),
        }


stt_service = STTService()
