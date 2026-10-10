# @evolspace/client

The Vite WebXR app the Quest 3 browser loads. It owns the XR session (VR and
AR passthrough), the space origin (persistent anchors), hand tracking,
push-to-talk audio, pose recording, `user.pose` streaming, desktop/emulated
modes and the `window.__evol` test hooks. Rendering of the scene itself, widgets
and the in-world system UI live in `@evolspace/runtime`; poses/bindings and the
interaction engine in `@evolspace/input`.

## Run

| How | URL |
|---|---|
| Embedded (normal) — the server serves this app through Vite middleware | `https://<pc-ip>:8443/` (headset), `http://127.0.0.1:8787/` (desktop) |
| Standalone UI dev (proxies `/ws`, `/api`, `/widgets` to `EVOL_SERVER`, default `http://127.0.0.1:8787`) | `npm run dev -w @evolspace/client` → `http://localhost:5173/` |

URL parameters (`src/config.ts`):

| Param | Meaning |
|---|---|
| `role=xr` (default) \| `desktop` \| `mirror` | `mirror` dynamically imports `src/mirror/index.ts` (mirror component) |
| `emulate=quest3` (`quest2`, `questpro`) | installs IWER before any session request → the real WebXR path runs in desktop Chrome / Playwright |
| `devui=1` | IWER DevUI overlay (with `emulate`) |
| `sem=living_room` | IWER synthetic environment for AR emulation |
| `autoenter=vr\|ar` | request a session at boot (works under emulation; real browsers need a gesture) |
| `server=wss://host:port` | WebSocket base override (default: same origin `/ws`). `http(s)://` and bare `host:port` are accepted; `ws=` is an alias (the mirror's documented param) |
| `fps=72\|90\|120`, `fbscale=1.2`, `foveation=0.5` | XR quality overrides |
| `perf=1` | show the perf overlay at start |
| `debug=1` | desktop debug dashboard (implies `role=desktop`); `/debug` redirects here — see "Debug mode" |

Without WebXR (or with `role=desktop`) the page runs **desktop mode**:

| Input | Action |
|---|---|
| RMB drag | look |
| W A S D / Q E, Shift | move / down–up, fast |
| MMB drag or Alt+LMB drag | orbit around the point under the cursor |
| wheel | dolly (while pinching: push/pull the hand) |
| LMB hold | **pinch** with the right hand (grab, press, slider drag … whatever the bindings say) |
| Ctrl+LMB | `select` command on the entity under the cursor |
| hold V | push-to-talk |
| hold B | push-to-talk to a **one-off agent**: a fresh headless `claude -p` (Sonnet; `EVOL_ONESHOT_MODEL`) with none of the main session's context, no fast path; while it works a small orb floats where you were when you invoked it, showing its current activity; it replies in the agent panel and exits when done, and the orb disappears a few seconds later (`apps/server/src/oneshot.ts`) |
| P / H | perf overlay / hide page panel |

The mouse hand is a synthesized `HandFrame` placed so the engine's
shoulder→hand ray passes through the cursor, so desktop exercises exactly the
same poses → bindings → actions pipeline as the headset.

## Debug mode (desktop dashboard)

`http://127.0.0.1:8787/debug` (or `https://<pc-ip>:8443/debug`, or `?debug=1` on any URL; also the
"Debug mode →" link on the page panel). The server redirects `/debug` to `/?role=desktop&debug=1`
keeping other params. It is desktop mode plus a 2D dashboard (Preact + `@preact/signals`, TSX,
lazy-loaded from `src/debug/` — the headset bundle never contains it) docked around the 3D view:
toolbar on top, tabbed left / right / bottom docks (drag edges to resize, collapse, drag tabs between
docks, right-click a tab to move/close; layout persisted in localStorage `evolspace.debug.layout`).

- `?debug=1` forces `role=desktop` (unless `role=mirror`): a debug tab **never requests or becomes
  primary and never streams `user.pose`**, so it can't take over the headset's slot or change
  `screenshot {view:'user'}`. Its hello adds the `user-pose` capability: the server forwards the
  primary's pose (≤15 Hz, `ServerMessage {type:'user.pose'}`) for the dashboard.
- The canvas is moved into the viewport cell and sized to it (`EvolClient.attachViewport`), so the
  camera aspect and mouse→ray mapping (canvas rect) stay right. All desktop controls still work.
- Keys: `` ` `` / F1 toggle the dashboard · F frame selection (Shift+F everything) · Delete remove · Ctrl+Z / Ctrl+Shift+Z /
  Ctrl+Y undo/redo · Esc clear selection. Never while typing; keys typed into dashboard controls never
  reach the fly camera / push-to-talk.
- Panels: **Scene** (tree, filter, select/frame, eye/lock, context menu, drag to reparent keeping the
  placement, error badges) and **Inspector** (name, widget + status/errors, transform with drag-to-scrub
  fields, props generated from the manifest's PropSpecs, extra props as JSON, ports with live values,
  links, parent/anchor/tags/visible/locked/interactions, raw JSON). Every edit is a scene op
  (source `user`, one undo group per gesture). Stubs (other components fill them): widgets, hands,
  view, links, channels, events, agent, sources, screenshots.
- **Links** (bottom): every link as `name.port` / `#channel` → …; enable toggle, inline transform (compiled
  while typing, previewed on the live value), live source value with a pulse when a value passes, link
  errors from `client.error` events, filter, delete, click an endpoint to select/frame it (or open the
  channel); **New link** form (entity + port from the manifest or a channel, loose type check) → `link.add`.
