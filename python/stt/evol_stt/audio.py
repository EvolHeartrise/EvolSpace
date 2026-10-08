"""PCM helpers: raw s16le bytes -> float32 mono at 16 kHz (Whisper's input rate)."""

from __future__ import annotations

import numpy as np

WHISPER_RATE = 16_000


class AudioError(ValueError):
    """Malformed audio input (bad length, unsupported rate)."""


def pcm16_to_float(data: bytes) -> np.ndarray:
    """Little-endian signed 16-bit PCM bytes -> float32 samples in [-1, 1)."""
    if len(data) % 2:
        raise AudioError(f"PCM s16le body must have an even number of bytes (got {len(data)})")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def resample(x: np.ndarray, src_rate: int, dst_rate: int = WHISPER_RATE) -> np.ndarray:
    """Resample mono audio. Integer down-sampling uses a box low-pass then decimates
    (good enough for speech recognition); other ratios use linear interpolation."""
    if src_rate == dst_rate or x.size == 0:
        return x.astype(np.float32, copy=False)
    if not 4_000 <= src_rate <= 192_000:
        raise AudioError(f"unsupported sample_rate {src_rate} (expected 4000..192000)")
    if src_rate > dst_rate and src_rate % dst_rate == 0:
        k = src_rate // dst_rate
        n = (x.size // k) * k
        return x[:n].reshape(-1, k).mean(axis=1).astype(np.float32)
    duration = x.size / src_rate
    n_out = max(1, int(round(duration * dst_rate)))
    t_out = np.arange(n_out, dtype=np.float64) / dst_rate
    t_in = np.arange(x.size, dtype=np.float64) / src_rate
    return np.interp(t_out, t_in, x).astype(np.float32)


def decode_body(data: bytes, sample_rate: int) -> np.ndarray:
    """Request body (PCM s16le mono at ``sample_rate``) -> float32 @ 16 kHz."""
    return resample(pcm16_to_float(data), sample_rate, WHISPER_RATE)


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read a PCM16 mono/stereo WAV file -> (float32 mono samples, sample rate)."""
    import wave

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise AudioError(f"{path}: only 16-bit PCM WAV is supported")
        rate = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    x = pcm16_to_float(raw)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, rate
