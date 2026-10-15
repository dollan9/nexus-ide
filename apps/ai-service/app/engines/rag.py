"""RAG-lager (FAS 3.5, R5): ChromaDB primärt, inbyggt JSONL-index som reserv.

Om `chromadb` inte går att importera (eller dess inbyggda sqlite-version strular)
faller vi tillbaka till `jsonl-fallback`: ett JSONL-vectorlager med kosinus-likhet
i minnet. Inget av alternativen får krascha servern — `status()` rapporterar
`engine: "none"` plus feltext när inget fungerar.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..schemas import RagChunk, RagIndexResult, RagStatusResult
from . import Availability, EngineUnavailable
from . import embed as embed_engine
from .chunker import SourceChunk, chunk_id, chunk_source

log = get_logger("ai.rag")

SKIP_DIRS = {
    "node_modules", ".venv", "venv", ".git", "dist", "build", "out", "coverage",
    "__pycache__", ".nexus", ".next", ".turbo", "target", ".cache", ".pnpm-store",
    ".idea", ".vscode", "site-packages", ".mypy_cache", ".pytest_cache", "espeak-ng-data",
}
INDEX_SUFFIXES = {
    ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
    ".md", ".css", ".scss", ".html", ".yaml", ".yml", ".toml", ".sh", ".rs", ".go",
}
_lock = threading.Lock()
_state = Availability(slot="rag", engine="none")
_last_indexed_at: int = 0
_indexing = False


@dataclass
class _JsonlIndex:
    path: Path
    mtime: float = 0.0
    rows: list[dict[str, Any]] | None = None
    matrix: Any = None


_jsonl = _JsonlIndex(path=Path(""))


def availability(settings: Settings | None = None) -> Availability:
    return _state


# --------------------------------------------------------------------- chroma
def _chroma_client(settings: Settings) -> Any:
    """Import + PersistentClient, eller EngineUnavailable (anroparen väljer reserv)."""
    import chromadb  # type: ignore[import-not-found]

    settings.chroma_path.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(settings.chroma_path))


def _collection_name(root: Path) -> str:
    digest = hashlib.sha1(str(root).lower().encode("utf-8")).hexdigest()[:10]
    return f"nexus_code_{digest}"


def _try_chroma(settings: Settings) -> Any:
    try:
        return _chroma_client(settings)
    except Exception as exc:  # noqa: BLE001 - R5: ingen crash, bara reserv
        log.warning("ChromaDB kunde inte laddas (%s: %s) → jsonl-fallback", type(exc).__name__, exc)
        return None


# --------------------------------------------------------------------- filskanning
def iter_source_files(root: Path, *, max_bytes: int, max_files: int = 0) -> Iterable[Path]:
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".") and d.lower() not in SKIP_DIRS
        )
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.suffix.lower() not in INDEX_SUFFIXES:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size == 0 or size > max_bytes:
                continue
            yield path
            count += 1
            if max_files and count >= max_files:
                return


def _rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _chunk_file(path: Path, root: Path, settings: Settings) -> list[SourceChunk]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
    except OSError:
        return []
    rel = _rel(path, root)
    chunks = chunk_source(rel, text)
    return chunks[: settings.rag_max_chunks_per_file]


# --------------------------------------------------------------------- indexering
def index_root(
    root_str: str,
    *,
    force: bool = False,
    max_files: int = 0,
    settings: Settings | None = None,
) -> RagIndexResult:
    """Skannar rot → kod-medvetna chunkar → embeddings → lager. Returnerar räknare."""
    global _state, _last_indexed_at, _indexing
    cfg = settings or get_settings()
    started = time.perf_counter()
    root = Path(root_str or cfg.root).expanduser().resolve()
    if not root.is_dir():
        raise EngineUnavailable("rag-root-missing", f"rot finns inte: {root}")

    files_done = 0
    chunks: list[SourceChunk] = []
    _indexing = True
    try:
        for path in iter_source_files(root, max_bytes=cfg.rag_max_file_bytes, max_files=max_files):
            chunks.extend(_chunk_file(path, root, cfg))
            files_done += 1
        if not chunks:
            _state = Availability(slot="rag", engine=_state.engine, ready=_state.ready, probed=True,
                                  detail="inga filer att indexera")
            return RagIndexResult(files=0, chunks=0, took_ms=int((time.perf_counter() - started) * 1000),
                                  engine=_state.engine or "none", error="inga indexbara filer")

        vectors = embed_engine.embed_texts([c.text for c in chunks], settings=cfg).vectors
        engine_used = "chroma"
        client = _try_chroma(cfg) if not force else None
        if client is None:
            engine_used = "jsonl-fallback"

        if engine_used == "chroma":
            try:
                _store_chroma(client, cfg, root, chunks, vectors)
            except Exception as exc:  # noqa: BLE001
                log.warning("Chroma-lagring felade: %s → jsonl-fallback", exc)
                engine_used = "jsonl-fallback"
                _state = Availability(slot="rag", engine="jsonl-fallback", ready=True, probed=True,
                                      detail=f"chroma-lagring felade: {type(exc).__name__}: {exc}",
                                      degraded=True)
        if engine_used == "jsonl-fallback":
            _store_jsonl(cfg, root, chunks, vectors)
    finally:
        _indexing = False

    _last_indexed_at = int(time.time() * 1000)
    if _state.engine != "jsonl-fallback" or not _state.degraded:
        _state = Availability(
            slot="rag", engine=engine_used, ready=True, probed=True,
            model=embed_engine.availability(cfg).model or cfg.embeddings_model,
            detail=f"{files_done} filer, {len(chunks)} chunkar → {root.name}",
            degraded=(engine_used == "jsonl-fallback"),
            notes=list(_state.notes) if engine_used == "jsonl-fallback" else [],
        )
    took = int((time.perf_counter() - started) * 1000)
    log.info("RAG-index: %d filer, %d chunkar, motor=%s (%d ms)", files_done, len(chunks), engine_used, took)
    return RagIndexResult(files=files_done, chunks=len(chunks), took_ms=took, engine=engine_used)


def _documents(root: Path, chunks: list[SourceChunk], vectors: list[list[float]]) -> list[dict[str, Any]]:
    """Material för lagret. `path` är redan relativ rot-sökväg (från chunkandet)."""
    rows: list[dict[str, Any]] = []
    for chunk, vector in zip(chunks, vectors):
        rows.append(
            {
                "id": chunk_id(chunk.path, chunk.start_line, chunk.end_line, chunk.symbol),
                "path": chunk.path,
                "startLine": chunk.start_line,
                "endLine": chunk.end_line,
                "symbol": chunk.symbol or "",
                "text": chunk.text,
                "vector": [round(float(x), 6) for x in vector],
                "root": str(root),
                "language": chunk.language,
            }
        )
    return rows


def _store_chroma(client: Any, settings: Settings, root: Path, chunks: list[SourceChunk], vectors: list[list[float]]) -> None:
    name = _collection_name(root)
    try:
        client.delete_collection(name)
    except Exception:  # noqa: BLE001 - finns inte än, OK
        pass
    collection = client.get_or_create_collection(
        name=name, metadata={"hnsw:space": "cosine", "root": str(root)}
    )
    rows = _documents(root, chunks, vectors)
    batch = 120
    for start in range(0, len(rows), batch):
        part = rows[start : start + batch]
        collection.add(
            ids=[row["id"] for row in part],
            documents=[row["text"] for row in part],
            embeddings=[row["vector"] for row in part],
            metadatas=[
                {
                    "path": row["path"], "startLine": row["startLine"], "endLine": row["endLine"],
                    "symbol": row["symbol"], "root": row["root"], "language": row["language"],
                }
                for row in part
            ],
        )
    settings.nexus_dir.mkdir(parents=True, exist_ok=True)
    _write_meta(settings, engine="chroma", root=root, files=len({row["path"] for row in rows}), chunks=len(rows))


def _store_jsonl(settings: Settings, root: Path, chunks: list[SourceChunk], vectors: list[list[float]]) -> None:
    path = settings.rag_jsonl_path
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = _documents(root, chunks, vectors)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(path)
    global _jsonl
    _jsonl = _JsonlIndex(path=path)
    _load_jsonl(force=True)
    _write_meta(settings, engine="jsonl-fallback", root=root, files=len({row["path"] for row in rows}), chunks=len(rows))


def _write_meta(settings: Settings, *, engine: str, root: Path, files: int, chunks: int) -> None:
    meta = settings.nexus_dir / "rag" / "meta.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "engine": engine,
        "root": str(root),
        "files": files,
        "chunks": chunks,
        "at": int(time.time() * 1000),
        "embeddingsModel": embed_engine.availability(settings).model,
    }
    meta.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_meta(settings: Settings) -> dict[str, Any]:
    meta = settings.nexus_dir / "rag" / "meta.json"
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


# --------------------------------------------------------------------- läsning
def _load_jsonl(*, force: bool = False) -> _JsonlIndex:
    global _jsonl
    path = _jsonl.path
    if not path or not path.is_file():
        return _jsonl
    mtime = path.stat().st_mtime
    if not force and _jsonl.rows is not None and abs(mtime - _jsonl.mtime) < 1e-6:
        return _jsonl
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    matrix = np.asarray([row.get("vector", []) for row in rows], dtype=np.float32) if rows else None
    if matrix is not None and matrix.ndim == 2 and matrix.shape[0]:
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        matrix = matrix / np.where(norms == 0, 1.0, norms)
    _jsonl = _JsonlIndex(path=path, mtime=mtime, rows=rows, matrix=matrix)
    return _jsonl


def query(text: str, k: int = 6, *, settings: Settings | None = None, root: str = "") -> list[RagChunk]:
    cfg = settings or get_settings()
    if not text.strip():
        return []
    engine = _resolve_engine(cfg)
    if engine == "none":
        return []
    vectors = embed_engine.embed_texts([text], settings=cfg).vectors
    if not vectors:
        return []
    qvec = np.asarray(vectors[0], dtype=np.float32)
    norm = float(np.linalg.norm(qvec))
    if norm > 0:
        qvec = qvec / norm

    limit = max(1, min(int(k or 6), 50))
    if engine == "chroma":
        return _query_chroma(cfg, qvec, limit, root)
    return _query_jsonl(cfg, qvec, limit, root)


def _resolve_engine(cfg: Settings) -> str:
    """Vad lagret faktiskt använder just nu — sanning, inte env-förhoppning."""
    if _state.probed and _state.engine in ("chroma", "jsonl-fallback"):
        return _state.engine
    meta = _read_meta(cfg)
    if meta.get("engine") == "jsonl-fallback" and cfg.rag_jsonl_path.is_file():
        _state.engine = "jsonl-fallback"
        _state.ready = True
        _state.probed = True
        _state.degraded = True
        return "jsonl-fallback"
    if cfg.chroma_path.is_dir() and any(cfg.chroma_path.iterdir()):
        if _try_chroma(cfg) is not None:
            _state.engine = "chroma"
            _state.ready = True
            _state.probed = True
            return "chroma"
    if cfg.rag_jsonl_path.is_file():
        _state.engine = "jsonl-fallback"
        _state.ready = True
        _state.probed = True
        _state.degraded = True
        return "jsonl-fallback"
    _state.engine = "none"
    _state.probed = True
    return "none"


def _chunk_from(row: dict[str, Any], score: float) -> RagChunk:
    return RagChunk(
        id=str(row.get("id", "")),
        path=str(row.get("path", "")),
        start_line=int(row.get("startLine", 0) or 0),
        end_line=int(row.get("endLine", 0) or 0),
        text=str(row.get("text", "")),
        score=round(float(score), 5),
        symbol=str(row.get("symbol", "") or "") or None,
    )


def _query_chroma(cfg: Settings, qvec: np.ndarray, limit: int, root: str) -> list[RagChunk]:
    client = _try_chroma(cfg)
    if client is None:
        return _query_jsonl(cfg, qvec, limit, root)
    try:
        collections = client.list_collections()
        wanted = [_collection_name(Path(root))] if root else None
        names = []
        for entry in collections:
            name = getattr(entry, "name", entry)
            names.append(str(name))
        targets = wanted if wanted and wanted[0] in names else names
        out: list[RagChunk] = []
        for name in targets:
            collection = client.get_collection(name=name)
            if collection.count() == 0:
                continue
            result = collection.query(
                query_embeddings=[[float(x) for x in qvec]],
                n_results=min(limit, collection.count()),
                include=["documents", "metadatas", "distances"],
            )
            metas = (result.get("metadatas") or [[]])[0]
            docs = (result.get("documents") or [[]])[0]
            dists = (result.get("distances") or [[]])[0]
            ids = (result.get("ids") or [[]])[0]
            for index, meta in enumerate(metas):
                distance = float(dists[index]) if index < len(dists) else 1.0
                row = dict(meta or {})
                row["id"] = ids[index] if index < len(ids) else row.get("id", "")
                row["text"] = docs[index] if index < len(docs) else row.get("text", "")
                out.append(_chunk_from(row, 1.0 - distance))
        out.sort(key=lambda chunk: chunk.score, reverse=True)
        return out[:limit]
    except Exception as exc:  # noqa: BLE001
        log.warning("Chroma-fråga felade: %s → jsonl", exc)
        return _query_jsonl(cfg, qvec, limit, root)


def _query_jsonl(cfg: Settings, qvec: np.ndarray, limit: int, root: str) -> list[RagChunk]:
    index = _load_jsonl(force=cfg.rag_jsonl_path.is_file())
    if index.rows is None or index.matrix is None:
        return []
    matrix = index.matrix
    if matrix.shape[1] != qvec.shape[0]:
        # dimensionerna skiljer sig (motor har bytts): kör ord-baserad relevans i stället
        return _lexical_fallback(index.rows, qvec, limit, root)
    scores = matrix @ qvec
    order = np.argsort(-scores)[:limit]
    out: list[RagChunk] = []
    for position in order:
        row = index.rows[int(position)]
        if root and str(row.get("root", "")) != str(Path(root)) :
            continue
        out.append(_chunk_from(row, float(scores[int(position)])))
    return out[:limit]


def _lexical_fallback(rows: list[dict[str, Any]], query_text: str, limit: int, root: str) -> list[RagChunk]:
    """Dimension-mismatch (motor byte mellom lagring och fråga): ordöverlapp räcker."""
    from ..textutil import words as content_words

    needle = set(content_words(query_text))
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        if root and str(row.get("root", "")) != str(Path(root)):
            continue
        tokens = set(content_words(str(row.get("text", ""))))
        if not tokens or not needle:
            continue
        overlap = len(needle & tokens) / len(needle)
        if overlap > 0:
            scored.append((overlap, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [_chunk_from(row, score) for score, row in scored[:limit]]


def status(settings: Settings | None = None) -> RagStatusResult:
    cfg = settings or get_settings()
    engine = _resolve_engine(cfg)
    meta = _read_meta(cfg)
    files = int(meta.get("files", 0) or 0)
    chunks = int(meta.get("chunks", 0) or 0)
    if engine == "jsonl-fallback":
        index = _load_jsonl(force=True)
        if index.rows:
            chunks = len(index.rows)
            files = len({row.get("path") for row in index.rows})
    return RagStatusResult(
        engine=engine,  # type: ignore[arg-type]
        indexed_files=files,
        chunks=chunks,
        embeddings_model=str(meta.get("embeddingsModel") or embed_engine.availability(cfg).model or cfg.embeddings_model),
        last_indexed_at=int(meta.get("at") or _last_indexed_at) or None,
        indexing=_indexing,
        error=_state.detail if engine == "none" else None,
    )


def reset_for_tests(settings: Settings | None = None) -> None:
    global _state, _jsonl, _last_indexed_at, _indexing
    cfg = settings or get_settings()
    _state = Availability(slot="rag", engine="none")
    _jsonl = _JsonlIndex(path=cfg.rag_jsonl_path)
    _last_indexed_at = 0
    _indexing = False
