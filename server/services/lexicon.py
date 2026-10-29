from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from rapidfuzz import fuzz, process
from wordfreq import top_n_list, zipf_frequency

from server.config import DATA_DIR
from server.utils import is_tamil_word

logger = logging.getLogger(__name__)

# Useful Tamil case / plural / derivation endings. The checker is deliberately
# conservative about what counts as a valid inflection: a root must itself be a
# recognised word before an ending is accepted.
SUFFIXES: tuple[str, ...] = tuple(
    sorted(
        {
            "களுக்கு",
            "களுடன்",
            "களிலிருந்து",
            "களில்",
            "களின்",
            "களை",
            "களால்",
            "களது",
            "களாக",
            "கள்",
            "க்காக",
            "க்கும்",
            "க்கு",
            "த்துக்கு",
            "த்தில்",
            "த்தை",
            "த்தால்",
            "த்தின்",
            "த்துடன்",
            "த்திலிருந்து",
            "இலிருந்து",
            "ிலிருந்து",
            "இருந்து",
            "வரை",
            "போல",
            "போல்",
            "என்று",
            "என",
            "ஆக",
            "ஆல்",
            "ஆன்",
            "ஆர்",
            "ஆள்",
            "ஐ",
            "இல்",
            "இன்",
            "உடன்",
            "உம்",
            "அன்",
            "அர்",
            "அது",
            "உக்கு",
        },
        key=len,
        reverse=True,
    )
)

FAMILY_SUFFIXES: tuple[str, ...] = (
    "கள்",
    "களை",
    "களுக்கு",
    "களில்",
    "க்கு",
    "இல்",
    "ஐ",
    "ஆல்",
    "உடன்",
    "ஆக",
    "அன்",
    "அர்",
    "ஆள்",
    "ஆர்",
    "த்தை",
    "த்தில்",
    "வு",
    "ப்பு",
)

CONFUSION_GROUPS: tuple[str, ...] = ("லள", "ரற", "நனண", "சஷஸ", "ஜய")
VOWEL_SIGN_GROUPS: tuple[str, ...] = ("ிீ", "ுூ", "ெே", "ொோ")

COMMON_TYPOS: dict[str, list[str]] = {
    "வணக்கம": ["வணக்கம்"],
    "வணக்கம்": ["வணக்கம்"],
    "நனறி": ["நன்றி"],
    "நன்றீ": ["நன்றி"],
    "தமழ்": ["தமிழ்"],
    "தமிழ": ["தமிழ்"],
    "அமா": ["அம்மா"],
    "அபா": ["அப்பா"],
    "மகிழ்சி": ["மகிழ்ச்சி"],
    "மகிழ்ச்சி": ["மகிழ்ச்சி"],
    "பள்ளிகு": ["பள்ளிக்கு"],
    "பள்ளிக்கூடம": ["பள்ளிக்கூடம்"],
    "ஆசிரியர்": ["ஆசிரியர்"],
    "ஆசிரியர": ["ஆசிரியர்"],
    "எழுது": ["எழுது"],
    "எழுத": ["எழுது"],
    "தமிழ்நாடு": ["தமிழ்நாடு"],
    "செய்தி": ["செய்தி"],
    "செய்தீ": ["செய்தி"],
    "படிக்க": ["படிக்க"],
    "படிக": ["படிக்க"],
    "வேலை": ["வேலை"],
    "வேல": ["வேலை"],
}

# Particles and interjections which are legitimate on their own and are often
# missing from frequency lists.
COMMON_PARTICLES = {
    "ஓ",
    "ஏ",
    "ஆ",
    "ஈ",
    "ஒ",
    "ஔ",
    "ஃ",
    "உம்",
    "ஏன்",
    "என்ன",
    "எப்படி",
    "எங்கே",
    "யார்",
    "எது",
    "இது",
    "அது",
    "இவை",
    "அவை",
    "இங்கே",
    "அங்கே",
    "மிக",
    "மிகவும்",
    "மட்டும்",
    "கூட",
    "தான்",
    "என்று",
    "என",
    "ஆக",
}

_NAME_RE = re.compile(r"^[\u0B80-\u0BFF]{2,}$")


