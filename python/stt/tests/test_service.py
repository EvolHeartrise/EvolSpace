"""End-to-end: start the real service (``python -m evol_stt``) on a free port,
POST SAPI-synthesized speech as raw PCM and check the transcripts.

Slow (loads Whisper; first run downloads weights) and Windows-only (SAPI).
Run:  .venv\\Scripts\\python.exe -m pytest -m slow -s
Prints a per-phrase latency table for each config.
"""

from __future__ import annotations

import json
import os
import re
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pytest

from evol_stt.audio import read_wav, resample

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "bench"

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(sys.platform != "win32", reason="needs Windows SAPI for speech synthesis"),
]

#: phrase id -> regex the normalized transcript must match
EXPECT = {
    "undo": r"^undo$",
    "delete-this": r"^delete this$",
    "duplicate-that": r"^duplicate that$",
    "passthrough": r"^switch to pass ?through$",
    "save": r"^save (the )?workspace$",
    "bigger-red": r"make this bigger",
    "resid": r"residual flow",
}


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s.lower().replace("'", ""))).strip()


@pytest.fixture(scope="session")
def wavs(tmp_path_factory) -> dict[str, np.ndarray]:
    out = tmp_path_factory.mktemp("wav")
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(BENCH / "tts.ps1"),
         "-OutDir", str(out), "-Phrases", str(BENCH / "phrases.json")],
        check=True, capture_output=True,
    )
    phrases = json.loads((BENCH / "phrases.json").read_text(encoding="utf-8"))
    audio = {}
    for p in phrases:
        x, rate = read_wav(str(out / f"{p['id']}.wav"))
        audio[p["id"]] = resample(x, rate)
    return audio


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_json(url: str, timeout: float = 2.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


class Service:
    def __init__(self, env: dict[str, str], log_file: Path):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        e = {**os.environ, "EVOL_STT_PORT": str(self.port), "PYTHONUNBUFFERED": "1", **env}
        # Log to a file: an undrained PIPE (4 KB on Windows) would block the service.
        self.log_file = log_file
        self._log = open(log_file, "wb")
        self.proc = subprocess.Popen([sys.executable, "-m", "evol_stt"], cwd=ROOT, env=e,
                                     stdout=self._log, stderr=subprocess.STDOUT)

    def log(self) -> str:
        return self.log_file.read_text(encoding="utf-8", errors="replace")[-3000:]

    def wait_ready(self, timeout: float = 600) -> dict:
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"service exited: {self.log()}")
            try:
                h = get_json(self.url + "/health")
                if h.get("ready"):
                    return h
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(0.25)
        raise TimeoutError("service did not become ready")

    def transcribe(self, x: np.ndarray, prompt: str | None = None, rate: int = 16000) -> tuple[dict, float]:
        pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
        q = f"sample_rate={rate}" + (f"&prompt={urllib.parse.quote(prompt)}" if prompt else "")
        req = urllib.request.Request(f"{self.url}/transcribe?{q}", data=pcm, method="POST",
                                     headers={"content-type": "application/octet-stream"})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read())
        return j, (time.perf_counter() - t0) * 1000

    def stop(self) -> None:
        self.proc.kill()
        self.proc.wait(10)
        self._log.close()


PROMPT = "Voice commands for EvolSpace and Claude: Claude, widget, passthrough, residual flow, workspace."


@pytest.mark.parametrize("label,env", [
    ("auto", {"EVOL_STT_MODEL": "auto", "EVOL_STT_DEVICE": "auto"}),
    ("cpu-fallback", {"EVOL_STT_MODEL": "auto", "EVOL_STT_DEVICE": "cpu"}),
])
def test_transcribes_sapi_speech(wavs, tmp_path, label, env):
    svc = Service(env, tmp_path / "service.log")
    try:
        health = svc.wait_ready()
        assert health["ok"] is True
        if label == "cpu-fallback":
            assert health["device"] == "cpu"
        rows = []
        for pid, x in wavs.items():
            lat = []
            for _ in range(3):
                r, wall = svc.transcribe(x, PROMPT)
                lat.append(wall)
            rows.append((pid, x.size / 16000, statistics.median(lat), r["latency_ms"], r["text"]))
        print(f"\n[{label}] {health['model']} on {health['device']}/{health['compute_type']} "
              f"beam {health['beam_size']} (load {health['load_ms']} ms, warm-up {health['warmup_ms']} ms)")
        for pid, dur, wall, svc_ms, text in rows:
            print(f"  {pid:15s} {dur:4.1f}s audio  {wall:6.0f} ms wall  {svc_ms:6.0f} ms service  {text!r}")
        texts = {pid: normalize(text) for pid, _, _, _, text in rows}
        for pid, pattern in EXPECT.items():
            assert re.search(pattern, texts[pid]), f"{pid}: {texts[pid]!r} !~ {pattern}"
        short = [wall for pid, dur, wall, _, _ in rows if dur < 3.0]
        # Short commands must come back in well under a second on either path.
        assert statistics.median(short) < 1000

        # 48 kHz input is resampled by the service.
        x48 = np.repeat(wavs["undo"], 3)
        r, _ = svc.transcribe(x48, PROMPT, rate=48000)
        assert normalize(r["text"]) == "undo"

        # Silence → VAD drops everything → empty text (no "Thank you." hallucination).
        r, _ = svc.transcribe(np.zeros(16000, dtype=np.float32), PROMPT)
        assert r["text"] == ""
    finally:
        svc.stop()
