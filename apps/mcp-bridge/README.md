# @evolspace/mcp-bridge

The MCP server through which Claude Code controls EvolSpace. It does three things:

1. **Tools**: a thin, context-efficient proxy over the server HTTP API (`packages/protocol/src/api.ts`).
2. **Voice channel**: pushes the user's requests from the headset into the running Claude Code session as
   `notifications/claude/channel` events. Claude sees them as `<channel source="evolspace" …>text</channel>`.
3. **Status hooks** (`scripts/hooks/status.mjs`, registered in `.claude/settings.json`): drive the in-XR
   "Claude is working" indicator from Claude Code's lifecycle.

## Running

The EvolSpace server must be running (`npm run dev` at the repo root). Then start Claude Code with the channel:

```powershell
pwsh scripts/claude.ps1            # Windows; extra args pass through, e.g. --continue
scripts/claude.sh                  # bash
```

Both set `MCP_PROTOCOL_NEGOTIATION=legacy` and pass `--dangerously-load-development-channels server:evolspace`.
Without the env var the stdio channel server negotiates a newer protocol revision and Claude Code **silently**
does not register the channel (tools still work, voice requests never arrive). The `server:evolspace` name must
match the key in `.mcp.json`.

On the first interactive launch Claude Code asks you to trust the workspace and to approve the project MCP
server `evolspace`. Until the workspace is trusted, the `permissions.allow` entry (`mcp__evolspace`, so tools
run without prompts while you are in the headset) is ignored. File edits still prompt unless you start with
e.g. `scripts/claude.ps1 --permission-mode acceptEdits`.

`.mcp.json` runs `node --import tsx apps/mcp-bridge/src/main.ts` relative to the repo root, which is where
Claude Code starts project MCP servers. `npm start -w @evolspace/mcp-bridge` runs it by hand (it then waits for
an MCP client on stdin).

Environment:

| Var | Default | Meaning |
|---|---|---|
| `EVOL_URL` | `http://127.0.0.1:8787` | EvolSpace server (bridge and hooks) |
| `EVOL_BRIDGE_LOG` | `info` | `debug`, `info`, `warn` or `error` (stderr only) |
| `EVOL_STATUS_HOOK` | (on) | `0` disables the status hook |

## Tools

| Tool | What it does |
|---|---|
| `scene` | Compact tree `id "name" widget @(x,y,z) {props}` plus links. `full` gives raw JSON, `entity` a subtree |
| `spawn` / `update` / `remove` | Entity ops (source `agent`, undoable). `spawn` without a position places the entity in front of the user, facing them, at a distance based on the widget's size. Rotation is `[x,y,z]` Euler degrees or a quaternion |
| `link` / `unlink` | Link refs: `e-12.value` for an entity port, `#chan.name` (or `channel:chan.name`) for a channel. Ports are checked against the widget manifest, so a typo fails immediately with the list of valid ports |
| `undo` / `redo` | Optional `steps` |
| `prefab` | Lists `library/prefabs` (no id) or instantiates one |
| `workspace` | `list`, `save`, `load` or `new` |
| `widgets` / `widget_info` / `widget_build` | Catalog lines; manifest details with the source path, build error and recent client errors; forced rebuild |
| `thumbnail` / `screenshot` | Return MCP image content (PNG) plus a one-line caption. Screenshot views are `user`, `entity`, `widget` and `camera`; `thumbnail` takes optional `props` |
| `user` | Head, facing, hands (wrist, key features, active poses), ray and gaze hits with entity names, the selected entity |
| `say` / `status` | Agent panel message in XR / status line |
| `events` | The server event log as one line per event, ending with `next=<cursor>`. Supports long-poll with `wait` |
| `channels` / `channel_get` / `channel_set` | The data bus. Tensors are summarized as dtype, shape, min, max, mean, std and the first values |
| `sources` | `list`, `start`, `stop`, `restart` or `logs` |
| `pose_record` / `gestures` / `voice_simulate` / `command` / `server_status` | Gestures, voice routing, the command registry, health |

Every tool validates its arguments with a zod schema, which is also the advertised JSON Schema. Unknown keys
are rejected, so a misspelled parameter fails instead of being silently ignored. Failures come back as
`isError` results with an actionable message. When the server is down, every tool says
`EvolSpace server is not running at … Start it with: npm run dev (in <repo>)`.

## Voice channel (src/channel.ts)

`ChannelPump` long-polls `GET /api/events?types=agent.ask&since=<cursor>&wait=25000`. For each ask it does two
things:

- Fire-and-forget `POST /api/agent/status {thinking, "Heard: <text>"}`, so the headset shows that Claude picked
  the request up (sent before the scene lookup, so it is immediate).
- Push `{content: text, meta}`. `meta` contains only non-empty keys made of `[A-Za-z0-9_]` (Claude Code drops
  other keys): `kind` (voice, widget, request), `target` (the entity the user pointed or looked at: hand focus,
  then gaze, then selection), `target_widget`, `target_name` (looked up in the scene when missing), `selected`,
  `selected_name`, `utterance_id` and `simulated`. Fields are read from `data` or `data.context`; the server
  emits `{text, context}` (voice: `apps/server/src/voice` `agentContext`; widget `askAgent`: `{entity, widget}`).
- `simulated="true"` marks asks produced by `voice_simulate` (usually Claude testing routing). They get no
  "Heard" status and no unanswered check, and the instructions tell Claude not to act on them.

