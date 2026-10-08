# evolinterp — interp backend

Mechanistic-interpretability backend for EvolSpace. It loads a model (the
user's **BeatSaberRL** NotePolicy, or a **toy** transformer testbed), runs an
*instrumented* forward that captures the residual stream, attention patterns
and block writes, and publishes the **interp data contract** (ARCHITECTURE.md)
so `resid-flow` / `resid-lens` can show it in XR. On top: a logit lens, linear
probes per layer, sparse autoencoders and causal interventions (head / attention
/ MLP ablations, attention blocking).

```
python/evolinterp/
  evolinterp/adapters/base.py   Adapter interface, Capture, TokenInfo, ProbeTarget
  evolinterp/adapters/bsrl.py   BeatSaberRL loader + instrumented re-implementation of _forward_stacked
  evolinterp/adapters/toy.py    toy task + model (trains in ~15 s, cached)
  evolinterp/interventions.py   intervention spec (JSON) shared by CLI / live / Python
  evolinterp/capture.py         dataset-wide capture, shared PCA basis (RMS-normalized residuals), capture.npz cache
  evolinterp/probes.py          per-layer sklearn logistic-regression probes
  evolinterp/sae.py             sparse autoencoders + automatic feature labels
  evolinterp/session.py         InterpSession: per-sample views, lens readouts, payloads
  evolinterp/contract.py        channel names, payload builder, validator
  evolinterp/live.py            the live source process
  evolinterp/lease.py           one live process per prefix (P.status owner + heartbeat)
  evolinterp/cli.py             python -m evolinterp ...
```

## Setup

```
cd python/evolinterp
uv sync                                   # Python 3.12 venv in .venv with CPU torch, sklearn, evolspace (editable)
.venv/bin/python -m evolinterp setup-bsrl   # (.venv/Scripts/python on Windows) git archive exp/bend7 python/ -> data/bsrl
```

`setup-bsrl` runs `git -C <BeatSaberRL> archive exp/bend7 python` (read-only; `$EVOL_BSRL_REPO`, default: the
`BeatSaberRL` folder next to this repo, e.g. `D:/Git/BeatSaberRL`) and
extracts into `data/bsrl/python` — it never touches the BSRL working tree or
branches. No Rust, CUDA or gymnasium is needed: `beat_arena_env` is stubbed so
only `beat_arena_env/constants.py` loads (its `__init__` imports the Rust sim).

Paths (all overridable): checkpoint `$EVOL_BSRL_CKPT` (default
`~/beat-arena-volume-backup/bend7/runs/bend7_cd1000/leaf_from_upd06000.pt`; on Windows `~` is `C:/Users/<you>`),
code `$EVOL_BSRL_CODE`, artifacts `$EVOL_INTERP_DATA` (default `data/interp`).

## Running

As a supervised source (the normal way; `autostart: false`):

| source | command |
|---|---|
| `library/sources/interp-bsrl` | `{python:python/evolinterp} -m evolinterp.live --model bsrl --checkpoint <ckpt> --prefix interp` |
| `library/sources/interp-toy`  | `{python:python/evolinterp} -m evolinterp.live --model toy --prefix interp` |

`{python:python/evolinterp}` is the server's placeholder for this folder's
`.venv` interpreter (apps/server/src/sources/process.ts `resolvePython`);
`cwd` is `../../../python/evolinterp` relative to the source folder. Both
sources also pass `--source <id>`.

**One process per prefix.** Both use prefix `interp`. Every `P.status` a live
process publishes carries `owner: {id, pid, host, source, model, prefix, since}` and
`ts`, re-published every 5 s (heartbeat, `evolinterp/lease.py`). A starting process
reads `P.status` first; if another owner is active (different id, `state` not
`stopped`, heartbeat younger than 20 s, and — on this host — its pid still alive) it
**refuses before loading anything**: it prints
`refusing to start source interp-bsrl: channel prefix 'interp.*' is already served by source interp-toy (...); stop it first (POST /api/sources/interp-toy/stop) or use another --prefix`
to stderr (visible in `GET /api/sources/<id>` `logTail` and the `source.exit`
event), asks the server to stop its own source (`--source`, so `restart: true`
does not loop), and exits with code 3. It never writes `P.status`, so the owner's
status stays intact. Restarting the owner itself works: the supervisor kills the old
process (`taskkill /F`), its pid is dead, so the successor takes over at once. A clean
exit publishes `state: "stopped"`. Two processes started within the same ~0.5 s are
settled by the heartbeat: the later claim yields (stderr, exit 3) and the earlier one
republishes everything. So: stop one interp source before starting the other
(`POST /api/sources/interp-toy/stop`), or run the second with another `--prefix`.

Start: MCP sources tool, `curl -X POST http://127.0.0.1:8787/api/sources/interp-bsrl/start`,
or `Client().source("interp-bsrl", "start")`. Logs: `GET /api/sources/interp-bsrl`.

Startup: first run captures all activations (~15 s for BSRL's 2048 samples)
into `data/interp/<model_id>/capture.npz` (format v2; older caches — raw-residual
projection — are ignored and recaptured automatically) and trains probes in a background
thread (~1–2 min; published when done). Later starts take ~2 s. SAEs found in
`data/interp/<model_id>/sae-<layer>.pt` are loaded automatically.

## CLI

```
python -m evolinterp verify    --model bsrl [--n 256]     # instrumented vs original forward (logits, value, every residual)
python -m evolinterp capture   --model bsrl [--force]     # dataset capture + PCA; prints norm/write growth per layer
python -m evolinterp probe     --model bsrl               # train probes, print accuracy table
python -m evolinterp sae-train --model bsrl --layer b5 [--features 768 --l1 3e-3 --steps 3000]
python -m evolinterp info      --model bsrl --sample 5 --layer 6 --token 8   # tokens + readout in the terminal
python -m evolinterp publish   --model bsrl --sample 5 --ablate '[{"op":"head","layer":8,"head":1}]'  # one-shot
python -m evolinterp live      --model toy  [--prefix interp --rate 4 --probes auto|load|off --threads 4 --source ID]
```

`--model toy` works everywhere; `--dataset obs.npy` (N×630) replaces the
checkpoint's `diag_probe_obs` for BSRL.

## Contract mapping (prefix `P` = `interp`)

| Channel | Produced from |
|---|---|
| `P.meta` | `model` — readable name, never a filesystem path (BSRL: `BeatSaberRL NotePolicy · bend7_cd1000 · upd 7000 (leaf from upd 6000) · 10L d192 h4`; toy: `toy red-majority transformer (3L d64 h4)`); `short_name` — compact label for titles (`BSRL bend7 · upd 7000`, `toy red-majority · 3L d64`); `checkpoint` — the path (BSRL `.pt`, toy weights cache); layers `embed, b0..b{L-1}`; tokens decoded from the observation (`label`, `group`, extra `detail`); `sample.label`; `lens`; `proj` — `{normalized: true, basis: "pca", explained_variance: [3 ratios]}`; extras: `heads`, `interventions` (human summary), `probes` |
| `P.resid.proj` f32 [L+1,T,3] | each residual vector divided by its RMS (`r / sqrt(mean(r²))` — the model reads the stream through pre-LN anyway), minus the global mean of the normalized vectors, projected on the top-3 PCs of **all** meaningful normalized residuals of the dataset (all layers, one basis), scaled so the 99th-percentile radius is 1; masked positions = 0. Direction only: magnitudes live in `P.resid.norm`. Without the normalization the basis was dominated by the late layers (norms grow ~7× with depth) and early layers collapsed onto the centre |
| `P.resid.norm` f32 [L+1,T] | ‖residual‖ (0 where masked) |
| `P.resid.delta` f32 [L,2,T] | ‖attention write‖, ‖MLP write‖ of block l (after interventions) |
| `P.resid.mask` u8 [L+1,T] | 1 = computed and not padding. BSRL: padding entity slots = 0 at every layer; the final block computes only the 5 lead tokens, so layer L entity tokens = 0 |
| `P.attn` f32 [L,H,T,T] | explicit softmax(QKᵀ/√dh) per block/head (query × key); BSRL final block: only the 5 lead query rows are non-zero |
| `P.probe.index` JSON string[] | probe names |
| `P.probe.<name>` f32 [L+1,T] | signed confidence in the **true** class, `2·P(true) − 1` ∈ [−1, 1] (+1 confidently right, 0 = P 0.5, −1 confidently wrong); **NaN = not applicable** (token kind, padding, uncomputed). Chosen for the consumers: resid-flow's `colorBy: probe` uses a diverging ramp and, like heatmap, draws non-finite values as neutral. Raw P(true): `ProbeSet.scores(..., signed=False)` |
| `P.probe.<name>.acc` f32 [L+1] | held-out accuracy per layer (NaN = no probe at that layer; `P.probe.info` has the same as JSON with `null`) |
| `P.lens.readout` JSON | see "Lens" below |
| `P.ctl.layer/token/sample/play` (in) | layer index 0..L (0 = embed), token 0..T−1, sample (wraps), play = bool, Hz, or a string of either (`"on"`, `"off"`, `"2"`; voice commands substitute strings) |

Extensions (additive, same prefix): `P.ctl.ablate` (in: intervention list),
`P.status` ({state: loading|training-probes|ready|error|stopped, message, model,
short_name, model_id, sample, layer, token, play, interventions, probes, saes, pid,
owner, ts}; re-published every 5 s as the prefix lease heartbeat), `P.probe.info` (classes,
descriptions, accuracy, baseline), `P.sae.index` (layer labels with an SAE),
`P.sae.<layer>.top` ({layer, token, sample, features: [{id, act, label, freq}],
stats}).

Republishing: sample or intervention change → everything; layer/token change →
`P.lens.readout` and `P.sae.*.top` only. While playing, the process advances
`P.ctl.sample` itself (over its own WS connection, which is never echoed back).
On (re)connect it republishes everything (a restarted server loses channels).
Existing `P.ctl.*` values are adopted at startup (incl. `ablate`). On every
(re)connect, control channels the server does not hold are seeded from the
process's current state — the defaults (layer = L, token 0, sample 0, play
false) on a fresh start, the live selection (and active `ablate`) after a
server restart — so bound sliders never show stale values. Data channels are
published before the index channels (`P.probe.index`, `P.sae.index`), so a
consumer reacting to an index finds the channels it names.

Failure handling: a bad control value (unparseable number, invalid
intervention, non-finite or |scale| > 1e6) is ignored and reported on
`P.status` (`state: error`); an exception while computing a sample is
reported the same way and the loop keeps serving (a crash would make the
supervisor restart the source into the same control values). Non-finite
numbers in JSON payloads (extreme ablations) are published as `null`. The
status returns to `ready` with the next successful publish that follows a control
change (a reconnect or heartbeat republish of the same state keeps the error visible).

### Lens

- **BSRL, lead token** (saber L/R, torso, leg L/R): the 5 lead-token residuals
  at the selected layer go through (final_ln) → SimBa trunk → 29 heads, i.e. a
  logit lens for a model whose readout is a concatenation of 5 tokens. Items:
  that limb's joints `<joint> <gear> (H entropy)` with top probability, then
  "argmax agrees with final (29 heads)", "KL(final ‖ this layer)", critic value;
  with interventions also "KL(clean ‖ intervened)" and the clean value. Exact at
  layer L (tested). Gear labels come from the build's gear tables (`coast`,
  `±full`, `±1/2`, `±1/4`, …; wrist bends have 7 gears on exp/bend7).
