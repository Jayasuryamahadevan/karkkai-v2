from __future__ import annotations

from datetime import date
from typing import Any

from server.services.lexicon import Lexicon, get_lexicon
from server.services.translation import translation_service
from server.utils import is_tamil_word, tamil_ratio


class WordService:
    def __init__(self) -> None:
        self.lexicon: Lexicon = get_lexicon()
        self._glossary_by_word: dict[str, dict] = {
            entry["ta"]: entry
            for entry in self.lexicon.glossary_entries
            if entry.get("ta")
        }
        self._english_index: list[tuple[str, dict]] = []
        for entry in self.lexicon.glossary_entries:
            for term in entry.get("en", []):
                self._english_index.append((term.lower(), entry))

    # ------------------------------------------------------------------ public
    def suggest(self, query: str, limit: int = 12) -> dict[str, Any]:
        query = (query or "").strip()
        limit = max(1, min(limit, 30))
        if not query:
            return {
                "query": "",
                "kind": "empty",
                "suggestions": [],
                "categories": self.lexicon.categories,
            }

        if not is_tamil_word(query) and tamil_ratio(query) < 0.1:
            return {
                "query": query,
                "kind": "english",
                "suggestions": self._search_english(query, limit),
                "categories": self.lexicon.categories,
            }

        suggestions: list[dict[str, Any]] = []
        seen: set[str] = set()

        # The exact word is useful when someone pastes a word to explore it.
        if query in self.lexicon.word_set:
            suggestions.append(self._make_entry(query, source="exact"))
            seen.add(query)

        for word in self.lexicon.prefix_matches(query, limit=limit):
            if word in seen:
                continue
            suggestions.append(self._make_entry(word, source="prefix"))
            seen.add(word)

        if len(suggestions) < min(limit, 6) and len(query) >= 2:
            for word, score in self.lexicon.fuzzy(query, limit=limit):
                if word in seen:
                    continue
                suggestions.append(
                    self._make_entry(word, source="similar", score=round(score, 1))
                )
                seen.add(word)

        return {
            "query": query,
            "kind": "tamil",
            "suggestions": suggestions[:limit],
            "categories": self.lexicon.categories,
        }

    def explore(self, query: str) -> dict[str, Any]:
        query = (query or "").strip()
        if not query:
            raise ValueError("Enter a Tamil or English word")

        if not is_tamil_word(query) and tamil_ratio(query) < 0.1:
            return self._explore_english(query)
        return self._explore_tamil(query)

    def random_word(self, category: str | None = None) -> dict[str, Any]:
        entries = self.lexicon.glossary_entries
        if category:
            entries = [e for e in entries if e.get("category") == category]
        if not entries:
            entries = self.lexicon.glossary_entries
        if not entries:
            return {}
        seed = date.today().toordinal()
        entry = entries[seed % len(entries)]
        return self._decorate_entry(dict(entry), source="word-of-the-day")

    def browse(self, category: str | None = None, limit: int = 40) -> list[dict[str, Any]]:
        entries = self.lexicon.glossary_entries
        if category:
            entries = [e for e in entries if e.get("category") == category]
        return [self._decorate_entry(dict(e), source="browse") for e in entries[:limit]]

    # ----------------------------------------------------------------- helpers
    def _make_entry(
        self, word: str, source: str = "word", score: float | None = None
    ) -> dict[str, Any]:
        entry = self._glossary_by_word.get(word)
        result: dict[str, Any] = {
            "ta": word,
            "en": entry.get("en", []) if entry else [],
            "category": entry.get("category") if entry else None,
            "synonyms": (entry.get("synonyms", []) if entry else [])[:5],
            "frequency": self.lexicon.frequency_label(word),
            "source": source,
        }
        if entry and entry.get("example"):
            result["example"] = entry["example"]
            result["example_en"] = entry.get("example_en")
        if score is not None:
            result["score"] = score
        return result

    def _decorate_entry(self, entry: dict[str, Any], source: str) -> dict[str, Any]:
        entry["source"] = source
        entry["frequency"] = self.lexicon.frequency_label(entry.get("ta", ""))
        return entry

    def _search_english(self, query: str, limit: int) -> list[dict[str, Any]]:
        q = query.lower().strip()
        matches: list[tuple[int, dict]] = []
        seen: set[str] = set()
        for term, entry in self._english_index:
            if term in seen:
                continue
            if term == q:
                rank = 0
            elif term.startswith(q):
                rank = 1
            elif q in term:
                rank = 2
            else:
                continue
            if entry["ta"] in {m[1]["ta"] for m in matches}:
                continue
            matches.append((rank, entry))
            seen.add(entry["ta"])

        results = []
        for _rank, entry in sorted(matches, key=lambda item: (item[0], item[1].get("category", ""), item[1]["ta"]))[:limit]:
            results.append(self._decorate_entry(dict(entry), source="glossary"))

        # Thesaurus concepts are searchable too.
        if len(results) < limit:
            for group in self.lexicon.thesaurus_groups:
                if q in group.get("en", "").lower() or group.get("ta", "").startswith(query):
                    for word in group.get("words", [])[:3]:
                        if any(result["ta"] == word for result in results):
                            continue
                        results.append(
                            {
                                "ta": word,
                                "en": [group.get("en", ""), "related word"],
                                "category": None,
                                "synonyms": [w for w in group.get("words", []) if w != word][:4],
                                "frequency": self.lexicon.frequency_label(word),
                                "source": "thesaurus",
                            }
                        )
                        if len(results) >= limit:
                            break
                if len(results) >= limit:
                    break
        return results[:limit]

    def _explore_tamil(self, word: str) -> dict[str, Any]:
        known = word in self.lexicon.word_set
        entry = self._glossary_by_word.get(word, {})
        roots = self.lexicon.morphological_roots(word)
        family: list[str] = []
        for root in roots:
            family.extend(self.lexicon.family_forms(root, limit=12))
        compounds = self.lexicon.compound_split(word)

        synonyms: list[str] = []
        related_concepts: list[dict[str, str]] = []
        for group in self.lexicon.thesaurus_groups:
            words = group.get("words", [])
            if word in words:
                synonyms.extend(w for w in words if w != word)
                related_concepts.append(
                    {"en": group.get("en", ""), "ta": group.get("ta", "")}
                )
        synonyms.extend(entry.get("synonyms", []))
        deduped_synonyms = []
        for synonym in synonyms:
            if synonym and synonym != word and synonym not in deduped_synonyms:
                deduped_synonyms.append(synonym)

        similar = [
            {"ta": candidate, "score": round(score, 1)}
            for candidate, score in self.lexicon.fuzzy(word, limit=6, score_cutoff=55)
            if candidate != word
        ]

        return {
            "query": word,
            "word": word,
            "kind": "tamil",
            "known": known,
            "gloss": entry.get("en", []),
            "category": entry.get("category"),
            "synonyms": deduped_synonyms[:12],
            "roots": roots,
            "family": list(dict.fromkeys(family))[:20],
            "compounds": [c["parts"] for c in compounds],
            "similar": similar,
            "related_concepts": related_concepts[:4],
            "example": entry.get("example"),
            "example_en": entry.get("example_en"),
            "frequency": self.lexicon.frequency_label(word),
            "source": "dictionary" if known else "loose",
        }

    def _explore_english(self, query: str) -> dict[str, Any]:
        matches = self._search_english(query, 8)
        if matches:
            best = matches[0]
            result = self._explore_tamil(best["ta"])
            result.update(
                {
                    "kind": "english",
                    "query": query,
                    "lookup": "glossary",
                    "alternatives": [
                        {
                            "ta": item["ta"],
                            "en": item.get("en", []),
                            "source": item.get("source"),
                        }
                        for item in matches[1:6]
                    ],
                }
            )
            return result

        # No local concept match: use the online translator as a word finder.
        translated = translation_service.translate(query, "en", "ta")
        ta_text = translated["translation"].strip()
        result = self._explore_tamil(ta_text)
        result.update(
            {
                "kind": "english",
                "query": query,
                "lookup": "online",
                "translation": ta_text,
                "engine": translated.get("engine_label"),
                "alternatives": [],
            }
        )
        return result


word_service = WordService()
