"""HTTP service.

    GET  /health      -> { ok, ready, model, device, compute_type, beam_size, load_ms, warmup_ms, error?, attempts }
    POST /transcribe  body: raw PCM s16le mono; query: sample_rate (default 16000), prompt (optional)
                      -> { text, language, duration, speech_duration, segments, latency_ms, model, device, compute_type }

The model loads in a background thread right after the socket is bound, so
/health answers immediately (ready=false while loading) and the supervisor sees
a live process. /transcribe returns 503 until the model is ready.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from aiohttp import web

from .audio import AudioError, decode_body
from .config import Settings
from .engine import Engine
from .watchdog import watch_parent

log = logging.getLogger("evol_stt")

ENGINE: web.AppKey[Engine] = web.AppKey("engine", Engine)
#: All model work (load, warm-up, inference) runs on ONE thread: CTranslate2 keeps
#: per-thread CUDA state, so a request on a fresh thread pays a ~250 ms first-use
#: penalty that the warm-up would not have absorbed.
MODEL_THREAD: web.AppKey[ThreadPoolExecutor] = web.AppKey("model_thread", ThreadPoolExecutor)
LOADING: web.AppKey[asyncio.Future[Any]] = web.AppKey("loading", asyncio.Future)


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


async def health(request: web.Request) -> web.Response:
    eng = request.app[ENGINE]
    a = eng.active
    return web.json_response({
        "ok": eng.error is None,
        "ready": eng.ready,
        "model": a.model if a else None,
        "device": a.device if a else None,
        "compute_type": a.compute_type if a else None,
        "beam_size": eng.beam_size if a else None,
        "load_ms": round(eng.load_ms) if eng.load_ms is not None else None,
        "warmup_ms": round(eng.warmup_ms) if eng.warmup_ms is not None else None,
        **({"error": eng.error} if eng.error else {}),
        "attempts": eng.attempts,
    })


async def transcribe(request: web.Request) -> web.Response:
    eng = request.app[ENGINE]
    if not eng.ready:
        return _error(503, eng.error or "model is still loading")
    try:
        sample_rate = int(request.query.get("sample_rate", "16000"))
    except ValueError:
        return _error(400, "sample_rate must be an integer")
    prompt = request.query.get("prompt") or None
    if prompt and len(prompt) > 1000:
        prompt = prompt[:1000]  # Whisper only uses the last ~224 prompt tokens anyway
    t0 = time.perf_counter()
    body = await request.read()
    try:
        audio = decode_body(body, sample_rate)
    except AudioError as e:
        return _error(400, str(e))
    if audio.size == 0:
        return web.json_response({"text": "", "language": eng.settings.language, "duration": 0.0, "speech_duration": 0.0,
                                  "segments": [], "latency_ms": 0.0})
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(request.app[MODEL_THREAD], eng.transcribe, audio, prompt)
    except Exception as e:  # noqa: BLE001
        log.exception("transcription failed")
        return _error(500, f"{type(e).__name__}: {e}")
    # latency_ms = request decode + inference (what the caller waits for, minus network).
    result["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    log.info("%.0f ms  %.2fs audio  %r", result["latency_ms"], result["duration"], result["text"])
    return web.json_response(result)


def _loader(exit_on_failure: bool):
    async def start_loading(app: web.Application) -> None:
        eng = app[ENGINE]
        loop = asyncio.get_running_loop()

        def load() -> None:
            try:
                eng.load()
            except Exception as e:  # noqa: BLE001 - reported via /health
                log.error("%s", e)
                if exit_on_failure:
                    # Let the supervisor restart us with backoff (e.g. the model
                    # download failed because the network was down).
                    logging.shutdown()
                    os._exit(3)

        app[LOADING] = loop.run_in_executor(app[MODEL_THREAD], load)

    return start_loading


def create_app(settings: Settings | None = None, engine: Engine | None = None, load: bool = True,
               exit_on_failure: bool = False) -> web.Application:
    """Build the aiohttp app. ``load`` starts model loading on startup (tests may
    pass a pre-loaded or fake engine with load=False)."""
    settings = settings or Settings()
    app = web.Application(client_max_size=settings.max_body)
    app[ENGINE] = engine or Engine(settings)
    app[MODEL_THREAD] = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")

    async def shutdown(app: web.Application) -> None:
        app[MODEL_THREAD].shutdown(wait=False, cancel_futures=True)

    app.on_cleanup.append(shutdown)
    app.router.add_get("/health", health)
    app.router.add_post("/transcribe", transcribe)
    if load:
        app.on_startup.append(_loader(exit_on_failure))
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    # Per-request library chatter ("Processing audio with duration ...", HF HTTP calls)
    # would flood the supervisor's log tail.
    for noisy in ("faster_whisper", "httpx", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    settings = Settings()
    log.info("evol-stt on http://%s:%d (model=%s device=%s compute=%s beam=%s)",
             settings.host, settings.port, settings.model, settings.device, settings.compute_type, settings.beam_size or "auto")
    # Exit promptly on Ctrl+C / supervisor kill even while a model is loading.
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    if settings.watch_parent:
        watch_parent()
    web.run_app(create_app(settings, exit_on_failure=True), host=settings.host, port=settings.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
