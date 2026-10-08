# mirror (browser side)

Renders the live space, and single widgets in a neutral "studio", into PNG data
URLs for the server's headless mirror (`apps/server/src/mirror`). The client's
`main.ts` loads it for `?role=mirror` and calls the default export
`startMirror({ wsUrl, container })`. A plain import also works: the module starts
itself one task later if nobody called it. It works in a normal tab too: open
`https://<server>/?role=mirror` and run
`await __evolMirror.capture({view:{kind:'widget',widget:'box'}}, null)`.

```ts
window.__evolMirror = {
  ready: Promise<void>,                  // snapshot + catalog received (rejects after 20 s; startup only)
  capture(req: ScreenshotRequest, userPose: UserPose | null, opts?: { failOnWidgetError?: boolean }): Promise<string>,
  info(): MirrorInfo,                    // GL renderer, context lost?, connection, scene version, widgets, last settle report
}
```

`capture()` serializes itself and waits up to 8 s for the initial scene + catalog. On
failure it throws `mirror: not ready…`, which tells the server to relaunch. It never
reuses the sticky `ready` rejection, so a page that got its state late still works.

## Structure

| File | Role |
|---|---|
| `index.ts` | entry, `window.__evolMirror`, WS URL (`?ws=` override) |
| `mirror.ts` | `MirrorRenderer`: WebGLRenderer (`preserveDrawingBuffer`), NetClient(role `mirror`), two `SpaceRuntime`s, capture pipeline |
| `runtime-adapter.ts` | the only importer of `@evolspace/runtime` values; narrow `RuntimeLike` interface |
| `passive.ts` | passive `NetPort` over the shared NetClient (see below), DOM-free, unit tested |
| `framing.ts` | pure camera math (user/explicit cameras, tight box framing), unit tested |
| `settle.ts` | "wait until loaded" (runtime idle hook, troika text syncs, image textures, entity objects, structural stability) |
| `studio.ts` | studio stage: mid-grey background, fading grid floor sized to the subject, soft lights |
| `overlays.ts` | debug labels (canvas sprites, constant screen size) and fallback ghost hands |
| `scene-index.ts` | id/name/widget/visibility index from snapshot/patch messages (labels, errors, load checks); `isStructural(ops)` |
| `background.ts` | `'scene' | 'transparent' | CSS color` parsing via the browser's CSS parser |

Two runtimes share one NetClient. Both are constructed synchronously right after it,
so neither misses the initial catalog. The **space** runtime mirrors the server
scene. The **studio** runtime (`sceneFromNet: false`) renders one locally spawned
widget per capture (fresh entity id each time, cleared afterwards).

## Passive observer

The mirror's widget instances are copies of the headset's, or one-off studio
instances. Their side effects must not reach the server, or they would duplicate or
fight the real ones: scene edits (`setProps`, `spawnChild`), channel publishes
(including port→channel links), `widget.event`, `agent.ask` and commands. A slider
in a thumbnail must not publish its default value to a live channel. Both runtimes
therefore talk through `passivePort()`, which forwards only `client.error`,
`client.log` and channel (un)subscriptions and drops binary publishes. The runtime
still applies widget scene edits locally, so screenshots show them; they are just
never persisted. The port also lets the mirror observe outgoing `client.error`s
(used for load checks and `failOnWidgetError`).

## Freshness (no stale screenshots)

The agent typically changes something (POST ops, edits a widget) and immediately asks
for a screenshot. The WS messages carrying the change may still be in flight. Before
each capture the page therefore GETs `/api/scene/summary` (version) and `/api/widgets`
(hashes) from the server (`net.httpBase`, best effort, 1.5 s timeout):
- it waits (up to 3 s) until the `scene.patch` messages up to that version arrived;
- it applies any manifest whose hash differs from what a runtime uses, as
  `widgets.updated` would, so a just-rebuilt widget renders its new bundle.

## User pose and anchors

The runtime expires a `setUser` pose after 1 s and then derives the head from the
render camera. In the mirror that would put head-anchored entities in front of
*every screenshot camera*. The mirror therefore feeds a user view to both runtimes
on every frame and tick: the capture's `UserPose`, or `DEFAULT_USER_VIEW` (standing
at the origin, 1.6 m, looking down -Z) when no headset is connected. Full hand frames
go to `setHandFrames` (joint anchors). Lazy head-follow anchors are snapped at
capture start, so they sit in front of the head instead of gliding there mid-capture.

## Views

- `user`: camera at `UserPose.head`, vertical FOV `pose.fov` (default 90°), image
  aspect from the request (the server derives the height from `pose.aspect`, default
  1). No pose is an error. Ghost hands are on by default.
- `camera`: `position` + `rotation` | `lookAt`. With neither, it looks at the centre
  of the scene content. FOV default 60°.
- `entity`: auto-frames the entity subtree bounds (`runtime.frameEntity`).
  `direction` points **from the subject toward the camera**. The default is the
  entity's own front (`[0, 0.3, 1]` in entity space). `padding` is the fractional
  margin per side (default 0.15). It is a tight fit: every bounding-box corner is
  projected, not a bounding sphere. Non-finite (NaN) parts are ignored.
- `widget`: studio render of `widget` with `props`, default direction
  `[0.3, 0.25, 1]` (a mild 3/4 view). Unknown widgets are rejected with the list of
  known ones. Ghost hands are never drawn in the studio.

Options:
- `hands`: ghost hands from the runtime's `createHandVisual` (60% opacity), with a
  fallback skeleton if unavailable.
- `labels`: name and "widget · id" above each entity, drawn on top.
- `background`: `scene` (the runtime's background or `#1b1f26`; studio default
  `#3a3f47`), `transparent`, or any CSS color including alpha.

## Waiting for a complete scene

Screenshots of half-loaded scenes are useless. Before capturing, `settle()` steps
frames (update + render) within an 8 s budget until:
1. the runtime's `whenIdle()` resolves (pending widget imports and async `create()`);
2. all troika texts have finished syncing and texture images are decoded;
3. every visible entity has an object with something renderable, or has reported a
   `client.error` (bounded by a 4 s grace, since an entity may render nothing);
4. the scene structure (objects, vertices, instance counts) and structural scene
   messages have been quiet for 150 ms, and at least 3 frames have run.
   Transform-only patches (drags) do not count, so captures don't stall mid-gesture.

Then the final camera is placed from the settled bounds, overlays are added, and two
more frames are rendered before `toDataURL`. A timeout is a warning, not an error. A
lost WebGL context fails the capture (`mirror: WebGL context lost`) so the server
relaunches the browser.

Widget failures: `thumbnail()` uses `failOnWidgetError`, so a broken widget yields an
error instead of a picture of the fallback box.

## Performance note

This code only runs in the PC's headless Chromium, never on the Quest. Between
captures it updates both runtimes at 10 Hz without rendering, so channel links and
anchors stay current. Renders happen only during captures.
