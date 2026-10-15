"""Media-hjälp: ffmpeg-avkodning, varaktighet, ton-syntes och bildinläsning.

Allt som anropar extern process är samlat här och i `try/except` — saknas ffmpeg
ska tjänsten svara med ett maskinläsbart fel, aldrig krascha (R5).
"""

from __future__ import annotations

import base64
import binascii
import io
import math
import shutil
import struct
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class DecodedAudio:
    """WAV i 16 kHz mono, plus varaktighet i millisekunder."""

    wav: bytes
    duration_ms: int
    source_format: str


class MediaError(RuntimeError):
    """Oklart mediefel (saknad binär, skadad fil, för stor fil)."""


def ffmpeg_binary() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_binary() -> str | None:
    return shutil.which("ffprobe")


def _run(cmd: list[str], *, timeout: float = 60.0) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise MediaError(f"binär saknas: {cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError(f"tidsgräns överskreds: {' '.join(cmd[:3])}") from exc


def decode_to_wav(data: bytes, fmt: str = "wav", *, timeout: float = 60.0) -> DecodedAudio:
    """Konverterar vilken base64-dekodad ljudfil som helst till 16 kHz mono WAV.

    WebM/Opus från MediaRecorder (FAS 5.3) och MP3 från edge-tts hanteras här, så att
    Whisper aldrig matas med ett format CTranslate2 inte kan läsa.
    """
    if not data:
        raise MediaError("tom ljudfil")
    # WAV kan läsas direkt — undvik ffmpeg-beroendet i det vanliga fallet.
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        duration = wav_duration_ms(data)
        if fmt in ("wav", ""):
            return DecodedAudio(data, duration, "wav")
    binary = ffmpeg_binary()
    if binary is None:
        raise MediaError("ffmpeg finns inte i PATH — kan inte avkoda ljudformat")
    ext = (fmt or "bin").lstrip(".").lower()
    with tempfile_dir() as tmp:
        src = tmp / f"audio.{ext}"
        dst = tmp / "audio.wav"
        src.write_bytes(data)
        proc = _run(
            [
                binary, "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(src), "-ac", "1", "-ar", str(SAMPLE_RATE),
                "-c:a", "pcm_s16le", str(dst),
            ],
            timeout=timeout,
        )
        if proc.returncode != 0 or not dst.exists():
            raise MediaError(
                "ffmpeg-avkodning felade: " + proc.stderr.decode("utf-8", "replace")[:400]
            )
        wav_bytes = dst.read_bytes()
    return DecodedAudio(wav_bytes, wav_duration_ms(wav_bytes), ext or "okänt")


class tempfile_dir:
    """Liten kontextmanager: tempkatalog som städas bort (inget lämnas kvar)."""

    def __enter__(self) -> Path:
        import tempfile

        self._td = tempfile.TemporaryDirectory(prefix="nexus-media-")
        return Path(self._td.name)

    def __exit__(self, *exc: object) -> bool:
        import contextlib

        with contextlib.suppress(OSError):
            self._td.cleanup()
        return False


def wav_duration_ms(wav: bytes) -> int:
    """Varaktighet ur WAV-huvudet; fallback till byteberäkning eller ffprobe."""
    try:
        with wave.open(io.BytesIO(wav), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or SAMPLE_RATE
            return int(frames / rate * 1000)
    except Exception:  # noqa: BLE001 - inte en PCM-wav
        pass
    probe = ffprobe_binary()
    if probe is not None:
        with tempfile_dir() as tmp:
            path = tmp / "in.bin"
            path.write_bytes(wav)
            proc = _run([probe, "-hide_banner", "-loglevel", "error", "-show_entries",
                         "format=duration", "-of", "csv=p=0", str(path)], timeout=30)
            text = proc.stdout.decode("utf-8", "replace").strip()
            try:
                return int(float(text) * 1000)
            except ValueError:
                pass
    # rådata-antagande: 16-bit mono
    if len(wav) > 44:
        return int((len(wav) - 44) / 2 / SAMPLE_RATE * 1000)
    return 0


def make_tone_wav(seconds: float = 1.5, freq: float = 440.0, sample_rate: int = 22_050) -> bytes:
    """Ren sinus-WAV utan ffmpeg — sista utvägen så att /speak alltid svarar.

    Låter som en signalton, INTE som tal. Anroparen MUST rapportera
    `engine: "tone"` så ingen test bedragas (CONVENTIONS: äkthet i tester).
    """
    total = max(1, int(seconds * sample_rate))
    frames = bytearray()
    amp = 12_000
    for i in range(total):
        value = int(amp * math.sin(2 * math.pi * freq * i / sample_rate))
        frames += struct.pack("<h", value)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(bytes(frames))
    return buf.getvalue()


def decode_base64(payload: str) -> bytes:
    """Base64 → bytes, tål data-URL-prefix och utbytta '-'/'_'."""
    if not payload:
        raise MediaError("tom base64")
    text = payload.strip()
    if text.startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    text = "".join(text.split())
    for candidate in (text, text.replace("-", "+").replace("_", "/")):
        try:
            return base64.b64decode(candidate + "=" * (-len(candidate) % 4))
        except (binascii.Error, ValueError):
            continue
    raise MediaError("base64 kunde inte avkodas")


def png_bytes_to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")
