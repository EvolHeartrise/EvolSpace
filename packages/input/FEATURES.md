# Hand features — reference for pose authors

A **pose** (`library/poses/<id>.json`, type `PoseDef`) is a conjunction of
ranges over the named scalar features below. `computeFeatures(frame, head, other?)`
in `src/features.ts` is the single source of truth; this document describes
exactly what it computes. Values are rounded to 4 decimals.

Coordinate conventions: space coordinates are meters, right-handed, Y up; the
head looks along its local −Z. Hand joints follow the WebXR Hand Input
convention (see "Joint conventions" at the end).

## Quick reference

| Feature | Unit / range | Open hand | Fist | Index pinch | Thumbs-up | Notes |
|---|---|---|---|---|---|---|
| `curl.thumb` | 0..1 | 0.0–0.2 | 0.5–0.8 | 0.2–0.5 | 0.0–0.2 | noisy on real tracking; prefer `thumb.out` |
| `curl.index` | 0..1 | 0.0–0.15 | 0.8–1.0 | 0.35–0.55 | 0.8–1.0 | |
| `curl.middle` / `ring` / `pinky` | 0..1 | 0.0–0.2 | 0.8–1.0 | 0.1–0.4 (relaxed) | 0.8–1.0 | relaxed hands curl ring/pinky more |
| `pinch.index` | m, 0..~0.2 | 0.08–0.12 | 0.03–0.06 | **0.005–0.02** | 0.10–0.13 | contact ≈ < 0.025 |
| `pinch.middle` / `ring` / `pinky` | m | 0.10–0.18 | 0.04–0.07 | 0.04–0.08 | 0.12–0.17 | |
| `spread.index-middle` etc. | deg, 0..~40 | 5–15 | (meaningless) | 3–10 | (meaningless) | only meaningful for extended fingers |
| `spread.thumb-index` | deg, 0..~120 | 20–50 | 30–60 | 10–30 | 70–90 | |
| `thumb.out` | palm lengths, 0..~1.4 | 0.8–1.0 | **0.5–0.7** | 0.6–0.8 | **1.0–1.3** | thumb tip ↔ index knuckle |
| `thumb.up` | cos, −1..1 | | | | > 0.7 | direction of the thumb vs world up |
| `palm.up` | cos, −1..1 | palm down ≈ −1, palm up ≈ +1, sideways ≈ 0 | | | | |
| `palm.towardHead` | cos, −1..1 | looking at your palm ≈ 0.8–1 | | | | Quest system gesture zone: > 0.6 |
| `palm.forward` | cos, −1..1 | "stop" gesture ≈ 0.8–1 | | | | |
| `point.forward` | cos, −1..1 | | | | | index finger along the gaze ≈ 1 |
| `wrist.height` | m | typically −0.6..0 | | | | wrist y − head y |
| `hands.distance` | m | | | | | only when both hands are tracked |

Typical values are from the synthetic hand model plus margins for real Quest 3
tracking; when in doubt, record the pose (`POST /api/gestures/record`) and read
the `stats` in the generated file.

## Definitions

Notation: `J(name)` = joint position; `norm(v)` = v/|v|; `angle(a,b)` =
unsigned angle in degrees; `·` = dot product; `×` = cross product.

### Palm frame (positions only)

Robust across runtimes whose joint *orientations* differ, so only joint
positions are used:

- `wrist = J(wrist)`
- `n` (palm normal, pointing **out of the palm**) =
  `norm((J(index-finger-phalanx-proximal) − wrist) × (J(pinky-finger-phalanx-proximal) − wrist))`,
  negated for the **left** hand (mirror image). This equals the WebXR wrist −Y axis.
- `forward = norm(J(middle-finger-phalanx-proximal) − wrist)` with its `n` component removed.
- `lateral = norm(forward × n)` — positive finger flexion rotates about this axis.
- `palmLength = |J(middle-finger-phalanx-proximal) − wrist|` (≈ 0.095 m adult).

### `curl.<finger>` — 0 straight … 1 fully curled (index, middle, ring, pinky)

Bones (unit vectors): `m` metacarpal (metacarpal → proximal), `p` proximal
phalanx (proximal → intermediate), `i` intermediate (→ distal), `d` distal (→ tip).
Flexion axis `a = norm(m × n)` (perpendicular to the metacarpal, in the palm
plane; the metacarpal never curls, so this stays well-defined in a fist).
Signed flexion of bone `u → v`: project both onto the plane ⟂ `a` (removes
sideways abduction), then `atan2(((u'×v')·a), (u'·v'))`; positive = toward the palm.

```
MCP = flex(m, p), PIP = flex(p, i), DIP = flex(i, d)
curl = clamp((max(0,MCP) + max(0,PIP) + max(0,DIP)) / 270°, 0, 1)
```

270° = 90° (MCP) + 110° (PIP) + 70° (DIP), the anatomical maxima. Hyperextension
counts as 0. Being angle-based, curl is independent of hand size.

### `curl.thumb` — 0 straight … 1 fully flexed

