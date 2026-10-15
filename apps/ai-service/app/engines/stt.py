"""STT med faster-whisper (FAS 5.1).

Enhetsval (auto): GPU `cuda`/`float16` bara om fri VRAM faktiskt räcker till
modellen, annars `cpu`/`int8`. Valet loggas och rapporteras i `/health`.
Svenska (`language="sv"`) måste fungera — Whisper-stödet är per-segment.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..media import DecodedAudio, decode_to_wav
from ..schemas import TranscriptResult, TranscriptSegment
from . import Availability, EngineUnavailable

log = get_logger("ai.stt")

# Grov VRAM-budget per CT2-modell (MB) för float16 — konservativ, fri VRAM måste
# överstiga detta för att vi ska våga ligga på GPU:n.
VRAM_BUDGET_MB: dict[str, int] = {
    "tiny": 700,
    "tiny.en": 700,
    "base": 1000,
    "base.en": 1000,
    "small": 2000,
    "small.en": 2000,
    "medium": 4000,
    "medium.en": 4000,
    "large-v3": 6500,
    "large-v2": 6500,
    "distil-large-v3": 3200,
}

_lock = threading.Lock()
_model: Any = None
_state: Availability = Availability(slot="stt", engine="faster-whisper", model="")


def availability(settings: Settings | None = None) -> Availability:
    return _state


def choose_device(settings: Settings, *, gpu_free_mb: int, has_nvidia: bool) -> tuple[str, str, str]:
    """Returnerar (device, compute_type, motivering). Ren function — testbar."""
    device = (settings.whisper_device or "auto").lower()
    compute = (settings.whisper_compute or "auto").lower()
    budget = VRAM_BUDGET_MB.get(settings.whisper_model, 1200)

    if device == "cpu":
        return "cpu", (compute if compute in {"int8", "float32", "int8_float32"} else "int8"), "WHISPER_DEVICE=cpu (manuellt)"
    if device == "cuda":
        if not has_nvidia:
            raise EngineUnavailable("gpu-unavailable", "WHISPER_DEVICE=cuda men ingen nvidia-smi")
        return "cuda", (compute if compute and compute != "auto" else "float16"), "WHISPER_DEVICE=cuda (manuellt)"

    # auto
    if has_nvidia and gpu_free_mb >= max(budget, settings.whisper_min_free_vram_mb):
        return "cuda", "float16", f"auto: fri VRAM {gpu_free_mb} MB >= budget {budget} MB"
    reason = (
        f"auto: cpu/int8 (fri VRAM {gpu_free_mb} MB, budget {budget} MB, nvidia={has_nvidia})"
    )
    return "cpu", "int8", reason


def _ensure(settings: Settings) -> Any:
    global _model, _state
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except Exception as exc:  # noqa: BLE001
            _state = Availability(
                slot="stt", engine="unavailable", ready=False, probed=True,
                model=settings.whisper_model,
                detail=f"import felade: {type(exc).__name__}: {exc}", degraded=True,
            )
            log.warning("faster-whisper kunde inte importeras: %s", exc)
            raise EngineUnavailable("stt-dependency-missing", f"{type(exc).__name__}: {exc}") from exc

        from ..sysinfo import probe_gpu

        gpu = probe_gpu()
        device, compute, why = choose_device(settings, gpu_free_mb=gpu.free_mb, has_nvidia=gpu.detected_by == "nvidia-smi")
        log.info("Laddar Whisper-modell %s → %s", settings.whisper_model, why)
        try:
            model = WhisperModel(
                settings.whisper_model,
                device=device,
                compute_type=compute,
                cpu_threads=settings.whisper_threads or 0,
            )
        except Exception as exc:  # noqa: BLE001 - vikter saknas / OOM / nät av
            _state = Availability(
                slot="stt", engine="unavailable", ready=False, probed=True,
                model=settings.whisper_model,
                detail=f"{type(exc).__name__}: {exc}", degraded=True,
                notes=[f"device-försök: {device}/{compute}"],
            )
            log.warning("Whisper-modellen kunde inte laddas (%s/%s): %s", device, compute, exc)
            raise EngineUnavailable(
                "stt-model-unavailable",
                f"{type(exc).__name__}: {exc}",
                engine="faster-whisper",
            ) from exc

        _model = model
        _state = Availability(
            slot="stt", engine="faster-whisper", ready=True, probed=True,
            model=settings.whisper_model,
            detail=f"{device}/{compute} — {why}",
            degraded=(device != "cuda"),
            notes=[f"gpu: {gpu.name} fri {gpu.free_mb} MB"],
        )
        log.info("Whisper laddad: %s på %s/%s", settings.whisper_model, device, compute)
    return _model


def transcribe(
    audio: DecodedAudio | bytes,
    *,
    language: str = "",
    settings: Settings | None = None,
    source_format: str = "wav",
) -> TranscriptResult:
    """Returnerar `TranscriptResult` (camelCase i JSON). Kastas via EngineUnavailable."""
    cfg = settings or get_settings()
    started = time.perf_counter()

    if isinstance(audio, bytes):
        decoded = decode_to_wav(audio, source_format)
    else:
        decoded = audio

    model = _ensure(cfg)
    lang = (language or cfg.whisper_language or "").strip() or None

    with _decode_tmp(decoded) as path:
        try:
            segments, info = model.transcribe(
                str(path),
                language=lang,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            collected = []
            for segment in segments:
                collected.append(
                    TranscriptSegment(
                        start=int(segment.start * 1000),
                        stop=int(segment.end * 1000),
                        text=(segment.text or "").strip(),
                    )
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("Whisper-transkribering felade: %s", exc)
            raise EngineUnavailable("stt-inference-failed", f"{type(exc).__name__}: {exc}") from exc

    text = " ".join(s.text for s in collected).strip()
    latency = int((time.perf_counter() - started) * 1000)
    log.info(
        "Transkriberad %d ms ljud → %d tecken (språk %s, tid %d ms)",
        decoded.duration_ms, len(text), getattr(info, "language", lang or "?"), latency,
    )
    return TranscriptResult(
        text=text,
        language=str(getattr(info, "language", lang or cfg.whisper_language)),
        duration_ms=decoded.duration_ms,
        model=cfg.whisper_model,
        engine="faster-whisper",
        latency_ms=latency,
        segments=collected,
    )


class _decode_tmp:
    """Skriver WAV till temp-fil (Whisper vill ha sökväg) och städar efter sig."""

    def __init__(self, decoded: DecodedAudio) -> None:
        self._decoded = decoded
        self._path: Any = None

    def __enter__(self) -> Any:
        import tempfile
        from pathlib import Path

        fd, name = tempfile.mkstemp(prefix="nexus-asr-", suffix=".wav")
        import os

        os.close(fd)
        self._path = Path(name)
        self._path.write_bytes(self._decoded.wav)
        return self._path

    def __exit__(self, *exc: object) -> bool:
        import contextlib
        import os

        if self._path is not None:
            with contextlib.suppress(OSError):
                os.unlink(self._path)
        return False


def reset_for_tests() -> None:
    """Testhook: glöm modell och tillstånd (ingen ny nedladdning i enhetstester)."""
    global _model, _state
    _model = None
    _state = Availability(slot="stt", engine="faster-whisper", model="")
