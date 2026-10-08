# EvolSpace architecture

EvolSpace is an XR work environment driven by Claude Code. A Quest 3 (WebXR,
hand tracking, voice) renders a scene the **server** describes. Claude Code
controls the space through an **MCP bridge** (tools + a channel that pushes the
user's voice requests into the Claude Code session), and can drive anything on
the machine (Python, Rust, bash, web APIs) and wire it into widgets through
**data channels**.

```
Quest 3 browser (apps/client, WebXR)                 PC
 ├ @evolspace/runtime  scene + widgets + links ◄─WS─►  apps/server  (Node, TS)
 ├ @evolspace/input    hand features, poses,           ├ scene authority, op log, undo, workspaces
 │                     interaction engine              ├ widget library: watch + esbuild + catalog
 ├ push-to-talk mic ──────── binary audio ────────►    ├ data bus (JSON + binary tensors)
 └ user.pose 30Hz (head, hands, focus) ──────────►     ├ voice: STT client, fast-path matcher, routing
                                                       ├ mirror: headless Chromium running the client in
                                                       │         mirror mode → screenshots/thumbnails
                                                       ├ sources: supervised data-driver processes
                                                       └ HTTP API  :8787 (local) / :8443 (TLS, headset)
python/stt  (faster-whisper HTTP :8790) ◄── server
python/evolspace (SDK) + python/evolinterp (activation capture, probes, SAEs) ──HTTP/WS──► server
apps/mcp-bridge (stdio MCP, claude/channel) ◄──► Claude Code ;  bridge ──HTTP/WS──► server
```

Contracts live in `packages/protocol/src` (TypeScript types = the spec):
`scene.ts` (entities, links, ops, prefabs), `gestures.ts` (hand frames, poses,
interaction bindings), `widgets.ts` (widget module API), `data.ts` (channels,
tensors, sources), `messages.ts` (WebSocket protocol), `api.ts` (HTTP API),
`codec.ts` (binary tensor/audio frames). Change a contract only if it is
genuinely broken, keep changes backward compatible, and note the change in
your final report.

## Repo layout & ownership

| Path | What | Owner (build phase) |
|---|---|---|
| `packages/protocol` | Shared types + codecs | (frozen; orchestrator) |
| `apps/server` (except `src/mirror`, `src/voice`) | HTTP/WS server, scene store, widget compiler, data bus, sources, commands, events | **server** |
| `packages/runtime` | Three.js scene runtime: reconciler, widget host, link/dataflow engine, UiKit/theme, NetClient, system UI (agent orb, agent panel, toasts, recording countdown) | **runtime** |
| `packages/input` + `library/poses` + `library/interactions` | Hand features, pose matcher, pose recording→PoseDef, hand rays, interaction engine (grab/scale/widget/command/channel), synthetic hands for tests | **input** |
| `apps/client` (except `src/mirror`) | Vite WebXR app: XR session (VR+AR), hand tracking, anchors, push-to-talk audio, desktop/emulated mode, test hooks | **client** |
| `apps/server/src/mirror` + `apps/client/src/mirror` | Headless renderer + screenshot/thumbnail API | **mirror** |
| `apps/mcp-bridge` + `.mcp.json` + `scripts/hooks` + `.claude/settings.json` | MCP tools, channel push, Claude Code status hooks | **bridge** |
| `python/stt` + `apps/server/src/voice` + `library/voice` | Speech-to-text service, voice session handling, fast-path command matcher, routing to the agent | **voice** |
| `library/widgets/{box,sphere,…}` + `library/shared` + `library/prefabs` | Standard widget set | **widgets** |
| `python/evolspace` + `python/evolinterp` + `library/sources/interp-*` | Python SDK, activation capture for BeatSaberRL + toy model, probes, SAEs, live interp source | **interp** |
| `library/widgets/resid-flow` + `library/prefabs/resid-lens.json` | First interp visualizer | **resid** |

Agents must not edit files owned by another agent. If you need something from
another component, code against the contract/API below and list the need in
your final report.

## Conventions

- TypeScript everywhere in `packages/*` and `apps/*`; ESM; run TS directly
  (`tsx` on the server, Vite in the browser) — no build step for packages.
  Packages export `./src/index.ts`.
- Typecheck: `npx tsc -p tsconfig.json` at the repo root (covers packages, apps, library).
- Tests: `vitest` (`npx vitest run <path>`). Put tests in `<pkg>/test/*.test.ts`.
- npm: NEVER run a bare `npm install` concurrently with other agents. Use
  `node scripts/npm-locked.mjs install <pkg> -w <workspace>` to add deps.
- Python: each Python project has its own `uv` venv (`uv venv --python 3.12`
  inside its folder; `.venv` is gitignored). Do not touch global Python.
- Ports: HTTP `127.0.0.1:8787`, HTTPS `0.0.0.0:8443` (self-signed cert generated
  into `certs/`), STT `127.0.0.1:8790`. Tests should use their own random ports
  where possible.
- Paths: config via env vars with sane defaults; repo root discovered from the
  module location, never the CWD.
- Do not `git commit`; the orchestrator commits.
- Performance target is a Quest 3 at 72–90 Hz with dozens of widgets: unlit
  materials, instancing, merged geometry, no per-frame allocation, no shadows.
- Visual style: clean and diagrammatic. Use the theme from the runtime.

## Internal package APIs (code against these)

### @evolspace/input (pure TS, no DOM — also imported by the server)

```ts
computeFeatures(frame: HandFrame, head: {position: Vec3; rotation: Quat}, other?: HandFrame): HandFeatures
handRay(frame: HandFrame, head: {position: Vec3; rotation: Quat}): { origin: Vec3; direction: Vec3 } // Quest-style shoulder→pinch ray
pinchPoint(frame: HandFrame): Vec3
derivePose(samples: HandFeatures[], opts: { id: string; hand: Handedness | 'either'; description?: string; sigma?: number }): PoseDef
synthHand(spec: SynthHandSpec): HandFrame  // spec: hand, wrist position/rotation, per-finger curl, pinch targets → plausible joints
class PoseMatcher { constructor(poses: PoseDef[]); setPoses(p: PoseDef[]): void;
  update(frames: Partial<Record<Handedness, HandFrame>>, head, tMs: number): PoseTransition[]; // {pose, hand, phase:'start'|'end'}
  active(hand: Handedness): string[] }
interface Hit { entity: string; point: Vec3; distance: number; object?: string; interactive: boolean }
interface InteractionHost {
  raycast(origin: Vec3, dir: Vec3): Hit | null;
  touch(point: Vec3, radius: number): Hit | null;
  getEntity(id: string): Entity | undefined;
  getWorldTransform(id: string): Transform;            // entity transform in space coords
  widgetBindings(widget: string): InteractionBinding[];
  setEntityTransform(id: string, t: Transform, phase: 'start' | 'move' | 'end'): void; // host previews locally + sends ops on move(throttled)/end
  deliver(id: string, e: InteractionEvent): void;      // → WidgetInstance.onInteraction
  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void; // held commands get start+end
  publish(channel: string, value: unknown): void;
  poseEvent(e: PoseEvent): void;
  hover?(hand: Handedness, hit: Hit | null): void;     // for ray/cursor visuals
}
class InteractionEngine { constructor(host: InteractionHost);
  setPoses(p: PoseDef[]): void; setInteractions(sets: Record<string, InteractionSet>): void;
  update(frames: Partial<Record<Handedness, HandFrame>>, head, tMs: number): void;
  rays(): Partial<Record<Handedness, { origin: Vec3; direction: Vec3; hit: Hit | null }>> }
```

Binding resolution when a pose starts on a hand: compute target per binding's
`target` mode; candidate scopes in order **entity.interactions → widget
default interactions → entity-default sets → global sets**; within a scope,
highest `priority` wins. A binding with action `widget` only matches if the
hit object was registered via `ctx.interactive()` (`hit.interactive`), so
pinching a slider's knob drags it while pinching its frame grabs the whole
widget. `locked` entities ignore `grab`/`scale`. Two-hand `scale` takes over
when the second hand pinches the same entity that the first is grabbing.

### @evolspace/runtime (browser)

```ts
class NetClient { constructor(url: string, role: ClientRole);
  send(m: ClientMessage): void; sendBinary(b: Uint8Array): void;
  on<T extends ServerMessage['type']>(type: T, cb): () => void;
  onTensor(cb: (channel, tensor, seq) => void): () => void; connected: boolean }
class SpaceRuntime {
  constructor(opts: { scene: THREE.Scene; net: NetClient; role: ClientRole; isMirror?: boolean; renderer: THREE.WebGLRenderer; camera: THREE.Camera });
  readonly root: THREE.Group;           // space-origin group; the client positions it (anchor)
  readonly system: SystemUi;            // agent orb/panel/toasts/countdown, voice HUD
  update(dt: number, t: number): void;  // per frame
  setUser(view: UserView): void;
  interactionHost(): InteractionHost;   // implements the input package's host interface
  runLocalCommand(name: string, args, phase): boolean; // false = unknown locally → client forwards to server
  entityObject(id: string): THREE.Object3D | undefined;
  frameEntity(id: string): THREE.Box3 | null;   // world bounds of an entity subtree (mirror framing)
}
```
The runtime subscribes itself to NetClient messages (snapshot, patch, catalog,
widget updates, channel values, gesture defs, agent status/messages) and
loads widget bundles with dynamic `import(manifest.url)`. It also subscribes
to channels needed by channel→port links and `ctx.channels.subscribe`.
Built-in fallback: an entity whose widget is missing/broken renders as a
wireframe box with an error label, and the error is reported via `client.error`.

### Commands
One registry name space. The client tries `runtime.runLocalCommand` first
(e.g. `voice.ptt`, `select`, `agent.panel.toggle`, `session.mode`,
`origin.recalibrate`); unknown names go to the server as `{type:'command'}`.
Server commands (apps/server/src/commands.ts) include `undo`, `redo`,
`delete` {entity}, `duplicate` {entity}, `workspace.save` {name?},
`screenshot` (logs a screenshot for the agent), `broadcast` {name, args}
(forwards a command to all xr clients), `agent.ask` {text}. Other components
register their own server commands via the registry.

## Agent integration (how Claude sees and acts)

- MCP bridge (`apps/mcp-bridge`, stdio) registered in `.mcp.json` as
  `evolspace`. Launch Claude Code in this repo with
  `claude --dangerously-load-development-channels server:evolspace`
  (with `MCP_PROTOCOL_NEGOTIATION=legacy` in the environment) so voice requests
  arrive as `<channel source="evolspace" ...>` events.
- Claude Code hooks (`.claude/settings.json`) POST `/api/agent/status` on
  UserPromptSubmit (thinking), PreToolUse (working: tool name), Stop (idle),
  so the headset shows a live "Claude is working" indicator.
- Claude replies to the user with the `say` tool → text panel in XR.
- Widget code, poses, interactions, voice commands, prefabs and sources are
  **files under `library/`**; Claude edits them with normal file tools and the
  server hot-reloads. MCP tools cover live state: scene ops, screenshots,
  channels, user state, events, recording poses.

## Interp data contract (producer: interp; consumer: resid-flow)

Channel prefix `P` (default `interp`). All tensors row-major float32 unless noted.

| Channel | Type | Meaning |
|---|---|---|
| `P.meta` | JSON | `{ model, checkpoint?, layers: string[] /*L+1 labels: "embed","b0".."b{L-1}"*/, tokens: {label, group?}[] /*T*/, d_model, sample: {index, total, label}, lens: {kind, description} }` |
| `P.resid.proj` | f32 `[L+1, T, 3]` | residual stream per layer/token projected to 3D with a basis shared across layers (PCA over a reference dataset), scaled to roughly unit range |
| `P.resid.norm` | f32 `[L+1, T]` | L2 norm of each residual vector |
| `P.resid.delta` | f32 `[L, 2, T]` | norms of the attention (0) and MLP (1) writes in block l |
| `P.resid.mask` | u8 `[L+1, T]` | 1 where the residual exists/is meaningful (padding slots, uncomputed positions = 0) |
| `P.attn` | f32 `[L, H, T, T]` | optional attention patterns (query × key) |
| `P.probe.<name>` | f32 `[L+1, T]` | linear-probe score at each layer/token (`P.probe.index` JSON lists probe names) |
| `P.lens.readout` | JSON | `{ layer, token, title, items: {label, value}[] }` — logit-lens-style decode of the residual at the selected layer/token |
| `P.ctl.layer` | number (in) | selected lens layer (widgets publish; interp listens) |
| `P.ctl.token` | number (in) | selected token index |
| `P.ctl.sample` | number (in) | dataset sample index / frame |
| `P.ctl.play` | boolean (in) | auto-advance samples |

The interp process re-publishes the data channels whenever a control changes.
