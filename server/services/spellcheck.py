from __future__ import annotations

import hashlib
import re
from typing import Any, Iterable

from rapidfuzz import fuzz

from server.services.lexicon import (
    COMMON_TYPOS,
    edits_one,
    get_lexicon,
    Lexicon,
)
from server.utils import is_tamil_word

TOKEN_RE = re.compile(r"[\u0B80-\u0BFF]+")


class SpellChecker:
    def check(self, text: str, extra_words: Iterable[str] | None = None) -> dict[str, Any]:
        text = text or ""
        lexicon = get_lexicon()
        extra = {w.strip() for w in (extra_words or []) if w and w.strip()}
        issues: list[dict[str, Any]] = []
        tokens = list(TOKEN_RE.finditer(text))
        seen_words: set[str] = set()

        for match in tokens:
            word = match.group(0)
            if len(word) <= 1:
                continue
            seen_words.add(word)
            if self._is_valid(word, lexicon, extra):
                continue
            suggestions = self._suggest(word, lexicon, extra)
            best = suggestions[0] if suggestions else None
            strong = bool(
                best
                and fuzz.ratio(word, best) >= 78
                and abs(len(word) - len(best)) <= 3
            )
            issues.append(
                {
                    "id": f"sp-{match.start()}",
                    "kind": "spelling",
                    "severity": "error" if strong else "review",
                    "word": word,
                    "start": match.start(),
                    "end": match.end(),
                    "suggestions": suggestions,
                    "message": (
                        f"Did you mean “{best}”?"
                        if strong and best
                        else "This word is not in the dictionary. Check the spelling or add it to your words."
                    ),
                }
            )

        issues.extend(self._repetitions(text, tokens))
        issues.extend(self._punct_spacing(text))
        issues.sort(key=lambda item: item.get("start", 0))
        issues = issues[:120]

        errors = sum(1 for issue in issues if issue["severity"] == "error")
        reviews = sum(1 for issue in issues if issue["severity"] == "review")
        style = sum(1 for issue in issues if issue["kind"] == "spacing")
        return {
            "issues": issues,
            "stats": {
                "characters": len(text),
                "words": len(tokens),
                "unique": len(seen_words),
                "errors": errors,
                "reviews": reviews,
                "style": style,
                "total": len(issues),
            },
            "lexicon_size": len(lexicon.words),
        }

    # ------------------------------------------------------------------ checks
    def _is_valid(self, word: str, lexicon: Lexicon, extra: set[str]) -> bool:
        if lexicon.is_known(word, extra):
            return True
        if word in COMMON_TYPOS:
            return False
        roots = lexicon.morphological_roots(word)
        if roots:
            # Only accept a root if it is reasonably established in the corpus.
            if any(lexicon.rank.get(root, 999999) < 70000 for root in roots):
                return True
        compounds = lexicon.compound_split(word)
        if compounds and any(
            lexicon.rank.get(part, 999999) < 60000
            for compound in compounds
            for part in compound["parts"]
        ):
            return True
        return False

    def _suggest(self, word: str, lexicon: Lexicon, extra: set[str]) -> list[str]:
        ranked: dict[str, float] = {}

        for correction in COMMON_TYPOS.get(word, []):
            if correction != word:
                ranked[correction] = max(ranked.get(correction, 0), 1000)

        for variant in edits_one(word):
            if variant in lexicon.word_set or variant in extra:
                score = 900 + fuzz.ratio(word, variant)
                ranked[variant] = max(ranked.get(variant, 0), score)

        for candidate, score in lexicon.fuzzy(word, limit=10, score_cutoff=60):
            if candidate == word:
                continue
            adjusted = score
            if candidate[:1] == word[:1]:
                adjusted += 4
            if abs(len(candidate) - len(word)) <= 1:
                adjusted += 3
            ranked[candidate] = max(ranked.get(candidate, 0), adjusted)

        # Prefer candidates that share a prefix, then score, then frequency.
        def sort_key(item: tuple[str, float]) -> tuple[float, int, int]:
            candidate, score = item
            prefix_bonus = 1 if candidate[:2] == word[:2] else 0
            return (score + prefix_bonus * 3, -abs(len(candidate) - len(word)), -lexicon.rank.get(candidate, 999999))

        return [
            candidate
            for candidate, _score in sorted(ranked.items(), key=sort_key, reverse=True)[:6]
        ]

    def _repetitions(
        self, text: str, tokens: list[re.Match]
    ) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        for previous, current in zip(tokens, tokens[1:]):
            if previous.group(0) == current.group(0):
                only_space = text[previous.end() : current.start()].strip() == ""
                if only_space:
                    issues.append(
                        {
                            "id": f"rep-{current.start()}",
                            "kind": "repetition",
                            "severity": "review",
                            "word": current.group(0),
                            "start": current.start(),
                            "end": current.end(),
                            "suggestions": [],
                            "message": "Repeated word — remove one copy if this was unintentional.",
                        }
                    )
        return issues

    def _punct_spacing(self, text: str) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        for match in re.finditer(r"[ \t]+([,.!?;:])", text):
            punct = match.group(1)
            issues.append(
                {
                    "id": f"space-{match.start()}",
                    "kind": "spacing",
                    "severity": "review",
                    "word": text[match.start() : match.end()],
                    "start": match.start(),
                    "end": match.end(),
                    "suggestions": [],
                    "fix": punct,
                    "message": f"Remove the space before “{punct}”.",
                }
            )
        for match in re.finditer(r"([,.!?;:])([^\s\d])", text):
            if match.group(1) in {".", ","} and match.group(2) in {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"}:
                continue
            issues.append(
                {
                    "id": f"nospace-{match.start()}",
                    "kind": "spacing",
                    "severity": "review",
                    "word": text[match.start() : match.end()],
                    "start": match.start() + 1,
                    "end": match.start() + 1,
                    "suggestions": [],
                    "fix": " ",
                    "message": "Add a space after punctuation.",
                }
            )
        return issues[:30]


spell_checker = SpellChecker()


def fingerprint_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
