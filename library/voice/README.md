# Voice fast-path commands (`commands.json`)

When the user speaks (push-to-talk), the server transcribes the utterance and
checks it against `commands.json`. If a command matches, the server runs it
directly, in about 200 ms. Anything that does not match goes to Claude as an
`agent.ask`. The server hot-reloads this file on save; no restart is needed.

**Keep this list conservative.** Add a command only for short, unambiguous
phrases that map to exactly one action. If the user might mean several things
or adds detail ("delete all the spheres", "make this red"), leave it to Claude.

## Format

`commands.json` is an array of `VoiceCommand` objects (see
`packages/protocol/src/api.ts`):

```json
{
  "id": "delete-target",
  "description": "Delete the entity being pointed at (or the selection).",
  "patterns": ["(delete|remove) (this|that|it)( (one|thing|widget))?"],
  "command": "delete",
  "args": { "entity": "$target" }
}
```

- **id**: unique. The id is shown in the headset HUD and in the result of
  `/api/voice/simulate`, so make it readable.
- **patterns**: JavaScript regexes. Each pattern is tested against the
  **normalized** transcript and must match the **whole** utterance; the server
  wraps it as `^(?:…)$` with the `iu` flags. Do not add `^`/`$`.
  - Normalization: lowercase, apostrophes dropped (`that's` → `thats`), all
    other punctuation and hyphens turned into spaces (`pass-through` →
    `pass through`, `A.R.` → `a r`), whitespace collapsed. Patterns should
    therefore contain only lowercase words and spaces.
  - When nothing matches, the matcher trims conversational padding one word or
    phrase at a time and retries after each step: first leading
    `um/uh/okay/so/hey/please/claude/can you/could you/just…`, then trailing
    `please/thanks/now/for me/claude`. As a result, "Okay Claude, undo
    please" matches `undo`, and "Hide Claude, please" matches as "hide claude"
    before it would be trimmed to "hide". You do not need to write these words
    into patterns.
  - Whisper spelling varies, so cover the variants: `pass ?through`, `re ?do`,
    `(ar|a r)`, `never ?mind`. Whisper often hears "Claude" as clod, clawed,
    cloud or clog.
  - Named groups become variables: `"set layer (?<n>[a-z0-9 ]+)"`.
- **command**: a name in the **server command registry**. See
  `POST /api/command {name:'commands.list'}` for the list: `undo`, `redo`,
  `delete`, `duplicate`, `spawn`, `workspace.save`, `screenshot`, `broadcast`,
  `agent.ask`, `say`, `source.restart`, … Two special cases:
  - `"none"` is a no-op. The utterance is consumed and nothing happens; used
    for "cancel" and "never mind".
  - Commands that run **in the headset** (`select`, `agent.panel.toggle`,
    `session.mode`, `origin.recalibrate`, `perf.toggle`, `hands.toggle`) go
    through `broadcast`:
    `"command": "broadcast", "args": { "name": "session.mode", "args": { "mode": "ar" } }`.
- **args** (optional): any JSON. Variables are substituted recursively inside
  nested objects and arrays:

  | Variable | Value |
  |---|---|
  | `$target` | The entity the user means by "this/that". Resolved in order: right-hand ray focus, left-hand ray focus, selection, gaze, all captured when push-to-talk started. |
  | `$focus` / `$selected` / `$gaze` | The individual context entities. |
  | `$<group>` | A named regex group. If an optional group did not match, its key is **omitted**. |
  | `$text` / `$transcript` | The normalized utterance / the raw transcript. |
  | `$x:number` / `$x:int` | Converted to a number. Accepts digits and spoken numbers ("twenty one"). |
  | `$x:slug` | `My Space` → `my-space` (workspace names, ids). |
  | `$x:bool` | `on/yes/true/show/open/enable` → `true`, otherwise `false`. |

  A string that is exactly `"$var"` is replaced by the (typed) value. A `$var`
  inside a longer string is spliced in as text. If `$target` (or another
  context variable) is needed but the user is not pointing at or selecting
  anything, the command does not run and the user is told to point at
  something.

Rules: the **first** matching command in file order wins, so put specific
commands before generic ones. An invalid entry (bad regex, missing field,
duplicate id) is skipped and reported in the XR panel and the server log, and
the remaining entries still load. If the file is not valid JSON (for example,
half-saved), the previous set stays active.

## Checking your change

```bash
curl -s localhost:8787/api/voice/commands            # what is loaded
curl -s -X POST localhost:8787/api/voice/simulate -H 'content-type: application/json' \
  -d '{"text":"delete this","context":{"target":"e-1234"}}'   # → {"route":"fastpath","command":"delete-target"}
```

`simulate` runs the command for real; it is equivalent to speaking. Also run
`npx vitest run apps/server/src/voice/test/matcher.test.ts`. That test checks
the shipped phrases against this file, including the phrases that must
**not** match.

## Example: adding a command on request

"Let me say *layer five* to set the interp lens layer":

```json
{
  "id": "set-interp-layer",
  "description": "Set the interp lens layer by voice.",
  "patterns": ["(set )?layer (?<n>[a-z0-9 -]+)"],
  "command": "channel.publish",
  "args": { "channel": "interp.ctl.layer", "value": "$n:int" }
}
```

Check `commands.list` first. At the time of writing there is no
`channel.publish` server command yet; it would need to be registered in
`apps/server/src/commands.ts`. Until then, use a command that does exist, or
`broadcast` to a client command.