**Unanswered-ask detector.** Claude Code drops channel events *silently* when the session did not register the
channel: started without `--dangerously-load-development-channels server:evolspace`, a modern protocol
revision (`MCP_PROTOCOL_NEGOTIATION=legacy` missing), a third-party provider (Bedrock/Vertex), or an org
policy without `channelsEnabled`. The headset would then show "Heard: …" forever. So 45 s after each push
(`unansweredMs`), if Claude has called none of the bridge's tools **and** the agent status still reads exactly
our "Heard: …" line (no hook fired), the bridge sets the status to idle and shows an error in XR telling the user
to start Claude Code with `scripts/claude.ps1`. It is skipped when the agent was already thinking or working at
push time, because the event then queues behind the current task. `claude --debug` logs the skip reason.

Delivery guarantees:

- **No replay**: asks older than the bridge's start are never delivered.
- **Outages**: the pump reconnects forever with backoff (500 ms up to 10 s). After a reconnect it re-reads the
  log and delivers asks newer than the last successful poll, minus 2 s of slack. A seq+ts+text set dedupes them.
- **Server restarts**: a restart is detected by the connection error, or by the head being below the cursor
  (checked on idle polls).
- **Never spins**: malformed pages back off, and empty pages that return early are throttled.
- The pump starts only after the MCP `initialized` handshake. Notifications sent before it would be lost.

**Process lifetime.** `main.ts` exits when stdin ends, closes or errors, on EPIPE, on SIGINT/SIGTERM/SIGHUP,
and (watchdog, every 5 s) when its parent process is gone. An orphaned bridge would otherwise keep polling
and posting "Heard: …" statuses with no Claude behind it.

## Status hooks (scripts/hooks/status.mjs)

The hooks are registered in `.claude/settings.json` in exec form: `node ${CLAUDE_PROJECT_DIR}/scripts/hooks/status.mjs <Event>`.
Exec form needs no shell and works from any cwd.

| Event | State |
|---|---|
| `SessionStart` | idle, "Claude Code session started" |
| `UserPromptSubmit` | thinking, "Thinking about: …" (channel-wrapped voice prompts show just the spoken text) |
| `PreToolUse` | working, a short human label ("Editing slider/widget.ts", "Running: npm test", "Taking screenshot", "Spawning slider"). The `status` tool is skipped so its own line wins |
| `Notification` | permission or input prompt: working, "Needs your permission in the terminal"; `idle_prompt`: idle |
| `Stop` | idle |
| `StopFailure` | error, "Stopped: …" |
| `SessionEnd` | idle |

The hook has no dependencies and starts in about 50 ms. It reads stdin until EOF or until it holds a complete
JSON document, so a caller that keeps stdin open does not stall it. It has a hard 400 ms deadline, always exits 0
and never writes to stdout: stdout from `UserPromptSubmit` and `SessionStart` would be injected into Claude's
context. It was verified against Claude Code 2.1.294: `SessionStart`, `UserPromptSubmit`, `StopFailure` and
`SessionEnd` were all observed POSTing.

## Layout

```
src/main.ts          stdio entry (stderr logging, graceful shutdown)
src/server.ts        createBridge(): low-level SDK Server, tools, channel capability, pump wiring
src/api.ts           HTTP client with actionable errors (down / timeout / HTTP status + server message)
src/channel.ts       ChannelPump + agent.ask → notification mapping
src/tool.ts          tool framework (zod → JSON Schema, validation, results)
src/tools/*.ts       scene, widgets, data, agent, system tool groups
src/refs.ts          link ref parser
src/format.ts        compact formatting, tensor stats, quaternion helpers
src/instructions.ts  the operating guide sent to Claude as MCP `instructions`
```

## Tests

```
npx vitest run apps/mcp-bridge          # or: npm test -w @evolspace/mcp-bridge
npx tsc -p apps/mcp-bridge/tsconfig.json
```

- `tools.test.ts` runs every tool against a programmable fake HTTP server (`test/fake-evol.ts`) over the SDK's
  `InMemoryTransport`, including a check that every tool gives an actionable error when the server is down.
- `channel.test.ts` covers notifications and meta, no replay, outage and restart recovery, no-spin regressions,
  and the advertised capabilities.
- `hook.test.ts` covers the event-to-status mapping and the real process: silent, exit 0, deadline when the
  server hangs or is down.
- `stdio.test.ts` spawns the bridge exactly as `.mcp.json` does, lists tools, calls one, and receives a channel
  notification. It also checks process lifetime: exit on stdin EOF, and no outliving a hard-killed parent.
- `integration.test.ts` drives the bridge against the **real** server (`apps/server` in-process on a random port
  with temp library and data dirs, a stub mirror and the real voice router). It covers scene ops including server
  warnings, the catalog and builds, JSON and tensor channels, say/status reaching a WS headset, screenshots,
  widget `askAgent` and `voice_simulate` becoming channel events, and the unanswered-ask detector. It imports
  `apps/server/test/helpers.ts`, so `npx tsc -p apps/mcp-bridge/tsconfig.json` also typechecks server sources.
- `refs.test.ts` covers the link ref syntax.

## Design notes

- **The low-level `Server` instead of `McpServer`**: channels need `experimental: {'claude/channel': {}}` and
  custom notifications. `claude/channel/permission` is deliberately not declared.
- **Compact outputs**: one line per entity, event or channel, numbers rounded, large values elided, and JSON
  truncated unless `full` is passed. Claude's context is the scarce resource.
- **Source code is not returned by tools**: Claude reads and edits `library/**` files with its own file tools.
  `widget_info` gives the path.
- **Server warnings are surfaced**: `/api/scene/ops` `warnings` (unknown props, ignored fields) are appended to
  spawn, update and link results as `warning:` lines.
- **No headset, no floor spawns**: without a user pose, root content without a position goes to eye height
  (1.3 m) in front of the space origin, not to (0,0,0) on the floor.
