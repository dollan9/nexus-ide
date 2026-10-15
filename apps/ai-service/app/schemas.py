"""Pydantic-modeller som speglar `@nexus/protocol` EXAKT.

Fältdefinierade i snake_case, serialiserade med camelCase-alias (pydantic
`alias_generator=to_camel`). FastAPI svarar med `by_alias=True`, så Node-laget kan
deserialisera direkt till `TranscriptResult` / `SpeakResult` / `VisionResult` /
`OcrBlock` / `RagChunk` / `RagStatus` utan namntranslation.

Undantaget: `/health`, eftersom den formen inte finns i protocol och är ett eget
kontrakt (se `docs` i huvudet på `main.py`).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Bas: accepterar både camelCase och snake_case, svarar alltid i camelCase."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
        str_strip_whitespace=True,
    )


# --------------------------------------------------------------------- förfrågningar
class TranscribeRequest(CamelModel):
    audio_base64: str = ""
    format: str = "wav"
    language: str = ""
    graceful: bool | None = None
    """Om sant: svarar 200 med text="" i stället för 503 när modellen saknas."""


class SpeakRequest(CamelModel):
    text: str = ""
    voice: str = ""
    format: Literal["wav", "mp3", "ogg"] = "wav"
    graceful: bool | None = None


class AnalyzeRequest(CamelModel):
    image_base64: str = ""
    image_path: str = ""
    prompt: str = ""
    target: Literal["screen", "window", "editor", "file"] = "file"
    graceful: bool | None = None


class OcrRequest(CamelModel):
    image_base64: str = ""
    image_path: str = ""
    target: Literal["screen", "window", "editor", "file"] = "file"
    min_confidence: float = 0.3
    graceful: bool | None = None


class ScreenshotRequest(CamelModel):
    monitor: int = 0
    window_title: str = ""
    target: Literal["screen", "window"] = "screen"


class WindowRequest(CamelModel):
    title_contains: str = ""


class EmbedRequest(CamelModel):
    texts: list[str] = Field(default_factory=list)
    model: str = ""


class RagIndexRequest(CamelModel):
    root: str = ""
    force: bool = False
    max_files: int = 0


class RagQueryRequest(CamelModel):
    query: str = ""
    k: int = 6


# --------------------------------------------------------------------- svar
class TranscriptSegment(CamelModel):
    start: int = Field(alias="from", serialization_alias="from")
    stop: int = Field(alias="to", serialization_alias="to")
    text: str = ""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class TranscriptResult(CamelModel):
    """`TranscriptResult` i @nexus/protocol (FAS 5.1)."""

    text: str = ""
    language: str = "sv"
    duration_ms: int = 0
    model: str = ""
    engine: str = ""
    latency_ms: int = 0
    segments: list[TranscriptSegment] = Field(default_factory=list)
    error: str | None = None


class SpeakResult(CamelModel):
    """`SpeakResult` — `engine` måste säga VILKEN motor som faktiskt gav bajten."""

    audio_base64: str | None = None
    url: str | None = None
    format: Literal["wav", "mp3", "ogg"] = "wav"
    engine: str = ""
    voice: str = ""
    bytes: int = 0
    latency_ms: int = 0
    error: str | None = None


class OcrBlock(CamelModel):
    text: str = ""
    confidence: float = 0.0
    box: tuple[int, int, int, int] = (0, 0, 0, 0)


class VisionResult(CamelModel):
    """`VisionResult` — engine ALDRIG vlm-* utan att en VLM faktiskt svarat."""

    text: str = ""
    engine: Literal["vlm-local", "vlm-cloud", "ocr", "stub"] = "stub"
    model: str = ""
    confidence: float = 0.0
    took_ms: int = 0
    blocks: list[OcrBlock] = Field(default_factory=list)
    note: str | None = None


class OcrResult(CamelModel):
    text: str = ""
    blocks: list[OcrBlock] = Field(default_factory=list)
    engine: str = "rapidocr"
    took_ms: int = 0
    error: str | None = None


class ScreenshotResult(CamelModel):
    png_base64: str = ""
    width: int = 0
    height: int = 0
    ts: int = 0
    target: str = "screen"
    bytes: int = 0
    display_id: str | None = None
    error: str | None = None


class WindowInfo(CamelModel):
    title: str = ""
    left: int = 0
    top: int = 0
    right: int = 0
    bottom: int = 0
    pid: int = 0


class WindowListResult(CamelModel):
    windows: list[WindowInfo] = Field(default_factory=list)
    engine: str = "win32"


class EmbedResult(CamelModel):
    vectors: list[list[float]] = Field(default_factory=list)
    dimensions: int = 0
    model: str = ""
    engine: str = ""
    took_ms: int = 0
    error: str | None = None


class RagChunk(CamelModel):
    id: str = ""
    path: str = ""
    start_line: int = 0
    end_line: int = 0
    text: str = ""
    score: float = 0.0
    symbol: str | None = None


class RagStatusResult(CamelModel):
    engine: Literal["chroma", "jsonl-fallback", "none"] = "none"
    indexed_files: int = 0
    chunks: int = 0
    embeddings_model: str = ""
    last_indexed_at: int | None = None
    indexing: bool = False
    error: str | None = None


class RagIndexResult(CamelModel):
    files: int = 0
    chunks: int = 0
    took_ms: int = 0
    engine: str = "none"
    error: str | None = None


class HealthGpu(CamelModel):
    name: str = "none"
    total_mb: int = 0
    used_mb: int = 0
    free_mb: int = 0
    detected_by: str = "unavailable"


class HealthResponse(BaseModel):
    """Eget kontrakt (finns ej i protocol). Avvikelse från camelCase är MEDVETEN:
    fälten är exakt som uppdraget kräver — `ram_free_mb`, `gpu.total_mb` osv.
    `engines`-mängden är kompatibel med `ServiceProbe.engines`."""

    ok: bool
    version: str
    engines: dict[str, str]
    models: dict[str, Any]
    gpu: dict[str, Any]
    ram_free_mb: int
    degraded: list[str]
    uptime_ms: int = 0
    pid: int = 0
    host: str = "127.0.0.1"
    port: int = 7955
    notes: list[str] = Field(default_factory=list)


class ErrorResponse(BaseModel):
    ok: Literal[False] = False
    reason: str = "engine-unavailable"
    engine: str = ""
    detail: str = ""
    endpoint: str = ""
    graceful_hint: str = (
        'Skicka {"graceful":true} i bodyn eller headern "X-Nexus-Graceful: 1" '
        "för att få 200 med tom text i stället för 503."
    )
