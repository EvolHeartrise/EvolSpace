# Interactions — how hand gestures do things

Every hand interaction in EvolSpace — grabbing, two-hand scaling, pressing
widget parts, push-to-talk, selection — is a **binding** from a **pose** to an
**action**. Nothing is hard-coded: edit these files (and `library/poses/*.json`)
and the server hot-reloads them to the headset.

- Poses: `library/poses/<id>.json` (`PoseDef`): conditions over hand features.
  Feature definitions and typical values: `packages/input/FEATURES.md`.
- Bindings live in three places:
  1. **Entity**: `entity.interactions` (set with a scene `update` op) — only for that entity.
  2. **Widget default**: `interactions` in a widget's definition (`library/widgets/<id>/widget.ts`).
  3. **Interaction sets** (this folder): `scope: "entity-default"` (applies to
     every entity) or `scope: "global"` (applies anywhere, even with nothing targeted).

Types: `InteractionSet` / `InteractionBinding` in `packages/protocol/src/gestures.ts`.

## Shipped sets

| File | Scope | Bindings |
|---|---|---|
| `standard.json` | entity-default | `press`: pinch an interactive part → widget handler `press` (priority 10) · `grab`: pinch → grab (target near) · `scale`: second hand pinches the grabbed entity → two-hand scale (priority 20) |
| `global.json` | global | `push-to-talk`: **left** middle-finger pinch, held → command `voice.ptt` · `select`: **right** middle-finger pinch → command `select` on the ray target · `agent-panel`: left palm-up open hand (300 ms) → `agent.panel.toggle` |

## Binding fields

```json
{
  "id": "grab",                       // unique within its set
  "description": "…",                 // optional, for humans/Claude
  "pose": "pinch",                    // a pose id from library/poses
  "hand": "either",                   // "left" | "right" | "either" (default) | "both"
  "target": "near",                   // "ray" | "touch" | "near" | "none"
  "action": { "type": "grab" },
  "priority": 0                       // higher wins within the same scope (default 0)
}
```

Targets: `ray` = the hand's pointing ray (from the shoulder through the hand);
`touch` = the pinch point (or index tip when not pinching) within 3 cm of an
entity; `near` = touch if anything is touched, else ray; `none` = no target.

Actions:

| Action | Effect |
|---|---|
| `{"type":"grab"}` | Entity follows the hand rigidly (keeps the grab offset) until the pose ends. Ignored on `locked` entities. |
| `{"type":"scale"}` | Only when the **other** hand is already grabbing the target entity: takes over as two-hand translate / yaw-rotate / uniform scale. Translation follows the midpoint between the pinches; the pivot is that midpoint when both hands touch the entity, or the entity's origin when either hand reached it by ray (distant objects scale in place). Releasing one hand returns to a one-hand grab. |
| `{"type":"widget","handler":"drag"}` | Sends `InteractionEvent`s (`start`/`move`/`end`, `cancel` if the hand is lost) to the widget's `onInteraction`. **Only matches when the hit object was registered with `ctx.interactive()`** — so pinching a slider's knob drags it and pinching its frame falls through to grab. |
| `{"type":"command","command":"undo","args":{…}}` | Runs a command at pose start **and again with phase `end`** at pose end (held commands like `voice.ptt` use both; one-shot commands ignore `end`). Args get `hand`, plus `entity` and `point` when the target hit something, or `entity: null` when a targeted binding (target ≠ `none`) hit nothing — e.g. `select` then clears the selection. |
| `{"type":"channel","channel":"interp.ctl.play","value":true,"endValue":false}` | Publishes `value` to a data channel at start, and `endValue` (if given) at end. |

## How a binding is chosen

When a pose starts on a hand, the engine looks for a binding in this order and
stops at the first scope that has a match (within a scope: highest `priority`;
ties → first declared; sets of the same scope are read in file-name order):

1. **entity** — `interactions` of the entity hit by the binding's target mode
2. **widget default** — that entity's widget's `interactions`
3. **entity-default** sets — any entity hit by the binding's target mode
4. **global** sets — no hit needed (commands/channels get `entity` only if something was hit)

A candidate is skipped (and the search continues) when: the pose/hand doesn't
match; a scoped binding's target hits nothing (or hits a different entity);
it's a `widget` action and the hit isn't an interactive part; it's
`grab`/`scale` on a `locked` entity, or `grab` on an entity another hand is
already manipulating; it's `scale` and the other hand isn't grabbing the hit
entity (or its ancestor); it's `hand: "both"` and the other hand doesn't hold
the same pose. A `both` binding ends when either hand releases.

Every pose start/end is logged as a `PoseEvent` (with the binding id and target)
— the agent can inspect them via the events API.

## Recipes

- **New global gesture → command**: add a binding to `global.json`, e.g.
  `{"id":"undo-fist","pose":"fist","hand":"right","target":"none","action":{"type":"command","command":"undo"}}`.
  Make sure the pose doesn't collide with poses used in the same context.
- **Make one entity respond differently**: give the entity an `interactions`
  array (scene `update` op); it overrides widget defaults and these sets for
  that entity.
- **Gesture drives a data channel**: `{"type":"channel","channel":"interp.ctl.play","value":true,"endValue":false}`.
- **Disable grabbing an entity**: set `locked: true` on it.
- **New pose**: record it (`POST /api/gestures/record {name, hand}` or the MCP
  tool), or write `library/poses/<id>.json` by hand using FEATURES.md.

## Pitfalls

- **Quest system gesture**: palm facing the head + index pinch opens the Quest
  menu. `pinch` excludes `palm.towardHead > 0.6`; keep new pinch-like poses
  away from that orientation.
- Bindings referencing a pose that doesn't exist never fire (the server's
  validator warns).
- Overlapping poses fire together: a binding on `fist` will also fire during
  a sloppy `thumbs-up` unless the poses are made exclusive (see `thumb.out`).
- `left`/`right` are the user's hands, not screen sides.
