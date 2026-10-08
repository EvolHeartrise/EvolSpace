# @evolspace/runtime

The browser-side scene runtime for EvolSpace (three.js). It turns the server's
scene (entities, links) into a three.js graph, hosts widget bundles, runs the
client-side dataflow, implements the input package's `InteractionHost`, and
draws the system UI (agent orb, message panel, voice HUD, toasts, pose-recording
countdown, selection and hover outlines). The client (`apps/client`) owns the XR
session and render loop. The mirror (`apps/client/src/mirror`) reuses the
runtime headlessly with `sceneFromNet: false`.

```ts
const net = new NetClient('wss://pc:8443/ws', 'xr', { hello: { wantPrimary: true } });
const rt = new SpaceRuntime({ scene, net, role: 'xr', renderer, camera });
const engine = new InteractionEngine(rt.interactionHost());
rt.onGestures((g) => { engine.setPoses(g.poses); engine.setInteractions(g.interactions); });
rt.registerLocalCommand('voice.ptt', (args, phase) => …);      // also session.mode, origin.recalibrate
rt.system.recording.onPhase((phase, req) => …);                 // 'countdown' | 'recording' | 'done' | 'cancelled'
// per frame:
rt.root.position/quaternion = spaceOrigin;                      // anchor
rt.setUser(userView); rt.setHandFrames(frames);
engine.update(frames, head, tMs); rt.setPointerRays(engine.rays());
rt.update(dt, t); renderer.render(scene, camera);
```

## Layout

| Path | What |
|---|---|
| `src/net/NetClient.ts` | WebSocket with reconnect/backoff and a connect timeout, hello (adds the `no-echo` capability), typed `on(type)`, tensor frames (`onTensor`), ref-counted channel subscriptions (resubscribed after reconnect), a bounded queue for durable messages |
| `src/data/ChannelHub.ts` | latest value per channel, local listeners, optimistic local publish with echo suppression |
| `src/scene/SceneMirror.ts` | pure copy of `SceneState`: snapshot/ops → `SceneDiff` (exact `scene.ts` semantics, stale-version rejection, cycle guard) |
| `src/scene/Reconciler.ts` | diff → `THREE.Group` per entity (`entity:<id>`, `userData.entityId`), hierarchy, orphan adoption, anchors, local transform previews |
| `src/scene/anchors.ts` | `AnchorRig` (head, hand joints) and `LazyFollower` (lazy head-follow: yaw only, re-centers when content leaves the view) |
| `src/scene/SceneWriter.ts` | outgoing widget edits: optimistic, throttled (100 ms leading+trailing), echo-safe field ownership |
| `src/widgets/WidgetHost.ts` | widget lifecycle, module cache by hash, hot reload with a flicker-free swap, error isolation → fallback |
| `src/widgets/context.ts` | the `WidgetContext` implementation, scoped per instance |
| `src/widgets/props.ts` | prop defaults and validation against `PropSpec` |
| `src/links/` | `LinkEngine` (port→port, channel→port, port→channel, channel→channel) and transform compilation |
| `src/interaction/` | `Picker` (bounds broad phase + precise narrow phase), `RuntimeInteractionHost`, `PointerVisuals` |
| `src/ui/` | `RuntimeUiKit` (troika text, rounded panels, material cache, ramps), fonts, glyph coverage and text mapping (`glyphs.ts`, generated `glyphCoverage.ts`), cached geometry, `BoundsOutline`, headless `stubTextFactory` |
| `src/system/` | `SystemUi` = `AgentOrb` + `AgentPanel` + `VoiceHud` + `Toasts` + `RecordingUi` |
| `src/hands/HandVisual.ts` | `createHandVisual(theme)`: instanced joints and bones (2 draw calls) |
| `src/theme.ts` | `DEFAULT_THEME` (widget `Theme`), `SYSTEM_STYLE` |

## Key behaviours and design decisions

- **Connection.** Reconnects forever with exponential backoff and jitter
  (0.5 s up to 10 s). A socket still connecting after 8 s is dropped and
  retried, because a TCP connect to a sleeping PC can hang for a minute.
  `reconnectNow()` skips the wait (the client calls it on page visibility).
  The hello carries the `no-echo` capability (`noEcho: false` turns it
  off), so the server doesn't send a client's own channel publishes back.
  While the socket's send buffer holds more than 256 KB (Wi-Fi stall),
  `user.pose` messages are skipped so they can't delay ops and commands.
  While offline, durable messages (ops, commands, publishes, errors) are
  queued, up to 256, and ephemeral ones (poses, voice, audio) are dropped.

