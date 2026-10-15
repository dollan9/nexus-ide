"""FastAPI-nyten för ai-service (FAS 5.1, 6.1–6.3, 3.5; R5, R7).

Lyssnar som standard på `127.0.0.1:7955` (host/port från `AI_SERVICE_HOST`/
`AI_SERVICE_PORT`, lästa ur `nexus-ide/.env` om den finns).

FELKONTRAKT (detta är valet som @nexus/core:s klient måste följa):
  * Standard: saknas motor eller vikt → **HTTP 503** med maskinläsbar JSON:
    `{"ok":false,"reason":"stt-model-unavailable","engine":"faster-whisper",
      "detail":"...","endpoint":"/transcribe","gracefulHint":"..."}`
    + headern `Retry-After: 30`.
  * Graciösitet begärs UTTRYKLIGEN av anroparen — nåndera av:
      body `{"graceful": true}`, header `X-Nexus-Graceful: 1`, query `?graceful=true`,
      eller miljö `AI_SERVICE_GRACEFUL=1`.
    Då kommer **HTTP 200** med `text: ""` och ett `error`-fält, så UI:t kan visa
    "röst offline" utan att kasta (R5).
  * Ett svar som kommer från en reservmotor bär alltid sanningen i `engine`
    (`edge-tts`, `hash-tfidf-local`, `jsonl-fallback`, `ocr`, `stub`, `tone`).

Svar-JSON använder exakt fältnamn från `@nexus/protocol` (camelCase); se `schemas.py`.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from . import logging_setup
from .config import get_settings, parse_bool
from .engines import EngineUnavailable, capture, embed, ocr, rag, stt, tts, vision
from .schemas import (
    AnalyzeRequest,
    EmbedRequest,
    ErrorResponse,
    HealthResponse,
    OcrRequest,
    RagIndexRequest,
    RagQueryRequest,
    ScreenshotRequest,
    SpeakRequest,
    TranscribeRequest,
)

SERVICE_VERSION = "1.0.0"
_STARTED_AT = time.time()
log = logging_setup.get_logger("ai.http")

app = FastAPI(
    title="NEXUS-IDE ai-service",
    version=SERVICE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url="/openapi.json",
)


# --------------------------------------------------------------------- hjälpfunkr
def _settings() -> Any:
    return get_settings()


def _wants_graceful(flag: bool | None, request: Request | None = None) -> bool:
    """Graciösitet är ett ANROPAR-beslut — aldrig ett antagande från servern."""
    if flag is not None:
        return flag
    cfg = _settings()
    if request is not None:
        header = request.headers.get("x-nexus-graceful")
        if header is not None:
            return parse_bool(header, False)
        if parse_bool(request.query_params.get("graceful"), False):
            return True
    return cfg.graceful_default


def _unavailable(exc: EngineUnavailable, *, endpoint: str, slot: str, graceful: bool) -> JSONResponse:
    """503 som standard, 200 + tom text om anroparen bett om graciösitet."""
    payload = ErrorResponse(
        reason=exc.reason,
        engine=exc.engine or slot,
        detail=(exc.detail or str(exc))[:600],
        endpoint=endpoint,
    )
    if not graceful:
        log.warning("%s → 503 %s (%s)", endpoint, exc.reason, exc.detail or "")
        return JSONResponse(status_code=503, content=payload.model_dump(),
                            headers={"Retry-After": "30"})

    log.info("%s → 200 graciös (tom text) eftersom motorn saknas: %s", endpoint, exc.reason)
    empty: dict[str, Any] = {
        "text": "",
        "engine": f"{slot}:unavailable",
        "error": f"{exc.reason}: {exc.detail or ''}".strip(": "),
        "language": _settings().whisper_language,
        "durationMs": 0,
        "latencyMs": 0,
        "model": _settings().whisper_model,
        "tookMs": 0,
        "confidence": 0.0,
        "blocks": [],
        "bytes": 0,
        "voice": "",
        "format": "wav",
        "segments": [],
        "note": "graciös form: ingen motor svarade",
    }
    return JSONResponse(status_code=200, content=empty)


def _internal_error(exc: Exception, endpoint: str, graceful: bool) -> JSONResponse:
    log.exception("Oväntat fel i %s", endpoint)
    return _unavailable(
        EngineUnavailable("internal-error", f"{type(exc).__name__}: {exc}", engine="internal"),
        endpoint=endpoint,
        slot="service",
        graceful=graceful,
    )


def _size_guard(request: Request) -> JSONResponse | None:
    length = request.headers.get("content-length")
    limit = _settings().request_max_bytes
    if length and int(length) > limit:
        return JSONResponse(
            status_code=413,
            content={"ok": False, "reason": "payload-too-large",
                     "detail": f"{length} bytes > gräns {limit}", "endpoint": str(request.url.path)},
        )
    return None


def _slot_for(endpoint: str) -> str:
    return {
        "/transcribe": "stt",
        "/speak": "tts",
        "/analyze": "vlm",
        "/ocr": "ocr",
        "/screenshot": "capture",
        "/embed": "embed",
        "/rag/index": "rag",
        "/rag/query": "rag",
    }.get(endpoint, "service")


def _engine_name(availability: Any, slot: str) -> str:
    """'faster-whisper:lazy' när motor ännu inte laddats — det är sanning, inte gissning."""
    if availability.ready:
        return availability.engine
    if availability.probed:
        return availability.engine
    return f"{availability.engine}:lazy"


async def _body_of(request: Request) -> dict[str, Any]:
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        data: dict[str, Any] = {}
        for key, value in form.items():
            if isinstance(value, UploadFile):
                raw = await value.read()
                import base64

                data["audioBase64"] = base64.b64encode(raw).decode("ascii")
                data["format"] = (value.filename or "").rsplit(".", 1)[-1] or "wav"
                data["originalName"] = value.filename or ""
            else:
                data[key] = value
        data["_multipart"] = True
        return data
    try:
        parsed = await request.json()
    except Exception:  # noqa: BLE001 - tomt/kropp-skadat body är giltigt fall, inte krasch
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {"audioBase64": parsed} if isinstance(parsed, str) else {}
    return parsed


# --------------------------------------------------------------------- /health
@app.get("/health")
async def health(request: Request) -> JSONResponse:
    """San rapport om vilka motorer som FACTTIST laddats, GPU, RAM och reservläge."""
    cfg = _settings()
    deep = parse_bool(request.query_params.get("deep"), False)

    if deep:
        # Fyll på genom att faktiskt ladda (kan ta minuter första gången).
        for loader in (
            lambda: stt._ensure(cfg),
            lambda: ocr._ensure(cfg),
        ):
            try:
                loader()
            except Exception as exc:  # noqa: BLE001
                log.info("djup probe: %s", exc)
        try:
            tts.probe_windows_voice(cfg)
        except Exception as exc:  # noqa: BLE001
            log.info("djup probe windows-tts: %s", exc)

    stt_state = stt.availability(cfg)
    tts_state = tts.tts_availability(cfg)
    ocr_state = ocr.availability(cfg)
    capture_state = capture.availability(cfg)
    embed_state = embed.availability(cfg)
    rag_state = rag.availability(cfg)
    vlm_state = vision.availability(cfg)

    gpu = None
    try:
        from .sysinfo import probe_gpu, probe_ram_free_mb

        gpu = probe_gpu()
        ram_free = probe_ram_free_mb()
    except Exception as exc:  # noqa: BLE001
        log.warning("systemprobe felade: %s", exc)
        gpu = None
        ram_free = 0

    # VLM: en lätt probe utan att ladda en modell — Vad finns faktiskt nåbart?
    vlm_label = "none"
    vlm_model = ""
    if vlm_state.ready:
        vlm_label = vlm_state.engine
        vlm_model = vlm_state.model
    else:
        try:
            if vision.ollama_running(cfg):
                found = vision._pick_vision_model(cfg)
                if found:
                    vlm_label, vlm_model = "vlm-local", found
                else:
                    vlm_label = "ollama-without-vision-model"
            elif cfg.secret_present("NVIDIA_API_KEY"):
                vlm_label = "vlm-cloud-configured"
            else:
                vlm_label = "ocr-fallback-only"
        except Exception as exc:  # noqa: BLE001
            vlm_label = f"probe-error:{type(exc).__name__}"

    degraded: list[str] = []
    for state in (stt_state, tts_state, ocr_state, capture_state, embed_state, rag_state, vlm_state):
        if state.degraded or (state.probed and not state.ready):
            label = f"{state.slot}: {state.engine}"
            if state.detail:
                label += f" — {state.detail[:120]}"
            if label not in degraded:
                degraded.append(label)
    if vlm_label in ("none", "ocr-fallback-only", "ollama-without-vision-model"):
        degraded.append(f"vlm: {vlm_label} (OCR är reserv för /analyze)")
    if not cfg.secret_present("NVIDIA_API_KEY"):
        degraded.append("vlm: NVIDIA_API_KEY är inte satt — moln-VLM otillgänglig")

    piper_voice = tts.voice_files(cfg, cfg.piper_voice)[0]
    payload: dict[str, Any] = {
        "ok": True,
        "version": SERVICE_VERSION,
        "protocolVersion": "1.0.0",
        "engines": {
            "stt": _engine_name(stt_state, "stt"),
            "tts": _engine_name(tts_state, "tts"),
            "vlm": vlm_label,
            "ocr": _engine_name(ocr_state, "ocr"),
            "capture": _engine_name(capture_state, "capture"),
            "embeddings": _engine_name(embed_state, "embed"),
            "rag": _engine_name(rag_state, "rag"),
        },
        "models": {
            "whisper": {
                "name": cfg.whisper_model,
                "loaded": stt_state.ready,
                "device": stt_state.detail.split(" — ")[0] if stt_state.ready else "",
                "language": cfg.whisper_language,
                "detail": stt_state.detail,
            },
            "piperVoice": {
                "name": cfg.piper_voice,
                "onDisk": piper_voice.is_file(),
                "path": str(piper_voice),
                "sizeMb": round(piper_voice.stat().st_size / 1_048_576, 1) if piper_voice.is_file() else 0,
                "engineInUse": tts_state.engine,
                "swedish": tts.sv_voice_status(cfg),
                "windowsVoices": tts.windows_voices(cfg),
            },
            "ocr": {
                "name": ocr_state.model or "rapidocr-onnxruntime",
                "loaded": ocr_state.ready,
                "detail": ocr_state.detail,
            },
            "vision": {"name": vlm_model or cfg.vision_model, "reachable": vlm_label in ("vlm-local", "vlm-cloud")},
            "embeddings": {"name": embed_state.model or cfg.embeddings_model, "engine": embed_state.engine},
        },
        "gpu": gpu.as_dict() if gpu else {
            "name": "none", "total_mb": 0, "used_mb": 0, "free_mb": 0, "detected_by": "unavailable",
        },
        "ram_free_mb": ram_free,
        "degraded": degraded,
        "uptime_ms": int((time.time() - _STARTED_AT) * 1000),
        "pid": _pid(),
        "host": cfg.host,
        "port": cfg.port,
        "notes": _state_notes(stt_state, tts_state, ocr_state, embed_state, rag_state),
    }
    return JSONResponse(status_code=200, content=payload)


def _pid() -> int:
    import os

    return os.getpid()


def _state_notes(*states: Any) -> list[str]:
    notes: list[str] = []
    for state in states:
        notes.extend(state.notes)
    return [note for note in notes if note][:12]


# --------------------------------------------------------------------- /transcribe
@app.post("/transcribe")
async def transcribe(request: Request) -> JSONResponse:
    """JSON `{audioBase64, format, language}` ELLER multipart med `file`/`audio`."""
    endpoint = "/transcribe"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        body = await _body_of(request)
        req = TranscribeRequest.model_validate(body)
        graceful = _wants_graceful(req.graceful, request)
        if not req.audio_base64:
            raise EngineUnavailable("no-audio", "tom audioBase64 (eller ingen multipart-fil)")
        from .media import decode_to_wav

        raw = __import__("base64").b64decode(
            req.audio_base64.split(",", 1)[-1] if req.audio_base64.startswith("data:") else req.audio_base64
        )
        decoded = decode_to_wav(raw, req.format or "wav")
        result = stt.transcribe(decoded, language=req.language, source_format=req.format or "wav")
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="stt", graceful=graceful)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"ok": False, "reason": "bad-request",
                                                      "detail": str(exc)[:400], "endpoint": endpoint})
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


# --------------------------------------------------------------------- /speak
@app.post("/speak")
async def speak(request: Request) -> JSONResponse:
    endpoint = "/speak"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        req = SpeakRequest.model_validate(await _body_of(request))
        graceful = _wants_graceful(req.graceful, request)
        result = tts.speak(req.text, voice=req.voice, fmt=req.format)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True,
                                                                       exclude_none=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="tts", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


# --------------------------------------------------------------------- /analyze
@app.post("/analyze")
async def analyze(request: Request) -> JSONResponse:
    endpoint = "/analyze"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        body = await _body_of(request)
        req = AnalyzeRequest.model_validate(body)
        graceful = _wants_graceful(req.graceful, request)
        image = req.image_base64
        if not image and not req.image_path:
            # Ingen bild angiven → ta en färsk skärmbild (FAS 6.1 + 6.2 i ett steg).
            shot = capture.capture(target="screen")
            image = shot.png_base64
        result = vision.analyze(image_base64=image, image_path=req.image_path, prompt=req.prompt)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True,
                                                                       exclude_none=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="vlm", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


# --------------------------------------------------------------------- /ocr
@app.post("/ocr")
async def ocr_endpoint(request: Request) -> JSONResponse:
    endpoint = "/ocr"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        body = await _body_of(request)
        req = OcrRequest.model_validate(body)
        graceful = _wants_graceful(req.graceful, request)
        image = req.image_base64
        if not image and not req.image_path:
            image = capture.capture(target="screen").png_base64
        result = ocr.run_ocr(image_base64=image, image_path=req.image_path,
                             min_confidence=req.min_confidence)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True,
                                                                       exclude_none=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="ocr", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


# --------------------------------------------------------------------- /screenshot
@app.post("/screenshot")
async def screenshot(request: Request) -> JSONResponse:
    endpoint = "/screenshot"
    graceful = _wants_graceful(None, request)
    try:
        req = ScreenshotRequest.model_validate(await _body_of(request))
        result = capture.capture(monitor=req.monitor, window_title=req.window_title, target=req.target)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True,
                                                                       exclude_none=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="capture", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


@app.get("/screenshot/windows")
async def screenshot_windows(title_contains: str = "") -> JSONResponse:
    """Fönsterlista (Win32 EnumWindows) — krävs för FAS 6.1 'window'-target."""
    windows = capture.list_windows(title_contains=title_contains)
    payload = {"windows": [w.model_dump(by_alias=True) for w in windows], "engine": "win32",
               "monitors": capture.monitor_count()}
    return JSONResponse(status_code=200, content=payload)


# --------------------------------------------------------------------- /embed
@app.post("/embed")
async def embed_endpoint(request: Request) -> JSONResponse:
    endpoint = "/embed"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        req = EmbedRequest.model_validate(await _body_of(request))
        if not req.texts:
            return JSONResponse(status_code=400, content={"ok": False, "reason": "no-texts",
                                                          "detail": "texts[] var tom", "endpoint": endpoint})
        result = embed.embed_texts(req.texts, model=req.model)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="embed", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


# --------------------------------------------------------------------- RAG
@app.post("/rag/index")
async def rag_index(request: Request) -> JSONResponse:
    endpoint = "/rag/index"
    graceful = _wants_graceful(None, request)
    try:
        req = RagIndexRequest.model_validate(await _body_of(request))
        result = rag.index_root(req.root, force=req.force, max_files=req.max_files)
        return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True))
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="rag", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


@app.post("/rag/query")
async def rag_query(request: Request) -> JSONResponse:
    """Returnerar en RAK ARRAY av `RagChunk` — samma form som `rag.search` förväntar sig."""
    endpoint = "/rag/query"
    too_big = _size_guard(request)
    if too_big is not None:
        return too_big
    graceful = _wants_graceful(None, request)
    try:
        req = RagQueryRequest.model_validate(await _body_of(request))
        chunks = rag.query(req.query, req.k)
        return JSONResponse(status_code=200, content=[c.model_dump(mode="json", by_alias=True) for c in chunks])
    except EngineUnavailable as exc:
        return _unavailable(exc, endpoint=endpoint, slot="rag", graceful=graceful)
    except Exception as exc:  # noqa: BLE001
        return _internal_error(exc, endpoint, graceful)


@app.get("/rag/status")
async def rag_status() -> JSONResponse:
    result = rag.status()
    return JSONResponse(status_code=200, content=result.model_dump(mode="json", by_alias=True,
                                                                    exclude_none=True))


@app.get("/")
async def root() -> dict[str, Any]:
    cfg = _settings()
    return {
        "service": "nexus-ai-service",
        "version": SERVICE_VERSION,
        "endpoints": [
            "GET /health", "POST /transcribe", "POST /speak", "POST /analyze", "POST /ocr",
            "POST /screenshot", "GET /screenshot/windows", "POST /embed", "POST /rag/index",
            "POST /rag/query", "GET /rag/status",
        ],
        "baseUrl": cfg.base_url,
        "errorContract": "503 + {ok:false,reason,engine,detail} som standard; "
                         "graceful:true (body/header X-Nexus-Graceful/query) ger 200 + text:''",
    }


def _bootstrap_logging() -> None:
    cfg = _settings()
    logging_setup.configure(cfg.log_level, cfg.log_path)
    log.info(
        "ai-service startar (version %s) — root=%s logg=%s",
        SERVICE_VERSION, cfg.root, cfg.log_path,
    )


@app.on_event("startup")
async def _on_startup() -> None:  # pragma: no cover - bara serverside
    _bootstrap_logging()


def main() -> None:  # pragma: no cover - entrypoint för `python -m app.main`
    import uvicorn

    _bootstrap_logging()
    cfg = _settings()
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level=cfg.log_level, access_log=False)


if __name__ == "__main__":  # pragma: no cover
    main()