- **BSRL, entity token**: probe predictions at that layer (`probe color: red`,
  with `(true X)` when wrong), attention from each lead token to it in the block
  reading that layer, residual norm.
- **Toy**: final LayerNorm + unembed on the selected residual (any token):
  probabilities of the 4 answers, entropy, agreement with the final CLS answer.

## Running experiments (for Claude)

Interventions are JSON (`evolinterp/interventions.py`):

```
{"op":"head","layer":8,"head":1,"scale":0}     ablate (or scale) one head's output
{"op":"attn","layer":3}  {"op":"mlp","layer":3}  zero a block's attention / MLP write
{"op":"block","key":7,"query":0,"layer":3}       saber L may not attend token 7 in b3 (omit query/layer = all)
```

`scale` defaults to 0 (ablate) and must be finite with |scale| ≤ 1e6; `layer` is a
block index or label (`"b3"`).

1. **Live, in the headset**: publish to `interp.ctl.ablate` (MCP channel publish,
   `Client().publish("interp.ctl.ablate", [...])`, or
   `curl -X PUT -H "Content-Type: application/json" -d '[{"op":"head","layer":8,"head":1}]' http://127.0.0.1:8787/api/channels/interp.ctl.ablate`).
   Every channel is recomputed for the current sample under the intervention;
   the readout title shows it and adds KL vs clean. Publish `[]` to clear.
