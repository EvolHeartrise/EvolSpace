"""Fast tests: audio helpers, config expansion, fallback selection, HTTP layer (fake engine)."""

from __future__ import annotations

import asyncio
import sys
import types

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer

from evol_stt.audio import AudioError, decode_body, pcm16_to_float, resample
from evol_stt.config import Settings
from evol_stt.engine import AUTO_PLAN, Candidate, Engine, candidates
from evol_stt.server import create_app


def settings(**kw) -> Settings:
    s = Settings()
    for k, v in kw.items():
        setattr(s, k, v)
    return s


# ---------------------------------------------------------------- audio

def test_pcm16_to_float_scales_and_validates():
    pcm = np.array([0, 16384, -32768, 32767], dtype="<i2").tobytes()
    x = pcm16_to_float(pcm)
    assert x.dtype == np.float32
    assert x.tolist() == pytest.approx([0.0, 0.5, -1.0, 32767 / 32768])
    with pytest.raises(AudioError):
        pcm16_to_float(b"\x00\x01\x02")


def test_resample_rates():
    x = np.sin(np.arange(48000) / 48000 * 2 * np.pi * 440).astype(np.float32)
    y = resample(x, 48000)  # integer decimation path
    assert y.size == 16000 and y.dtype == np.float32
    z = resample(x[:44100], 44100)  # interpolation path
    assert abs(z.size - 16000) <= 1
    assert resample(x[:100], 16000) is not None and resample(x[:100], 16000).size == 100
    with pytest.raises(AudioError):
        resample(x, 1000)
    assert decode_body(b"", 16000).size == 0


# ---------------------------------------------------------------- config expansion

def test_candidates_auto_uses_measured_plan():
    assert candidates(settings(model="auto", device="auto", compute_type="auto")) == AUTO_PLAN
    cpu = candidates(settings(model="auto", device="cpu", compute_type="auto"))
    assert cpu and all(c.device == "cpu" for c in cpu)
    forced = candidates(settings(model="auto", device="cuda", compute_type="float32"))
    assert all(c.compute_type == "float32" and c.device == "cuda" for c in forced)
    assert len(forced) == len(set(forced))  # de-duplicated


def test_candidates_pinned_model():
    plan = candidates(settings(model="base.en", device="auto", compute_type="auto"))
    assert plan[0] == Candidate("base.en", "cuda", "int8")
    assert plan[-1].device == "cpu"
    assert candidates(settings(model="base.en", device="cpu", compute_type="int8")) == [Candidate("base.en", "cpu", "int8")]


# ---------------------------------------------------------------- fallback selection

class _Seg:
    def __init__(self, text: str):
        self.text, self.start, self.end, self.avg_logprob, self.no_speech_prob = text, 0.0, 1.0, -0.1, 0.01


class _Info:
    language, duration, duration_after_vad = "en", 1.0, 0.8


def _fake_whisper(monkeypatch, broken: set[tuple[str, str]], fail_at: str = "load"):
    """Install a fake faster_whisper.WhisperModel; configs in `broken` fail at load or first inference."""
    calls: list[dict] = []

    class FakeModel:
        def __init__(self, name, device, compute_type, **kw):
            self.key = (device, compute_type)
            if fail_at == "load" and self.key in broken:
                raise RuntimeError(f"cannot load {self.key}")

        def transcribe(self, audio, **kw):
            if fail_at == "infer" and self.key in broken:
                raise RuntimeError("CUDA failed with error no kernel image is available for execution on the device")
            calls.append(kw)
            return iter([_Seg(" hello world")]), _Info()

    mod = types.ModuleType("faster_whisper")
    mod.WhisperModel = FakeModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", mod)
    return calls


@pytest.mark.parametrize("fail_at", ["load", "infer"])
def test_auto_falls_back_to_cpu(monkeypatch, fail_at):
    _fake_whisper(monkeypatch, {("cuda", "int8"), ("cuda", "int8_float32"), ("cuda", "float32")}, fail_at)
    eng = Engine(settings(model="auto", device="auto", compute_type="auto", beam_size=0))
    chosen = eng.load()
    assert chosen.device == "cpu"
    assert len(eng.attempts) == 3 and all("cuda" in a["config"] for a in eng.attempts)
    assert eng.ready and eng.beam_size == 1


def test_all_configs_failing_reports_error(monkeypatch):
    _fake_whisper(monkeypatch, {(c.device, c.compute_type) for c in AUTO_PLAN})
    eng = Engine(settings(model="auto", device="auto", compute_type="auto"))
    with pytest.raises(RuntimeError):
        eng.load()
    assert not eng.ready and eng.error and "no working STT config" in eng.error


def test_transcribe_passes_prompt_vad_and_beam(monkeypatch):
    calls = _fake_whisper(monkeypatch, set())
    eng = Engine(settings(model="small.en", device="cuda", compute_type="int8", beam_size=0))
    eng.load()
    calls.clear()
    r = eng.transcribe(np.zeros(16000, dtype=np.float32), prompt="Claude, widget.")
    assert r["text"] == "hello world"
    assert r["duration"] == 1.0 and r["speech_duration"] == 0.8
    assert r["model"] == "small.en" and r["device"] == "cuda"
    kw = calls[0]
    assert kw["initial_prompt"] == "Claude, widget." and kw["vad_filter"] is True
    assert kw["beam_size"] == 5 and kw["language"] == "en" and kw["condition_on_previous_text"] is False


# ---------------------------------------------------------------- HTTP layer

class FakeEngine:
    def __init__(self, ready=True):
        self.settings = settings()
        self.ready = ready
        self.error = None if ready else None
        self.active = Candidate("fake", "cpu", "int8") if ready else None
        self.load_ms, self.warmup_ms, self.attempts, self.beam_size = 1.0, 2.0, [], 1
        self.seen: list[tuple[int, str | None]] = []

    def transcribe(self, audio, prompt=None):
        self.seen.append((audio.size, prompt))
        return {"text": "undo", "language": "en", "duration": audio.size / 16000, "segments": [], "latency_ms": 1.0}


def _run(coro):
    return asyncio.run(coro)


def test_http_transcribe_and_health():
    async def go():
        eng = FakeEngine()
        async with TestClient(TestServer(create_app(engine=eng, load=False))) as c:
            h = await (await c.get("/health")).json()
            assert h["ready"] is True and h["model"] == "fake"
            pcm = (np.ones(48000, dtype="<i2") * 1000).tobytes()  # 1 s at 48 kHz
            r = await c.post("/transcribe?sample_rate=48000&prompt=Claude", data=pcm)
            assert r.status == 200
            j = await r.json()
            assert j["text"] == "undo" and j["latency_ms"] >= 0
            assert eng.seen == [(16000, "Claude")]  # resampled to 16 kHz
            assert (await c.post("/transcribe?sample_rate=abc", data=pcm)).status == 400
            assert (await c.post("/transcribe", data=b"\x00\x01\x02")).status == 400
            empty = await (await c.post("/transcribe", data=b"")).json()
            assert empty["text"] == ""
    _run(go())


def test_http_503_while_loading():
    async def go():
        async with TestClient(TestServer(create_app(engine=FakeEngine(ready=False), load=False))) as c:
            r = await c.post("/transcribe", data=b"\x00\x00" * 1600)
            assert r.status == 503
            assert (await (await c.get("/health")).json())["ready"] is False
    _run(go())
