"""Whisper engine: picks a working (model, device, compute_type), warms it up and
transcribes utterances.

"auto" resolution walks :data:`AUTO_PLAN` (measured on the target machine, see
README) and keeps the first config that loads AND survives a warm-up inference.
CUDA problems (missing DLLs, no kernels for the GPU's architecture, OOM) often
surface only at the first inference, which is why warm-up is part of selection.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from .audio import WHISPER_RATE
from .config import Settings
from .cuda import register_cuda_dlls

log = logging.getLogger("evol_stt")


@dataclass(frozen=True)
class Candidate:
    model: str
    device: str
    compute_type: str

    def __str__(self) -> str:
        return f"{self.model} on {self.device}/{self.compute_type}"


#: Preferred configs, best first. Measured on GTX 1080 (Pascal sm_61, no fast
#: float16) + i7-7700K with SAPI speech, see README "Measured latency":
#:   small.en cuda/int8 ~170 ms per short command (beam 5), lowest WER of all
#:   configs under noise; medium.en ~400 ms and large-v3-turbo ~500 ms were not
#:   more accurate on short commands. int8_float32 / float32 are within ~20 ms
#:   and only kept as fallbacks. CPU: tiny.en ~350 ms beat base.en (~700 ms) on
#:   both latency and measured accuracy; small.en on CPU (~2.2 s) is too slow.
AUTO_PLAN: list[Candidate] = [
    Candidate("small.en", "cuda", "int8"),
    Candidate("small.en", "cuda", "int8_float32"),
    Candidate("small.en", "cuda", "float32"),
    Candidate("tiny.en", "cpu", "int8"),
    Candidate("base.en", "cpu", "int8"),
]

#: When a model is pinned but the device/compute is "auto".
DEVICE_PLAN: list[tuple[str, str]] = [
    ("cuda", "int8"),
    ("cuda", "int8_float32"),
    ("cuda", "float32"),
    ("cpu", "int8"),
    ("cpu", "float32"),
]


def candidates(settings: Settings) -> list[Candidate]:
    """Expand the settings' model/device/compute ("auto" or explicit) into an ordered list."""
    model, device, compute = settings.model, settings.device, settings.compute_type
    if model == "auto":
        plan = [c for c in AUTO_PLAN if device in ("auto", c.device)]
        if compute != "auto":
            plan = [Candidate(c.model, c.device, compute) for c in plan]
        if not plan:  # e.g. device=cpu but plan has no cpu entry
            plan = [Candidate("tiny.en", device, "int8" if compute == "auto" else compute)]
    else:
        pairs = [(d, ct) for d, ct in DEVICE_PLAN if device in ("auto", d)] or [(device, "int8")]
        if compute != "auto":
            pairs = [(d, compute) for d, _ in pairs]
        plan = [Candidate(model, d, ct) for d, ct in pairs]
    # De-duplicate, keep order.
    seen: set[Candidate] = set()
    return [c for c in plan if not (c in seen or seen.add(c))]