2. **Batch, in Python** (the venv): measure effects over the dataset —

   ```python
   import numpy as np
   from evolinterp.adapters import make_adapter
   from evolinterp.interventions import Interventions
   a = make_adapter("bsrl", log=None)
   ix = np.arange(512)
   clean = a.run(ix, want_attn=False).outputs["logits"]
   def kl(lg):   # mean per-head KL(clean || ablated)
       p = np.exp(clean - clean.max(-1, keepdims=True)); p /= p.sum(-1, keepdims=True)
       q = np.exp(lg - lg.max(-1, keepdims=True)); q /= q.sum(-1, keepdims=True)
       return float(np.mean(np.sum(p * (np.log(p + 1e-12) - np.log(q + 1e-12)), -1)))
   effects = {(l, h): kl(a.run(ix, Interventions.parse({"op": "head", "layer": l, "head": h}), want_attn=False).outputs["logits"])
              for l in range(a.n_layers) for h in range(a.n_heads)}
   ```
   then publish the winner live (step 1) and `say` the finding.
3. **Probes / SAEs**: `python -m evolinterp probe ...`, `sae-train --layer bN`,
   then restart the source (`/api/sources/interp-bsrl/restart`) to publish them.
4. **Ad-hoc data**: `InterpSession.open(adapter)` gives `view(i, iv)`,
   `readout(i, layer, token, iv)` and `payload(prefix, ...)`; `capture.npz`
   holds proj/norm/delta/mask for every sample for dataset-wide questions.

