# mirror (server side)

The mirror lets Claude *see* the space. It is a headless Chromium (Playwright)
running the normal client in mirror mode (`<baseUrl>/?role=mirror`, browser code in
`apps/client/src/mirror`), driven through `window.__evolMirror.capture(req, userPose, opts?)`.

```
server core ── startMirror(deps) ──► HeadlessMirror
                                       ├ SerialQueue      one capture at a time (max 32 queued)
                                       ├ launchBestBrowser GPU probe → fallback chain
                                       ├ Page (/?role=mirror) ── WS ──► server (role 'mirror', passive)
                                       └ capture: setViewport → evaluate(capture) → PNG data URL → Buffer
```

API (`types.ts`): `startMirror(deps): Promise<Mirror>` with
`screenshot(ScreenshotRequest) → PNG Buffer`, `thumbnail(widgetId, props?)`
(512×512 studio render, written to `<widgetsDir>/<id>/thumbnail.png`), `close()`,
and optional `status()` (backend, counters). `ScreenshotRequestError` (exported from
`index.ts`) marks errors caused by the request itself.

## Behaviour

- **Launch once, keep alive.** `startMirror` returns immediately and warms up in
  the background; the first capture waits for it.
- **GPU.** Candidates in order: headless shell `--use-angle=d3d11` (Windows; metal/gl
  elsewhere) + `--enable-gpu --ignore-gpu-blocklist`, then "new headless"
  (`channel: 'chromium'`), then default GL, then SwiftShader. Each is probed with
  `WEBGL_debug_renderer_info`; the first hardware renderer wins, otherwise the first
  software one (logged as a warning). On the dev box (GTX 1080) the first candidate
  gives `ANGLE (NVIDIA ... Direct3D11)`.
- **Serialized queue + timeout.** Every capture runs alone (one page, one renderer).
  A capture exceeding `captureTimeoutMs` (20 s) rejects and the browser is killed;
  the next request relaunches it. Startup has its own timeout (45 s). At most 32
  captures may be queued/running; more are rejected with `mirror: busy` instead of
  piling up behind a hung renderer.
- **Recovery.** A capture is retried once when the failure is about the renderer, not
  the request:
  - page `crash` / browser `disconnected` (or killed) → relaunch + retry;
  - WebGL context lost (GPU reset / driver TDR; the page checks `gl.isContextLost()`
    and fails with `mirror: WebGL context lost`) → relaunch + retry;
  - the page never got its initial scene/catalog (`mirror: not ready…`, e.g. its WS
    is stuck) → relaunch + retry;
  - the page navigated mid-capture (Vite HMR full reload in dev) → retry on the same
    page. Every capture first waits for `window.__evolMirror` to exist (again).

  Page-side request errors (unknown entity, bad background…) and timeouts are not
  retried: they would just happen again.
- **Thumbnails** are written atomically (`atomicWrite` from `../util/fs.ts`: temp
  file + rename with Windows-safe retries). The temp name matches the widget
  watcher's ignore pattern, so writing never triggers a rebuild and nobody reads
  half a PNG.
- **Errors** are descriptive and prefixed `mirror:`; request validation
  (`request.ts`) happens before anything touches the browser.
- **Logging.** Backend choice, readiness, every capture (`mirror: entity 'b2' 640x480 in 223 ms`),
  page reloads, page `console.error`/`pageerror` (rate-limited to 30 per 10 s) and the
  page's own `mirror:` warnings (e.g. "scene did not settle", "scene is behind the
  server") go to `deps.log`. A capture that is a single flat color logs a warning
  (camera pointing at nothing / empty scene).

The page side is a **passive observer** (see the client README): the mirror's widget
copies never send scene edits, channel publishes, widget events or agent requests
to the server; only errors/logs and channel subscriptions go out. Before each
capture the page also asks the server for its scene version and widget hashes, so
ops/rebuilds made just before a screenshot request are always included.

## Request defaults (`request.ts`)

`width`×`height` default 1024×768 (16…4096). For `view.kind = 'user'`
without an explicit height the height follows the headset aspect
(`UserPose.aspect`, default 1). `hands` defaults to true for `user`, false otherwise.
`user` without a connected headset is an error. See the client README for camera
conventions (`direction`, `padding`, fallbacks).

## Configuration

| Option (`deps.options`) | Env | Default |
|---|---|---|
| `captureTimeoutMs` | `EVOL_MIRROR_TIMEOUT_MS` | 20000 |
| `startupTimeoutMs` | `EVOL_MIRROR_STARTUP_TIMEOUT_MS` | 45000 |
| `gpu` (`auto`/`gpu`/`software`) | `EVOL_MIRROR_GPU` | auto |
| `extraArgs` | `EVOL_MIRROR_ARGS` (space separated) | – |
| `pagePath` | – | `/?role=mirror` |

## Tests

```
npx vitest run apps/server/src/mirror apps/client/src/mirror
```

- `test/unit.test.ts`: queue, timeout, PNG decoder/stats, request validation, launch
  config, navigation-error detection.
- `test/mirror.integration.test.ts`: real Chromium + real mirror page + the real
  `@evolspace/runtime` against `test/fake-server.ts` (Vite serving `apps/client`,
  fixture widgets from `test/fixtures/*.js`, a fake `/ws` that sends
  hello/catalog/gestures/snapshot and can delay patches or go silent, plus
  `/api/scene/summary` and `/api/widgets`). Covers camera, widget (studio),
  slow-loading widget thumbnail, user view with ghost hands, entity framing with
  labels, backgrounds, error messages, crash recovery, concurrent captures,
  passivity (a side-effecting widget sends nothing but errors/logs), scene ops still
  in flight, a rebuilt widget whose `widgets.updated` has not arrived yet,
  head-anchored entities with/without a headset, WebGL context loss, a page reload
  before/during a capture, and a page that never receives its initial state.
  Writes samples and the mirror log to `data/mirror-samples/`; look at them after
  changes.
- `EVOL_MIRROR_MOCK_RUNTIME=1` swaps in `test/fixtures/mock-runtime.ts` (used
  automatically if `packages/runtime/src/index.ts` does not exist) to separate mirror
  bugs from runtime bugs; tests that need real scene patches/anchors are skipped then.

`png.ts` (`decodePng`, `imageStats`) is a dependency-free PNG decoder that other
server code/tests can use to sanity-check screenshots.
