"""Vision (FAS 6.2): lokal VLM → NVIDIA NIM → RapidOCR → stub.

Äkthetsregel (CONVENTIONS): `engine` sätts ALDRIG till `vlm-*` utan att en
verklig VLM svarat. Utan Ollama-modell och utan `NVIDIA_API_KEY` är svaret
`ocr` (textdump) eller `stub` (inget) — aldrig ett påhittat VLM-svar.
"""

from __future__ import annotations

import base64
import time
from typing import Any

import httpx

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..schemas import OcrBlock, VisionResult
from . import Availability, EngineUnavailable
from . import ocr as ocr_engine

log = get_logger("ai.vision")

_state = Availability(slot="vlm", engine="none", ready=False)
_ollama_models_cache: tuple[float, list[str]] = (0.0, [])


def availability(settings: Settings | None = None) -> Availability:
    return _state


def _image_payload(image_base64: str, image_path: str) -> str:
    if image_base64:
        text = image_base64
        if text.startswith("data:") and "," in text:
            text = text.split(",", 1)[1]
        return "".join(text.split())
    if image_path:
        from pathlib import Path

        return base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
    raise EngineUnavailable("no-image", "varken imageBase64 eller imagePath angavs")


# --------------------------------------------------------------------- Ollama (prioritet 1)
def ollama_running(settings: Settings, *, timeout: float = 2.0) -> bool:
    try:
        response = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=timeout)
        return response.status_code == 200
    except Exception:  # noqa: BLE001 - ingen server = normal nedbrytning
        return False


def ollama_models(settings: Settings, *, ttl: float = 15.0) -> list[str]:
    global _ollama_models_cache
    now = time.monotonic()
    cached_at, cached = _ollama_models_cache
    if now - cached_at < ttl:
        return cached
    names: list[str] = []
    try:
        response = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=3.0)
        response.raise_for_status()
        for entry in response.json().get("models", []):
            name = str(entry.get("name", ""))
            if name:
                names.append(name)
    except Exception as exc:  # noqa: BLE001
        log.info("Ollama-modellista kunde inte hämtas: %s", exc)
    _ollama_models_cache = (now, names)
    return names


def _pick_vision_model(settings: Settings) -> str:
    """Första kandidaten ur env/standardlistan som faktiskt finns lokalt."""
    installed = ollama_models(settings)
    if not installed:
        return ""
    for candidate in settings.vision_models:
        base = candidate.split(":")[0]
        for name in installed:
            if name == candidate or name.split(":")[0] == base:
                return name
    # sista chansen: en installerad modell med vision-ledtråd
    for name in installed:
        if any(hint in name.lower() for hint in ("llava", "qwen2.5vl", "vision", "minicpm-v")):
            return name
    return ""


def _ask_ollama(image: str, prompt: str, settings: Settings) -> tuple[str, str]:
    model = _pick_vision_model(settings)
    if not model:
        raise EngineUnavailable(
            "vlm-local-missing",
            f"Ollama saknar vision-modell (kandidater: {', '.join(settings.vision_models)})",
        )
    payload = {"model": model, "prompt": prompt, "images": [image], "stream": False}
    try:
        response = httpx.post(
            f"{settings.ollama_base_url}/api/generate", json=payload,
            timeout=max(30.0, settings.http_timeout_s * 4),
        )
        response.raise_for_status()
        data: dict[str, Any] = response.json()
    except Exception as exc:  # noqa: BLE001
        raise EngineUnavailable("vlm-local-failed", f"{type(exc).__name__}: {exc}") from exc
    text = str(data.get("response", "")).strip()
    if not text:
        raise EngineUnavailable("vlm-local-empty", "Ollama svarade utan text")
    return text, model


# --------------------------------------------------------------------- NVIDIA NIM (prioritet 2)
def _ask_nvidia(image: str, prompt: str, settings: Settings) -> tuple[str, str]:
    key = ""
    import os

    key = os.environ.get("NVIDIA_API_KEY", "") or ""
    if not key:
        raise EngineUnavailable("vlm-cloud-no-key", "NVIDIA_API_KEY är inte satt")
    body = {
        "model": settings.nvidia_vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image}"}},
                ],
            }
        ],
        "max_tokens": 1024,
        "temperature": 0.2,
    }
    try:
        response = httpx.post(
            f"{settings.nvidia_base_url}/chat/completions",
            json=body,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            timeout=max(30.0, settings.http_timeout_s * 3),
        )
        response.raise_for_status()
        data = response.json()
        text = str(data["choices"][0]["message"]["content"]).strip()
    except Exception as exc:  # noqa: BLE001
        raise EngineUnavailable("vlm-cloud-failed", f"{type(exc).__name__}: {exc}") from exc
    if not text:
        raise EngineUnavailable("vlm-cloud-empty", "NIM svarade utan text")
    return text, settings.nvidia_vision_model


