"""TTS-kedja (FAS 5.2): Piper → edge-tts → Windows System.Speech → sinuston.

`engine`-fältet i `SpeakResult` är ALLTID den motor som faktiskt producerade bytesen.
Om edge-tts svarar står det "edge-tts", aldrig "piper". En sinuston står som "tone"
och markeras i `/health` som degraderad — den är inte tal.

Motorerna är valfria beroenden och laddas latat i `try/except` (R5):
  * piper-tts        — lokalt, egna voice-modeller (HuggingFace `rhasspy/piper-voices`)
  * edge-tts         — moln, kräver nät
  * windows-speech   — PowerShell + System.Speech (denna maskin: "Microsoft Zira Desktop")
  * tone             — ren WAV utan beroenden, sista utvägen så /speak aldrig hänger sig
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Any, Callable, Iterable

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..media import make_tone_wav
from ..schemas import SpeakResult
from . import Availability, EngineUnavailable

log = get_logger("ai.tts")

_lock = threading.Lock()
_piper_cache: dict[str, Any] = {}
_state = Availability(slot="tts", engine="piper")
_PROBE: dict[str, Any] = {}

# Svenska Piper-röster (FAS 5.1/5.2) — provas och RAPPORTERAS, men är aldrig ett krav.
SV_VOICE_CANDIDATES = ("sv_sv-tdummy-medium",)
VALID_FORMATS = ("wav", "mp3", "ogg")
_VOICE_PATTERN = re.compile(
    r"^(?P<family>[a-z]{2})_(?P<region>[A-Z]{2})-(?P<name>[\w.]+)-(?P<quality>x_low|low|medium|high)$"
)
_WINDOWS_WAV = "tts-windows.wav"


def availability(settings: Settings | None = None) -> Availability:
    return _state


# ================================================================= Piper
def voice_files(settings: Settings, voice: str) -> tuple[Path, Path]:
    root = settings.piper_path
    return root / f"{voice}.onnx", root / f"{voice}.onnx.json"


def voice_present(settings: Settings, voice: str) -> bool:
    onnx, _meta = voice_files(settings, voice)
    return onnx.is_file() and onnx.stat().st_size > 500_000


def download_voice(settings: Settings, voice: str, *, timeout: float = 300.0) -> Path:
    """Hämtar voice via pipers EGEN nedladdare (`piper.download_voices`), residuell URL-läsare som reserv.

    Tidsbegränsad i en daemon-tråd: en hängande HuggingFace-anslutning får inte
    blockera servern — då kastar vi EngineUnavailable och kedjan går vidare.
    """
    onnx, _meta = voice_files(settings, voice)
    if onnx.is_file() and onnx.stat().st_size > 500_000:
        return onnx
    if not _VOICE_PATTERN.match(voice):
        raise EngineUnavailable("piper-voice-invalid", f"röstnamn matchar mönstret inte: {voice}", engine="piper")
    settings.piper_path.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    def _fetch() -> None:
        try:
            from piper import download_voices as dv  # type: ignore[import-not-found]

            dv.download_voice(voice, settings.piper_path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"piper.download_voices: {type(exc).__name__}: {exc}")
            try:
                _download_manual(settings, voice, timeout=min(timeout, 120.0))
            except Exception as exc2:  # noqa: BLE001
                errors.append(f"manuell URL: {type(exc2).__name__}: {exc2}")

    _run_in_daemon(_fetch, timeout, label=f"piper-voice {voice}")
    if not onnx.is_file():
        raise EngineUnavailable(
            "piper-voice-unavailable", f"{voice}: " + (" | ".join(errors) or "ingen fil efter nedladdning"),
            engine="piper",
        )
    size_mb = onnx.stat().st_size / 1_048_576
    log.info("Piper-voice hämtad: %s (%.1f MB) → %s", voice, size_mb, onnx)
    return onnx


def _run_in_daemon(fn: Callable[[], None], timeout: float, *, label: str) -> bool:
    """Kör fn med tidsgräns. True om den blev klar i tid."""
    done = threading.Event()

    def _wrapper() -> None:
        try:
            fn()
        finally:
            done.set()

    thread = threading.Thread(target=_wrapper, daemon=True, name="nexus-download")
    thread.start()
    finished = done.wait(timeout)
    if not finished:
        log.warning("Nedladdning '%s' överskred %.0fs — lämnas som daemontråd", label, timeout)
    return finished


def _voice_url(voice: str, suffix: str) -> str:
    match = _VOICE_PATTERN.match(voice)
    if not match:
        raise EngineUnavailable("piper-voice-invalid", voice, engine="piper")
    family = match.group("family")
    lang = f"{family}_{match.group('region')}"
    name = match.group("name")
    quality = match.group("quality")
    return (
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
        f"{family}/{lang}/{name}/{quality}/{lang}-{name}-{quality}{suffix}?download=true"
    )


def _download_manual(settings: Settings, voice: str, *, timeout: float) -> None:
    """Samma URL-schema som pipers CLI — bara en reserv när nedladdaren själv felar."""
    import httpx

    onnx, meta = voice_files(settings, voice)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        for url, dest in ((_voice_url(voice, ".onnx"), onnx), (_voice_url(voice, ".onnx.json"), meta)):
            if dest.is_file() and dest.stat().st_size > 100:
                continue
            response = client.get(url)
            response.raise_for_status()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(response.content)
            tmp.replace(dest)


def _load_piper(settings: Settings, voice: str) -> Any:
    cached = _piper_cache.get(voice)
    if cached is not None:
        return cached
    global _state
    with _lock:
        cached = _piper_cache.get(voice)
        if cached is not None:
            return cached
        from piper import PiperVoice  # type: ignore[import-not-found]

        onnx = voice_files(settings, voice)[0]
        if not onnx.is_file():
            onnx = download_voice(settings, voice)
        meta = voice_files(settings, voice)[1]
        loaded = PiperVoice.load(
            onnx,
            config_path=meta if meta.is_file() else None,
            download_dir=settings.piper_path,
        )
        _piper_cache[voice] = loaded
        _state = Availability(
            slot="tts", engine="piper", ready=True, probed=True, model=voice,
            detail=f"lokal Piper, {onnx.stat().st_size / 1_048_576:.1f} MB",
        )
        log.info("Piper-voice laddad: %s", voice)
        return loaded


def _chunks_to_wav(chunks: Iterable[Any]) -> bytes:
    frames: list[bytes] = []
    channels, width, rate = 1, 2, 22_050
    for chunk in chunks:
        data = bytes(chunk.audio_int16_bytes)
        if not data:
            continue
        channels = max(1, int(chunk.sample_channels))
        width = int(chunk.sample_width)
        rate = int(chunk.sample_rate)
        frames.append(data)
    if not frames:
        return b""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        for frame in frames:
            handle.writeframes(frame)
    return buf.getvalue()


def _speak_piper(text: str, settings: Settings, voice: str) -> bytes:
    from piper import SynthesisConfig  # type: ignore[import-not-found]

    engine = _load_piper(settings, voice)
    wav = _chunks_to_wav(engine.synthesize(text, SynthesisConfig()))
    if len(wav) < 2_000:
        raise EngineUnavailable("piper-empty-audio", "Piper returnerade ingen ljuddata", engine="piper")
    return wav


# ================================================================= edge-tts
def _speak_edge(text: str, settings: Settings, voice: str) -> bytes:
    """Edge TTS (moln) → mp3. Nätfel är normal nedbrytning, inte en krasch."""
    import edge_tts  # type: ignore[import-not-found]

    settings.nexus_dir.mkdir(parents=True, exist_ok=True)
    tmp = settings.nexus_dir / "tts-edge.mp3"
    with contextlib.suppress(OSError):
        tmp.unlink()

    async def _run() -> None:
        await edge_tts.Communicate(text, voice).save(str(tmp))

    try:
        asyncio.run(asyncio.wait_for(_run(), timeout=max(20.0, settings.http_timeout_s * 2)))
    except Exception as exc:  # noqa: BLE001
        raise EngineUnavailable("edge-tts-failed", f"{type(exc).__name__}: {exc}", engine="edge-tts") from exc
    data = tmp.read_bytes() if tmp.is_file() else b""
    with contextlib.suppress(OSError):
        tmp.unlink()
    if len(data) < 500:
        raise EngineUnavailable("edge-tts-empty-audio", "mp3 saknas eller är för kort", engine="edge-tts")
    return data


# ================================================================= Windows
def _ps_escape(value: str) -> str:
    return value.replace("'", "''").replace("\n", " ")


def _speak_windows(text: str, settings: Settings, voice: str) -> bytes:
    """System.Speech via PowerShell till WAV — riktigt tal, utan nätverk."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if powershell is None:
        raise EngineUnavailable("powershell-missing", "powershell.exe finns inte i PATH", engine="windows-speech")

    settings.nexus_dir.mkdir(parents=True, exist_ok=True)
    out = settings.nexus_dir / _WINDOWS_WAV
    with contextlib.suppress(OSError):
        out.unlink()

    payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        f"$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}'))\n"
        "Add-Type -AssemblyName System.Speech\n"
        "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
        f"$voice = '{_ps_escape(voice)}'\n"
        "if ($voice -ne '') { try { $synth.SelectVoice($voice) } catch { }\n"
        "}\n"
        f"$synth.SetOutputToWaveFile('{_ps_escape(out.as_posix())}')\n"
        "$synth.Speak($text)\n"
        "$synth.Dispose()\n"
    )
    runner = settings.nexus_dir / "tts-windows.ps1"
    runner.write_text(script, encoding="utf-8")
    try:
        proc = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(runner)],
            capture_output=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineUnavailable("windows-speech-failed", str(exc), engine="windows-speech") from exc
    data = out.read_bytes() if out.is_file() else b""
    if proc.returncode != 0 or len(data) < 2_000:
        raise EngineUnavailable(
            "windows-speech-failed",
            (proc.stderr.decode("utf-8", "replace") or "ingen wav producerad")[:300],
            engine="windows-speech",
        )
    return data


