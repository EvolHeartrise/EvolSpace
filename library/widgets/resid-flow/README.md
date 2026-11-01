# resid-flow

The residual stream of a transformer as a 3D flow through its layers - the first
interpretability visualizer of EvolSpace. It consumes the **Interp data contract**
(ARCHITECTURE.md) on channels `<prefix>.*` (default prefix `interp`).

```
   title (short name, 1 line)         ┐  header: above the top plane, ends left of the
   sample · lens · T × L+1            ┘  readout column (never overlaps it)
   b9  ──── ● ── ● ───── ●
   b8  ─── ●╲ ── ●  ──── ●       ← one smooth tube per token,
   ...      ╲   (ticks: attn|mlp write magnitudes beside nodes)
   b5  ══ LENS PLANE ═══ ◉ ⌒⌒ arcs ══ [handle] b5   ┌ readout ─────────────┐
   ...                                              │ label        ▇▇▇ 0.80 │  ← follows the lens,
  embed ×4.2 ─── ● ─── ● ──── ●                     └───────────────────────┘    clamped to the stack
```

## What it shows

| Element | Data | Notes |
|---|---|---|
| Layer frames (+Y stack, labels `embed, b0…`) | `P.meta.layers` (L+1) | thin translucent squares; dense stacks label every k-th layer |
| Token trajectories | `P.resid.proj` `[L+1,T,3]` | Catmull-Rom tube through each token's projected residual (comp 0 → x, comp 1 → z, optional comp 2 → y jitter); width/brightness by `P.resid.norm`; color by token group (`P.meta.tokens[].group`, theme palette). Scaling per `normalize` (below); layers magnified by `auto`/`per-layer` show their gain in the layer label (`embed ×4.2`) |
| Header | `P.meta` | title = `meta.short_name`, else `meta.model` cut to one line at a word boundary (`…`); the checkpoint path is never shown. Subtitle: sample, lens layer/token, `T tokens × L+1 layers` (+ `unit-norm proj` when `meta.proj.normalized`), the groups separated by ` \| ` (troika collapses runs of spaces). All header lines are single lines fitted to the width left of the readout column |
| Masked positions | `P.resid.mask` (u8) | no node; a trajectory ends / splits at masked layers |
| Flow particles | - | comets travelling upward in the trajectory shader (`uTime`), zero extra draw calls |
| Attn / MLP ticks | `P.resid.delta` `[L,2,T]` | block b's writes drawn at the node it produced (layer b+1); attn = accent, MLP = accent2; bright at the lens layer / selected token |
| Lens plane + handle | `layer` input, `P.ctl.layer` | highlighted plane at the selected layer; trajectories glow where they cross it |
| Selected token | `token` input, `P.ctl.token` | widened + ringed; others dimmed (`dimOthers`) |
| Attention arcs | `P.attn` `[L,H,T,T]` | in the lens plane l, block l−1's attention (the one that wrote this residual) from the selected query to its top-k keys (`attnHead` = −1 → mean over heads); particles flow key → query. `P.attn` is only subscribed while `showAttn` is on (it is the largest tensor) |
| Readout panel | `P.lens.readout` | single-line title + labeled bars right of the lens handle; "updating…" while its layer/token differ from the selection. The label column widens for descriptive labels (up to 30 chars, longer ones cut at a word boundary) and the panel for a long title (0.32–0.52 m). Bars are scaled by the largest \|value\| of the readout (values may exceed 1); `null`/non-numeric values show ` - ` and no bar; \|v\| < 1e-9 shows `0`. The panel follows the lens but is clamped to the stack's height (±2 cm), so it never reaches the header |
| Probe colors | `P.probe.<name>` `[L+1,T]` | `colorBy: 'probe'`: python/evolinterp's `2·P(true) − 1` on a **fixed** [−1, 1] diverging ramp (0 = neutral, beyond ±1 saturates); NaN = not applicable → neutral gray. (The old [0,1]/−1 convention is no longer recognized: −1 is now a valid score) |
| Waiting panel | - | shown until a usable `P.resid.proj` exists; lists every channel as ok / -- / bad (with the offending shape) |

## Interaction

Widget default binding `resid-pick` (pinch, `near`, handler `pick`; the entity-default
`press` and poke presses are handled the same way):

