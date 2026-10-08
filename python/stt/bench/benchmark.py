"""Benchmark STT configs on SAPI-synthesized utterances.

    .venv\\Scripts\\python.exe bench\\benchmark.py [--configs small.en:cuda:int8_float32 ...] [--repeat 3] [--json out.json]

Generates WAVs from bench/phrases.json with Windows SAPI (bench/tts.ps1), then
for each config: load, warm up, transcribe every phrase ``repeat`` times and
report median latency (ms) and word error rate against the reference text.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import numpy as np  # noqa: E402

from evol_stt.audio import read_wav, resample  # noqa: E402
from evol_stt.config import Settings  # noqa: E402
from evol_stt.engine import Engine  # noqa: E402

DEFAULT_CONFIGS = [
    "tiny.en:cpu:int8",
    "base.en:cpu:int8",
    "small.en:cpu:int8",
    "distil-small.en:cpu:int8",
    "base.en:cuda:int8_float32",
    "small.en:cuda:int8",
    "small.en:cuda:int8_float32",
    "small.en:cuda:float32",
    "distil-small.en:cuda:int8_float32",
    "distil-medium.en:cuda:int8_float32",
    "medium.en:cuda:int8_float32",
    "large-v3-turbo:cuda:int8_float32",
]

PROMPT = "EvolSpace, Claude, widget, passthrough, residual flow, slider, sphere, workspace."


def normalize(s: str) -> list[str]:
    s = s.lower().replace("-", " ")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return s.split()


def wer(ref: str, hyp: str) -> float:
    r, h = normalize(ref), normalize(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[len(h)] / max(1, len(r))


def synth(out_dir: Path) -> list[dict]:
    phrases = json.loads((HERE / "phrases.json").read_text(encoding="utf-8"))
    missing = [p for p in phrases if not (out_dir / f"{p['id']}.wav").exists()]
    if missing:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "tts.ps1"),
             "-OutDir", str(out_dir), "-Phrases", str(HERE / "phrases.json")],
            check=True, capture_output=True,
        )
    return phrases


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", nargs="*", default=DEFAULT_CONFIGS, help="model:device:compute_type")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--beam", type=int, default=0, help="0 = engine default (5 on CUDA, 1 on CPU)")
    ap.add_argument("--wav-dir", default=str(Path(tempfile.gettempdir()) / "evol-stt-bench"))
    ap.add_argument("--json", default=None)
    ap.add_argument("--snr", type=float, default=None,
                    help="add white noise at this SNR (dB) plus 300 ms of leading/trailing noise, like a real PTT clip")
    args = ap.parse_args()

    wav_dir = Path(args.wav_dir)
    phrases = synth(wav_dir)
    audio = {}
    for p in phrases:
        x, rate = read_wav(str(wav_dir / f"{p['id']}.wav"))
        x = resample(x, rate)
        if args.snr is not None:
            rng = np.random.default_rng(len(p["id"]))
            pad = np.zeros(4800, dtype=np.float32)
            x = np.concatenate([pad, x, pad])
            sig = float(np.sqrt(np.mean(x[x != 0] ** 2)))
            x = (x + rng.standard_normal(x.size) * sig / (10 ** (args.snr / 20))).astype(np.float32)
        audio[p["id"]] = x

    results = []
    for spec in args.configs:
        model, device, compute = spec.split(":")
        settings = Settings()
        settings.model, settings.device, settings.compute_type, settings.beam_size = model, device, compute, args.beam
        eng = Engine(settings)
        t0 = time.perf_counter()
        try:
            eng.load()
        except Exception as e:  # noqa: BLE001
            print(f"{spec:40s} FAILED: {e}", flush=True)
            results.append({"config": spec, "error": str(e)})
            continue
        load_s = time.perf_counter() - t0
        rows = []
        for p in phrases:
            lats, text = [], ""
            for _ in range(args.repeat):
                r = eng.transcribe(audio[p["id"]], prompt=PROMPT)
                lats.append(r["latency_ms"])
                text = r["text"]
            rows.append({"id": p["id"], "ref": p["text"], "hyp": text, "wer": wer(p["text"], text),
                         "audio_s": audio[p["id"]].size / 16000, "median_ms": statistics.median(lats)})
        short = [r for r in rows if r["audio_s"] < 3.0]
        summary = {
            "config": spec,
            "load_s": round(load_s, 1),
            "warmup_ms": round(eng.warmup_ms or 0),
            "short_median_ms": round(statistics.median(r["median_ms"] for r in short)),
            "short_max_ms": round(max(r["median_ms"] for r in short)),
            "long_max_ms": round(max(r["median_ms"] for r in rows)),
            "mean_wer": round(statistics.mean(r["wer"] for r in rows), 3),
            "rows": rows,
        }
        results.append(summary)
        print(f"{spec:40s} short median {summary['short_median_ms']:5d} ms  short max {summary['short_max_ms']:5d} ms  "
              f"longest {summary['long_max_ms']:5d} ms  WER {summary['mean_wer']:.3f}  (load {summary['load_s']} s)", flush=True)
        for r in rows:
            if r["wer"] > 0:
                print(f"    {r['id']:15s} wer={r['wer']:.2f}  '{r['hyp']}'", flush=True)
        del eng
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