- **Widgets** (left): catalog with thumbnails, version, instance count, build status (tab badge = build
  errors); details: description, error, props/inputs/outputs, instances, recent errors; Spawn (in front of
  the camera, selected), Rebuild, render thumbnail (mirror; only on click), copy source path.
- **Channels** (bottom): live list (polled only while open; rate from seq deltas, virtualized), filter;
  selected channel is subscribed over WS via the runtime ChannelHub (released on close): JSON tree, tensor
  stats (min/max/mean/std/NaN) + sparkline (1-D) / heatmap (2-D, diverging when signed; 3-D+ with slice
  sliders), rolling sparkline for numbers, quick slider/toggle/text controls, JSON publish (PUT), delete, copy.

### Extending it (contracts in `src/debug/types.ts`)

```ts
// panels/<id>.tsx (+ optional panels/<id>/…), listed once in panels/index.ts
export default definePanel({ id, title, dock: 'left' | 'right' | 'bottom', order, icon?, component: ({ ctx }) => …,
  init?(ctx) /* once at start: overlays, toolbar actions */, badge?(ctx) /* tab badge; '!3' = error style */ });
registerOverlay({ id, title, defaultEnabled?, create(ctx) => ({ update?(dt, tMs), dispose() }) }); // 3D overlays (ctx.overlays toggles)
registerToolbarAction({ id, title, icon?, order?, run(ctx), active?(ctx) });  // 'screenshot.myView' is a placeholder to replace
```

`ctx` (`DebugContext`): `client` (typed EvolClient port: `sim`, `command`, `onFrame`, `desktop`, …), `runtime`,
`engine`, `net`, `THREE`, `scene`, `camera`, `renderer`, `api` (typed wrapper of every HTTP endpoint,
`src/debug/api.ts`), `store` (signals: `conn`, `health`, `headset`, `scene`, `tree`, `catalog`,
`widgetStatus`, `entityErrors`, `selection`, `selectedEntity`, `agentStatus`, `agentMessages`, `events`
(long-polled ring buffer), `channels`/`sources` (polled only while `need('channels'|'sources')` is held —
`useNeed(ctx, …)` in components), `userPose`, `workspaces`), `actions` (`select`, `frame`, `frameAll`, `ops`, `update`,
`setProps`, `remove`, `duplicate`, `undo`, `redo`, `spawn` (≈1.2 m in front of the camera, facing it),
`command`, `serverCommand`, `toast`, `newGroup`), `layout`, `overlays`, `toast`. Shared UI:
`src/debug/ui/{kit,fields,menu,icons,format,hooks}`; CSS classes/variables in `src/debug/styles.ts`.
`window.__evol.debug` is the context (tests, devtools).

## Test

```bash
npx vitest run apps/client/test       # unit: space math, origin/anchors, resampler/PCM/PTT, recorder, router, sim, pose builder,
                                      #   debug dashboard (store/api/layout/keys; Preact components under happy-dom)
npx vitest run apps/client/test-e2e   # e2e (skips unless a server answers on EVOL_URL, default http://127.0.0.1:8787)
npx tsc -p apps/client/tsconfig.json  # typecheck (src + tests)
```

