"""Motorpaket för ai-service: röst, vision, OCR, fångst, embeddings och RAG.

Varje modul håller sin egen laddning i `try/except` och exponerar en
`Availability` så att `/health` kan berätta sanningen om vad som faktiskt laddats.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Availability:
    """Sanningsvittnesstruktur för en motor (FAS 5.1/6.1 och R5)."""

    slot: str                      # stt | tts | vlm | ocr | embed | capture | rag
    engine: str                    # t.ex. "faster-whisper", "rapidocr", "unavailable"
    ready: bool = False            # laddad och användigbar just nu
    probed: bool = False           # har försökt ladda (False = laddas vid behov)

    model: str = ""
    detail: str = ""               # felmeddelande eller koncis notering
    degraded: bool = False         # sandheden: reserv i stället för förstahandsvalet
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "slot": self.slot,
            "engine": self.engine,
            "ready": self.ready,
            "probed": self.probed,
            "model": self.model,
            "detail": self.detail,
            "degraded": self.degraded,
            "notes": list(self.notes),
        }


class EngineUnavailable(RuntimeError):
    """Kastas INUTÄNFT motorn, fångas av routen och blir 503 eller graceful-svar."""

    def __init__(self, reason: str, detail: str = "", *, engine: str = "unavailable") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail
        self.engine = engine


__all__ = ["Availability", "EngineUnavailable"]
