# @evolspace/input

Hand features, pose matching, pose recording → `PoseDef`, Quest-style hand
rays, the interaction engine (grab / two-hand scale / widget / command /
channel bindings) and synthetic hands for tests and the desktop simulator.

Pure TypeScript - **no DOM, WebXR or three.js imports** - so the browser runtime
and the Node server share it. Contracts are in `packages/protocol/src/gestures.ts`.

## Layout

| File | What |
|---|---|
| `src/features.ts` | `computeFeatures(frame, head, other?)`, `FEATURE_INFO` (range/scale per feature), palm frame, finger angles. Documented in [FEATURES.md](FEATURES.md). |
| `src/matcher.ts` | `PoseMatcher` (enterMs debounce, exitSlack hysteresis, per-hand state, tracking-loss grace), `matchesPose`. |
| `src/derive.ts` | `derivePose(samples, opts)` → editable `PoseDef` with `stats`. |
| `src/ray.ts` | `handRay` (shoulder → hand anchor), `pinchPoint`, `contactPoint`, `OneEuroFilter`, `RaySmoother`. |
| `src/engine.ts` | `InteractionEngine`, `InteractionHost`, `Hit`. |
| `src/synth.ts` | `synthHand(spec)`, `wristRotation(fingers, palm)`, `HAND_SHAPES` presets. |
| `src/validate.ts` | `validatePoseDef`, `validateInteractionSet`, `validateInteractionBinding` (for hot-reload error messages). |
| `src/joints.ts`, `src/math.ts` | Joint indexing, small vec3/quat helpers (`math` namespace export). |

Default content lives in `library/poses/*.json` and `library/interactions/*.json`
(see `library/interactions/README.md`).

## Test

```sh
npx vitest run packages/input          # 90+ tests, < 1 s
npx tsc -p packages/input/tsconfig.json   # includes tests
```

`test/helpers.ts` has a `FakeHost` (axis-aligned box entities with optional
interactive parts) that is a good template for exercising the engine.

## Usage

```ts
import { InteractionEngine, synthHand, HAND_SHAPES, wristRotation } from '@evolspace/input';

const engine = new InteractionEngine(host);           // host: InteractionHost (the runtime implements it)
engine.setPoses(poses);                                // from 'gestures.defs'
engine.setInteractions(interactionSets);
// every XR frame:
engine.update({ left: leftFrame, right: rightFrame }, head, performance.now());
const rays = engine.rays();                            // for ray / cursor visuals

// Desktop simulator / tests:
const frame = synthHand({ hand: 'right', ...HAND_SHAPES.pinch,
  position: [0.2, 1.2, -0.35], rotation: wristRotation([0, 0, -1], [-0.6, -1, 0]) });
```

## Key design decisions

- **Features from joint positions only.** Curl is a sum of signed flexion
  angles (size-independent, abduction removed by projecting onto the flexion
  plane, axis taken from the metacarpal so it stays defined in a fist). Palm
  normal from wrist + index/pinky knuckles, sign-flipped for the left hand.
  Orientations reported by a runtime are never trusted for classification.
- **Extra features** beyond the protocol list: `thumb.out` (size-normalized
  thumb-tip ↔ index-knuckle distance; separates fist from thumbs-up far more
  reliably than thumb curl), `thumb.up`, `palm.forward`, `wrist.height`.
- **Hysteresis in feature units**: margin = `exitSlack × FEATURE_INFO.scale`, so
  one-sided bounds (e.g. `pinch.index max 0.025`) get a sensible release point
  (0.04 m). Tracking loss holds poses for 100 ms (`lostGraceMs`).
- **Hand ray**: from an estimated shoulder (head pose, yaw only: 18 cm out,
  22 cm down, 6 cm back) through the midpoint of the index knuckle and thumb MCP
  joint, which barely move when pinching (no ray jump on pinch). Smoothed with
  a one-euro filter per hand (`RaySmoother`).
- **synthHand** is the exact inverse of the feature definitions (curl spread
  across MCP/PIP/DIP in the 90:110:70 ratio; pinches solved by an analytic
  thumb IK: bisect MCP/IP flexion for reach, swing from the CMC). Left hands are
  the mirror image (positions x → −x, quaternions (x, −y, −z, w)).
- **derivePose** keeps features the user held steady (std/scale ≤ 0.12) that
  say something about the pose: all curls + `thumb.out`; pinches only when in
  contact (max only); spreads only between extended fingers and when unusual;
  `palm.up` / `palm.towardHead` / `thumb.up` only when strongly oriented
  (|mean| ≥ 0.75; `orientation: false` disables). Ranges = mean ± 2.5σ with a
  per-feature minimum half-width, clamped, bounds near the range ends dropped,
  rounded outward (curl 0.05, pinch 0.005 m, cosines 0.05, degrees 1).
  Never by default: `point.forward`, `palm.forward`, `wrist.height`,
  `hands.distance`, `spread.thumb-index` (use `include`).
- **InteractionEngine** - resolution rules in the header of `src/engine.ts`
  and in `library/interactions/README.md`. Details worth knowing:
  - `setEntityTransform` receives **space-coordinate** transforms (same frame
    as `getWorldTransform`); phases: one `start`, `move` every update (host
    throttles), one `end` - a grab that turns into a two-hand scale and back is
    one gesture.
  - Grab pointer: touch grabs follow `{pinchPoint, wrist rotation}`; ray grabs
    follow the ray pose `{origin, lookRotation(direction)}` (object keeps its
    distance and swings with the ray).
  - Two-hand scale: uniform scale = ratio of pinch-point distances; rotation
    about world up (`scaleRotation: 'yaw'` default, `'full'`/`'none'`
    available); translation = motion of the pinch midpoint. The pivot for
    rotation/scale is the pinch midpoint when both hands acquired the entity by
    **touch**, otherwise (any hand on a ray) the entity's own origin - scaling
    a panel 3 m away must not push it further away or swing it around the
    user. Releasing either hand falls back to a one-hand grab by the other.
  - Commands get `args = {...binding.args, hand, entity?, point?}` (entity/point
    when the binding's target hit something; `entity: null` when a binding
    with target ≠ `none` hit nothing, unless `binding.args` sets `entity`)
    on both `start` and `end`.
  - Widget events: `point` is the contact point for touch drags (from `start`
    on - not the host's surface-clamped touch hit point), or the current
    ray intersected with the plane through the initial hit with normal = the
    entity's local +Z for ray drags. Lost hands → `cancel`.
  - Built-ins besides bindings: `hover` start/move/end to widgets when a hand's
    near target is an interactive object; `press` start/end when an extended,
    non-pinching index tip pokes an interactive object (`poke` option).
  - `host.hover(hand, hit)` is called every update with the near target (touch
    hit, else ray hit) or null.
  - Host callbacks may throw: every transition / manipulation / hover step of
    an `update()` is isolated, the remaining steps still run (so no `end` is
    ever lost), and the first error is rethrown at the end of `update()`.
  - `cancelAll()` ends every session (widgets get `cancel`); poses still held
    stay active without a session, so they don't re-fire until re-made.
  - Time (`tMs`) must be monotonic per clock; a backwards jump (new clock
    base) restarts debounces and smoothing instead of stalling them.
  - Cost: ≈ 40 µs per two-hand `update()` on a desktop CPU (excluding host
    raycasts). The math helpers allocate small tuples; fine at 90 Hz, but keep
    it in mind before adding per-joint work.