class Engine:
    """Thread-safe wrapper around one ``WhisperModel``."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model: Any = None
        self.active: Candidate | None = None
        self.load_ms: float | None = None
        self.warmup_ms: float | None = None
        self.error: str | None = None
        #: Failed attempts during selection: [{"config", "error"}].
        self.attempts: list[dict[str, str]] = []
        self._lock = threading.Lock()
        self._ready = False

    @property
    def ready(self) -> bool:
        """True once a config is loaded AND warmed up."""
        return self._ready

    @property
    def beam_size(self) -> int:
        """Configured beam, or auto: 5 on CUDA (free for short clips: +~5 ms), 1 on CPU."""
        if self.settings.beam_size > 0:
            return self.settings.beam_size
        return 5 if self.active and self.active.device == "cuda" else 1

    # ------------------------------------------------------------------ loading

    def load(self) -> Candidate:
        """Try candidates in order; keep the first that loads and warms up."""
        register_cuda_dlls()
        from faster_whisper import WhisperModel  # heavy import; after DLL setup

        plan = candidates(self.settings)
        for cand in plan:
            t0 = time.perf_counter()
            try:
                log.info("loading %s", cand)
                model = self._open(WhisperModel, cand)
                t1 = time.perf_counter()
                self.model, self.active = model, cand
                self.warmup()
                self.load_ms = (t1 - t0) * 1000
                self.error = None
                self._ready = True
                log.info("ready: %s (load %.0f ms, warm-up %.0f ms)", cand, self.load_ms, self.warmup_ms or 0)
                return cand
            except Exception as e:  # noqa: BLE001 - any failure means "try the next config"
                self.model, self.active = None, None
                msg = f"{type(e).__name__}: {e}"
                self.attempts.append({"config": str(cand), "error": msg})
                log.warning("config %s failed: %s", cand, msg)
        self.error = "no working STT config: " + "; ".join(f"{a['config']} -> {a['error']}" for a in self.attempts)
        raise RuntimeError(self.error)

    def _open(self, whisper_model: Any, cand: Candidate) -> Any:
        """Open from the local cache first (fast, works offline); download only if missing."""
        kw = dict(device=cand.device, compute_type=cand.compute_type,
                  cpu_threads=self.settings.cpu_threads, download_root=self.settings.models_dir)
        try:
            return whisper_model(cand.model, local_files_only=True, **kw)
        except Exception as e:  # noqa: BLE001
            # Not cached (huggingface_hub raises LocalEntryNotFoundError) -> download.
            # Device/compute errors would recur; re-raise those without a download attempt.
            if "LocalEntryNotFound" not in type(e).__name__ and "local" not in str(e).lower():
                raise
            log.info("downloading %s (first use)", cand.model)
            return whisper_model(cand.model, **kw)

    def warmup(self) -> None:
        """Run the full pipeline once (decoder + VAD) so the first real request is fast."""
        t0 = time.perf_counter()
        rng = np.random.default_rng(0)
        # 1 s of faint noise; VAD off so the decoder actually runs (VAD would drop it).
        noise = (rng.standard_normal(WHISPER_RATE) * 0.01).astype(np.float32)
        self._run(noise, prompt="warm up", vad=False)
        self._run(noise, prompt=None, vad=True)  # loads the Silero VAD session
        self.warmup_ms = (time.perf_counter() - t0) * 1000

    # ------------------------------------------------------------------ inference

    def transcribe(self, audio: np.ndarray, prompt: str | None = None, vad: bool = True) -> dict[str, Any]:
        """Transcribe 16 kHz float32 mono audio. Returns the HTTP response payload."""
        if self.model is None:
            raise RuntimeError(self.error or "model not loaded")
        t0 = time.perf_counter()
        segments, info = self._run(audio, prompt=prompt, vad=vad)
        latency = (time.perf_counter() - t0) * 1000
        text = " ".join(s.text.strip() for s in segments).strip()
        return {
            "text": text,
            "language": info.language,
            "duration": round(audio.size / WHISPER_RATE, 3),
            "speech_duration": round(float(getattr(info, "duration_after_vad", info.duration)), 3),
            "segments": [
                {
                    "start": round(s.start, 3),
                    "end": round(s.end, 3),
                    "text": s.text.strip(),
                    "avg_logprob": round(s.avg_logprob, 4),
                    "no_speech_prob": round(s.no_speech_prob, 4),
                }
                for s in segments
            ],
            "latency_ms": round(latency, 1),
            "model": self.active.model if self.active else None,
            "device": self.active.device if self.active else None,
            "compute_type": self.active.compute_type if self.active else None,
        }

    def _run(self, audio: np.ndarray, prompt: str | None, vad: bool) -> tuple[list[Any], Any]:
        s = self.settings
        lang = s.language if s.language and s.language != "auto" else None
        if self.active and self.active.model.endswith(".en"):
            lang = "en"
        beam = self.beam_size
        with self._lock:  # one inference at a time on one model
            segs, info = self.model.transcribe(
                audio,
                language=lang,
                beam_size=beam,
                best_of=beam,
                temperature=s.temperatures if len(s.temperatures) > 1 else s.temperatures[0],
                initial_prompt=prompt or None,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=vad,
                vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
            )
            return list(segs), info  # the generator does the decoding; consume under the lock
