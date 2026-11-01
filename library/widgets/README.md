# Widgets - authoring guide

Widgets are the building blocks of the space. Each is one folder,
`library/widgets/<id>/widget.ts`, default-exporting a `WidgetDefinition`
(contract: `packages/protocol/src/widgets.ts`). The server watches this folder
and `library/shared/`, bundles each widget with esbuild, and hot-reloads it on
every client. Save a file → the headset updates in ~1 s.

```
library/widgets/<id>/widget.ts     the widget (may import ./*.ts and ../../shared/*.ts)
library/shared/*.ts                helpers bundled into widgets that import them
library/prefabs/<id>.json          reusable groups of entities + links
library/test/*.test.ts             harness + tests (npx vitest run library/test)
```

## Standard widgets

| id | what | key props | in → out |
|---|---|---|---|
| `shape` | primitive solid (box sphere cylinder cone torus capsule plane ring tetra octa) | kind, color, size, dims, wireframe, opacity, outline, label, pressable | color, scale, visible → press |
| `box` | `shape` with kind=box | (same minus kind) | same |
| `group` | invisible container; `handle: true` adds a grab bar | handle, label | – |
| `text` | SDF label, optional plate, billboarding | text, size, color, maxWidth, align, font, billboard off/yaw/full, background | text → |
| `panel` | card: title + markup body (`#`, `-`, `1.`, ```` ``` ````, `---`, `**b**`, `` `c` ``), auto-size | title, body, width, height, maxWidth, textSize, color, accent | body, title → |
| `slider` | pinch-drag knob/track, ticks for coarse steps, persists value (drags and inputs); no emit on create unless `emitOnCreate` | min, max, step, value, label, orientation, length, decimals, unit, color, emitOnCreate | value, min, max → value, commit |
| `button` | pinch/poke plate, press feedback, optional ask-Claude | label, width, height, color, fireOn, ask, logEvent | → press (event), pressed |
| `toggle` | on/off switch, persists | value, label, color | value → value |
| `gauge` | 270° dial with read-out | value, min, max, label, unit, color | value → |
| `number` | big formatted read-out (auto-shrinks) | value, label, unit, format, precision, size, width, signColors, channel | value → |
| `line-plot` | rolling stream or whole series, y axis, ≤ 8 series | title, width, height, window, autoscale, min, max, color, channel | value, series, clear → |
| `bar-chart` | bars from `{label,value}[]` / record / array / tensor | title, color (or `palette`), autoscale, labels, maxBars, interactive, channel | data → bar |
| `heatmap` | 2-D tensor as texture; hover cell read-out | colormap, autoscale, min, max, rowLabels, colLabels, showColorbar, interactive, channel | data → cell, select |
| `points` | instanced 3-D scatter, colors/sizes, ray picking | pointSize, color, colormap, fit, extent, maxPoints, showBounds, interactive, channel | points, colors, sizes, select → index, hover |
| `line` | polyline: hairline or tube | points, color, radius, closed, opacity, channel | points → |
| `arrow` | 3-D arrow with label | from, to, color, radius, headLength, headRadius, label | from, to → |
| `axes` | x/y/z axes with ticks + labels | length, min, max, ticks, labels, negative | – |
| `image` | URL or pixel tensor `[H,W,C]` on a quad | url, width, opacity, caption, frame | url, pixels → loaded |
| `channel-view` | debug inspector: JSON / tensor stats + histogram | channel, title, width, maxLines, histogram, refreshHz | value → |

Exact props/ports/descriptions: the catalog (`widgets` MCP tool, `GET /api/widgets`).
Prefabs: `slider-number` (slider → number), `control-panel` (panel + 2 sliders +
toggle + button, publishing to `ui.control.*`), `resid-lens` (resid-flow + layer/sample sliders).

Slider pitfalls: it does not emit `value` on create (set `emitOnCreate: true` when a local
consumer such as a read-out needs the initial value) - a `value → channel` link would otherwise
overwrite shared channel state each time any client loads the scene. Link `commit` (user gestures
only) to shared control channels; feed `min`/`max` from data (`#interp.meta` with transform
`x.sample.total - 1`). A `value` input beyond the current range is clamped for display but
remembered, so it re-applies when a later `max` input widens the range.

## The contract in one screen

