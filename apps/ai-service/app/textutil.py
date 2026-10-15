"""Textnormalisering för rösrunda-testet (FAS 5.4) och RAG-tokenisering.

Ett transkript från Whisper skiljer sig i skiljetecken, gemener/versaler och
utta-ljud från den talade strängen. Därför jämför vi på en normaliserad form.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")
_DIGITS = re.compile(r"\d+")

# Vanligaste ta-ljuds-neutraliseringarna för svenska (FAS 5.1 kräver språk "sv").
_SOUND_ALIKES: tuple[tuple[str, str], ...] = (
    ("ä", "e"),
    ("ö", "o"),
    ("å", "a"),
)

STOPWORDS = frozenset(
    {
        "the", "a", "an", "is", "are", "was", "were", "and", "or", "of", "to", "in",
        "for", "on", "with", "det", "den", "de", "att", "och", "är", "i", "på", "med",
        "till", "om", "en", "ett", "jag", "du", "vi", "har", "had", "have",
    }
)


def strip_accents(text: str) -> str:
    """NFKD + borttagning av kombinerande tecken: 'ä' → 'ae'? nej → 'a'."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_transcript(text: str, *, fold_nordic: bool = True) -> str:
    """Normaliserar ett transkript för jämförelse.

    Steg: gemener → accentborttag → (valfritt) ä/o/å-foldning → ta bort skiljetecken
    → kollapsa blanktecken. Returnerar alltid en sträng, aldrig None.
    """
    if not text:
        return ""
    out = strip_accents(text.lower())
    if fold_nordic:
        # efter strip_accents är ä→a, ö→o, å→a redan; foldningen fångar rester
        for src, dst in _SOUND_ALIKES:
            out = out.replace(src, dst)
    out = _PUNCT.sub(" ", out)
    out = _WS.sub(" ", out).strip()
    return out


def words(text: str) -> list[str]:
    """Ord i normaliserad form, utan stopwords och ensamma bokstäver."""
    return [w for w in normalize_transcript(text).split() if len(w) > 1 and w not in STOPWORDS]


def word_overlap(spoken: str, heard: str) -> float:
    """Andel av de talade orden som finns i transkriptet (0.0–1.0)."""
    expected = words(spoken)
    if not expected:
        return 0.0
    got = set(words(heard))
    hits = sum(1 for w in expected if w in got)
    return hits / len(expected)


def fuzzy_ratio(spoken: str, heard: str) -> float:
    """Sekvenslikhet mellan normaliserade strängar (0.0–1.0)."""
    a = normalize_transcript(spoken)
    b = normalize_transcript(heard)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def similarity(spoken: str, heard: str) -> float:
    """Bästa måttet: ordöverlapp eller fuzzy — det högsta värdet."""
    return max(word_overlap(spoken, heard), fuzzy_ratio(spoken, heard))


def tokenize(text: str) -> list[str]:
    """Lätta tokens för hash/TF-IDF-embeddern (R5-fallback)."""
    return [t for t in _WS.split(_PUNCT.sub(" ", strip_accents(text.lower()))) if t]
