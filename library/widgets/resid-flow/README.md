# resid-flow

The residual stream of a transformer as a 3D flow through its layers — the first
interpretability visualizer of EvolSpace. It consumes the **Interp data contract**
(ARCHITECTURE.md) on channels `<prefix>.*` (default prefix `interp`).

```
          ┌──────────── header: model · sample · lens ─────────────┐
   b9  ───┼──── ● ── ● ───── ●                                     │
   b8  ───┼─── ●╲ ── ●  ──── ●       ← one smooth tube per token,
   ...    │     ╲   (ticks: attn|mlp write magnitudes beside nodes)
   b5  ═══╪═ LENS PLANE ═══ ◉ ⌒⌒ arcs ══ [handle] b5  ┌ readout ──┐
   ...    │                                            │ ▇▇▇ Paris │
  embed ──┴─── ● ─── ● ──── ●                          └───────────┘
```

## What it shows

| Element | Data | Notes |
|---|---|---|
| Layer frames (+Y stack, labels `embed, b0…`) | `P.meta.layers` (L+1) | thin translucent squares; dense stacks label every k-th layer |
| Token trajectories | `P.resid.proj` `[L+1,T,3]` | Catmull-Rom tube through each token's projected residual (comp 0 → x, comp 1 → z, optional comp 2 → y jitter); width/brightness by `P.resid.norm`; color by token group (`P.meta.tokens[].group`, theme palette) |
| Masked positions | `P.resid.mask` (u8) | no node; a trajectory ends / splits at masked layers |
| Flow particles | — | comets travelling upward in the trajectory shader (`uTime`), zero extra draw calls |
| Attn / MLP ticks | `P.resid.delta` `[L,2,T]` | block b's writes drawn at the node it produced (layer b+1); attn = accent, MLP = accent2; bright at the lens layer / selected token |
| Lens plane + handle | `layer` input, `P.ctl.layer` | highlighted plane at the selected layer; trajectories glow where they cross it |
| Selected token | `token` input, `P.ctl.token` | widened + ringed; others dimmed (`dimOthers`) |
| Attention arcs | `P.attn` `[L,H,T,T]` | in the lens plane l, block l−1's attention (the one that wrote this residual) from the selected query to its top-k keys (`attnHead` = −1 → mean over heads); particles flow key → query. `P.attn` is only subscribed while `showAttn` is on (it is the largest tensor) |
| Readout panel | `P.lens.readout` | title + labeled bars beside the lens; "updating…" while its layer/token differ from the selection; the label column widens for long labels (up to 22 chars) |
| Probe colors | `P.probe.<name>` `[L+1,T]` | `colorBy: 'probe'`: probabilities (all values in [0,1], −1 = n/a, as python/evolinterp publishes) → diverging ramp around 0.5, n/a gray; otherwise signed scores scaled by the 98th-percentile |score| |
| Waiting panel | — | shown until a usable `P.resid.proj` exists; lists every channel as ok / -- / bad (with the offending shape) |

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
event), `P.ctl.*` channels (emit, so linked sliders follow), input ports (view only — publish
through the channel, as the prefab does with the slider's `commit`), and the producer's
`P.lens.readout` layer/token until anything else chose a selection. The `sample` input is
forwarded to `P.ctl.sample`: feed it from a user-gesture output (a slider's `commit`), not
from a port that emits on create, or every client load resets the producer's sample.

## Props (highlights)

`prefix`, `width` (plane size, 0.6 m), `height` (stack height, 0.8 m) / `layerSpacing`
(fixed, 0 = auto), `normalize` (`global` shows norm growth, `layer` fills each plane),
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
(0..10, length = stack height, so its ticks line up with the planes for 11 layers — set
`max` to L for other models) and a **sample** slider (set `max` to `meta.sample.total − 1`).

| Link | Why |
|---|---|
| layer-slider.`value` → resid.`layer` | live lens preview while dragging (view only) |
| layer-slider.`commit` → `interp.ctl.layer` | publish on release |
| `interp.ctl.layer` → layer-slider.`value` | follow picks in the visualizer, voice, Claude, the producer |
| sample-slider.`commit` → `interp.ctl.sample` / `interp.ctl.sample` → sample-slider.`value` | same for samples |

Only `commit` (a user gesture) may write the ctl channels: the slider emits `value` with
its stored prop on create and does not persist values it receives on its input, so a
`value → channel` link would reset the producer's layer/sample every time any xr/desktop
client loads the scene. resid-flow publishes its own picks (`publishLayer`/`publishToken`
default on) and the sliders follow the channels, so every control path publishes once.
`test/prefab-flow.test.ts` runs these links through the runtime's real `LinkEngine` with
the real slider in every creation order.

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
  else the first plane footprint crossed — and only the winning layer's proxy reports a
  hit. (Per-layer plane hits would let a nearer plane shadow every interior node for any
  angled ray.) Each proxy's thin bounding box is the touch target, so pinching between
  layers still grabs the widget. Floating labels (hover/selection/lens) never raycast. Hit points land
  exactly on nodes, and `resolvePoint(localPoint)` maps events back to token/layer.
  Rendered meshes never raycast (cheap hover on Quest).
- **Robust to arrival order**: every tensor is validated against proj's `[L+1, T]`;
  stale shapes are ignored (and reported in the status line) until replaced.
- **Self-contained**: no imports from `library/shared` (built concurrently), only
  `import type` from `@evolspace/protocol`.

## Tests

```bash
npx vitest run library/widgets/resid-flow
```

Node env, real three.js, fake ctx (`test/fake-ctx.ts`): data validation, layout/picking
math, node counts with masks, rebuild on shape change, interactions → emits/publishes,
hover, handle scrub, angled-ray stack picking, inputs/channels, prefix/probe/filter props,
subscription diffing (attn only while shown), readout sizing, scale (T=256 × L=32),
esbuild bundle (ESM, no bare imports, side-effect-free evaluation; plus the server's own
compiler/evaluator when present), prefab validity (and the server planner), prefab
dataflow with the real slider + runtime LinkEngine (`test/rig.ts`), and the demo
publisher against a fake HTTP/SSE server.
