# evol-stt: speech-to-text service

A small HTTP service on `127.0.0.1:8790` that turns push-to-talk audio into
text with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(CTranslate2). The EvolSpace server (`apps/server/src/voice`) posts each
utterance here, then routes the transcript to a fast-path command or to Claude.

The server supervises it as the source `library/sources/stt/source.json`
(`autostart: true`), so you normally never start it by hand.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{ ok, ready, model, device, compute_type, beam_size, load_ms, warmup_ms, error?, attempts }`. `ready` is false while the model loads (about 2 s when cached). |
| `POST` | `/transcribe?sample_rate=16000&prompt=...` | Body: raw PCM s16le mono. Other rates are resampled to 16 kHz. `prompt` is a vocabulary hint (Whisper `initial_prompt`). Returns `{ text, language, duration, speech_duration, segments[{start,end,text,avg_logprob,no_speech_prob}], latency_ms, model, device, compute_type }`. |

Errors: `400` for a malformed body or rate, `503` while the model is loading,
`500` if inference fails. A body that is empty or all silence returns
`text: ""`, because the Silero VAD filter drops non-speech before decoding.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `EVOL_STT_MODEL` | `auto` | Whisper model (`small.en`, `base.en`, `tiny.en`, `medium.en`, `large-v3-turbo`, or a path). `auto` follows the measured plan below. |
| `EVOL_STT_DEVICE` | `auto` | `cuda`, `cpu` or `auto` (CUDA first, then CPU). |
| `EVOL_STT_COMPUTE` | `auto` | CTranslate2 compute type (`int8`, `int8_float32`, `float32`). |
| `EVOL_STT_BEAM` | `0` (auto) | Beam width. Auto uses 5 on CUDA (no extra cost on short clips) and 1 on CPU. |
| `EVOL_STT_TEMPERATURES` | `0` | Comma list. More than one value turns on Whisper's temperature fallback, which is slower on bad audio. |
| `EVOL_STT_LANGUAGE` | `en` | Forced to `en` for `.en` models. |
| `EVOL_STT_CPU_THREADS` | `0` | `0` uses the library default. |
| `EVOL_STT_MODELS_DIR` | HF cache | Where models are downloaded. |
| `EVOL_STT_HOST` / `EVOL_STT_PORT` | `127.0.0.1` / `8790` | Bind address. |
| `EVOL_STT_WATCH_PARENT` | `1` | Exit when the launching process dies (see "No orphans" below). `0` disables it. |

**Auto selection** (`evol_stt/engine.py: AUTO_PLAN`): the service tries
`small.en` on cuda/int8, then cuda/int8_float32, then cuda/float32, then
`tiny.en` on cpu/int8, then `base.en` on cpu/int8. For each config it loads the
model **and runs a warm-up inference**. A config counts as working only if both
succeed, because CUDA problems such as missing DLLs or missing kernels for the
GPU architecture often show up only at the first inference. Failed attempts are
listed in `/health.attempts`. If no config works, the process exits with code 3
and the supervisor restarts it with backoff.

Models load from the local Hugging Face cache first, so startup works offline.
The service downloads a model only when it is missing.

**No orphans.** The supervisor kills the whole process tree when it stops or
restarts the source. If the EvolSpace server itself dies hard, though, an
orphaned STT process would keep port 8790 and about 1 GB of VRAM, and the next
server's copy could not bind. So the service watches the process that launched
it and exits when that process goes away (`evol_stt/watchdog.py`). On Windows,
`.venv\Scripts\python.exe` is a launcher that runs the real interpreter as its
child. The watchdog skips that launcher and watches its parent instead: the
Node server, or your shell when you run the service by hand.

## Measured latency (GTX 1080 / i7-7700K, Windows 10, driver 582.28)

Test audio: Windows SAPI (Zira) phrases, 16 kHz, VAD on, vocabulary prompt on.
Latency is the service-side median of 3 runs. Short means clips under 3 s,
which covers typical commands such as "Delete this." or "Switch to
passthrough.". The longest clip is a 6 s sentence. WER is the mean over 9
phrases. Most remaining "errors" are `passthrough` transcribed as
`pass through`, and SAPI's "Claude" heard as "clog" or "clock"; the matcher
patterns cover both.

| Config | Short median | Short max | 6 s clip | WER clean | WER at 10 dB SNR |
|---|---|---|---|---|---|
| **small.en cuda int8, beam 5 (default)** | **~170 ms** | 200 ms | 390 ms | 0.03 | **0.00** |
| small.en cuda int8, beam 1 | 169 ms | 200 ms | 414 ms | 0.03 | 0.03 |
| small.en cuda int8_float32 | 193 ms | 313 ms | 326 ms | 0.03 | — |
| small.en cuda float32 | 180 ms | 203 ms | 307 ms | 0.03 | — |
| base.en cuda int8_float32 | 70 ms | 84 ms | 191 ms | 0.10 | — |
| distil-small.en cuda int8_float32 | 125 ms | 139 ms | 187 ms | 0.10 | — |
| medium.en cuda int8 | 386 ms | 416 ms | 737 ms | 0.00 | 0.03 |
| large-v3-turbo cuda int8 | 505 ms | 514 ms | 592 ms | 0.03 | 0.00 |
| distil-medium.en cuda | 280 ms | — | — | **0.60, broken on short clips** | — |
| tiny.en cpu int8 (CPU fallback) | 360 ms | 394 ms | 443 ms | 0.00 | 0.03 |
| base.en cpu int8 | 684 ms | 758 ms | 758 ms | 0.10 | 0.13 |
| small.en cpu int8 | 2206 ms | 3963 ms | — | 0.03 | — |
| distil-small.en cpu int8 | 1945 ms | 5942 ms | — | 0.10 | — |

What the measurements show:
- **CUDA works on Pascal (sm_61)** with the int8, int8_float32 and float32
  compute types; float16 is not offered. The three types are within about
  20 ms of each other on `small.en`. `int8` is the default because it uses the
  least VRAM.
- `small.en` on CUDA is the best trade-off. Bigger models (`medium.en`,
  `large-v3-turbo`) cost 2–3× the latency and were no more accurate on short
  commands. At 0 dB SNR every model fails in the same way.
- Beam 5 costs nothing extra on the GPU for short clips and fixed the noisy
  errors.
- On CPU, `tiny.en` beat `base.en` on both latency and measured accuracy.
  `small.en` on CPU is too slow (over 2 s).
- Whole pipeline (WebSocket audio, voice service, STT, matcher, command): about
  **165–240 ms** from releasing push-to-talk to `voice.result`, measured
  through `apps/server/src/voice/test/real-stt.e2e.test.ts` and over a real
  server WebSocket.
- All model work (load, warm-up, inference) runs on **one dedicated thread**.
  CTranslate2 keeps CUDA state per thread, and a request on a fresh thread
  measured about 450 ms instead of about 200 ms.

To re-measure on other hardware:
`.venv\Scripts\python.exe bench\benchmark.py [--snr 10] [--configs small.en:cuda:int8 ...]`

## Setup / run / test

```powershell
cd python\stt
uv venv --python 3.12      # once
uv sync                    # installs faster-whisper, aiohttp, CUDA 12 cuBLAS/cuDNN wheels, pytest
.venv\Scripts\python.exe -m evol_stt               # run standalone (normally the server supervises it)
.venv\Scripts\python.exe -m pytest                 # fast tests (fake engine, fallback logic, HTTP layer, parent watchdog)
.venv\Scripts\python.exe -m pytest -m slow -s      # real model + SAPI speech, prints a latency table
```

Linux/macOS: the same with `.venv/bin/python` (CPU fallback without an NVIDIA GPU). The `slow` speech tests and
`bench/` synthesize speech with Windows SAPI, so they skip/need Windows.

## Layout

- `evol_stt/server.py`: aiohttp app, `/health` and `/transcribe`. The model
  loads in the background after the port is bound, so `/health` answers right
  away and the supervisor sees a live process.
- `evol_stt/engine.py`: candidate plan, load plus warm-up fallback, and
  `transcribe()` (VAD, prompt, no conditioning on previous text, no
  timestamps).
- `evol_stt/cuda.py`: adds the `nvidia-*` wheel `bin/` folders to the Windows
  DLL search path before CTranslate2 is imported. CTranslate2 bundles cuDNN
  but needs cuBLAS 12.
- `evol_stt/audio.py`: PCM decoding and resampling.
- `evol_stt/watchdog.py`: exits the service when the launching process dies.
  Uses Win32 through ctypes, so it needs no extra dependency.
- `bench/tts.ps1`: SAPI phrase synthesizer (16 kHz mono WAV).
  `bench/phrases.json` holds the phrases and `bench/benchmark.py` runs the
  config sweep.
