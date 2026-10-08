# @evolspace/server

The EvolSpace hub: scene authority (ops, undo, workspaces), widget compiler,
data bus, sources supervisor, gestures, agent I/O, commands, and the HTTP/WS
API that the headset, the mirror, the MCP bridge and every script on the
machine talk to. Contracts: `packages/protocol/src` (`api.ts`, `messages.ts`
are the spec for this package).

## Run

```bash
npm run dev -w @evolspace/server      # tsx watch (restarts on server code edits)
npx tsx apps/server/src/main.ts       # plain run
```

Startup prints the local API URL and the `https://<LAN-IP>:8443/` URLs to open
on the Quest (accept the self-signed certificate once). The cert is regenerated
(and must be re-accepted) only when a *primary* LAN address is new — a
private-range IPv4 on a physical interface — or near expiry / on a hostname
change. WSL/Hyper-V/Docker/VPN adapters and link-local 169.254.x addresses are
ignored for that decision, and new certs keep earlier addresses as SANs.

| Env | Default | |
|---|---|---|
| `EVOL_HTTP_PORT` | `8787` | plain HTTP on `127.0.0.1` (local tools, mirror) |
| `EVOL_HTTPS_PORT` | `8443` | HTTPS on `0.0.0.0` (headset); `off` disables |
| `EVOL_DATA_DIR` | `<repo>/data` | workspaces, `state.json`, screenshots |
| `EVOL_LIBRARY_DIR` | `<repo>/library` | widgets, shared, prefabs, poses, interactions, voice, sources |
| `EVOL_CERTS_DIR` | `<repo>/certs` | cached TLS cert (`meta.json` records the SANs) |
| `EVOL_PROD=1` | | serve `apps/client/dist` statically instead of Vite |
| `EVOL_CLIENT=none` | | API only |
| `EVOL_NO_AUTOSTART=1` | | don't autostart sources |
| `EVOL_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `EVOL_ALLOWED_ORIGINS` | | extra browser origins (comma-separated) allowed to use the API/WS; `*` disables the origin/host checks |

## Test

```bash
npx vitest run apps/server/test       # ~10 s; random ports, temp dirs
npx tsc -p apps/server/tsconfig.json  # includes tests
```

`test/helpers.ts` has `startTestServer()` (in-process app on a random port with
a temp library/data dir and stub mirror/voice), `TestClient` (WS client with
`next(type, pred)`), and `makeLibrary()`. `test/hardening.test.ts` covers the
origin/host policy, TLS reuse decisions, workspace safety, undo robustness,
recording reconnects, stale event cursors, Windows `.cmd` sources and orphan reaping.
`test/fixes.test.ts` covers exact undo, no-op batches, save-as resync, `channel.publish`/`ping`,
voice wiring, gesture lint warnings and screenshot error statuses.
The MCP bridge's `integration.test.ts` also runs against this server in-process.

## Layout

```
src/main.ts            env config, banner, signals (SIGINT/SIGTERM/SIGBREAK)
src/app.ts             composition root: startApp(config, overrides) → RunningApp
src/services.ts        the service container routes/handlers receive
src/config.ts          ServerConfig + env loading (repo root from module location)
src/http/              router (typed, no framework), body readers, origin policy, Vite/static client
src/ws/hub.ts          WS transport: registry, roles, primary election, keepalive
src/ws/client.ts       per-client send path with backpressure coalescing
src/ws/handlers.ts     client→server message semantics
src/scene/             store (ops/undo), validation, sanitize (workspace files), prefabs, summary, workspaces
src/widgets/           esbuild compiler, isolated evaluator (worker), watcher/catalog
src/data/bus.ts        channels, ChannelInfo, cached encodings
src/sources/           supervisor + process helpers (placeholders, tree kill)
src/gestures/          pose/interaction loading, recording, @evolspace/input boundary
src/commands.ts        command registry + built-ins (registerCommand for modules)
src/events.ts          ServerEvent ring buffer + long-poll
src/agent.ts           agent status + recent messages
src/user.ts            latest UserPose → /api/user summary
src/routes/            HTTP routes per area
src/mirror, src/voice  owned by the mirror / voice components (imported via index.ts)
```

## Design notes (things clients rely on)

**Security (browser origins)** — `src/http/origin.ts`
- The API can inject requests into Claude Code (`agent.ask`), so web pages in the
  user's browser must not reach it. Requests whose `Host` header doesn't name this
  machine (loopback, its IPs, its hostname incl. `<host>.local`/`.lan`) are refused
  (DNS rebinding). Requests *with* an `Origin` header are refused unless it is the
  same origin, loopback, this machine, or in `EVOL_ALLOWED_ORIGINS`. Requests
  without `Origin` (curl, Python, Node fetch, the MCP bridge, hooks) pass. Same for
  WebSocket upgrades (`/ws` and Vite HMR). CORS headers echo allowed origins only.
- There is no authentication: anything on the LAN that can reach :8443 can drive
  the space (same trust model as a dev server).

**WebSocket**
- The server sends nothing until the client's `hello`; it then replies `hello`,
  `scene.snapshot`, `widgets.catalog`, `gestures.defs`, `agent.status` and up to
  20 recent `agent.message`s. Messages sent before `hello` are handled as role `tool`.
- **`hello` is re-sent** whenever a client's primary flag changes. Primary: among xr
  clients with `wantPrimary !== false`, the most recent hello wins; on disconnect
  the most recently connected remaining xr client is promoted (falling back to
  `wantPrimary:false` ones). Only the primary's `user.pose`/`pose.event` feed `/api/user`.
- **Channel echo:** a publisher that is subscribed to its own channel receives its
  value back (server is the source of truth). Send `capabilities: ['no-echo']` in
  `hello` to suppress echoes to the publishing client.
- Subscriptions accept exact names, `prefix.*` (anything below `prefix.`) and `*`.
  Subscribing delivers the current value immediately.
- **Backpressure:** control messages are always queued. Channel values are
  coalesced latest-per-channel while `bufferedAmount` > 1 MB, then flushed as the
  socket drains — a slow Quest gets the newest tensor, never a backlog.
- Invalid `scene.ops` from a client → the client gets a fresh `scene.snapshot`
  (to undo optimism) and a `client.log` warn event is recorded. A failed WS
  `command` sends that client an `agent.message` of kind `error`.
- Binary frames: `AUD0…` → `VoiceService.onAudio`; anything else is a tensor
  frame published to `header.channel`.
- **Liveness:** `{type:'command', name:'ping'}` is answered (to the sender only) with
  `{type:'command', name:'pong'}` — clients treat any inbound message as "alive" and
  should ignore `pong`. Over HTTP, `ping` returns `{ok: true}`.
- On disconnect the server tells voice (`VoiceService.onDisconnect`), which drops that
  client's utterances still being recorded right away (not after the 10 s stale timer).

**Scene store**
- Ops are applied atomically per batch (rollback on error; the error names the
  op index). Broadcast `scene.patch` ops are *normalized*: `add` carries the full
  entity with the assigned id, defaulted props and full transform.
- Ids: `e-xxxx` / `l-xxxx` (4 hex, grows on collisions); callers may supply ids
  (`[A-Za-z0-9_.:-]{1,64}`).
- `add` accepts a *partial* transform (merged onto identity). Quaternions are normalized.
- Prop types are checked against the widget manifest (errors); unknown props are
  **warnings** returned from `POST /api/scene/ops` (widgets may persist private state).
- In `update` patches, `null` clears optional fields (`name`, `anchor`, `tags`,
  `interactions`, `locked`) — used by inverse ops for undo.
- Undo grouping: same `group` id (one grab), or same interactive source
  (`user`/`widget`/`voice`) within 400 ms. Agent batches are separate steps.
  A batch that changes nothing (every op re-sets current values, `clear` on an empty
  scene) is still applied and broadcast but is **not** an undo step (and keeps redo).
- Undo is exact: a prop key an edit created (unknown prop, or a default filled in by a
  `widget` change) is **deleted** on undo, not set to a default/null; undoing a widget
  change restores the previous props exactly. Inverse ops carry an internal
  `$unsetProps` field (rejected from callers, never broadcast); because a `scene.patch`
  can't delete keys, such an undo is followed by a `scene.snapshot` (clients diff it).
  Undo/redo broadcast with source `undo`/`redo`. `POST /api/scene/undo|redo` return
  `{version, ok}` (`ok:false` = nothing to undo); if an inverse ever fails to apply
  the scene is untouched, the history is cleared and `error` explains why.
- Normalized patches: `update` carries the normalized quaternion; `link.update`
  carries validated refs and `transform: null` when the transform was cleared.
- Commands that edit the scene record op source `voice` (voice), `user` (WS) or
  `agent` (HTTP, i.e. Claude/scripts) so Claude's edits never merge into a user's undo step.
- Workspaces: `data/workspaces/<name>.json`, debounced atomic writes (750 ms after the
  last change, at least every 3 s during continuous drags); `data/state.json` remembers
  the last workspace for boot. Load/new broadcast a snapshot. Loading *sanitizes*
  the file (missing fields defaulted, dangling parents/links and parent cycles
  repaired; each repair is logged). An unreadable file at boot is renamed to
  `<name>.json.corrupt-<ts>` before the server starts empty (never overwritten).
  `new` refuses an existing name (409). Prefab link ids in files are ignored (fresh ids).
  Save-as (`POST /api/workspaces/<new>/save`, `workspace.save {name}`) renames the current
  workspace and broadcasts a `scene.snapshot` so clients' `SceneState.workspace` is current.

**Widgets** (`library/widgets/<id>/widget.ts`)
- esbuild → one ESM bundle (inline source map). Runtime npm imports are rejected
  with "use ctx.THREE"; `import type` is fine; `@evolspace/protocol` values may be
  bundled; relative imports must stay inside `library/`.
- The bundle is evaluated in a worker thread (5 s timeout) to read the static
  fields → `WidgetManifest`. Errors keep the last good bundle and set `manifest.error`;
  every build emits a `widget.build` event (`{widget, ok, error?, hash?, ms}`).
- Watching `library/widgets/**` + `library/shared/**`; a shared-file edit rebuilds
  exactly the widgets whose bundles include it. New/removed widgets broadcast
  `widgets.catalog`; rebuilds broadcast `widgets.updated`.
- `/widgets/:id.js` (no-cache, ETag) and `/widgets/:id/thumbnail.png`.

**Sources** (`library/sources/<id>/source.json`)
- `"{python}"` → nearest `.venv` walking up from the source's `cwd` (so
  `"cwd": "../../../python/stt"` uses `python/stt/.venv`), then the source folder's
  `.venv`, else `python`. `"{python:python/stt}"` names a project explicitly.
  `"node"` → the server's own Node. `{repo}`/`{source}` expand in args/env.
- Children get `EVOL_URL`, `EVOL_REPO`, `PYTHONUNBUFFERED=1`. Crash → restart with
  backoff (0.5 s × 2ⁿ, max 30 s; reset after 30 s uptime) unless `restart:false`.
  Stop kills the whole tree (`taskkill /T /F` on Windows). `source.exit` events
  carry the exit code and the last 20 log lines. Editing `source.json` restarts it.
- Windows: `.cmd`/`.bat` commands and npm shims (`npm`, `npx`, `tsx`, …) run through
  `cmd.exe` with quoted args (Node can't spawn them directly).
- Orphans: running children are recorded in `data/sources.pids.json`. If the server
  was hard-killed (Task Manager, `tsx watch` restarts on Windows), the next boot kills
  those process trees — only if the pid still runs the same executable — before
  autostarting (otherwise e.g. a stale STT keeps port 8790).

**Other**
- `GET /api/events?since&wait&types&limit`: without `since` → the most recent events;
  `next` skips filtered-out events. A `since` beyond the head (cursor from a previous
  server run) is treated as 0, so the caller immediately sees `next < since` (log reset).
- Pose recording survives a headset reconnect: if the recording client drops, its
  `pose.recording` is accepted from the reconnected client for 10 s.
- `user.pose` without a valid `head` is ignored (one `client.log` warning per client).
- `/widgets/:id.js` answers `If-None-Match` with 304.
- Screenshot/thumbnail errors (`routes/mirror-errors.ts`): request problems are 4xx —
  `ScreenshotRequestError` and page-side request errors (invalid background, unknown
  widget/entity, a widget that fails to load or reports a render error) → 400; unknown
  entity (entity view) / widget (widget view) are pre-checked → 404; `user` view without a
  headset → 409. Renderer trouble is 5xx: timeouts 504, busy/closed 503, crashes 502.
- Gesture files: besides structural errors (file skipped, `errors` in `GET /api/gestures`),
  loaded files are linted with `@evolspace/input`'s `validatePoseDef` /
  `validateInteractionSet` (unknown feature names, bad binding `hand` values, …) →
  `warnings: {file: string[]}`. Every (re)load records a `gestures.load` event
  `{ok, poses, interactions, errors?, warnings?}` so Claude sees typos after an edit.
- Voice gets `describeEntity(id)` (name + widget) for readable deictic context and
  `agentStatus()` (to hand Claude's thinking/working indicator back after an utterance).
- `main.ts` shuts down gracefully on SIGINT/SIGTERM/SIGBREAK/SIGHUP; an uncaught
  exception saves the workspace synchronously before exiting.
- Mirror is started lazily on the first screenshot/thumbnail (retried if it fails).
- `@evolspace/input` is loaded lazily (`gestures/input.ts`); if missing,
  `/api/user` omits features (`featuresError`) and recording returns 503.

**Additive API beyond `api.ts`** (all backward compatible): `GET /api` (route
list), `GET /api/agent/status` (`{status, messages}`), `GET /api/commands`,
`GET /api/prefabs`, `GET /api/sources/:id`, `DELETE /api/channels/:name`,
`GET /api/channels/:name?format=json`, `X-Producer`/`X-Description` headers on
PUT, `errors`/`warnings` in `GET /api/gestures`, `warnings` in `POST /api/scene/ops`, extra
fields in `/api/health` and source statuses, `group` in `POST /api/scene/ops`.

Extra server commands: `workspace.load {name}`, `workspace.new {name}`, `say
{text, kind?}`, `source.restart {id}`, `widget.rebuild {id}`, `commands.list`,
`channel.publish {channel, value}` → `{channel, seq}` (voice fast-path / bindings driving
channels, e.g. "layer five"; producer `command:<origin>`), `ping` → `{ok: true}`.
`screenshot` saves `data/screenshots/<ts>.png` and records a `client.log` event
with `kind: 'screenshot'` and the path.
