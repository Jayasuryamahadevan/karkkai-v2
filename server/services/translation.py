from __future__ import annotations

import hashlib
import logging
import re
import threading
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
    "bing": "Bing Translator",
    "mymemory": "MyMemory",
    "sarvam": "Sarvam AI",
}

# Bing expects a handful of non-standard codes.
BING_LANG_ALIASES = {
    "zh": "zh-Hans",
    "zh-cn": "zh-Hans",
    "zh-tw": "zh-Hant",
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
        self._bing_lock = threading.Lock()
        self._bing_auth: dict[str, Any] | None = None

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
        if preferred not in {"auto", "bing", "mymemory", "sarvam"}:
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
                if source == "auto" and provider == "bing":
                    translated, detected_by_provider = self._bing(text, "auto", target)
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
                "bing": True,
                "mymemory": True,
                "sarvam": bool(SARVAM_API_KEY),
            },
            "preferred": TRANSLATION_ENGINE,
            "labels": PROVIDER_LABELS,
        }

    # -------------------------------------------------------------- providers
    def _provider_order(self, preferred: str) -> list[str]:
        if preferred == "bing":
            return ["bing", "mymemory"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "mymemory":
            return ["mymemory", "bing"] + (["sarvam"] if SARVAM_API_KEY else [])
        if preferred == "sarvam":
            return (["sarvam"] if SARVAM_API_KEY else []) + ["bing", "mymemory"]
        order = ["bing", "mymemory"]
        if SARVAM_API_KEY:
            order.append("sarvam")
        return order

    def _translate_with(
        self, provider: str, text: str, source: str, target: str
    ) -> str:
        if provider == "bing":
            translated, _ = self._bing(text, source, target)
            return translated
        if provider == "mymemory":
            return self._mymemory(text, source, target)
        if provider == "sarvam":
            return self._sarvam(text, source, target)
        raise TranslationError(f"Unknown translation provider: {provider}")

    def _bing(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        """Translate through Bing's public web translator.

        Bing's site is free and needs no account. Its widgets fetch a short-lived
        token from the translator page, then post text to ``ttranslatev3``. The
        token and cookies are reused until they expire, after which the token is
        refreshed automatically.
        """
        paragraphs: list[str] = []
        detected: str | None = None
        for paragraph in split_paragraphs(text):
            if not paragraph.strip():
                paragraphs.append("")
                continue
            chunks = group_chunks(split_sentences(paragraph), 900) or [paragraph]
            parts: list[str] = []
            for chunk in chunks:
                translated, chunk_lang = self._bing_chunk(chunk, source, target)
                parts.append(translated)
                if detected is None and chunk_lang:
                    detected = chunk_lang
            paragraphs.append(" ".join(parts))
        return "\n".join(paragraphs), detected

    def _bing_chunk(
        self, text: str, source: str, target: str
    ) -> tuple[str, str | None]:
        from_lang = "auto-detect" if source == "auto" else source
        to_lang = BING_LANG_ALIASES.get(target.lower(), target)
        with self._bing_lock:
            last_error: Exception | None = None
            for attempt in range(2):
                try:
                    auth = self._bing_auth
                    if not auth or auth["expires"] <= time.time():
                        auth = self._bing_refresh_auth()
                    response = self.session.post(
                        auth["url"],
                        data={
                            "fromLang": from_lang,
                            "text": text,
                            "to": to_lang,
                            "token": auth["token"],
                            "key": auth["key"],
                        },
                        headers={
                            "Referer": "https://www.bing.com/translator",
                            "Origin": "https://www.bing.com",
                        },
                        timeout=TRANSLATE_TIMEOUT,
                    )
                    if response.status_code != 200 or "ShowCaptcha" in response.text:
                        raise TranslationError(
                            f"Bing HTTP {response.status_code}"
                        )
                    data = response.json()
                    items = data if isinstance(data, list) else [data]
                    parts: list[str] = []
                    detected: str | None = None
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        for row in item.get("translations") or []:
                            if isinstance(row, dict) and row.get("text"):
                                parts.append(str(row["text"]))
                        lang = item.get("detectedLanguage") or {}
                        if isinstance(lang, dict) and lang.get("language"):
                            detected = str(lang["language"])
                    translated = "".join(parts)
                    if translated.strip():
                        return translated, detected
                    raise TranslationError("Bing returned no text")
                except Exception as exc:
                    last_error = exc
                    self._bing_auth = None
                    if attempt == 0:
                        time.sleep(0.25)
            raise TranslationError(f"Bing Translate failed: {last_error}")

    def _bing_refresh_auth(self) -> dict[str, Any]:
        response = self.session.get(
            "https://www.bing.com/translator", timeout=TRANSLATE_TIMEOUT
        )
        if response.status_code != 200:
            raise TranslationError(f"Bing page HTTP {response.status_code}")
        page = response.text
        ig = re.search(r'IG:"([^"]+)"', page)
        iid = re.search(r'data-iid="(translator\.\d+)"', page)
        helper = re.search(
            r'params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]',
            page,
        )
        if not (ig and iid and helper):
            raise TranslationError("Bing translator page changed")
        key, token, interval_ms = helper.group(1), helper.group(2), int(helper.group(3))
        self._bing_auth = {
            "url": (
                "https://www.bing.com/ttranslatev3"
                f"?isVertical=1&IG={ig.group(1)}&IID={iid.group(1)}&SFX=1"
            ),
            "key": key,
            "token": token,
            "expires": time.time() + max(60.0, interval_ms / 1000 - 120),
        }
        return self._bing_auth

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