## BeatSaberRL caveats

- Checkpoints need the **exp/bend7** code: main's `check_gear_layout` rejects
  their per-joint gear counts (wrist bends 7 gears). The export is pinned to
  that branch; re-run `setup-bsrl` if the branch moves.
- The policy's fp16/CUDA path bypasses module hooks and uses fused kernels;
  everything here runs the **fp32 CPU reference path**. The instrumented
  forward mirrors `NotePolicy._forward_stacked` (incl. note-geo lanes,
  value-residual / emb_ln / final_ln options) and is verified bit-exact against
  `forward_stacked` and block hooks (`verify`, `tests/test_bsrl.py`).
- The dataset is the checkpoint's frozen `diag_probe_obs` (2048 states from
  training rollouts, fp16-rounded). Samples are **independent states, not an
  episode** — "play" steps through unrelated frames. Pass `--dataset` with a
  sequential obs array for temporal playback.
- No positional encoding: entity slots are sorted nearest-first, so token index
  ≠ identity across samples. Labels come from the obs lanes: colour (lanes 4/5),
  cut direction from (cos, sin) lanes 6/7 binned to U/UR/R/DR/D/DL/L/UL or
  `dot`, kind flags (bomb 8, chain link 10, wall 14), and time-to-hit =
  (z − head z offset)/speed exactly as `_note_geo` computes t_plane (unclipped).
- Residual norms grow ~7× through depth (≈110 → 770). `P.resid.proj` therefore
  projects RMS-normalized vectors (mean radius per layer ≈ 0.9 embed, 0.37–0.6
  b0..b9 instead of early layers collapsing to the centre; explained variance of
  the 3 PCs ≈ 20 %, 14 %, 10 %); read magnitudes from `P.resid.norm`
  (`python -m evolinterp capture` prints both per layer). The logit lens on early layers is off-distribution for the trunk
  (no final LN) — read "agrees with final"/KL rather than raw confidences.
- Probes are trained on entity tokens only (lead tokens show NaN). Held-out
  split is by sample. Current leaf (upd 7000): colour/cutdir/kind ≈100 % up to
  b5–b6 and decay in the last blocks (colour 0.85 at b8) — the late stream
  is repurposed for the lead tokens' readout.

## Tests

```
cd python/evolinterp
.venv/bin/python -m pytest -q                     # ~1 min (.venv/Scripts/python on Windows); BSRL tests skip without code/checkpoint
.venv/bin/python -m pytest -q -m "not server"     # skip the end-to-end real-server test
```

- `test_toy.py` — instrumented forward == model forward (fused SDPA), attention
  sanity, interventions (attention ablation kills accuracy; block op), contract
  payload validation, cached vs fresh arrays, probe pipeline (answer appears
  only after attention), SAE train/save/load/top features.
- `test_bsrl.py` — bit-exact verification incl. intermediate residuals, final
  block masking, token decoding vs raw lanes, lens exact at layer L,
  interventions, payload validation.
- `test_live.py` — the live loop against the SDK's fake server: startup
  publish, control adoption/seeding, lens-only republish, ablation, bad values →
  `P.status` error, play (bool / Hz / strings), reconnect after a simulated
  server restart (data republished, lost controls re-seeded from the current
  state), compute errors reported without killing the loop, extreme
  interventions staying JSON-safe.
- `test_toy.py` also: `P.meta` names (`short_name`, no path in `model`) and
  `meta.proj`, per-vector scale invariance of the projection, stale v1 capture
  caches recaptured. `test_bsrl.py`: BSRL names, early layers not collapsed.
- `test_lease.py` — prefix lease: active-owner rules (stopped / stale heartbeat /
  dead pid / remote host), refusal message, release never clobbering a successor,
  heartbeat race resolution, `live.main` refusing a taken prefix with exit code 3
  without touching `P.status`.
- `test_integration.py` — real server (random port) supervising
  `library/sources/interp-toy` → contract channels → controls; starting
  `interp-bsrl` meanwhile is refused (log message, self-stopped, not restarted, owner
  untouched); restarting `interp-toy` takes the prefix over → stop.

## Design notes

- One adapter interface (`run`, `reference`, `tokens`, `probe_targets`,
  `lens`) — the contract, probes, SAEs and live loop are model-agnostic.
- Per-sample views come from an LRU of single-sample instrumented forwards
  (~10 ms for BSRL); the clean proj/norm/delta/mask come from the dataset
  cache, so control changes round-trip in ~20 ms.
- The full residual tensor (BSRL ≈ 250 MB as float16) exists only while
  training probes/SAEs.
- Probe weights are plain arrays evaluated in numpy (no sklearn objects at
  runtime, no pickles).