def probe_windows_voice(settings: Settings) -> str:
    """Probar EN gång: returnerar röstnamn som faktiskt kan syntetisera, annars ''."""
    if "windows_ok" in _PROBE:
        return str(_PROBE.get("windows_name") or "")
    name = ""
    detail = ""
    try:
        wav = _speak_windows("Nexus test", settings, "")
        if len(wav) > 2_000:
            names = windows_voices(settings)
            name = names[0] if names else "Microsoft Zira Desktop"
    except EngineUnavailable as exc:
        detail = exc.detail
    _PROBE["windows_ok"] = bool(name)
    _PROBE["windows_name"] = name
    if detail:
        log.info("Windows-talmotor ej tillgänglig: %s", detail)
    with contextlib.suppress(OSError):
        (settings.nexus_dir / _WINDOWS_WAV).unlink()
    with contextlib.suppress(OSError):
        (settings.nexus_dir / "tts-windows.ps1").unlink()
    return name


def windows_voices(settings: Settings) -> list[str]:
    """Installerade System.Speech-röster (används av /health och scripts/test_voice.sh)."""
    cached = _PROBE.get("voices")
    if isinstance(cached, list):
        return list(cached)
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    names: list[str] = []
    if powershell:
        try:
            proc = subprocess.run(
                [powershell, "-NoProfile", "-Command",
                 "Add-Type -AssemblyName System.Speech;",
                 "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices()",
                 "| ForEach-Object { $_.VoiceInfo.Name }"],
                capture_output=True, timeout=45, check=False,
            )
            names = [line.strip() for line in proc.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        except Exception as exc:  # noqa: BLE001
            log.info("Kunde inte lista Windows-röster: %s", exc)
    _PROBE["voices"] = names
    return names


# ================================================================= kedjan
def chain_order(settings: Settings) -> list[str]:
    preferred = (settings.tts_engine or "piper").lower()
    order = ["piper", "edge-tts", "windows-speech", "tone"]
    if preferred in order:
        order.remove(preferred)
        order.insert(0, preferred)
    return order


def speak(text: str, *, voice: str = "", fmt: str = "wav", settings: Settings | None = None) -> SpeakResult:
    """Kör TTS-kedjan och svarar med SAN `engine`: piper | edge-tts | windows-speech | tone."""
    global _state
    cfg = settings or get_settings()
    if not text or not text.strip():
        raise EngineUnavailable("empty-text", "tom text kan inte läsas upp")
    target_format = fmt if fmt in VALID_FORMATS else "wav"
    started = time.perf_counter()
    attempts: list[dict[str, str]] = []

    for engine in chain_order(cfg):
        try:
            if engine == "piper":
                name = voice if _looks_piper(voice) else cfg.piper_voice
                wav = _speak_piper(text, cfg, name)
                return _result(wav, "wav", "piper", name, started, cfg, attempts)
            if engine == "edge-tts":
                name = _edge_voice(voice, cfg)
                mp3 = _speak_edge(text, cfg, name)
                data, out_fmt = _maybe_to_wav(mp3, "mp3", target_format)
                return _result(data, out_fmt, "edge-tts", name, started, cfg, attempts)
            if engine == "windows-speech":
                name = "" if _looks_piper(voice) else (voice or probe_windows_voice(cfg))
                wav = _speak_windows(text, cfg, name)
                data, out_fmt = _maybe_to_wav(wav, "wav", target_format)
                return _result(data, out_fmt, "windows-speech",
                               name or windows_voice_label(), started, cfg, attempts)
            if engine == "tone":
                seconds = max(0.6, min(4.0, len(text) / 14.0))
                wav = make_tone_wav(seconds=seconds)
                _state = Availability(
                    slot="tts", engine="tone", ready=True, probed=True,
                    detail="INTE TAL — sinuston, ingen talmotor var tillgänglig", degraded=True,
                )
                return _result(wav, "wav", "tone", "none", started, cfg, attempts)
        except EngineUnavailable as exc:
            attempts.append({"engine": engine, "error": exc.detail or exc.reason})
            log.warning("TTS %s felade (%s) — provar nästa motor", engine, exc.detail or exc.reason)
            if engine == "piper":
                _state = Availability(
                    slot="tts", engine="piper-unavailable", ready=False, probed=True,
                    model=cfg.piper_voice, detail=exc.detail, degraded=True,
                )
        except Exception as exc:  # noqa: BLE001 - R5: ingen motor får fälla servern
            attempts.append({"engine": engine, "error": f"{type(exc).__name__}: {exc}"})
            log.exception("Oväntat TTS-fel i %s", engine)

    _state = Availability(slot="tts", engine="unavailable", ready=False, probed=True,
                          detail=str(attempts), degraded=True)
    raise EngineUnavailable("tts-all-engines-failed", str(attempts))


def windows_voice_label() -> str:
    return str(_PROBE.get("windows_name") or "Microsoft Zira Desktop")


def _looks_piper(voice: str) -> bool:
    return bool(_VOICE_PATTERN.match(voice or ""))


def _edge_voice(voice: str, cfg: Settings) -> str:
    if voice and "-" in voice and not _looks_piper(voice):
        return voice
    return cfg.edge_tts_voice


def _maybe_to_wav(data: bytes, source_fmt: str, want: str) -> tuple[bytes, str]:
    """Konvertera om ffmpeg finns; annars ärligt om verkligt format (ingen lögn)."""
    if want == source_fmt:
        return data, source_fmt
    ffmpeg = shutil.which("ffmpeg")
    if want == "wav" and source_fmt in ("mp3", "ogg") and ffmpeg:
        with tempfile.TemporaryDirectory(prefix="nexus-tts-") as tmp:
            src, dst = Path(tmp) / f"in.{source_fmt}", Path(tmp) / "out.wav"
            src.write_bytes(data)
            proc = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                 "-ac", "1", "-ar", "22050", str(dst)],
                capture_output=True, timeout=60, check=False,
            )
            if proc.returncode == 0 and dst.is_file():
                return dst.read_bytes(), "wav"
    return data, source_fmt


