# Voice (server side)

`createVoice(deps, opts?)` implements `VoiceService` (`types.ts`): it receives
push-to-talk audio from xr clients, transcribes it with `python/stt`, and
routes the text to a fast-path command (`library/voice/commands.json`) or to
Claude.

```
voice.begin ─► buffer PCM per utterance (cap 30 s)         status: listening
voice.end   ─► too short (<250 ms)? → voice.result none
            ─► POST python/stt /transcribe (vocabulary prompt)   status: transcribing
            ─► empty / hallucination ("Thank you.") / prompt echo → voice.result none
            ─► say(text, 'heard')                       (always: the XR panel echo)
            ─► commands.json match? ─ yes → substitute $vars → deps.runCommand(...)
            │                       └ no  → deps.agentAsk(text, deictic context)
            ─► voice.result → originating client; voice.utterance event   status: handed back
                                                           (Claude's thinking/working, else idle)
```

## Files

| File | What |
|---|---|
| `index.ts` | `createVoice`: utterance buffers, status, the STT call, transcript cleaning, routing. |
| `types.ts` | Contract with the server core (`VoiceDeps`, `VoiceService`). |
| `normalize.ts` | `normalize()` (the contract form), `canonicalForms()` / `canonical()` (fillers trimmed step by step / fully), `parseNumber()` (spoken numbers). |
| `matcher.ts` | `matchCommand()`, `contextEntities()` (deictic target), `substituteArgs()` (`$target`, `$group`, `$x:number`, …). |
| `commands.ts` | Loads, validates and compiles `commands.json` (each bad entry is skipped with a report, and a broken file keeps the last good set); chokidar hot reload. |
| `stt.ts` | `SttClient` (errors are typed as `unavailable`, `loading`, `timeout` or `failed`) and `buildPrompt()`. |

The command file format is documented in `library/voice/README.md`.

## Behaviour details

- **Deictic target** (`$target`): right-hand ray focus, then left-hand focus,
  then selected, then gaze, all taken from the `VoiceContext` the client
  captured when push-to-talk started. Push-to-talk is a left-hand gesture, so
  the right hand is the one that points. `simulate()` also accepts an explicit
  `context.target`.
- **To Claude**: `agentAsk(text, { source:'voice', kind:'voice', utteranceId,
  clientId, target, target_name, target_widget, selected, selected_name, focus,
  gaze, focused? })`. The field names match `apps/mcp-bridge/src/channel.ts`
  `askToNotification`. Names and widgets come from the optional
  `deps.describeEntity`.
- **Status**: voice borrows the agent status indicator. It shows `listening`
  on begin and `transcribing` on end. When routing is done, it **gives the
  indicator back**: if Claude was `thinking` or `working` (when push-to-talk
  started, or because a Claude Code hook changed it meanwhile), that status
  is restored. Otherwise the indicator goes to `idle`. If something else
  changed the status after voice's last update, voice leaves it alone. This
  needs the optional `deps.agentStatus()`; without it, voice always ends with
  `idle`. On the agent route, the MCP bridge then sets `thinking` when it
  delivers the request to Claude Code.
- **STT down**: the user sees "Speech recognition is not running" in XR, and
  the service runs `source.restart {id:'stt'}` (at most once per 60 s). In the
  first 20 s after server start (`startupGraceMs`), an unreachable STT is
  assumed to be booting under the supervisor, so voice does not restart it and
  the user sees "still starting up". `503 loading` → "still starting up".
  Timeout (15 s) → "timed out". In every case `voice.result` returns
  `route:'none'` and the status is handed back.
- **Robustness**: utterances are keyed by client + utterance id, so clients
  can never clobber each other. Audio for unknown ids or from the wrong client
  is ignored. Ids are truncated to 36 chars everywhere, the size of the
  AudioFrame field. A new `voice.begin` from the same client supersedes a lost
  one. Utterances with no audio or end for 10 s are dropped. Non-16 kHz rates
  (8–48 kHz) are passed through, and the STT service resamples them. After
  `close()`, in-flight transcriptions do not run commands.
- **Matching**: the matcher tries the plain normalized text first, then every
  intermediate filler-trimmed form, least trimmed first (`canonicalForms()`).
  For example, "hide Claude please" becomes "hide claude", which matches,
  rather than being trimmed all the way to "hide".
- **Hot reload**: edit `library/voice/commands.json` and it applies on save.
  Problems are reported in the XR panel and the server log.
- `voice.result.command` and `simulate().command` hold the **voice command
  id** (for example `delete-target`), not the server command name.

Options (`VoiceOptions`, second argument): `sttUrl` (default `deps.sttUrl` →
`EVOL_STT_URL` → `http://127.0.0.1:8790`), `sttTimeoutMs`, `minDurationMs`,
`maxDurationMs`, `staleMs`, `watch`, `sttSourceId`, `restartCooldownMs`,
`startupGraceMs`.

## Tests

```bash
npx vitest run apps/server/src/voice                       # matcher + service with a fake STT HTTP server
EVOL_STT_E2E=1 npx vitest run apps/server/src/voice/test/real-stt.e2e.test.ts
# ^ full stack: spawns python/stt on a free port, SAPI speech → real commands.json; prints per-phrase latency
```

Measured end to end, from `voice.end` to `voice.result`, on GTX 1080 +
small.en: **165–240 ms**. Per-config STT numbers are in
`python/stt/README.md`.
