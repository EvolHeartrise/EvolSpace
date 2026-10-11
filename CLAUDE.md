# EvolSpace — operating guide for Claude

EvolSpace is the user's XR work environment. They wear a Quest 3 (hand tracking, push-to-talk voice); you
drive the space from this repo through the `evolspace` MCP tools, and you can use everything else Claude Code
can do (bash, Python, scripts) and wire results into the space through data channels.
Architecture and contracts: `ARCHITECTURE.md` and `packages/protocol/src` (the types are the spec).

## Running it

- Server: `npm run dev` (repo root) → http://127.0.0.1:8787 (local API), https://<LAN-IP>:8443 (headset; the
  startup log prints the URL). Run it in the background; it supervises `library/sources/*` (STT autostarts).
- Debug dashboard (no headset needed): http://127.0.0.1:8787/debug — scene tree, inspector, live ports, … around the 3D
  view; never takes the headset's primary slot. Details: `apps/client/README.md` "Debug mode".
- Claude Code with voice: `scripts/claude.sh` (Linux/macOS) or `pwsh scripts/claude.ps1` (Windows) (sets `MCP_PROTOCOL_NEGOTIATION=legacy` and
  `--dangerously-load-development-channels server:evolspace`). Voice requests then arrive as
  `<channel source="evolspace" kind="voice" target=... selected=...>text</channel>` events.
- Tests: `npx tsc -p tsconfig.json`, `npx vitest run` (fast suite), e2e: see `tests/e2e/README.md`.
  Python: each project under `python/` has its own `.venv` (uv, Python 3.12).

## How to respond to the user in XR

- A channel event is the user speaking to you in the headset. They can't see the terminal: answer with the
  `say` tool (short — it's a floating text panel). Keep the status line meaningful with `status` during long work.
- `target`/`selected` meta = what they were pointing at / had selected ("make *this* bigger"). Use `user` for
  their head/hand pose and what they're looking at; place new things relative to them (`spawn` without a
  position places in front of the user).
- Act only on request. Don't rearrange or delete things unprompted.
- After building or changing anything visual, `screenshot` it (entity view to inspect, `user` view to see what
  they see) and fix what looks wrong before saying it's done. Screenshots never include passthrough.

## Where things live (edit files; the server hot-reloads)

| What | Where | Notes |
|---|---|---|
| Widgets | `library/widgets/<id>/widget.ts` | Authoring guide: `library/widgets/README.md`. No runtime npm imports (use `ctx.THREE`/`ctx.ui`). Check `widget_info`/`events` for build + runtime errors after edits. The user never edits/audits widget code — you own it end to end. |
| Shared widget helpers | `library/shared/` | |
| Prefabs (entity groups + links) | `library/prefabs/<id>.json` | |
| Hand poses | `library/poses/<id>.json` | Features documented in `packages/input/FEATURES.md`. Record by demonstration with `pose_record`, or author from a verbal description. |
| Interaction bindings | `library/interactions/*.json` | Standard grab/scale/PTT/select are just bindings here — change them on request. Scope order: entity > widget default > entity-default > global. |
| Voice fast-path commands | `library/voice/commands.json` | Whole-utterance regexes → server commands. Everything else comes to you. |
| Data sources (long-running drivers) | `library/sources/<id>/source.json` | Any language; publish to channels via HTTP (`PUT /api/channels/<name>`), the Python SDK (`python/evolspace`), or `channel_set`. |
| API keys / secrets | `~/.config/evolspace/secrets.env` (outside the repo) | `KEY=value` lines the user edits. A source lists the names it needs in `source.json` `"secrets": ["X_API_KEY"]` and gets exactly those as env vars; without them it isn't started (status shows the missing names). Keys never go in widgets, channels, props, logs, git — and never ask the user to say/paste one. |
| Agent browser | source `browser` + widget `browser` + `node scripts/browser.mjs …` | "Use the browser to …": start the `browser` source if needed (spawn a `browser` widget if none), then drive it with `scripts/browser.mjs` (`search`, `goto`, `snapshot` → `click <n>` / `fill <n> <text>`, `text`, `scroll`, `back`); every step shows live in the widget. Ask before submitting forms, signing in or paying. |
| Discord | source `discord` + widget `discord` | Signed in as the user (`DISCORD_USER_TOKEN`, a user token: against Discord's ToS, the user chose it). Read via `discord.channels` / `discord.ch.<id>`; send with `channel_set discord.request {cmd:'send', channel, content}` only when the user explicitly asks, with the exact text (confirm wording if unclear). |
| Spotify | source `spotify` + widget `spotify` | EvolSpace's own Spotify client (go-librespot in `data/spotify`, Connect device "EvolSpace", Premium). Music streams to the widget on `spotify.audio.stream` and plays in the client that last touched the widget. Search: `channel_set spotify.request {cmd:'search', query}` (results show in the widget's Search tab); play: `{cmd:'play', uri, skipTo?}`; other controls in `source.json`. Sign-in = the pairing code the widget shows. |
| Interp | `python/evolinterp` | `interp-bsrl` / `interp-toy` sources publish the `interp.*` contract consumed by `resid-flow`. README covers experiments (ablations, probes, SAEs). |

Live state (scene, links, channels, workspaces, screenshots, events) goes through MCP tools, not files.
Workspaces persist in `data/workspaces/` (gitignored).

## Composition patterns

- Link widget ports locally (`link e-12.value e-34.value`, optional JS `transform` of `x`); bind data with
  `#channel.name` refs. Port→channel links publish to the server where scripts/Python listen.
- One-off visualization of some computation: run it (Python etc.), publish tensors/JSON to a channel, show it
  with an existing widget (points, heatmap, line-plot, bar-chart, panel, channel-view) — write a new widget
  only when none fits, then keep it in the library for reuse.
- Prefer composing small widgets + links; build a "mega widget" when tight coupling/performance demands it.

## Conventions

- Quest 3 performance: unlit materials, instancing/merged geometry, no per-frame allocation, emit on change only.
- Clean, diagrammatic style using `ctx.theme`.
- Commit with a clear message when a chunk of work is done; the repo is private on GitHub (EvolHeartrise/EvolSpace).
- BeatSaberRL (`D:/Git/BeatSaberRL`) is read-only from here; interp exports its `exp/bend7` code via `git archive`.