The e2e suite (headless Chromium + SwiftShader + a fake microphone) needs a
running server with at least one widget; each test adds an entity via
`POST /api/scene/ops` and checks the server: (1) `?role=desktop` +
`__evol.sim.setPinchAt` grab-drag, (2) `?role=desktop` + real mouse LMB-hold
drag, (3) `?emulate=quest3&autoenter=vr` (IWER): VR session, origin, emulated
hands, `/api/user` streaming, sim grab, and leaving XR mid-grab (no dangling
engine session, desktop FOV restored), (4) hold V → push-to-talk audio frames
reach the server's voice service (`voice.utterance` event, not cancelled).
To run it against an isolated server (no effect on your workspace):

```bash
EVOL_HTTP_PORT=18788 EVOL_HTTPS_PORT=off EVOL_DATA_DIR=<tmp>/data EVOL_LIBRARY_DIR=<tmp>/lib EVOL_NO_AUTOSTART=1 npx tsx apps/server/src/main.ts &
EVOL_URL=http://127.0.0.1:18788 npx vitest run apps/client/test-e2e
```
(`<tmp>/lib` = a copy of `library/` **without `sources/`**, so the test server never
spawns the STT or interp sources. On Windows, stopping the shell does not stop the
node child: kill the process listening on the test port afterwards.)

## Test hooks (`window.__evol`, `src/hooks.ts`)

```js
__evol.runtime / engine / net / client
__evol.sim.setHands({ hand: 'right', position: [0, 1.2, -0.4], pinch: 'index' }) // SynthHandSpec(s) or HandFrame(s), space coords
__evol.sim.setPinchAt('right', [x, y, z], true)   // pinch point exactly at a point
__evol.sim.clearHands()                           // back to real/desktop input
__evol.sim.command('session.mode', { mode: 'ar' }) // through the client router
__evol.state()                                    // JSON snapshot: connection, mode, origin, hands, ptt, mic, perf, recent commands, rays
```

Simulated hands override real input in every mode (XR, emulated XR, desktop).

## Structure

```
src/main.ts            role routing (mirror → ./mirror/index.ts via import.meta.glob)
src/app.ts             EvolClient: wiring + the frame loop
src/integration.ts     the only module instantiating runtime/input classes (narrow ports)
src/commands.ts        CommandRouter: client handlers → runtime.runLocalCommand → server
src/config.ts          URL params + persisted settings (localStorage)
src/math/space.ts      rigid-transform math, fillPoses matrices → space joints, recalibration
src/xr/session.ts      requestSession VR/AR, frame rate / foveation / framebuffer scale, mode switch
src/xr/origin.ts       space origin: persistent anchors, restore, recalibrate
src/xr/hands.ts        XRHand → HandFrame (space coords), fillPoses/fillJointRadii fast path
src/xr/emulate.ts      IWER (+DevUI, +SEM) installation
src/desktop/controls.ts fly/orbit camera + mouse-driven right hand
src/sim/sim.ts         simulated hands for tests
src/audio/{mic,resampler,ptt}.ts  mic capture (AudioWorklet), 16 kHz PCM16 resampler/chunker, push-to-talk
src/pose/recorder.ts   30 Hz feature sampling → pose.recording (timed by the runtime's RecordingUi)
src/user/pose-stream.ts UserPose builder (rounded), 30 Hz rate gate
src/perf/overlay.ts    in-world fps/draw-call/triangle panel (CanvasTexture, head-locked)
src/ui/landing.ts      2D page panel (status, Enter VR/AR, toggles, mic, help, toasts)
src/ui/hud.ts          voice/recording/toast feedback → runtime SystemUi + page
src/debug/             desktop debug dashboard (Preact, lazy): index.tsx entry, types.ts contracts,
                       store.ts/api.ts/layout.ts/keyboard.ts/camera.ts/overlays.ts, shell/, ui/, panels/
```

## Design decisions

- **Frames.** three.js world = XR reference space (`local-floor`). `runtime.root`
  is placed at the *space origin* every frame; head, hands, rays, `user.pose`
  and everything the engine sees are in **space** coordinates
  (`space = origin⁻¹ · world`). VR and AR use the same origin, so content stays
  put across mode switches.
- **Origin policy** (`xr/origin.ts`). If the session supports anchors: restore
  the persisted anchor (`restorePersistentAnchor`, handle in localStorage key
  `evolspace.origin.anchor`) or, on first use, anchor at the user's feet facing
  their gaze and `requestPersistentHandle`. Anchors are used in VR too (Quest
  supports them) — this is what makes VR/AR share coordinates and survive
  recenters. Without anchors: local-floor identity (+ in-memory recalibration).
  `origin.recalibrate` re-anchors; the old anchor and its persistent handle are
  deleted once the new one exists. No `bounded-floor`: room-scale pacing is unconstrained.
