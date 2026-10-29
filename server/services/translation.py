from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import requests

from server.config import (
    MYMEMORY_EMAIL,
    SARVAM_API_KEY,
    SARVAM_TRANSLATE_MODEL,
    TRANSLATE_TIMEOUT,
    TRANSLATION_ENGINE,
)
from server.utils import (
    TTLCache,
    detect_source_lang,
    group_chunks,
    split_paragraphs,
    split_sentences,
    validate_lang,
)

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

PROVIDER_LABELS = {
    "google": "Google Translate",
    "mymemory": "MyMemory",
    "sarvam": "Sarvam AI",
}

SARVAM_LANGS = {
    "en": "en-IN",
    "ta": "ta-IN",
    "hi": "hi-IN",
    "te": "te-IN",
    "ml": "ml-IN",
    "kn": "kn-IN",
    "bn": "bn-IN",
    "gu": "gu-IN",
    "mr": "mr-IN",
    "pa": "pa-IN",
    "od": "od-IN",
}


class TranslationError(RuntimeError):
    pass


class TranslationService:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9,ta;q=0.8",
            }
        )
        self.cache = TTLCache(ttl_seconds=6 * 3600, max_items=512)

    # ----------------------------------------------------------------- public
    def translate(
        self,
        text: str,
        source: str = "auto",
        target: str = "ta",
        engine: str | None = None,
    ) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValueError("Text is empty")
        source = validate_lang(source, allow_auto=True)
        target = validate_lang(target)
        if source != "auto" and source.lower() == target.lower():
            return {
                "translation": text,
                "source_lang": source,
                "target_lang": target,
                "engine": "none",
                "engine_label": "Same language",
                "latency_ms": 0,
                "cached": False,
                "warnings": [],
            }

        preferred = (engine or TRANSLATION_ENGINE or "auto").strip().lower()
        if preferred not in {"auto", "google", "mymemory", "sarvam"}:
            preferred = "auto"

        cache_key = (
            preferred,
            source.lower(),
            target.lower(),
            hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )
        cached = self.cache.get(cache_key)
        if cached is not None:
            result = dict(cached)
            result["cached"] = True
            result["latency_ms"] = 0
            return result

        started = time.perf_counter()
        detected = source
        if source == "auto":
            detected = detect_source_lang(text)

        providers = self._provider_order(preferred)
        if not providers:
            raise TranslationError("No translation provider is available")

        warnings: list[str] = []
        last_error: Exception | None = None
        result: dict[str, Any] | None = None
        used_provider = ""
        for provider in providers:
            try:
                if source == "auto" and provider == "google":
                    translated, detected_by_provider = self._google(
                        text, "auto", target, timeout=TRANSLATE_TIMEOUT
                    )
                    if detected_by_provider:
                        detected = detected_by_provider
                else:
                    translated = self._translate_with(provider, text, detected, target)
                if not translated.strip():
                    raise TranslationError("The provider returned an empty translation")
                used_provider = provider
                result = {"translation": translated}
                break
            except Exception as exc:  # provider failures are expected; try next
                logger.warning("Translation provider %s failed: %s", provider, exc)
                last_error = exc
                if provider == providers[-1]:
                    break
                warnings.append(f"{PROVIDER_LABELS.get(provider, provider)} was unavailable; using a fallback.")

        if result is None:
            raise TranslationError(
                "Translation failed. Check your internet connection and try again."
            ) from last_error

        response = {
            "translation": result["translation"].strip(),
            "source_lang": detected,
            "target_lang": target,
            "engine": used_provider,
            "engine_label": PROVIDER_LABELS.get(used_provider, used_provider),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "cached": False,
            "warnings": warnings,
        }
        self.cache.set(cache_key, response)
        return response

    def status(self) -> dict[str, Any]:
        return {
            "available": {
                "google": True,
                "mymemory": True,
                "sarvam": bool(SARVAM_API_KEY),
            },
            "preferred": TRANSLATION_ENGINE,
            "labels": PROVIDER_LABELS,
        }

    # -------------------------------------------------------------- providers
    def _provider_order(self, preferred: str) -> list[str]:
        if preferred == "google":
            return ["google", "mymemory"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "mymemory":
            return ["mymemory", "google"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "sarvam":
            return (["sarvam"] if SARVAM_API_KEY else []) + ["google", "mymemory"]
        order = ["google", "mymemory"]
        if SARVAM_API_KEY:
            order.append("sarvam")
        return order

    def _translate_with(
        self, provider: str, text: str, source: str, target: str
    ) -> str:
        if provider == "google":
            translated, _ = self._google(text, source, target, timeout=TRANSLATE_TIMEOUT)
            return translated
        if provider == "mymemory":
            return self._mymemory(text, source, target)
        if provider == "sarvam":
            return self._sarvam(text, source, target)
        raise TranslationError(f"Unknown translation provider: {provider}")

    def _google(
        self, text: str, source: str, target: str, timeout: float
    ) -> tuple[str, str | None]:
        """Translate via the public Google Translate web endpoint.

        The ``client=at`` endpoint is the lightweight one used by Google's own
        web widgets. It accepts POST, which lets us avoid URL length limits for
        Tamil text. If it changes or is blocked, the caller falls back.
        """
        params = {
            "client": "at",
            "sl": source,
            "tl": target,
            "hl": "en",
            "dt": "t",
        }
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                response = self.session.post(
                    "https://translate.google.com/translate_a/single",
                    params=params,
                    data={"q": text},
                    timeout=timeout,
                )
                if response.status_code != 200:
                    raise TranslationError(f"Google HTTP {response.status_code}")
                data = response.json()
                segments = data[0] if isinstance(data, list) and data else []
                translated = "".join(
                    str(seg[0])
                    for seg in segments
                    if isinstance(seg, list) and seg and seg[0]
                )
                detected = None
                if len(data) > 2 and isinstance(data[2], str):
                    detected = data[2]
                if translated.strip():
                    return translated, detected
                raise TranslationError("Google returned no text")
            except Exception as exc:
                last_error = exc
                if attempt == 0:
                    time.sleep(0.25)
        # A second, simpler endpoint occasionally survives when the first is
        # rate-limited. It is also useful on networks where ``translate.google``
        # is blocked but ``clients5.google`` is reachable.
        try:
            response = self.session.get(
                "https://clients5.google.com/translate_a/t",
                params={
                    "client": "dict-chrome-ex",
                    "sl": source,
                    "tl": target,
                    "q": text[:1400],
                },
                timeout=timeout,
            )
            if response.status_code == 200:
                data = response.json()
                translated = self._flatten_google_json(data)
                if translated.strip():
                    return translated, None
        except Exception as exc:
            last_error = exc
        raise TranslationError(f"Google Translate failed: {last_error}")

    def _flatten_google_json(self, data: Any) -> str:
        if isinstance(data, str):
            return data
        if isinstance(data, list):
            if data and isinstance(data[0], str):
                return "".join(str(x) for x in data if isinstance(x, str))
            chunks = []
            for item in data:
                value = self._flatten_google_json(item)
                if value:
                    chunks.append(value)
            return "".join(chunks)
        if isinstance(data, dict):
            for key in ("translatedText", "translation", "text"):
                value = data.get(key)
                if isinstance(value, str):
                    return value
        return ""

    def _mymemory(self, text: str, source: str, target: str) -> str:
        if source == "auto":
            source = detect_source_lang(text)
        results: list[str] = []
        for chunk in group_chunks(split_sentences(text), 450):
            params = {
                "q": chunk,
                "langpair": f"{source}|{target}",
                "mt": "1",
            }
            if MYMEMORY_EMAIL:
                params["de"] = MYMEMORY_EMAIL
            response = self.session.get(
                "https://api.mymemory.translated.net/get",
                params=params,
                timeout=TRANSLATE_TIMEOUT,
            )
            if response.status_code != 200:
                raise TranslationError(f"MyMemory HTTP {response.status_code}")
            payload = response.json()
            if str(payload.get("responseStatus")) != "200":
                raise TranslationError(payload.get("responseDetails") or "MyMemory error")
            translated = (payload.get("responseData") or {}).get("translatedText") or ""
            if not translated:
                raise TranslationError("MyMemory returned no text")
            results.append(translated)
        return " ".join(results)

    def _sarvam(self, text: str, source: str, target: str) -> str:
        if not SARVAM_API_KEY:
            raise TranslationError("Sarvam API key is not configured")
        if source not in SARVAM_LANGS or target not in SARVAM_LANGS:
            raise TranslationError("Sarvam does not support this language pair")
        response = self.session.post(
            "https://api.sarvam.ai/translate",
            headers={
                "api-subscription-key": SARVAM_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "input": text,
                "source_language_code": SARVAM_LANGS[source],
                "target_language_code": SARVAM_LANGS[target],
                "speaker_gender": "Female",
                "mode": "formal",
                "model": SARVAM_TRANSLATE_MODEL,
                "enable_preprocessing": True,
            },
            timeout=TRANSLATE_TIMEOUT,
        )
        if response.status_code >= 400:
            raise TranslationError(f"Sarvam HTTP {response.status_code}: {response.text[:160]}")
        payload = response.json()
        translated = (
            payload.get("translated_text")
            or payload.get("translation")
            or payload.get("output")
        )
        if not isinstance(translated, str) or not translated.strip():
            raise TranslationError("Sarvam returned no text")
        return translated


# ------------------------------------------------------------------ helpers
def chunk_for_translation(text: str, max_len: int = 1800) -> list[str]:
    """Return chunks that preserve paragraph boundaries where possible."""
    paragraphs = split_paragraphs(text)
    chunks: list[str] = []
    for paragraph in paragraphs:
        if not paragraph:
            chunks.append("")
            continue
        if len(paragraph) <= max_len:
            chunks.append(paragraph)
            continue
        sentence_chunks = group_chunks(split_sentences(paragraph), max_len)
        chunks.extend(sentence_chunks or [paragraph[:max_len]])
    return chunks


translation_service = TranslationService()
