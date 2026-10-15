"""OCR med RapidOCR + ONNXRuntime (FAS 6.3).

Medvetet valt i stället för pytesseract/easyocr: pytesseract kräver en
systembinary som INTE finns på denna maskin, och easyocr drar med torch
(~800 MB). `rapidocr-onnxruntime` har sina modeller i wheel-paketet.
"""

from __future__ import annotations

import base64
import io
import threading
from typing import Any

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..schemas import OcrBlock, OcrResult
from . import Availability, EngineUnavailable

log = get_logger("ai.ocr")

_lock = threading.Lock()
_instance: Any = None
_state: Availability = Availability(slot="ocr", engine="rapidocr")


def availability(settings: Settings | None = None) -> Availability:
    return _state


def _ensure() -> Any:
    """Latyladdning: ett import-/modellfel gör aldrig servern omöjlig (R5)."""
    global _instance, _state
    if _instance is not None:
        return _instance
    with _lock:
        if _instance is not None:
            return _instance
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]

            _instance = RapidOCR()
            _state = Availability(
                slot="ocr", engine="rapidocr", ready=True, probed=True,
                model="rapidocr-onnxruntime (PP-OCR models bundled)",
                detail="modeller följer med wheel-paketet",
            )
            log.info("RapidOCR laddad")
        except Exception as exc:  # noqa: BLE001
            _state = Availability(
                slot="ocr", engine="unavailable", ready=False, probed=True,
                detail=f"{type(exc).__name__}: {exc}", degraded=True,
            )
            log.warning("RapidOCR kunde inte laddas: %s", exc)
            raise EngineUnavailable("ocr-unavailable", f"{type(exc).__name__}: {exc}", engine="unavailable") from exc
    return _instance


def _load_image(image_base64: str = "", image_path: str = "") -> Any:
    from PIL import Image  # lokal import: håller modulen importbar utan Pillow

    if image_base64:
        raw = base64.b64decode(image_base64) if not image_base64.startswith("data:") else \
            base64.b64decode(image_base64.split(",", 1)[1])
        return Image.open(io.BytesIO(raw)).convert("RGB")
    if image_path:
        return Image.open(image_path).convert("RGB")
    raise EngineUnavailable("no-image", "varken imageBase64 eller imagePath angavs")


def _to_blocks(result: list[Any], min_confidence: float) -> list[OcrBlock]:
    blocks: list[OcrBlock] = []
    for item in result or []:
        try:
            box, text, conf = item[0], str(item[1]), float(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        if not text.strip() or conf < min_confidence:
            continue
        xs = [int(round(float(p[0]))) for p in box]
        ys = [int(round(float(p[1]))) for p in box]
        blocks.append(
            OcrBlock(
                text=text.strip(),
                confidence=round(conf, 4),
                box=(min(xs), min(ys), max(xs), max(ys)),
            )
        )
    return blocks


def run_ocr(
    *,
    image_base64: str = "",
    image_path: str = "",
    min_confidence: float = 0.3,
    settings: Settings | None = None,
) -> OcrResult:
    """Kör OCR och returnerar `{text, blocks, engine, tookMs}` (camelCase i JSON)."""
    import time

    started = time.perf_counter()
    image = _load_image(image_base64, image_path)
    engine = _ensure()
    try:
        import numpy as np  # noqa: PLC0415 - valfrint men installerat

        array = np.asarray(image)
    except Exception:  # noqa: BLE001
        array = image
    result, _elapsed = engine(array)
    blocks = _to_blocks(result if isinstance(result, list) else [], min_confidence)
    took_ms = int((time.perf_counter() - started) * 1000)
    text = "\n".join(block.text for block in blocks)
    log.info("OCR: %d block, %d ms (%s)", len(blocks), took_ms, image_path or "base64")
    return OcrResult(text=text, blocks=blocks, engine="rapidocr", took_ms=took_ms)
