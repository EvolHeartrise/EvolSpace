# Full-stack e2e suite

`tests/e2e/full-stack.test.ts` runs the whole EvolSpace stack for real and checks the seams between components:

| Step | What runs | What is checked |
|---|---|---|
| 1 | MCP bridge spawned exactly like `.mcp.json` (stdio, `EVOL_URL` → test server), MCP SDK `Client` | tool list, `spawn` a box, `scene` shows it, `screenshot` camera + entity views are PNG images with non-uniform pixels |
| 2a | Playwright Chromium, `?role=desktop` | `window.__evol.sim` pinch-grab moves the box on the server, `POST /api/scene/undo` restores it (server + client) |
| 2b | `?emulate=quest3&autoenter=vr` (IWER) | immersive-vr session, the page is the primary xr client, `/api/user` streams, grab + undo; floor grid on in VR, off in emulated AR, back on after |
| 2c | runtime `NetClient` in Node | the heartbeat `ping` is answered with `pong`, which is consumed (never reaches listeners) |
| 3 | MCP `spawn` slider + number, `link` slider.value → number.value and `#e2e.gain` → slider.value | channel PUT shows 0.80 on the number; a sim drag on the knob changes it; the slider persists the value |
| 4 | `POST /api/voice/simulate` | `undo` → fast path; `make the cube red` → agent → the bridge pushes `notifications/claude/channel` with `kind`, `target`, `target_name`, `simulated` |
| 5 | `POST /api/gestures/record`, primary page holding a synthetic fist | a recorded PoseDef is written to the **temp library copy**, loads, and is removed |
| 6 | `scripts/hooks/status.mjs` with UserPromptSubmit / PreToolUse / Stop JSON | `/api/agent/status` goes thinking → working → idle; with the server down the hook exits 0 within the deadline |
| 7 | `interp-toy` source (python/evolinterp venv) + `resid-lens` prefab | `interp.*` channels appear, entity screenshots of resid-flow are non-uniform, `PUT interp.ctl.layer` switches `interp.lens.readout` to that layer; the source is stopped |

`tests/e2e/debug.test.ts` covers the desktop debug dashboard (`/debug`): redirect + never primary, headset pose push,
tree selection, Ctrl+click picking in the resized view, inspector prop edit → `/api/scene` → Ctrl+Z, Delete + undo,
layout persistence; screenshot `data/debug-samples/debug-e2e.png`.

## Running

```bash
EVOL_E2E=1 npx vitest run tests/e2e          # bash
$env:EVOL_E2E=1; npx vitest run tests/e2e    # PowerShell
```

Without `EVOL_E2E=1` the suite is skipped, so the default `npx vitest run` stays fast. A run takes ~30 s (the first one also pre-bundles the client deps into the Vite cache below).

Typecheck: `npx tsc -p tests/e2e`.

Requirements: Playwright Chromium (`npx playwright install chromium`), and for step 7 the
`python/evolinterp/.venv` (the toy model trains in ~15 s the first time, then it is cached in `data/interp/`).

## Isolation

- The server is a child process on a **free random port** (never 8787/8443/8790), HTTPS off,
  `EVOL_NO_AUTOSTART=1`, `EVOL_DATA_DIR` in a temp dir and `EVOL_LIBRARY_DIR` pointing to a temp
  **copy** of `library/` (source `cwd`s are rewritten to absolute repo paths). Recorded poses
  therefore never land in the real library, and the user's running server (which watches
  `library/`) never sees test files.
- Vite's dep-optimizer cache is `data/e2e/.vite-cache` (`EVOL_VITE_CACHE_DIR`), so the test server
  never re-optimizes the shared `node_modules/.vite` under a running dev server.
- Teardown stops running sources through the API, kills the server process tree and checks that
  the port is free again.

## Outputs

Screenshots are saved to `data/e2e/` (gitignored) for inspection:

- `01-mcp-camera.png`, `01-mcp-entity-box.png` — the spawned box via the MCP `screenshot` tool
- `03-link-slider-number.png` — the linked slider + number after the drag
- `07-interp-resid-flow.png`, `07-interp-resid-flow-layer.png` — the resid-lens rig on the toy model, before and after moving the lens layer