Thumb bones: metacarpal (`thumb-metacarpal → thumb-phalanx-proximal`),
proximal phalanx (`→ thumb-phalanx-distal`), distal phalanx (`→ thumb-tip`).
`curl.thumb = clamp((angle(meta, prox) + angle(prox, dist)) / 140°, 0, 1)`
(140° = 60° MCP + 80° IP). Unsigned (the thumb's flexion axis is ill-defined),
and it does not include the thumb's base (CMC) rotation, so a thumb tucked
across the palm can still read low. To tell "thumb out" from "thumb tucked",
use **`thumb.out`**.

### `pinch.<finger>` — meters (index, middle, ring, pinky)

`|J(thumb-tip) − J(<finger>-finger-tip)|`. Tip joints sit inside the finger
pads, so touching pads read ≈ 0.008–0.02 m. Use `max ≈ 0.025` for "touching";
the exit hysteresis (below) then releases at ≈ 0.04.

### `spread.<a>-<b>` — degrees

- Long fingers (`index-middle`, `middle-ring`, `ring-pinky`): angle between the
  two proximal-phalanx directions after projecting them onto the palm plane
  (⟂ `n`). Meaningful only when both fingers are fairly straight (curl < ~0.4);
  for curled fingers the projections degenerate and the value is noise.
- `thumb-index`: 3-D angle between the thumb direction
  (`thumb-phalanx-proximal → thumb-tip`) and the index proximal phalanx.

### `thumb.out` — palm lengths

`|J(thumb-tip) − J(index-finger-phalanx-proximal)| / palmLength`. Size
independent. Thumb wrapped over a fist ≈ 0.5–0.7; relaxed alongside the hand
≈ 0.8–0.95; stuck out (thumbs-up, "L") ≈ 1.0–1.3.

### `thumb.up` — cosine

`norm(J(thumb-tip) − J(thumb-phalanx-proximal)) · (0,1,0)`. Only meaningful when
the thumb is extended (`thumb.out` high).

### Orientation (cosines, −1..1)

- `palm.up = n · (0,1,0)`
- `palm.towardHead = n · norm(head.position − wrist)` — **Quest reserves "palm
  facing the head + index pinch" for its system menu**; keep pinch-like poses at
  `palm.towardHead max ≈ 0.6`.
- `palm.forward = n · headForward` where `headForward` = head rotation applied to (0,0,−1).
- `point.forward = norm(J(index-tip) − J(index-finger-phalanx-proximal)) · headForward`.

### Position

- `wrist.height = wrist.y − head.y` (meters; negative = below the eyes).
- `hands.distance = |wrist − otherWrist|` (meters). **Only present when both
  hands are tracked**; a condition on a missing feature never holds.

## How conditions are evaluated (PoseMatcher)

- `{ "feature": f, "min"?: a, "max"?: b }`: holds when `a ≤ value ≤ b`. All
  conditions must hold. Unknown / missing features never hold (the validator
  warns about unknown names).
- `hand`: `"left"`, `"right"` or `"either"` (tracked per hand independently).
- **Entry debounce** `enterMs` (default 60): conditions must hold continuously
  that long before the pose starts.
- **Exit hysteresis** `exitSlack` (default 0.15): while active, every bound is
  widened by `exitSlack × scale(feature)`; the pose ends on the first frame a
  widened condition fails. Scales:

  | Feature | scale | margin at 0.15 |
  |---|---|---|
  | `curl.*` | 1 | 0.15 |
  | `pinch.*` | 0.1 m | 0.015 m |
  | `spread.*` (long fingers) | 30° | 4.5° |
  | `spread.thumb-index` | 60° | 9° |
  | `palm.*`, `point.forward`, `thumb.up` | 2 | 0.3 |
  | `thumb.out` | 1 | 0.15 |
  | `wrist.height`, `hands.distance` | 1 m | 0.15 m |

- Tracking loss: active poses are held 100 ms, then end.

## Authoring tips

- Describe **shape** with curls, pinches and `thumb.out`; add orientation
  (`palm.up`, `thumb.up`, …) only when the orientation is the point of the pose.
- Prefer one-sided bounds at the ends of a range (`curl min 0.65` rather than
  `0.65..1`).
- Leave ~0.1 (curl) / 0.005 m (pinch) of margin beyond what you expect: real
  tracking is noisier than the synthetic model.
- Make poses that share a binding context mutually exclusive (e.g. `fist` uses
  `thumb.out max 0.8`, `thumbs-up` uses `thumb.out min 0.95`).
- Recorded poses (`source: "recorded"`) carry `stats` (mean/std of every
  feature during the recording) — use them to tune ranges by hand.

## Joint conventions (WebXR Hand Input)

`HandFrame.joints` = 25 × `[px, py, pz, qx, qy, qz, qw]` in `HAND_JOINTS` order.
For every joint, **−Z points along the bone that starts at that joint, toward
the fingertip** (the tip joint reuses its incoming bone direction) and **−Y
points out of the palm** (+Y = back of the hand / nail side); X = Y × Z. Both
hands use the same rule, so with an identity wrist rotation the palm faces
down, the fingers point forward (−Z), and the thumb lies on −X for a right
hand and +X for a left hand. `synthHand` produces exactly this; the features
only use joint positions, so they do not depend on a runtime getting the
orientations right.