- pinch a **layer frame** → lens to that layer: emits `layer`, publishes `P.ctl.layer`
- pinch a **token node** → select token: emits `token`, publishes `P.ctl.token`
  (and moves the lens to the node's layer unless `pickNodeSetsLayer: false`)
- pinch-drag the **lens handle** (pill right of the plane) vertically → scrub layers
- hover → token tooltip / layer outline / handle highlight
- pinching anything else (header, panel, empty space) falls through to the standard grab

Selection sources, latest wins: user interaction (emit + publish + `select` widget
event), `P.ctl.*` channels (emit, so linked sliders follow), input ports (view only - publish
through the channel, as the prefab does with the slider's `commit`), and the producer's
`P.lens.readout` layer/token until anything else chose a selection. The `sample` input is
forwarded to `P.ctl.sample`: feed it from a user-gesture output (a slider's `commit`), not
from a port that emits on create, or every client load resets the producer's sample.

## Props (highlights)

`prefix`, `width` (plane size, 0.6 m), `height` (stack height, 0.8 m) / `layerSpacing`
(fixed, 0 = auto), `normalize`: `auto` (default) = one global center/scale, but a layer whose
spread would cover < 40 % of the plane is magnified about its centroid (the centroid keeps its
global position, so drift between layers stays true; the label shows the gain) - early layers
no longer collapse to a dot when residual norms grow with depth; `global` = one scale for all
(shows growth); `per-layer` (old name `layer`) = every layer centered and filling its plane.
With interp's per-vector-normalized projections (`meta.proj.normalized`), `auto` is usually
identical to `global` except for genuinely tight layers (e.g. `embed`).
`depthJitter`, `tokenFilter` (group names), `colorBy` (`group|position|norm|probe` + `probe`
name → `P.probe.<name>`), `showAttn|showDelta|showParticles|showLabels|showReadout`,
`dimOthers`, `pickNodeSetsLayer`, `publishLayer|publishToken`, `attnHead`, `attnTopK`,
`tubeWidth`, `flowSpeed`. See `widget.ts` for the full specs.

## Demo without Python

```bash
# server running (npm run dev), then:
npx tsx library/widgets/resid-flow/demo-data.ts            # publish + follow interp.ctl.* (Ctrl+C to stop)
npx tsx library/widgets/resid-flow/demo-data.ts --once     # publish one sample and exit
#   --url http://127.0.0.1:8787  --prefix interp  --layers 10  --heads 4  --sample 0  --play-ms 3000
```

Then instantiate the rig: `POST /api/prefabs/resid-lens/instantiate` (or the MCP tool).
The demo simulates a small transformer (prev-token / BOS-sink / same-group / entity
heads, MLP pulls toward rotating group attractors, growing norms, a high-norm BOS) over
three sentences: T=29, T=29 with a masked padded tail, and T=35 (shape change). It
answers `ctl.layer`/`ctl.token` with a synthetic logit-lens readout, `ctl.sample` with
a full republish, and `ctl.play = true` (or a rate in Hz) by auto-advancing samples.
Publishes are serialized and coalesced with dirty flags (latest state wins; a sample
change is never dropped by a readout request that arrives while publishing).

## Prefab `library/prefabs/resid-lens.json`

resid-flow at `[-0.15, 1.3, -1.0]` with two child sliders: a vertical **layer** slider
(length = stack height, so its ticks line up with the planes) and a **sample** slider. Both
take their range from the data and never emit on create (`emitOnCreate: false`).

| Link | Why |
|---|---|
| layer-slider.`value` → resid.`layer` | live lens preview while dragging (view only) |
| layer-slider.`commit` → `interp.ctl.layer` | publish on release |
| `interp.ctl.layer` → layer-slider.`value` | follow picks in the visualizer, voice, Claude, the producer |
| sample-slider.`commit` → `interp.ctl.sample` / `interp.ctl.sample` → sample-slider.`value` | same for samples |
| `interp.meta` → layer-slider.`max` (`x.layers.length - 1`), → sample-slider.`max` (`x.sample.total - 1`) | ranges follow the dataset (transforms return `undefined` for incomplete meta = filtered) |

Only `commit` (a user gesture) may write the ctl channels: `value` also fires for inputs
and (with `emitOnCreate`) on load, so a `value → channel` link could reset the producer's
layer/sample whenever a client loads the scene. The sliders persist values they receive on
their `value` input (throttled), so the knobs come back where they were; a `ctl.sample` that
arrives before `meta` (beyond the prefab's default max) is remembered and re-applied once the
`max` link widens the range. resid-flow publishes its own picks (`publishLayer`/`publishToken`
default on) and the sliders follow the channels, so every control path publishes once.
`test/prefab-flow.test.ts` runs these links through the runtime's real `LinkEngine` with
the real slider in every creation order (incl. a 2048-sample dataset and a model change).

## Code layout

| File | Role |
|---|---|
| `widget.ts` | definition: props, ports, bindings, `create` |
| `controller.ts` | subscriptions, selection state, interactions, coalesced rebuilds (in `update`) |
| `data.ts` | channel normalization (any dtype, f16, nested JSON), shape validation against proj, status |
| `layout.ts` | pure geometry: node placement, trajectories, arcs, ticks, point/ray picking |
| `colors.ts` | node colors (group / position / norm / probe) from theme ramps |
| `view.ts` | three.js scene graph, materials, pick proxies |
| `shaders.ts` | unlit billboard shaders (ribbons, nodes, ticks) |
| `readout.ts` | readout panel |
| `demo-data.ts` | synthetic publisher (Node script; not part of the bundle) |

## Design decisions

- **Draw calls are constant** (~25–35 incl. texts): merged frames (2), one indexed
  ribbon mesh for all trajectories, one for arcs, instanced nodes and ticks, column
  texts + one instanced bar mesh in the readout. Billboarding happens per eye in the
  vertex shader, so a 2-vertex-wide strip reads as a shaded tube.
- **No per-frame work**: channel callbacks only mark dirty flags; rebuilds happen once
  in the next `update()`; idle frames write a few uniforms (time, lens slide). Buffers
  only grow and are reused across samples. Samples per layer gap adapt so the
  trajectory mesh stays ≤ ~40k center-line samples (T=256 × L=32 builds in tens of ms
  on desktop).
- **Picking** via one invisible proxy per layer (`ctx.interactive`). Their custom raycast
  resolves the whole stack once per ray (`rayStack`, cached across the proxies): the
  nearest node the ray visually passes through, else the closest node within 1.8 cm,
  else the first plane footprint crossed - and only the winning layer's proxy reports a
  hit. (Per-layer plane hits would let a nearer plane shadow every interior node for any
  angled ray.) Each proxy's thin bounding box is the touch target, so pinching between
  layers still grabs the widget. Floating labels (hover/selection/lens) never raycast. Hit points land
  exactly on nodes, and `resolvePoint(localPoint)` maps events back to token/layer.
  Rendered meshes never raycast (cheap hover on Quest).
- **Bounds** (culling, picking broad phase, entity-screenshot framing): plain meshes get the
  layout box; the node / delta-tick InstancedMeshes get it as their all-instances box, while
  their *geometry* box bounds one shader-sized instance (the runtime unions geometry box ×
  instance matrices, so a layout-sized geometry box used to triple the framed size).
- **Robust to arrival order**: every tensor is validated against proj's `[L+1, T]`;
  stale shapes are ignored (and reported in the status line) until replaced.
- **Self-contained**: no imports from `library/shared`, only `import type` from
  `@evolspace/protocol`.
- **No overlaps**: header lines are fitted to one line (estimated with a conservative 0.6 em
  advance, cut at word boundaries) and end left of the readout column; the readout panel is
  clamped vertically to the stack, the lens label to 7 chars between handle and panel.

## Tests

```bash
npx vitest run library/widgets/resid-flow
```

Node env, real three.js, fake ctx (`test/fake-ctx.ts`): `test/bsrl-layout.test.ts`
reproduces the BeatSaberRL screenshot (collapsed embed, long model/checkpoint strings, long
readout labels, null/large readout values, signed probes) and checks normalization modes,
header fitting, readout bars and that readout and header never overlap at any lens layer;
plus data validation, layout/picking
math, node counts with masks, rebuild on shape change, interactions → emits/publishes,
hover, handle scrub, angled-ray stack picking, inputs/channels, prefix/probe/filter props,
subscription diffing (attn only while shown), readout sizing, scale (T=256 × L=32),
esbuild bundle (ESM, no bare imports, side-effect-free evaluation; plus the server's own
compiler/evaluator when present), prefab validity (and the server planner), prefab
dataflow with the real slider + runtime LinkEngine (`test/rig.ts`), and the demo
publisher against a fake HTTP/SSE server.
