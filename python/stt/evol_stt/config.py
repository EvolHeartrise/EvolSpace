"""Service settings from environment variables (all optional)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    v = os.environ.get(name, "").strip()
    return v or default


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_float_list(name: str, default: list[float]) -> list[float]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return [float(p) for p in raw.split(",") if p.strip()]
    except ValueError:
        return default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("EVOL_STT_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("EVOL_STT_PORT", 8790))
    #: Whisper model name ("small.en", "distil-small.en", ...) or path, or "auto".
    model: str = field(default_factory=lambda: _env("EVOL_STT_MODEL", "auto"))
    #: "auto" | "cuda" | "cpu".
    device: str = field(default_factory=lambda: _env("EVOL_STT_DEVICE", "auto"))
    #: CTranslate2 compute type ("int8", "int8_float32", "float32", ...) or "auto".
    compute_type: str = field(default_factory=lambda: _env("EVOL_STT_COMPUTE", "auto"))
    #: CPU threads for CTranslate2 (0 = library default = physical cores).
    cpu_threads: int = field(default_factory=lambda: _env_int("EVOL_STT_CPU_THREADS", 0))
    #: Beam width; 0 = auto (5 on CUDA, 1 on CPU).
    beam_size: int = field(default_factory=lambda: _env_int("EVOL_STT_BEAM", 0))
    #: Decoding temperatures; more than one enables Whisper's fallback (slower on bad audio).
    temperatures: list[float] = field(default_factory=lambda: _env_float_list("EVOL_STT_TEMPERATURES", [0.0]))
    language: str = field(default_factory=lambda: _env("EVOL_STT_LANGUAGE", "en"))
    #: Where models are downloaded (default: the Hugging Face cache).
    models_dir: str | None = field(default_factory=lambda: os.environ.get("EVOL_STT_MODELS_DIR") or None)
    #: Largest accepted request body (bytes). 16 MB ~ 8 min of 16 kHz PCM16.
    max_body: int = field(default_factory=lambda: _env_int("EVOL_STT_MAX_BODY", 16 * 1024 * 1024))
    #: Exit when the launching process (the EvolSpace server) dies, so a crashed
    #: server never leaves an orphan holding the port and GPU memory. "0" disables.
    watch_parent: bool = field(default_factory=lambda: _env("EVOL_STT_WATCH_PARENT", "1") not in ("0", "false", "no"))