- **Scene sync.** Snapshots are diffed against the current state, so a
  reconnect never re-creates unchanged widgets. Patches whose `version` is not
  newer than the current one are ignored. Ops are applied in order. Re-adding an
  existing id replaces it in place. `null` in a patch clears optional fields.
- **Anchors** apply only to root entities. `head` uses a rigid head frame,
  `head`+`lazy` gets a per-entity `LazyFollower`, and `hand` uses a joint frame
  (default `wrist`) that is hidden while the hand is untracked. If the client
  never calls `setUser`, the head pose comes from the camera.
- **Widgets.** Bundles load with `import(new URL(manifest.url, base))`. `base`
  defaults to the NetClient's HTTP origin. `?h=<hash>` busts the cache, and
  definitions are cached per (widget, hash). Each instance gets its own
  `ctx.root` group under the entity node, so child entities never mix with
  widget content. On hot reload or a prop-driven re-create, the new instance is
  built hidden and swapped in when ready. After `dispose()`, the host releases
  the instance's channel subscriptions and disposes its non-shared GPU
  resources. Context calls made after disposal do nothing.
- **Errors.** Every call into widget code (`create`, `update`, `onProps`,
  `onInput`, `onInteraction`, `dispose`) is guarded. A throw swaps the widget for
  a wireframe box (`manifest.size`, or 30 cm) with an error label, sends
  `client.error` (with stack, deduplicated) and shows a toast. A broken widget
  is retried when its bundle is rebuilt or its props change. An unknown widget
  is reported only after the first catalog arrives. A widget whose first build
  failed (the catalog lists it with an empty `url`) shows its build error
  without trying to import anything. Widgets that disappear from a new catalog
  are forgotten: running instances keep their code, and a later re-create
  reports them as missing. `record.error` holds the message for `error` and
  `missing` records (the mirror reads it).
- **Props.** Props are resolved against the manifest's `PropSpec`s: missing
  values take defaults (cloned), and out-of-range values are clamped. A value
  that cannot be coerced falls back to the default and logs a `client.log`
  warning. Undeclared props pass through unchanged. `onProps(props, prev)` gets
  the same `ctx.props` object, mutated in place. Without `onProps`, the
  instance is re-created. Props that change while an async `create()` is still
  running are delivered once it finishes.
- **`ctx.setProps` / `ChildHandle`.** Changes apply locally at once (no
  round-trip lag) and are sent at most every 100 ms. Fields edited locally are
  owned for about 1.2 s, and incoming server ops are stripped of those fields,
  so late echoes of intermediate values can't make a dragged slider jump back.
  A widget's own `setProps` never triggers its `onProps`.
- **Links.** A transform is compiled once with `new Function('x', …)` and cached
  by source. If a transform returns `undefined`, the value is dropped, so a
  transform can act as a filter. Compile and runtime errors are reported once
  per link. Loop guard: a link may not re-enter itself synchronously, and each
  link fires at most 32 times per frame. Values over that cap are not lost:
  the latest one is delivered at the next frame. If frames stall (the render
  loop pauses while the headset is off), the cap resets every 250 ms instead.
  When a link is added, the source port's last output is replayed through it. Inputs that arrive before a widget
  is ready are replayed into `onInput` after `create`.
- **Channels.** Subscriptions are ref-counted end to end. A local publish
  reaches local listeners immediately. The server doesn't echo it (`no-echo`),
  and if an echo comes anyway it is ignored. Tensors are sent as binary frames
  (`codec.ts`). When the last listener of a channel leaves, its cached value
  is dropped (tensors can be large). This happens on a microtask, so a
  release and resubscribe in the same tick (widget re-create) keeps the value,
  because the server sees no change and would not resend it.
- **Interaction.** All host methods work in space coordinates.
  `setEntityTransform` converts each transform into the entity's
  parent/anchor frame. During a gesture it previews locally, sends a throttled
  `scene.ops` (source `user`) on move and a final op on end, and gives all ops
  of the gesture one `group` for undo. A pinch released without moving the
  entity sends nothing, so it leaves no empty undo step. Locked entities
  ignore it, and an entity removed mid-gesture gets no further ops. `deliver`
  recomputes `localPoint` in `ctx.root` coordinates. For `runCommand`, local
  commands get both phases. Server commands are one-shot and are sent on
  `start` only.
- **Hit testing.** The broad phase tests the ray or point against a cached
  node-local AABB of each entity's own content. The narrow phase precisely
  raycasts the visible meshes of entities whose box was hit. A hit on an
  object registered with `ctx.interactive()` gives `hit.interactive = true`.
  When nothing precise is hit, a box hit still counts (forgiving grabs), ranked
  after precise hits. Touch prefers interactive parts, then the nearest box,
  then the smallest box (the most specific one).
