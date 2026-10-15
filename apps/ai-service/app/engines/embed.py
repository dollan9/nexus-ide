"""Embeddings (FAS 3.5 / R5): Ollama `nomic-embed-text` → lokal hash/TF-IDF.

RAG får aldrig krascha: om Ollama inte svarar används en deterministisk
lokal embedder (hashad bag-of-words med IDF-viktning, L2-normaliserad). Den är
plain— men stabil och testbar, och `engine`-fältet säger alltid vilken som råkade.
"""

from __future__ import annotations

import hashlib
import math
import threading
import time
from collections import Counter
from typing import Sequence

import httpx
import numpy as np

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..schemas import EmbedResult
from ..textutil import tokenize
from . import Availability, EngineUnavailable

log = get_logger("ai.embed")

_lock = threading.Lock()
_state = Availability(slot="embed", engine="ollama", model="")
_ollama_checked_at = 0.0
_ollama_ok: bool | None = None


def availability(settings: Settings | None = None) -> Availability:
    return _state


# --------------------------------------------------------------------- Ollama
def ollama_has_embedding_model(settings: Settings, model: str, *, ttl: float = 20.0) -> bool:
    global _ollama_checked_at, _ollama_ok
    now = time.monotonic()
    if _ollama_ok is not None and now - _ollama_checked_at < ttl:
        return _ollama_ok
    ok = False
    try:
        response = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=2.0)
        response.raise_for_status()
        names = [str(m.get("name", "")) for m in response.json().get("models", [])]
        wanted = model.split(":")[0]
        ok = any(name == model or name.split(":")[0] == wanted for name in names)
    except Exception as exc:  # noqa: BLE001
        log.info("Ollama-embeddings ej tillgängliga: %s", exc)
        ok = False
    with _lock:
        _ollama_checked_at = now
        _ollama_ok = ok
    return ok


def _ollama_embed(texts: Sequence[str], settings: Settings, model: str) -> list[list[float]]:
    vectors: list[list[float]] = []
    timeout = max(20.0, settings.http_timeout_s)
    for text in texts:
        try:
            response = httpx.post(
                f"{settings.ollama_base_url}/api/embeddings",
                json={"model": model, "prompt": text},
                timeout=timeout,
            )
            response.raise_for_status()
            raw = response.json().get("embedding") or []
        except Exception as exc:  # noqa: BLE001
            raise EngineUnavailable("ollama-embed-failed", f"{type(exc).__name__}: {exc}") from exc
        if not raw:
            raise EngineUnavailable("ollama-embed-empty", "tom vektor från Ollama")
        vectors.append([float(x) for x in raw])
    return vectors


# --------------------------------------------------------------------- lokal reserv
def _token_index(token: str, dim: int) -> int:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % dim


def local_embed(texts: Sequence[str], dim: int = 384) -> list[list[float]]:
    """Deterministisk hash/TF-IDF-embedder. Samma indata → samma vektorer."""
    docs = [Counter(tokenize(text)) for text in texts]
    n = max(1, len(docs))
    df: Counter[str] = Counter()
    for counts in docs:
        for token in counts:
            df[token] += 1
    vectors: list[list[float]] = []
    for counts in docs:
        vec = np.zeros(dim, dtype=np.float32)
        total = sum(counts.values()) or 1
        for token, occurrences in counts.items():
            tf = occurrences / total
            idf = math.log((n + 1) / (df[token] + 1)) + 1.0
            vec[_token_index(token, dim)] += tf * idf
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec = vec / norm
        vectors.append([round(float(x), 6) for x in vec])
    return vectors


# --------------------------------------------------------------------- ingång
def embed_texts(texts: Sequence[str], *, model: str = "", settings: Settings | None = None) -> EmbedResult:
    global _state
    cfg = settings or get_settings()
    if not texts:
        return EmbedResult(vectors=[], dimensions=0, model=model or cfg.embeddings_model,
                           engine="none", took_ms=0)
    started = time.perf_counter()
    wanted = model or cfg.embeddings_model
    notes: list[str] = []

    if ollama_has_embedding_model(cfg, wanted):
        try:
            vectors = _ollama_embed(texts, cfg, wanted)
            took = int((time.perf_counter() - started) * 1000)
            _state = Availability(slot="embed", engine="ollama", ready=True,
                                  probed=True, model=wanted, detail=f"{len(vectors)} vektorer")
            log.info("Embeddings: ollama/%s × %d (%d ms)", wanted, len(vectors), took)
            return EmbedResult(vectors=vectors, dimensions=len(vectors[0]), model=wanted,
                               engine="ollama", took_ms=took)
        except EngineUnavailable as exc:
            notes.append(f"ollama: {exc.detail}")
            log.warning("Ollama-embeddings felade: %s — faller tillbaka", exc.detail)
    else:
        notes.append("ollama: server svarar inte eller modellen finns inte")

    vectors = local_embed(texts, cfg.embed_dim_fallback)
    took = int((time.perf_counter() - started) * 1000)
    _state = Availability(
        slot="embed", engine="hash-tfidf-local", ready=True, probed=True,
        model=f"local-{cfg.embed_dim_fallback}", degraded=True,
        detail="Ollama ej tillgänglig — deterministisk lokal embedder",
        notes=notes,
    )
    log.info("Embeddings: lokal hash/TF-IDF × %d dim=%d (%d ms)", len(vectors), cfg.embed_dim_fallback, took)
    return EmbedResult(vectors=vectors, dimensions=cfg.embed_dim_fallback,
                       model="hash-tfidf-local", engine="hash-tfidf-local",
                       took_ms=took, error="; ".join(notes) if notes else None)


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    va, vb = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    if va.shape != vb.shape:
        vb = np.resize(vb, va.shape)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom <= 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


def reset_for_tests() -> None:
    global _state, _ollama_ok, _ollama_checked_at
    _state = Availability(slot="embed", engine="ollama", model="")
    _ollama_ok = None
    _ollama_checked_at = 0.0