@dataclass
class Lexicon:
    words: list[str]
    word_set: set[str]
    rank: dict[str, int]
    glossary_entries: list[dict] = field(default_factory=list)
    categories: dict[str, dict] = field(default_factory=dict)
    thesaurus_groups: list[dict] = field(default_factory=list)
    sorted_words: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.sorted_words = sorted(self.word_set)

    def is_known(self, word: str, extra: set[str] | None = None) -> bool:
        if not word:
            return True
        if word in self.word_set:
            return True
        if extra and word in extra:
            return True
        if word in COMMON_PARTICLES:
            return True
        return False

    def morphological_roots(self, word: str) -> list[str]:
        roots: list[str] = []
        for suffix in SUFFIXES:
            if len(word) > len(suffix) + 1 and word.endswith(suffix):
                root = word[: -len(suffix)]
                if root in self.word_set and root not in roots:
                    roots.append(root)
                # a second, shorter ending can be stacked in Tamil
                for suffix2 in SUFFIXES:
                    if len(root) > len(suffix2) + 1 and root.endswith(suffix2):
                        root2 = root[: -len(suffix2)]
                        if root2 in self.word_set and root2 not in roots:
                            roots.append(root2)
        return roots

    def compound_split(self, word: str) -> list[dict]:
        """Find plausible two-part compounds, favouring frequent parts."""
        found: list[dict] = []
        if len(word) < 6:
            return found
        for i in range(3, len(word) - 2):
            left, right = word[:i], word[i:]
            if left in self.word_set and right in self.word_set:
                found.append(
                    {
                        "parts": [left, right],
                        "score": self.rank.get(left, 999999)
                        + self.rank.get(right, 999999),
                    }
                )
        found.sort(key=lambda item: item["score"])
        return found[:3]

    def family_forms(self, root: str, limit: int = 24) -> list[str]:
        candidates = {root}
        for suffix in FAMILY_SUFFIXES:
            candidates.add(root + suffix)
        # Common sandhi-style plural for stems ending in ம்.
        if root.endswith("ம்") and len(root) > 2:
            candidates.add(root[:-2] + "ங்கள்")
        return [
            word
            for word in sorted(candidates, key=lambda w: self.rank.get(w, 999999))
            if word in self.word_set and word != root
        ][:limit]

    def prefix_matches(self, prefix: str, limit: int = 12) -> list[str]:
        import bisect

        start = bisect.bisect_left(self.sorted_words, prefix)
        found: list[str] = []
        idx = start
        while idx < len(self.sorted_words) and self.sorted_words[idx].startswith(prefix):
            found.append(self.sorted_words[idx])
            idx += 1
            if len(found) >= 250:
                break
        found.sort(key=lambda w: self.rank.get(w, 999999))
        return found[:limit]

    def fuzzy(self, word: str, limit: int = 8, score_cutoff: float = 62) -> list[tuple[str, float]]:
        if not self.words:
            return []
        results = process.extract(
            word,
            self.words,
            scorer=fuzz.ratio,
            limit=max(limit * 3, limit),
            score_cutoff=score_cutoff,
        )
        return [(str(item[0]), float(item[1])) for item in results[:limit]]

    def frequency_label(self, word: str) -> dict:
        zipf = zipf_frequency(word, "ta")
        rank = self.rank.get(word)
        return {
            "zipf": round(float(zipf), 2),
            "rank": rank,
            "common": bool(zipf >= 3.5),
        }


_lock = threading.Lock()
_lexicon: Lexicon | None = None


def _load_json(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        logger.warning("Could not load %s: %s", path, exc)
        return {}


def _build_lexicon() -> Lexicon:
    logger.info("Building Tamil word index...")
    source_words = top_n_list("ta", 90000)
    words: list[str] = []
    seen: set[str] = set()
    rank: dict[str, int] = {}
    for word in source_words:
        if not is_tamil_word(word) or len(word) > 32:
            continue
        if word in seen:
            continue
        seen.add(word)
        words.append(word)
        rank[word] = len(rank)

    glossary = _load_json(DATA_DIR / "tamil_glossary.json")
    thesaurus = _load_json(DATA_DIR / "tamil_thesaurus.json")
    entries = glossary.get("entries", [])
    groups = thesaurus.get("groups", [])

    curated: Iterable[str] = []
    for entry in entries:
        curated = list(curated) + [entry.get("ta", "")] + entry.get("synonyms", [])
    for group in groups:
        curated = list(curated) + [group.get("ta", "")] + group.get("words", [])
    curated = list(curated) + list(COMMON_PARTICLES)

    for word in curated:
        word = (word or "").strip()
        if not is_tamil_word(word) or word in seen:
            continue
        seen.add(word)
        words.append(word)
        rank[word] = len(rank)

    extra_path = DATA_DIR / "extra_words.txt"
    if extra_path.exists():
        for line in extra_path.read_text(encoding="utf-8").splitlines():
            word = line.strip()
            if is_tamil_word(word) and word not in seen:
                seen.add(word)
                words.append(word)
                rank[word] = len(rank)

    lexicon = Lexicon(
        words=words,
        word_set=seen,
        rank=rank,
        glossary_entries=entries,
        categories=glossary.get("categories", {}),
        thesaurus_groups=groups,
    )
    logger.info("Tamil word index ready: %s words", len(words))
    return lexicon


def get_lexicon() -> Lexicon:
    global _lexicon
    if _lexicon is not None:
        return _lexicon
    with _lock:
        if _lexicon is None:
            _lexicon = _build_lexicon()
    return _lexicon


def lexicon_status() -> dict:
    try:
        lex = get_lexicon()
        return {"ready": True, "words": len(lex.words), "glossary": len(lex.glossary_entries)}
    except Exception as exc:
        return {"ready": False, "error": str(exc)}


def generate_confusion_variants(word: str) -> set[str]:
    variants: set[str] = set()
    for group in CONFUSION_GROUPS:
        for char in group:
            if char not in word:
                continue
            for replacement in group:
                if replacement == char:
                    continue
                variants.add(word.replace(char, replacement, 1))
    for group in VOWEL_SIGN_GROUPS:
        for char in group:
            if char not in word:
                continue
            for replacement in group:
                if replacement == char:
                    continue
                variants.add(word.replace(char, replacement, 1))
    if word.endswith("்"):
        variants.add(word[:-1])
    else:
        variants.add(word + "்")
    # Repeated consonant is a common typo: அமா -> அம்மா.
    for i in range(1, len(word)):
        if word[i] == word[i - 1] and word[i] not in " ாிீுூெேைொோௌ":
            variants.add(word[:i] + word[i + 1 :])
    # A missing doubled consonant next to a vowel is common in informal typing.
    for i in range(1, len(word)):
        if word[i] in "கசடதபறமயரலவழளன":
            variants.add(word[:i] + word[i] + word[i:])
    return variants


def edits_one(word: str) -> set[str]:
    variants = generate_confusion_variants(word)
    return {v for v in variants if v != word}