def _result(
    data: bytes, fmt: str, engine: str, voice: str, started: float,
    settings: Settings, attempts: list[dict[str, str]],
) -> SpeakResult:
    latency = int((time.perf_counter() - started) * 1000)
    log.info(
        "TTS: engine=%s voice=%s format=%s bytes=%d (%d ms)%s",
        engine, voice, fmt, len(data), latency,
        f" — efter {len(attempts)} felande motor(er)" if attempts else "",
    )
    return SpeakResult(
        audio_base64=base64.b64encode(data).decode("ascii"),
        format=fmt,  # type: ignore[arg-type]
        engine=engine,
        voice=voice,
        bytes=len(data),
        latency_ms=latency,
    )


def tts_availability(settings: Settings) -> Availability:
    """Lätt probe för /health: kollar disk och import — försöker INTE hämta något över nätet."""
    global _state
    onnx, _meta = voice_files(settings, settings.piper_voice)
    import_ok, import_error = True, ""
    try:
        import piper  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        import_ok, import_error = False, f"{type(exc).__name__}: {exc}"
    edge_ok, edge_error = True, ""
    try:
        import edge_tts  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        edge_ok, edge_error = False, f"{type(exc).__name__}: {exc}"

    notes = [
        f"piper-import={'ok' if import_ok else import_error}",
        f"piper-voice={'på disk' if onnx.is_file() else 'ej nedladdad'}",
        f"edge-tts={'installerad (kräver nät)' if edge_ok else edge_error}",
        f"windows-speech={_PROBE.get('windows_name') if _PROBE.get('windows_ok') else 'ej probead'}",
    ]
    if import_ok and onnx.is_file():
        _state = Availability(slot="tts", engine="piper", ready=True, probed=False,
                              model=settings.piper_voice,
                              detail=f"{onnx.stat().st_size / 1_048_576:.1f} MB voice på disk", notes=notes)
    elif _PROBE.get("windows_ok"):
        _state = Availability(slot="tts", engine="windows-speech", ready=True, probed=True,
                              model=windows_voice_label(), degraded=True, notes=notes)
    elif edge_ok:
        _state = Availability(slot="tts", engine="edge-tts", ready=True, probed=False,
                              model=settings.edge_tts_voice, degraded=True, notes=notes)
    else:
        _state = Availability(slot="tts", engine="tone", ready=True, probed=True,
                              detail="ingen riktig talmotor tillgänglig", degraded=True, notes=notes)
    return _state


def sv_voice_status(settings: Settings) -> dict[str, Any]:
    """Finns en svensk Piper-röst på disk? (rapporteras, krävs inte — R5)"""
    present = [v for v in SV_VOICE_CANDIDATES if voice_present(settings, v)]
    windows_sv = [name for name in windows_voices(settings) if "sv" in name.lower()]
    return {
        "requested": settings.piper_voice,
        "svCandidates": list(SV_VOICE_CANDIDATES),
        "svOnDisk": present,
        "svAvailable": bool(present) or bool(windows_sv),
        "windowsVoices": windows_voices(settings),
    }


def reset_for_tests() -> None:
    global _state
    _piper_cache.clear()
    _PROBE.clear()
    _state = Availability(slot="tts", engine="piper")