# --------------------------------------------------------------------- huvud-ingång
def analyze(
    *,
    image_base64: str = "",
    image_path: str = "",
    prompt: str = "",
    settings: Settings | None = None,
) -> VisionResult:
    cfg = settings or get_settings()
    text_prompt = (prompt or cfg.default_prompt).strip() or cfg.default_prompt
    started = time.perf_counter()
    image = _image_payload(image_base64, image_path)
    notes: list[str] = []

    # 1) lokal VLM
    if ollama_running(cfg):
        try:
            answer, model = _ask_ollama(image, text_prompt, cfg)
            _state = Availability(slot="vlm", engine="vlm-local", ready=True, probed=True,
                                  model=model, detail="Ollama svarade")
            took = int((time.perf_counter() - started) * 1000)
            log.info("/analyze: vlm-local %s (%d ms)", model, took)
            return VisionResult(text=answer, engine="vlm-local", model=model,
                                confidence=0.8, took_ms=took, note=f"prompt: {text_prompt[:80]}")
        except EngineUnavailable as exc:
            notes.append(f"vlm-local: {exc.detail}")
            log.info("/analyze: vlm-local avböjd — %s", exc.detail)
    else:
        notes.append("vlm-local: Ollama svarar inte på " + cfg.ollama_base_url)

    # 2) moln-NIM
    try:
        answer, model = _ask_nvidia(image, text_prompt, cfg)
        _state = Availability(slot="vlm", engine="vlm-cloud", ready=True, probed=True,
                              model=model, detail="NVIDIA NIM svarade")
        took = int((time.perf_counter() - started) * 1000)
        log.info("/analyze: vlm-cloud %s (%d ms)", model, took)
        return VisionResult(text=answer, engine="vlm-cloud", model=model,
                            confidence=0.7, took_ms=took, note=f"prompt: {text_prompt[:80]}")
    except EngineUnavailable as exc:
        notes.append(f"vlm-cloud: {exc.detail}")
        log.info("/analyze: vlm-cloud avböjd — %s", exc.detail)

    # 3) OCR-textdump (ingen VLM alls — det står det explicit i note)
    try:
        result = ocr_engine.run_ocr(image_base64=image if not image_path else "", image_path=image_path)
        took = int((time.perf_counter() - started) * 1000)
        _state = Availability(slot="vlm", engine="none", ready=False, probed=True,
                              detail="ingen VLM nåbar — OCR används", degraded=True, notes=notes)
        confidence = round(
            sum(block.confidence for block in result.blocks) / len(result.blocks), 4
        ) if result.blocks else 0.0
        log.info("/analyze: ocr-fallback %d block (%d ms)", len(result.blocks), took)
        return VisionResult(
            text=result.text,
            engine="ocr",
            model="rapidocr-onnxruntime",
            confidence=confidence,
            took_ms=took,
            blocks=result.blocks,
            note="Ingen VLM tillgänglig (Ollama saknar vision-modell, NVIDIA_API_KEY satt eller nåbar). "
                 "Texten är en OCR-dump, INTE en beskrivning. " + " | ".join(notes),
        )
    except EngineUnavailable as exc:
        notes.append(f"ocr: {exc.detail}")

    # 4) stub — aldrig ett påhittat svar
    took = int((time.perf_counter() - started) * 1000)
    _state = Availability(slot="vlm", engine="stub", ready=False, probed=True,
                          detail="ingen motor svarade", degraded=True, notes=notes)
    log.warning("/analyze: stub (%d ms)", took)
    return VisionResult(
        text="", engine="stub", model="none", confidence=0.0, took_ms=took,
        note="Ingen vision-motor svarade: " + " | ".join(notes),
    )


def blocks_of(result: VisionResult) -> list[OcrBlock]:
    return list(result.blocks)
