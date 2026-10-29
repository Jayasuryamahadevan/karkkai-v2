from __future__ import annotations

import html
import re
import threading
import time
from collections import OrderedDict
from typing import Any

TAMIL_RE = re.compile(r"[\u0B80-\u0BFF]")
TAMIL_WORD_RE = re.compile(r"^[\u0B80-\u0BFF]+$")
LATIN_RE = re.compile(r"[A-Za-z]")
LANG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$")


class TTLCache:
    """Small, thread-safe in-memory cache with a maximum size."""

    def __init__(self, ttl_seconds: int = 3600, max_items: int = 512) -> None:
        self.ttl = ttl_seconds
        self.max_items = max_items
        self._data: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any) -> Any | None:
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            expires, value = item
            if expires < now:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key: Any, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.time() + self.ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self.max_items:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        return len(self._data)


def tamil_ratio(text: str) -> float:
    visible = [ch for ch in text if not ch.isspace()]
    if not visible:
        return 0.0
    tamil = sum(1 for ch in visible if "\u0B80" <= ch <= "\u0BFF")
    return tamil / len(visible)


SCRIPT_LANGS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"[\u0B80-\u0BFF]"), "ta"),
    (re.compile(r"[\u0900-\u097F]"), "hi"),
    (re.compile(r"[\u0C00-\u0C7F]"), "te"),
    (re.compile(r"[\u0C80-\u0CFF]"), "kn"),
    (re.compile(r"[\u0D00-\u0D7F]"), "ml"),
    (re.compile(r"[\u0980-\u09FF]"), "bn"),
    (re.compile(r"[\u0A80-\u0AFF]"), "gu"),
    (re.compile(r"[\u0600-\u06FF]"), "ar"),
    (re.compile(r"[\uAC00-\uD7AF]"), "ko"),
    (re.compile(r"[\u3040-\u30FF]"), "ja"),
    (re.compile(r"[\u4E00-\u9FFF]"), "zh"),
)


def detect_source_lang(text: str) -> str:
    """Detect the source language locally so API auto-detection is not needed."""
    if any("\u3040" <= ch <= "\u30FF" for ch in text):
        return "ja"
    best_code = "en"
    best_count = 0
    for pattern, code in SCRIPT_LANGS:
        count = len(pattern.findall(text))
        if count > best_count:
            best_code = code
            best_count = count
    return best_code


def contains_tamil(text: str) -> bool:
    return bool(TAMIL_RE.search(text))


def is_tamil_word(text: str) -> bool:
    return bool(TAMIL_WORD_RE.fullmatch(text))


def validate_lang(code: str, *, allow_auto: bool = False) -> str:
    code = (code or "").strip()
    if allow_auto and code == "auto":
        return code
    if not LANG_RE.fullmatch(code):
        raise ValueError("Invalid language code")
    return code


def split_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs while keeping empty lines meaningful."""
    return re.split(r"\n", text)


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?۔।])\s+", text)
    return [p for p in parts if p]


def group_chunks(parts: list[str], max_len: int) -> list[str]:
    """Group sentence-ish parts into chunks no longer than max_len."""
    chunks: list[str] = []
    current = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        while len(part) > max_len:
            cut = part.rfind(" ", 0, max_len)
            if cut < max_len // 2:
                cut = max_len
            if current:
                chunks.append(current.strip())
                current = ""
            chunks.append(part[:cut].strip())
            part = part[cut:].strip()
        if not part:
            continue
        if current and len(current) + 1 + len(part) > max_len:
            chunks.append(current.strip())
            current = part
        else:
            current = f"{current} {part}".strip()
    if current:
        chunks.append(current.strip())
    return chunks


def escape_html(text: str) -> str:
    return html.escape(text, quote=False)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_color(value: str | None, default: str = "#171512") -> tuple[float, float, float]:
    value = (value or default).strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        value = default.lstrip("#")
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return r, g, b


def clamp_rect(rect: list[float], width: float, height: float) -> list[float]:
    x0, y0, x1, y1 = (float(v) for v in rect)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    x0 = clamp(x0, 0, width)
    x1 = clamp(x1, 0, width)
    y0 = clamp(y0, 0, height)
    y1 = clamp(y1, 0, height)
    return [x0, y0, x1, y1]


def is_probably_rotated(page_rotation: int) -> bool:
    return int(page_rotation or 0) % 360 != 0
