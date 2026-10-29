from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import requests

from server.config import (
    MOZHI_HOSTS,
    MYMEMORY_EMAIL,
    SARVAM_API_KEY,
    SARVAM_TIMEOUT,
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
    "mozhi": "Yandex Translator",
    "mymemory": "MyMemory",
    "sarvam": "Sarvam AI",
}

# Mozhi delegates to Yandex, which uses slightly different codes for Chinese.
MOZHI_LANG_ALIASES = {
    "zh-cn": "zh",
    "zh-tw": "zh",
    "zh": "zh",
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
        if preferred not in {"auto", "mozhi", "mymemory", "sarvam"}:
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
                if source == "auto" and provider in {"sarvam", "mozhi"}:
                    detector = self._sarvam if provider == "sarvam" else self._mozhi
                    translated, detected_by_provider = detector(text, "auto", target)
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
                "mozhi": True,
                "mymemory": True,
                "sarvam": bool(SARVAM_API_KEY),
            },
            "preferred": TRANSLATION_ENGINE,
            "labels": PROVIDER_LABELS,
        }

    # -------------------------------------------------------------- providers
    def _provider_order(self, preferred: str) -> list[str]:
        if preferred == "mozhi":
            return ["mozhi", "mymemory"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "mymemory":
            return ["mymemory", "mozhi"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "sarvam":
            return (["sarvam"] if SARVAM_API_KEY else []) + ["mozhi", "mymemory"]
        # Prefer Sarvam when its key is configured: it has the best Tamil quality.
        order = (["sarvam"] if SARVAM_API_KEY else []) + ["mozhi", "mymemory"]
        return order

    def _translate_with(
        self, provider: str, text: str, source: str, target: str
    ) -> str:
        if provider == "mozhi":
            translated, _ = self._mozhi(text, source, target)
            return translated
        if provider == "mymemory":
            return self._mymemory(text, source, target)
        if provider == "sarvam":
            translated, _ = self._sarvam(text, source, target)
            return translated
        raise TranslationError(f"Unknown translation provider: {provider}")

    def _mozhi(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        """Translate through a public Mozhi instance (Yandex engine).

        Mozhi is a free, open-source translation front-end that needs no account
        or API key. We try several public instances in order so a single outage
        does not break translation.
        """
        paragraphs: list[str] = []
        detected: str | None = None
        for paragraph in split_paragraphs(text):
            if not paragraph.strip():
                paragraphs.append("")
                continue
            chunks = group_chunks(split_sentences(paragraph), 1500) or [paragraph]
            parts: list[str] = []
            for chunk in chunks:
                translated, chunk_lang = self._mozhi_chunk(chunk, source, target)
                parts.append(translated)
                if detected is None and chunk_lang:
                    detected = chunk_lang
            paragraphs.append(" ".join(parts))
        return "\n".join(paragraphs), detected

    def _mozhi_chunk(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        to_lang = MOZHI_LANG_ALIASES.get(target.lower(), target)
        last_error: Exception | None = None
        for host in MOZHI_HOSTS:
            try:
                response = self.session.get(
                    f"{host}/api/translate",
                    params={
                        "engine": "yandex",
                        "from": source,
                        "to": to_lang,
                        "text": text,
                    },
                    timeout=TRANSLATE_TIMEOUT,
                )
                if response.status_code != 200:
                    raise TranslationError(f"Mozhi HTTP {response.status_code}")
                payload = response.json()
                translated = (
                    payload.get("translated-text")
                    or payload.get("translated_text")
                    or ""
                )
                if not str(translated).strip():
                    raise TranslationError("Mozhi returned no text")
                lang = payload.get("detected") or None
                return str(translated), (str(lang) if lang else None)
            except Exception as exc:
                last_error = exc
                logger.warning("Mozhi host %s failed: %s", host, exc)
                continue
        raise TranslationError(f"Mozhi Translate failed: {last_error}")

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

    def _sarvam(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        if not SARVAM_API_KEY:
            raise TranslationError("Sarvam API key is not configured")
        if source != "auto" and source not in SARVAM_LANGS:
            raise TranslationError("Sarvam does not support this language")
        if target not in SARVAM_LANGS:
            raise TranslationError("Sarvam does not support this language")

        paragraphs: list[str] = []
        detected: str | None = None
        for paragraph in split_paragraphs(text):
            if not paragraph.strip():
                paragraphs.append("")
                continue
            # mayura:v1 accepts at most 1000 characters per request.
            chunks = group_chunks(split_sentences(paragraph), 950) or [paragraph]
            parts: list[str] = []
            for chunk in chunks:
                translated, chunk_lang = self._sarvam_chunk(chunk, source, target)
                parts.append(translated)
                if detected is None and chunk_lang:
                    detected = chunk_lang
            paragraphs.append(" ".join(parts))
        return "\n".join(paragraphs), detected

    def _sarvam_chunk(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        source_code = "auto" if source == "auto" else SARVAM_LANGS[source]
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.session.post(
                    "https://api.sarvam.ai/translate",
                    headers={
                        "api-subscription-key": SARVAM_API_KEY,
                        "Content-Type": "application/json",
                    },
                    json={
                        "input": text,
                        "source_language_code": source_code,
                        "target_language_code": SARVAM_LANGS[target],
                        "speaker_gender": "Female",
                        "mode": "formal",
                        "model": SARVAM_TRANSLATE_MODEL,
                        "enable_preprocessing": True,
                    },
                    timeout=SARVAM_TIMEOUT,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    # Rate limits and server errors are worth retrying.
                    raise requests.HTTPError(
                        f"Sarvam HTTP {response.status_code}", response=response
                    )
                if response.status_code >= 400:
                    # 4xx (bad key, bad language, too much text) will not fix
                    # itself by retrying.
                    raise TranslationError(
                        f"Sarvam HTTP {response.status_code}: {response.text[:160]}"
                    )
                payload = response.json()
                translated = (
                    payload.get("translated_text")
                    or payload.get("translation")
                    or payload.get("output")
                )
                if not isinstance(translated, str) or not translated.strip():
                    raise TranslationError("Sarvam returned no text")
                lang = payload.get("source_language_code")
                detected = (
                    str(lang).split("-")[0]
                    if isinstance(lang, str) and lang
                    else None
                )
                return translated, detected
            except TranslationError:
                raise
            except Exception as exc:  # timeouts / connection resets
                last_error = exc
                if attempt < 2:
                    time.sleep(0.6 * (attempt + 1))
                    continue
                raise TranslationError(f"Sarvam connection failed: {exc}") from exc
        raise TranslationError(f"Sarvam failed: {last_error}")


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