- **Pointer visuals.** The ray beam and cursor follow the ray hit
  (`setPointerRays`). The hover highlight and the `select` target follow
  `host.hover()`, where the engine reports the near target (touch preferred
  over ray). Without an engine calling `hover()`, the ray hit is used for
  both.
- **Local commands.** Built in: `select` (`{entity: id}` selects it and
  `{entity: null}` clears; without `entity` it takes the hovered entity, and
  selecting the selected one again toggles it off), `agent.panel.toggle`,
  `agent.panel.scroll {delta}` and `pose.record.cancel`. The client registers
  more with `registerLocalCommand`. A `command` message from the server runs a
  local command with phase `start`.
- **UI kit.** `ui.material()` and `ui.panel()` return cached, shared resources
  (`userData.evolShared`). Widgets must `clone()` a material before mutating
  it. `ui.color(ramp, t, target?)`: `sequential` takes t in [0, 1],
  `diverging` takes t in [-1, 1], and `palette` treats an integer t as an index
  (it wraps) and a fractional t in [0, 1) as a position along the palette. Text
  is troika, and `.set()` changes are synced in one batch per frame. Fonts load
  from `/fonts/` (`apps/client/public/fonts`), never from a CDN. Panel
  geometry is cached per size, so animate a panel's size with `mesh.scale`,
  not by calling `ui.panel()` with new sizes every frame.
- **Glyph coverage.** For a character its font lacks, troika fetches
  fallback fonts from cdn.jsdelivr.net. Offline, the text then never finishes
  typesetting and stays blank. So every string assigned to a UiKit text
  (`ui.text()`, `.set()`, even a direct `text.text = …`) is first mapped onto
  the bundled fonts' coverage (`src/ui/glyphs.ts`): CR/CRLF become LF, a tab
  becomes two spaces, other control and invisible format characters are
  dropped, common emoji become look-alikes (✅→✓, ❌→×, 🚀→→), and anything
  else uncovered becomes □. The coverage tables come from the fonts' cmaps.
  After replacing a font, run
  `node packages/runtime/scripts/gen-glyph-coverage.mjs` (a test fails if the
  tables are stale).
- **System UI** sits on two lazy-follow frames: the HUD (orb with state,
  detail and elapsed timer, voice meter, toasts, countdown) and the agent
  panel. The orb shows `offline` while the socket is down. While push-to-talk
  is held (`system.voiceBegin/voiceLevel/voiceEnd`) it shows `listening`.
  Otherwise it follows `agent.status`. The elapsed timer counts from
  `AgentStatus.since`, so it shows the true duration after a reconnect or
  reload. Fresh replies and errors open the panel automatically
  (`system.autoOpenPanel`). Messages the server replays on reconnect, or
  messages older than a minute, don't. Everything is hidden in the mirror
  (`isMirror`).
- **Performance (Quest 3).** Per-frame paths use module-level scratch objects
  and allocate nothing. Materials are unlit (`MeshBasicMaterial`) and cached,
  geometry is shared and instanced (hands), outlines are line brackets rather
  than post-processing, and text syncs once per frame. Bounds are refreshed
  lazily (on change, or at most once a second for animated widgets).

## Testing

```
npx vitest run packages/runtime                 # node env, no WebGL
npx tsc -p packages/runtime/tsconfig.json       # src + test + scripts
node packages/runtime/scripts/browser-smoke.mjs [out.png]
```

The browser smoke test bundles `scripts/smoke-entry.ts` with esbuild, serves it
and the fonts on a random port, and renders it in headless Chromium
(Playwright, SwiftShader). It checks for page errors, typesetting of every text
with the bundled fonts, the widget statuses (ready / error / missing) and a ray
hit on an interactive object. It also checks that no request leaves the
page's origin: the scene includes emoji, which would trigger troika's CDN
font fallback without the glyph mapping. It writes a screenshot (default:
`<tmp>/evolspace-runtime-smoke.png`). Unit tests inject `stubTextFactory`,
because troika needs WebGL and a worker. The test fixtures (mock WebSocket,
fake widget loader, runtime factory) are in `test/helpers.ts`.

## Notes for other components

- The `InteractionHost`/`Hit` types are declared structurally in
  `src/interaction/types.ts`, so the runtime has no code dependency on
  `@evolspace/input`.
- Per frame, the client should call `setPointerRays(engine.rays())` (ray and
  cursor visuals) and `setHandFrames(frames)` (joint anchors), and report
  `rt.selected` in `user.pose.selected`.
- The mirror can use `applySnapshot`/`applyPatch`, `whenIdle()` (wait for
  widget loads before a screenshot), `frameEntity(id)` and `sceneFromNet: false`.
