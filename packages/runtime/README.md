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
rt.setEnvironment({ grid: mode !== 'ar' });                     // on every session mode change
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
| `src/net/NetClient.ts` | WebSocket with reconnect/backoff, a connect timeout and a liveness heartbeat, hello (adds the `no-echo` capability), typed `on(type)`, tensor frames (`onTensor`), ref-counted channel subscriptions (resubscribed after reconnect), a bounded queue for durable messages |
| `src/net/passive.ts` | `passiveNetPort`: the send filter a mirror runtime uses (only errors, logs and channel subscriptions go out) |
| `src/data/ChannelHub.ts` | latest value per channel, local listeners, optimistic local publish with echo suppression |
| `src/scene/SceneMirror.ts` | pure copy of `SceneState`: snapshot/ops → `SceneDiff` (exact `scene.ts` semantics, stale-version rejection, cycle guard) |
| `src/scene/Reconciler.ts` | diff → `THREE.Group` per entity (`entity:<id>`, `userData.entityId`), hierarchy, orphan adoption, anchors, local transform previews |
| `src/scene/FloorGrid.ts` | `createFloorGrid(theme)`: faint 10 m floor grid with a 1 m cell size and an origin marker, drawn as one `LineSegments` |
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
- **Heartbeat.** Browsers never see the server's WebSocket-level pings, so a
  dead path (Wi-Fi roam, PC asleep) can leave the socket looking open for
  minutes. Any inbound frame counts as liveness. After 10 s without one, the
  client sends a light probe, `{type:'command', name:'ping'}`, at most once
  per 10 s. A reconnect is forced in two cases. (a) The server has answered a
  probe at least once with `{type:'command', name:'pong'}` (the answer is
  swallowed) and then nothing arrives for 30 s. (b) The socket's send buffer
  stays backed up without draining for 20 s while nothing arrives. A quiet
  server that never answers probes is never dropped for being quiet. If an
  older server answers the probe with "Command 'ping' failed…", that message
  is swallowed and probing stops for that connection. Configure with
  `heartbeat: { probeMs, timeoutMs, stallMs }`, or turn it off with
  `heartbeat: false`.

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
  When a link is added, the source port's last output is replayed through it.
  The exception is outputs whose manifest type is `event` (momentary triggers):
  they are never cached, so a new link from `button.press` does not fire a
  stale press. Inputs that arrive before a widget is ready are replayed into
  `onInput` after `create`, and all value inputs are replayed again when the
  widget is re-created (hot reload, prop-driven re-create). Momentary inputs
  are never replayed on a re-create. These are values from an `event` output,
  or values into an input declared `event`, such as `Reset.press → slider.value`
  with transform `1`. If one arrives while no instance is ready, it is
  delivered once to the next instance.
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
  ignore it. An entity that is removed or locked mid-gesture gets no further
  ops: its gesture state is dropped at once (`activeGestures()` lists the
  live ones), and the local preview of a locked entity snaps back. `deliver`
  recomputes `localPoint` in `ctx.root` coordinates. For `runCommand`, local
  commands get both phases. Server commands are one-shot and are sent on
  `start` only.
- **Hit testing.** The broad phase tests the ray or point against a cached
  node-local AABB of each entity's own content. The narrow phase precisely
  raycasts the visible meshes of entities whose box was hit. A hit on an
  object registered with `ctx.interactive()` gives `hit.interactive = true`.
  When nothing precise is hit, a box hit still counts (forgiving grabs), ranked
  after precise hits. Touch prefers interactive parts, then the nearest box,
  then the smallest box (the most specific one). Touch skips an interactive
  that is no longer under the entity's content root. That happens when a
  widget rebuilds and detaches its old meshes without telling the host. If
  the object was attached once, it is also dropped from the registry. An
  object registered before it was attached is kept until it shows up. The
  registry is also swept as it grows.
- **Bounds.** An `InstancedMesh` is bounded by its own `boundingBox` (all
  instances), both in the broad phase and in `frameEntity`, which is used for
  mirror framing. Cached geometry and instance bounds are only trusted while
  the data is unchanged. When a position attribute's version changes (or the
  attribute is replaced), or the `instanceMatrix` version or `count` changes,
  the cached box and sphere are dropped and recomputed. This also keeps
  three's raycast early-out (bounding sphere) correct for widgets that
  rewrite vertices.
- **Pointer visuals.** The ray beam and cursor follow the ray hit
  (`setPointerRays`). The hover highlight and the `select` target follow
  `host.hover()`, where the engine reports the near target (touch preferred
  over ray). Without an engine calling `hover()`, the ray hit is used for
  both.
- **Local commands.** Built in: `select` (`{entity: id}` selects it and
  `{entity: null}` clears; without `entity` it takes the hovered entity, and
  selecting the selected one again toggles it off), `agent.panel.toggle`
  (`{visible: true|false}` shows/hides it; without a boolean `visible` it
  toggles), `agent.panel.scroll {delta}`, `grid.toggle` (`{visible?}`, same
  rule) and `pose.record.cancel`. The client registers
  more with `registerLocalCommand`. A `command` message from the server runs a
  local command with phase `start`.
- **Environment (floor grid).** A faint floor grid marks the space origin. It
  is 10 × 10 m with 1 m cells, fades out with distance from the origin, and
  has a small origin marker: a red-ish +X tick and a blue-ish +Z tick. It is
  one `LineSegments` with RGBA vertex colors: one draw call, unlit, no depth
  writes, never hit-tested. It is a child of the scene (not of `root`, so it
  never counts toward bounds computed over `root`) and follows `root`'s world
  transform in `update()`. It is on by default when the scene comes from the
  net (headset, mirror space view) and off for local scenes
  (`sceneFromNet: false`, the mirror studio, which draws its own floor);
  override with the `grid` option. The runtime does not know the XR session
  mode, so the client calls `rt.setEnvironment({ grid: mode !== 'ar' })` on
  every mode change (the grid would cover the passthrough floor). The local
  command `grid.toggle` and `rt.environment` cover the rest.
- **Mirror is passive.** With `isMirror` (role `mirror`), the runtime wraps
  its net port in `passiveNetPort`. Widget side effects never reach the
  server: `setProps`/`spawnChild` scene ops, `widget.event`, `agent.ask`,
  channel publishes (from `ctx.channels.publish`, port→channel links and
  tensor frames), forwarded commands, pose events and gesture ops. They
  still apply locally (optimistic scene edits, local channel listeners), so
  screenshots show them. Errors and logs still go out, and the server tags
  them with the connection role (`mirror`). Channel subscriptions also go
  out. The mirror's own `passivePort` wrapper (`apps/client/src/mirror`)
  stays compatible: it sees the same errors as before, and everything else
  is filtered twice.
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
- The client should call `rt.setEnvironment({ grid: mode !== 'ar' })` whenever
  the XR session mode changes (desktop/VR: grid on; AR: off).
- Server: the heartbeat works best when the `ping` command answers the
  sender with `{type:'command', name:'pong'}`. Without an answer, the client
  still probes and still detects send stalls, but it cannot use silence
  alone to decide that the connection is dead.
