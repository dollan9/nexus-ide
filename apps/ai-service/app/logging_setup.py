"""Logging: samma rad till fil (`apps/ai-service/ai-service.log`) och stdout.

Roterad via `logging.handlers.RotatingFileHandler` (5 × 2 MB) så att en lång
session inte sväller. Inga nycklar loggas — se `redact()`.
"""

from __future__ import annotations

import logging
import logging.handlers
import re
from pathlib import Path

_LOGGERS: set[str] = set()
_SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|authorization|bearer|token|secret)[\"'=: ]+([^\s,;\"']+)"),
    re.compile(r"nvapi-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"sk-[A-Za-z0-9]{8,}"),
)

_ROOT_FORMAT = "%(asctime)s %(levelname)-5s [%(name)s] %(message)s"


def redact(message: str) -> str:
    """Ersätter potentiella hemligheter innan de når filen (R2)."""
    text = message
    text = _SECRET_PATTERNS[0].sub(lambda m: f"{m.group(1)}=***", text)
    text = _SECRET_PATTERNS[1].sub("nvapi-***", text)
    text = _SECRET_PATTERNS[2].sub("sk-***", text)
    return text


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:  # noqa: D102
        return super().format(record)


def _redact_filter(record: logging.LogRecord) -> int:
    try:
        record.msg = redact(str(record.getMessage()))
        record.args = ()
    except Exception:  # noqa: BLE001 - en lograd får aldrig fälla servern
        pass
    return 1


def configure(level: str = "info", log_path: Path | None = None) -> logging.Logger:
    """Konfigurerar rotloggern. Idempotent — anropas både av main och test."""
    root = logging.getLogger()
    numeric = getattr(logging, level.upper(), logging.INFO)
    root.setLevel(numeric)

    if "nexus-ai" in _LOGGERS:
        for handler in root.handlers:
            handler.setLevel(numeric)
        return root

    formatter = _RedactingFormatter(_ROOT_FORMAT)
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.handlers = [stream]

    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.handlers.RotatingFileHandler(
                log_path, maxBytes=2_000_000, backupCount=5, encoding="utf-8"
            )
            file_handler.setFormatter(formatter)
            root.addHandler(file_handler)
        except OSError as exc:  # skrivskydd/oktalt path → stdout ändå (R5)
            root.warning("Loggfil kunde inte öppnas (%s) — skriver endast stdout", exc)

    root.addFilter(_redact_filter)
    _LOGGERS.add("nexus-ai")
    # tysta praliga tredjepartsloggare
    for noisy in ("uvicorn.access", "httpx", "httpcore", "chromadb", "edge_tts", "urllib3"):
        logging.getLogger(noisy).setLevel(max(numeric, logging.WARNING))
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
