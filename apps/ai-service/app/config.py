"""Konfiguration för ai-service: miljövariabler + `.env` (R2: aldrig hårdkodade nycklar).

Läsordning (senast vinner):
  1. `nexus-ide/.env.example`  — bara ofarliga inställningar (hamnar ej i git som hemlighet)
  2. `nexus-ide/.env`          — användarens riktiga värden/nycklar
  3. `os.environ`              — processmiljön har sista ordet, så skript kan köra över

`Settings` är oföränderlig och byggs en gång i `get_settings()`; `reload_settings()`
används av testerna.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

_TRUE_VALUES = {"1", "true", "yes", "on", "sannt", "sant"}
_FALSE_VALUES = {"0", "false", "no", "off", "falskt", "fejl"}


def parse_bool(raw: str | bool | None, default: bool = False) -> bool:
    """Tolkar strängar ur miljöfil på ett trögt, förutsägbart sätt."""
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    value = str(raw).strip().lower()
    if not value:
        return default
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    return default


def parse_int(raw: str | int | None, default: int = 0) -> int:
    """Intograsion som aldrig kastar: '12.5' → 12, 'abc' → default, None → default."""
    if raw is None:
        return default
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int):
        return raw
    text = str(raw).strip().replace("_", "")
    if not text:
        return default
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return int(float(text))
    except ValueError:
        return default


def parse_float(raw: str | float | None, default: float = 0.0) -> float:
    if raw is None:
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def repo_root() -> Path:
    """Roten för nexus-ide-repot: .../nexus-ide (förbi apps/ai-service)."""
    here = Path(__file__).resolve()
    return here.parents[2]


@dataclass(frozen=True)
class Settings:
    """Allt ai-service läser utifrån. Inget hemligt värde loggas någonsin."""

    host: str = "127.0.0.1"
    port: int = 7955
    log_level: str = "info"

    # --- STT (FAS 5.1) ---
    whisper_model: str = "base"
    whisper_device: str = "auto"          # auto | cuda | cpu
    whisper_compute: str = "auto"         # auto | float16 | int8 | float32
    whisper_language: str = "sv"
    whisper_threads: int = 0              # 0 = CTranslate2 väljer
    # Minsta fria VRAM (MB) för att våga ladda Whisper på GPU.
    whisper_min_free_vram_mb: int = 1800

    # --- TTS (FAS 5.2) ---
    tts_engine: str = "piper"             # önskad-first; kedjan provas ändå
    piper_voice: str = "en_US-lessac-medium"
    piper_voice_dir: str = ""             # "" => <repo>/.nexus/piper-voices
    edge_tts_voice: str = "sv-SE-SofieNeural"

    # --- Vision / OCR (FAS 6) ---
    ocr_engine: str = "rapidocr"
    vision_model: str = "llava:13b"
    vision_models: tuple[str, ...] = ("llava:13b", "qwen2.5vl:7b")
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_vision_model: str = "microsoft/llava-v1.6-mistral-7b-hf"
    default_prompt: str = (
        "Beskriv exakt vad skärmen visar: kod, felmeddelanden, UI"
    )

    # --- Embeddings / RAG (FAS 3.5) ---
    embeddings_model: str = "nomic-embed-text"
    embed_dim_fallback: int = 384
    ollama_base_url: str = "http://127.0.0.1:11434"
    chroma_dir: str = ""                  # "" => <repo>/.nexus/chroma
    rag_max_file_bytes: int = 400_000
    rag_max_chunks_per_file: int = 200

    # --- Beteende ---
    graceful_default: bool = False        # /transcribe m.fl.: 503 som standard
    http_timeout_s: float = 25.0
    request_max_bytes: int = 24_000_000   # tak för base64-bod (≈18 MB binärt)

    root: Path = field(default_factory=repo_root)

    # ------------------------------------------------------------- härledda sökväger
    @property
    def nexus_dir(self) -> Path:
        return self.root / ".nexus"

    @property
    def chroma_path(self) -> Path:
        return Path(self.chroma_dir) if self.chroma_dir else self.nexus_dir / "chroma"

    @property
    def piper_path(self) -> Path:
        return Path(self.piper_voice_dir) if self.piper_voice_dir else self.nexus_dir / "piper-voices"

    @property
    def rag_jsonl_path(self) -> Path:
        return self.nexus_dir / "rag" / "index.jsonl"

    @property
    def log_path(self) -> Path:
        return self.root / "apps" / "ai-service" / "ai-service.log"

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def secret_present(self, name: str) -> bool:
        """Sandhet (R2): returnerar ENDAST om en nyckel är satt, aldrig värdet."""
        return bool(_lookup(os.environ, name))


# ----------------------------------------------------------------- miljöinläsning
def _read_env_file(path: Path) -> dict[str, str]:
    """Enkel .env-läsare (ingen beroenderisk om python-dotenv saknas).

    Stödjer `NYCKEL=värde`, `export NYCKEL=värde`, kommentarer med # och citattecken.
    """
    out: dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in raw.splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        if text.startswith("export "):
            text = text[len("export ") :].strip()
        key, _, value = text.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        # ta bort radkommentar utanför citat
        if value and value[0] not in {'"', "'"}:
            value = value.split(" #", 1)[0].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        out[key] = value
    return out


def _lookup(mapping: Mapping[str, str], name: str) -> str | None:
    value = mapping.get(name)
    return value if value not in (None, "") else None


def build_settings(env: Mapping[str, str] | None = None, *, root: Path | None = None) -> Settings:
    """Bygger Settings från (i ordning): .env.example, .env, processmiljön."""
    base = repo_root() if root is None else root
    layers: dict[str, str] = {}
    for name in (".env.example", ".env"):
        layers.update(_read_env_file(base / name))
    try:  # python-dotenv är valfritt; vår egen läsare ovan räcker
        from dotenv import dotenv_values  # type: ignore[import-not-found]

        for name in (".env.example", ".env"):
            candidate = base / name
            if candidate.is_file():
                for key, value in dotenv_values(candidate).items():
                    if value is not None:
                        layers[key] = value
    except Exception:  # noqa: BLE001 - degradation, aldrig krasch (R5)
        pass
    if env is not None:
        layers.update({k: v for k, v in env.items() if v is not None})

    get = lambda name, default=None: _lookup(layers, name) or default  # noqa: E731

    vision_list: tuple[str, ...] = ()
    raw_models = get("NEXUS_VISION_MODELS")
    if raw_models:
        vision_list = tuple(x.strip() for x in raw_models.split(",") if x.strip())

    kwargs: dict[str, Any] = {
        "host": get("AI_SERVICE_HOST", "127.0.0.1"),
        "port": parse_int(get("AI_SERVICE_PORT"), 7955),
        "log_level": get("LOG_LEVEL", "info"),
        "whisper_model": get("WHISPER_MODEL", "base"),
        "whisper_device": get("WHISPER_DEVICE", "auto"),
        "whisper_compute": get("WHISPER_COMPUTE", "auto"),
        "whisper_language": get("WHISPER_LANGUAGE", "sv"),
        "whisper_threads": parse_int(get("WHISPER_THREADS"), 0),
        "whisper_min_free_vram_mb": parse_int(get("WHISPER_MIN_FREE_VRAM_MB"), 1800),
        "tts_engine": get("TTS_ENGINE", "piper"),
        "piper_voice": get("PIPER_VOICE", "en_US-lessac-medium"),
        "piper_voice_dir": get("PIPER_VOICE_DIR", ""),
        "edge_tts_voice": get("EDGE_TTS_VOICE", "sv-SE-SofieNeural"),
        "ocr_engine": get("OCR_ENGINE", "rapidocr"),
        "vision_model": get("VISION_MODEL", "llava:13b"),
        "nvidia_base_url": get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
        "nvidia_vision_model": get("NVIDIA_VISION_MODEL", "microsoft/llava-v1.6-mistral-7b-hf"),
        "default_prompt": get("NEXUS_VISION_PROMPT", Settings.default_prompt),
        "embeddings_model": get("EMBEDDINGS_MODEL", "nomic-embed-text"),
        "ollama_base_url": get("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        "chroma_dir": get("NEXUS_CHROMA_DIR", ""),
        "rag_max_file_bytes": parse_int(get("RAG_MAX_FILE_BYTES"), 400_000),
        "rag_max_chunks_per_file": parse_int(get("RAG_MAX_CHUNKS_PER_FILE"), 200),
        "graceful_default": parse_bool(get("AI_SERVICE_GRACEFUL"), False),
        "http_timeout_s": parse_float(get("AI_SERVICE_HTTP_TIMEOUT_S"), 25.0),
        "root": base,
    }
    if vision_list:
        kwargs["vision_models"] = vision_list
    else:
        primary = kwargs["vision_model"]
        extras = tuple(m for m in Settings.vision_models if m != primary)
        kwargs["vision_models"] = (primary, *extras)
    return Settings(**kwargs)


_SETTINGS: Settings | None = None


def get_settings() -> Settings:
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = build_settings(os.environ)
    return _SETTINGS


def reload_settings(env: Mapping[str, str] | None = None, *, root: Path | None = None) -> Settings:
    """Testhook: byggs om från ett givet miljö- snapshot."""
    global _SETTINGS
    merged: dict[str, str] = dict(os.environ)
    if env:
        merged.update(env)
    _SETTINGS = build_settings(merged, root=root)
    return _SETTINGS