- **Mode switches need user activation.** `session.mode` without activation
  (voice, server broadcast) is parked; the next XR `select` (pinch) or page click
  completes it. Toast: "Pinch or click to switch to AR".
- **Quality defaults (Quest 3).** 90 Hz target (nearest supported), fixed
  foveation 0.5, framebuffer scale 1.0 (1.3 with the "High resolution" toggle),
  `antialias`, pixel ratio ≤ 2. All overridable by URL.
- **Hands.** `fillPoses` + `fillJointRadii` (one call each per hand) with a
  `getJointPose` fallback; matrices are converted straight into space-frame
  joints without three.js objects. Virtual hands render in VR (toggle) and are
  off by default in AR (real hands visible through passthrough).
- **Floor grid** (the runtime's, `src/xr/environment.ts`). Hidden while an AR session
  runs (it would cover the real floor), restored to its previous value (default on, or
  whatever `grid.toggle` set) when AR ends or switches to VR.
- **Push-to-talk.** The mic graph is warmed on the first gesture on a headset
  (or "Enable mic"), kept alive with a 250 ms pre-roll ring so the first
  syllable isn't clipped, and released after 5 idle minutes. AudioWorklet
  (Blob URL, works in dev/middleware/build) → main-thread windowed-sinc
  resampler (handles 48k and 44.1k) → PCM16 → 100 ms `AUD0` frames. Presses
  < 200 ms are sent as cancelled; 60 s safety cap. Permission errors surface as
  HUD/page toasts and a `client.log`. Audio is not queued while offline, so PTT
  refuses to start without a connection and an utterance in flight is aborted
  (sent as cancelled, error toast) when the socket drops or the page is hidden
  for good (`pagehide`). `AudioContext.resume()` is never awaited for more than
  1 s (without user activation it can stay pending forever); the context then
  resumes on the next click/key. A mic track that ends (device unplugged,
  permission revoked) releases the graph so the next press re-acquires it.
- **Commands.** `voice.ptt`, `session.mode {mode: vr|ar|toggle|exit}`,
  `origin.recalibrate`, `perf.toggle {visible?}`, `hands.toggle {visible?}`,
  `reload` are client-owned and registered into the runtime's local command
  registry (`registerLocalCommand`), so server-pushed `{type:'command'}` and
  runtime UI reach them too. The engine's host is proxied so binding commands go
  through the client router (logged in `__evol.state().commands`) →
  `runtime.runLocalCommand` → server (start phase only).
- **Pose recording.** The runtime receives `pose.record` and shows the in-world
  countdown (`system.recording`); the client subscribes to its phases and samples
  `computeFeatures` at 30 Hz (fixed grid, frame-rate independent) exactly during
  'recording', replying `pose.recording` on 'done' (also when no hand was tracked,
  with an error toast, so the server never hangs). `PoseRecorder.start()` keeps a
  self-timed mode (countdown + duration) for use without the runtime UI.
- **`user.pose`** is streamed only by the **primary** `role=xr` client (the server
  ignores everyone else's) at 30 Hz on a fixed grid (frame-rate independent,
  resyncs if the frame clock jumps backwards), values rounded to 0.1 mm / 1e-4 to
  halve JSON size. A real headset asks for primary (`wantPrimary`);
  emulated/desktop clients don't (they still become primary when no headset is
  connected).
- **Session changes cancel interactions.** Entering or leaving XR calls
  `InteractionEngine.cancelAll()`, so a grab or held command (push-to-talk) never
  outlives the hands that drove it. Leaving XR restores the desktop camera FOV
  (three.js overwrites `camera.fov` while presenting).
- **Resilience.** A throwing `engine.update` / `runtime.update` is reported
  (`client.error`, throttled to once per 5 s per message, console included) and
  the frame still renders. `dt` is clamped to (0, 0.1] s. Returning to the page /
  waking the headset (`visibilitychange`, `online`) reconnects immediately
  instead of waiting out the backoff.
- **Origin races.** Anchor restore and creation are async; a placement decided
  later (recalibrate) always wins — a slow `restorePersistentAnchor` or
  `createAnchor` that resolves afterwards is discarded (and deleted) instead of
  pulling the origin back.