```ts
import type { WidgetDefinition } from '@evolspace/protocol';   // `import type` only
import { makeText } from '../../shared/text.ts';               // relative imports get bundled

const definition: WidgetDefinition<MyProps> = {
  description: 'One or two sentences for the catalog: what it shows, its props/ports.',
  version: '1.0.0',
  props:   { label: { type: 'string', default: 'Hi', description: '…' } },  // every prop gets a default
  inputs:  { value: { type: 'number', description: '…' } },
  outputs: { value: { type: 'number', description: '…' } },
  interactions: [/* default bindings, e.g. dragBinding() */],
  size: [0.2, 0.1, 0.01],   // meters: framing before first render AND the hit box while content is empty
                            // (omit only for widgets that can be invisible, like `group`)
  create(ctx) {                                               // build into ctx.root; return the instance
    return { update(dt, t) {}, onProps(p, prev) {}, onInput(port, v) {}, onInteraction(e) {}, dispose() {} };
  },
};
export default definition;
```

Host semantics (packages/runtime/src/widgets):
- `ctx.props` has defaults applied (enum → first option) and is updated **in place** before `onProps`.
  Without `onProps` the instance is disposed and re-created on every prop change.
- `ctx.setProps(patch)` persists to the scene; it writes `ctx.props` first, so your own writes do **not** trigger `onProps`.
- `onProps(p, prev)` runs for ANY prop change. Adopt a state prop (a slider's `value`) only when
  `p.value !== prev.value`: the current state may have come from an input link (not persisted),
  and an unrelated edit (label, color) must not revert it.
- Inputs received before/while re-creating are replayed after `create`. Outputs: the latest
  value of each port is replayed to links created later - so emit initial values from `create`.
- Anything that throws (create/update/onProps/…) replaces the widget with an error box and is
  reported to Claude (`events`); other widgets keep running. After `dispose` the host also frees
  every geometry/material/texture under `ctx.root` except shared ones (`userData.evolShared`).

### ctx cheat sheet

| ctx. | use |
|---|---|
| `THREE` | three.js namespace (never `import 'three'` at runtime) |
| `root` | add your objects here; never move it (the entity transform drives it) |
| `props`, `theme` | current props; theme colors/ramps (`accent`, `accent2`, `text`, `textDim`, `surface`, `border`, `background`, `positive`, `negative`, `palette[]`, `sequential[]`, `diverging[3]`) |
| `ui.text(s, opts)` | troika SDF text; `.set(str)` is cheap (no-op when unchanged). Size/font are fixed at creation (re-create to change them); `color` may be reassigned live (troika applies it at render time - see `number`). Creating a text is expensive: update, don't re-create, on data changes |
| `ui.panel(w, h, opts)` | rounded themed card centered at origin, facing +Z (cached geometry + material) |
| `ui.material(color)` | **shared** cached unlit material - never mutate; use `ownMaterial()` for anything you change |
| `ui.color(ramp, t)` | theme ramp color (allocates; use `shared/colormap.ts` LUTs on hot paths) |
| `emit(port, v)` | output a value (flows over links) |
| `input(port)` | latest input value (or its default) |
| `setProps(patch)` | persist state (slider value, toggle). Throttle continuous changes (`shared/binding.ts` `Throttle`) |
| `interactive(obj)` | make obj (and its subtree) a hit target; its `name` comes back as `e.objectName` |
| `channels.get/subscribe/publish` | data bus; subscriptions are released automatically on dispose |
| `spawnChild(widget, props, transform, name)` | create a persisted child entity |
| `event(name, data)` / `log()` / `error(msg)` | agent-visible event log / client log / error report (doesn't throw) |
| `askAgent(text)` | send a request to Claude with this entity as context |
| `isMirror`, `user` | rendering for screenshots? head/hand poses (space coordinates) |

## Rules

1. **No runtime imports of packages.** `import type` from `three` / `@evolspace/protocol` only.
   Shared code lives in `library/shared/` and is imported relatively. The build fails otherwise.
2. **Top-level code is side-effect free.** The server evaluates the bundle in Node (no DOM) to
   read the definition. Build objects inside `create`, cache lazily (see `shared/resources.ts`).
3. **Every prop has a default** that matches its type; color defaults are theme tokens
   (`accent`, `secondary`, `positive`, `negative`, `text`, `dim`, `surface`, `border`,
   `background`) resolved with `resolveColor()` - keeps everything on-theme.
4. **Quest performance** (72–90 Hz with dozens of widgets):
   - Unlit `MeshBasicMaterial` only; no lights/shadows. Solids use `shadedGeometry()` +
     `ownMaterial(…, { shaded: true })` for baked depth cues.
   - Shared unit geometry (`sharedGeometry`/`shadedGeometry`), scaled per mesh. Never mutate it.
   - Many similar things → one `InstancedMesh` via `FittedInstances` (`shared/instanced.ts`):
     it keeps the object's bounds tight, which the picker and screenshot framing rely on.
   - **No allocation per frame.** Preallocate vectors/matrices/colors in `create`. `update()`
     should usually just check a `dirty` flag; coalesce many inputs into one redraw per frame.
   - Reuse buffers/textures when sizes don't change (`needsUpdate = true`); grow capacity in
     powers of two. Rate-limit expensive text/statistics (see `channel-view`).
   - Few texts: pool them, hide what doesn't fit (≤ ~24 labels per chart).
5. **Don't replace `onBeforeRender`** on troika text - chain it (see `shared/billboard.ts`),
   or the text silently disappears.
6. **Emit on change only** (and once on create). That keeps link cycles (A ↔ B) from looping.
7. **Rebuild cleanly.** When `onProps` rebuilds, tear down with `disposeTree(oldGroup)`
   (hides + detaches + frees non-shared resources) so stale hit targets can't be hit.
8. **Interactive parts block grabbing.** Pinching an `interactive` part goes to the widget;
   pinching anything else grabs the entity. Leave a frame/card margin to grab by, and give
   big-area interactivity an `interactive` prop (heatmap, points, bar-chart do).
9. Errors in data: `ctx.error(...)` and keep the last good state - never throw on bad input.

## Interaction

Hand input arrives as `InteractionEvent`s in `onInteraction(e)`; `e.localPoint` is in
`ctx.root` coordinates, `e.objectName` names the interactive part.

| handler | when | phases |
|---|---|---|
| `press` | pinch on an interactive part (standard binding) or index-finger poke | start, end, cancel |
| `hover` | hand ray/touch is on an interactive part | start, move, end |
| custom (`drag`) | your widget's default binding, e.g. `interactions: [dragBinding()]` (pinch → handler `drag`, wins over press/grab on interactive parts) | start, move, end, cancel |

Helpers (`shared/handle.ts`): `DragHandle` (one-hand drags with start point + delta,
hover tracking), `PressTracker` (merges hands; distinguishes completed vs cancelled
presses), `KnobVisual` (idle/hover/active without allocation), `dragBinding()`.
Make small targets easy to hit with an invisible hit mesh: `new Mesh(sharedGeometry(T,'box'),
hitMaterial(T))` - not drawn, still raycast. Pose/binding system: `library/interactions/README.md`.

## Data and links

- Ports are typed (`number boolean string vec3 color json tensor event any`). Accept loose
  input (numbers as strings, size-1 tensors, f16) via `shared/tensor.ts`: `toScalar`,
  `asVector`, `asMatrix`, `asSeries`, `asPoints`, `asLabeled`, `toFloat32` (f16 decoded; f32 not copied).
- Tensors: `{$tensor:true, dtype, shape, data}`, row-major; f16 arrives as raw `Uint16Array`.
- Data widgets also take a `channel` prop (`ChannelProp` in `shared/binding.ts`) - a shortcut
  for a channel→port link. **`channels.subscribe` delivers a value the channel already holds
  synchronously, inside the call** - so construct the `ChannelProp` after your first `build()`
  (spawning a plot on a live channel crashed `line-plot` before this rule), and reset
  per-channel state *before* `refresh()` (`channel.wanted !== channel.channel`, see `channel-view`).

Links live in the scene (`SceneOp` `link.add`), not in widget code:

```
MCP:  link {from: "e-12.value", to: "e-13.value"}                 port → port (on the headset)
      link {from: "#interp.resid.norm", to: "e-14.data"}          channel → port
      link {from: "e-12.value", to: "#ui.lens.layer", transform: "Math.round(x)"}   port → channel
HTTP: POST /api/scene/ops {"ops":[{"op":"link.add","link":{"from":{"kind":"port","entity":"e-12","port":"value"},
                                                          "to":{"kind":"channel","channel":"ui.lens.layer"}}}]}
```

`transform` is a pure JS expression of `x`; returning `undefined` drops the value (filter).
Port→channel values are published by the client running the widget (the headset). Prefabs
(`library/prefabs/*.json`, type `Prefab`) bundle entities + links with local ids - see
`control-panel.json` for both link kinds and constant transforms (`"transform": "1"`).

## Shared library (`library/shared`)

| module | contents |
|---|---|
| `color.ts` | `resolveColor` (theme tokens/hex/CSS), `paletteColor`, `parseHex`, `hexToInt`, `mixHex` |
| `colormap.ts` | LUTs: theme `sequential`/`diverging`/`palette` + `viridis`/`magma`/`gray`; `lutColor`, `divergingT`, `rangeT`, `categoryT` |
| `tensor.ts` | `isTensor`, f16 decode, `toFloat32`, `stats`/`extent`/`normalize`, shape coercions, indexing |
| `format.ts` | `formatNumber` (auto/fixed/int/sci/si/percent), `formatTick`, `formatValue`, `formatAge`, `truncate` |
| `layout.ts` | `niceTicks`/`niceRange`, `snap`, text-size estimates, `clamp`/`lerp`, `stackDown` |
| `text.ts` | `makeText` (non-pickable labels, weight extension), `textSize`/`MeasureWatch` (layout with real glyph sizes once measured), `parseMarkup` |
| `style.ts` | `STYLE` spacing/type scale, `buildCard` (panel + title + content rect), `PlotAxes` (gridlines + tick labels) |
| `resources.ts` | `sharedGeometry`/`shadedGeometry`/`sharedEdges`, `ownMaterial`, `hitMaterial`, `disposeTree` |
| `instanced.ts` | `FittedInstances` (instanced mesh with tight bounds) |
| `handle.ts` | `DragHandle`, `PressTracker`, `KnobVisual`, `dragBinding`, `along` |
| `line-window.ts` | `LineWindow`: a double-buffered, over-scanned window of lines for multi-line scroll texts (file previews, column lists): scrolls by moving, refills the hidden buffer near the edge and swaps once it is laid out (no flicker) |
| `binding.ts` | `ChannelProp` (prop-driven subscription), `Throttle` |
| `scroll.ts` | `SmoothScroll` (follow the hand 1:1, fling + friction, `scrollTo` easing; `unit` = one row in your scroll unit) and `ScrollViewport` (clip partial rows at the area's edges: clipping planes for meshes, clipRect for texts, hit boxes trimmed). Every scroll area uses these: pool one extra row and lay out with `floor(pos)` + fraction, never `Math.round`. No flicker: item i always uses slot `i % slots` (a row keeps its texts while in view), and a slot taking a new item stays hidden until its `TextSync` is `ready()` (troika lays text out asynchronously; the old string shows meanwhile) |
| `billboard.ts` | `Billboard` (face the rendering camera; yaw or full) |
| `segments.ts` | `SegmentMath` (orient unit rods between points), `readVec3` |
| `shape.ts` | implementation behind `shape`/`box` |
| `syntax.ts` | lightweight syntax highlighting (TS/JS, Python, Rust, Go, C-family, shell, SQL, Lua, GDScript, JSON, YAML, TOML/INI, Markdown, HTML/XML, CSS, Dockerfile): `languageFor(name)`, `highlight(text, lang)` → spans per line, `colorRanges(…)` → troika colorRanges |
| `icons.ts` | Lucide icons as flat stroke meshes: `makeIcon(ctx, 'play', {size, color})`, `setIcon`; data in `lucide-icons.ts` (generated - add icons with `node scripts/gen-lucide.mjs <name>`) |

Text layout note: troika measures glyphs asynchronously. Lay out with `textSize()` (estimate
until measured), keep a `MeasureWatch` over your texts and re-run layout in `update()` when
`watch.changed()` (see `panel`, `text`, `number`).

## Testing

```
npx vitest run library/test            # all widget tests (Node, real three.js, fake ctx)
npx tsc -p tsconfig.json               # typecheck (library is included)
```

`library/test/harness.ts` mounts a widget with a fake `WidgetContext` and records what it does:

```ts
const h = await mount(slider, { min: 0, max: 10, step: 1 });
h.drag('knob', [0.05, 0, 0]);        // pinch-drag an interactive part (handler 'drag')
h.press('button');                   // press start+end on a part; h.interact({...}) for raw events
h.input('value', 3); h.publish('my.channel', tensor('f32', [2, 2], [1, 2, 3, 4]));
await h.setProps({ max: 5 });        // like an agent prop update (onProps or re-create)
h.frame(10);                         // update() + text sync
h.emitsOn('value'); h.rec.setProps; h.rec.errors; h.hasText('5'); h.bounds(); pickerBounds(h.root)
h.dispose(); expect(h.rec.afterDispose).toEqual([]);
```

`smoke.test.ts` runs every widget through defaults, all enum options, junk on every input and
stray interactions; `build.test.ts` bundles each widget like the server (no bare imports) and
evaluates it in plain Node. **A new widget is covered by both automatically** - add a focused
test file for its behaviour. To see it for real: `screenshot` MCP tool with view
`{kind:"widget", widget:"<id>", props:{…}}` (or `POST /api/screenshot`), or `widget_thumbnail`.

## Worked example: `gauge`

`library/widgets/gauge/widget.ts` (≈ 100 lines) is the reference for a small widget - read it
before writing a new one. The shape of it:

```ts
create(ctx) {
  const T = ctx.THREE;
  let group: THREE.Group | null = null;
  let fill: THREE.Mesh | null = null;          // value arc
  let readout: Text | null = null;
  let value = ctx.props.value;

  function build() {                           // (re)build everything from props
    if (group) disposeTree(group);             // hide + detach + free the old subtree
    group = new T.Group();
    group.add(ctx.ui.panel(0.14, 0.14));       // themed card
    // RingGeometry segments are indexed by angle → a draw range shows a partial arc:
    // one geometry, nothing reallocated when the value changes.
    fill = new T.Mesh(new T.RingGeometry(0.044, 0.054, 64, 1, -Math.PI / 4, Math.PI * 1.5),
                      ownMaterial(T, resolveColor(ctx.theme, ctx.props.color), { doubleSide: true }));
    readout = makeText(ctx, '', { size: 0.02, font: 'mono' });
    readout.position.z = STYLE.zText;          // text sits in front of the card
    group.add(fill, readout);
    ctx.root.add(group);
    render();
  }

  function render() {                          // cheap: draw range + text.set (no-op if unchanged)
    const t = clamp01((value - ctx.props.min) / (ctx.props.max - ctx.props.min || 1));
    fill!.geometry.setDrawRange(0, Math.round(t * 64) * 6);
    readout!.set(formatNumber(value, { precision: 3, unit: ctx.props.unit }));
  }

  build();
  return {
    onProps(p, prev) { if (p.value !== prev.value) value = p.value as number; build(); },
    onInput(port, v) {
      const n = toScalar(v);                   // numbers, numeric strings, size-1 tensors
      if (port === 'value' && Number.isFinite(n) && n !== value) { value = n; render(); }
    },
    dispose() { if (group) disposeTree(group); },
  };
}
```

Then wire and check it: `spawn {widget: "gauge", props: {max: 100, label: "GPU"}}`,
`link {from: "#gpu.load", to: "<id>.value"}`, `screenshot` the entity, and test it
(`library/test/gauge.test.ts`):

```ts
const h = await mount(gauge, { max: 10, label: 'loss', unit: 'ms' });
h.input('value', 2.5);
expect(h.hasText('2.5 ms')).toBe(true);
h.dispose();
```

## Checklist for a new or changed widget

- [ ] description says what it shows and names its main props/ports
- [ ] every prop typed with a default; colors default to theme tokens
- [ ] emits only on change; initial outputs on create unless they could overwrite shared state
      (then opt-in, like the slider's `emitOnCreate`); `setProps` only for state worth restoring (throttled)
- [ ] no per-frame allocation; instancing/shared geometry; texts pooled/limited
- [ ] interactive parts named; a grabbable margin remains
- [ ] bad input → `ctx.error`, never a throw
- [ ] `npx vitest run library/test` green; looked at a screenshot
