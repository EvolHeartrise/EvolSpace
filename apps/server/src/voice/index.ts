// Voice service: push-to-talk utterances → STT → fast-path command or Claude.
//
//   voice.begin ─► buffer PCM (cap 30 s), status 'listening'
//   voice.end   ─► status 'transcribing' ─► POST python/stt /transcribe (vocabulary prompt)
//               ─► transcript echoed to the XR panel (kind 'heard')
//               ─► fast path: library/voice/commands.json match → deps.runCommand
//                  otherwise: deps.agentAsk(text, deictic context) → Claude
//                  (voice.begin agent 'oneshot': no fast path, deps.oneshotAsk → a one-off agent)
//               ─► voice.result to the originating client, voice.utterance event, status restored
//                  (Claude's thinking/working if it was busy, else idle)
//
// simulate(text) runs the same routing without audio (POST /api/voice/simulate).
// See README.md in this folder for design notes.
import type { AgentState, AgentStatus, ClientMessage, ServerMessage, VoiceCommand, VoiceContext } from '@evolspace/protocol';
import type { VoiceDeps, VoiceService } from './types.ts';
import { CommandLibrary } from './commands.ts';
import { contextEntities, matchCommand, MissingVariableError, substituteArgs, type ContextEntities } from './matcher.ts';
import { normalize } from './normalize.ts';
import { buildPrompt, SttClient, SttError, type SttResult } from './stt.ts';

export type { VoiceDeps, VoiceService };
export { normalize, canonical, canonicalForms, parseNumber } from './normalize.ts';
export { matchCommand, substituteArgs, contextEntities } from './matcher.ts';
export { parseCommands } from './commands.ts';

type VoiceBegin = Extract<ClientMessage, { type: 'voice.begin' }>;
type VoiceEnd = Extract<ClientMessage, { type: 'voice.end' }>;
type Route = 'fastpath' | 'agent' | 'none';

export interface VoiceOptions {
  /** STT base URL. Default: deps.sttUrl ?? env EVOL_STT_URL ?? http://127.0.0.1:8790. */
  sttUrl?: string;
  sttTimeoutMs?: number;
  /** Utterances shorter than this are ignored (accidental pinches). Default 250 ms. */
  minDurationMs?: number;
  /** Audio beyond this is dropped. Default 30 s. */
  maxDurationMs?: number;
  /** An utterance with no audio/end for this long is discarded (client vanished). Default 10 s. */
  staleMs?: number;
  /** Watch commands.json for edits. Default true. */
  watch?: boolean;
  /** Source to restart (via the 'source.restart' command) when STT is unreachable; null disables. Default 'stt'. */
  sttSourceId?: string | null;
  /** Minimum time between such restarts. Default 60 s. */
  restartCooldownMs?: number;
  /**
   * For this long after createVoice (server start) an unreachable STT is assumed
   * to be booting under the supervisor: no restart, "still starting up". Default 20 s.
   */
  startupGraceMs?: number;
  now?: () => number;
}

/** Special command name: matched, but intentionally does nothing ("never mind"). */
export const NOOP_COMMAND = 'none';

/** Whisper's classic outputs for non-speech; dropped when there is barely any speech. */
const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'thank you so much for watching',
  'bye', 'bye bye', 'the end', 'please subscribe', 'subtitles by the amaraorg community', 'so',
]);

interface Utterance {
  id: string;
  clientId: string;
  sampleRate: number;
  context: VoiceContext;
  oneshot: boolean;
  chunks: Int16Array[];
  samples: number;
  maxSamples: number;
  truncated: boolean;
  startedAt: number;
  stale: NodeJS.Timeout | null;
}

export interface RouteOutcome {
  route: Route;
  /** Voice command id (fast path). */
  command?: string;
}

export function createVoice(deps: VoiceDeps, opts: VoiceOptions = {}): VoiceService {
  const now = opts.now ?? Date.now;
  const minMs = opts.minDurationMs ?? 250;
  const maxMs = opts.maxDurationMs ?? 30_000;
  const staleMs = opts.staleMs ?? 10_000;
  const sttSourceId = opts.sttSourceId === undefined ? 'stt' : opts.sttSourceId;
  const restartCooldownMs = opts.restartCooldownMs ?? 60_000;
  let lastRestart = -Infinity;
  const stt = new SttClient({
    url: opts.sttUrl ?? deps.sttUrl ?? process.env.EVOL_STT_URL ?? 'http://127.0.0.1:8790',
    timeoutMs: opts.sttTimeoutMs ?? 15_000,
  });

  let hadProblems = false;
  const library = new CommandLibrary({
    dir: deps.voiceDir,
    watch: opts.watch,
    log: deps.log,
    onReload: ({ count, problems, initial }) => {
      // Surface edit mistakes where the editor (usually Claude) and the user will
      // see them, and confirm once they are fixed.
      if (!initial && problems.length) deps.say(`Voice commands: ${problems.length} problem(s): ${problems[0]}`, 'error');
      else if (!initial && hadProblems) deps.say(`Voice commands OK again: ${count} loaded.`, 'info');
      hadProblems = problems.length > 0;
    },
  });
  const ready = library.init().catch((e: Error) => deps.log('error', `voice: could not load commands: ${e.message}`));

  /**
   * Utterances being recorded, keyed by client + utterance id (ids come from
   * clients, so two clients must never be able to clobber each other's entry).
   */
  const listening = new Map<string, Utterance>();
  const key = (clientId: string, utteranceId: string) => `${clientId}\u0000${utteranceId}`;
  /** Utterances being transcribed/routed. */
  let busy = 0;
  let closed = false;
  const createdAt = now();
  const startupGraceMs = opts.startupGraceMs ?? 20_000;

  // ------------------------------------------------------------------ status
  //
  // Voice borrows the agent status indicator while it is active (listening →
  // transcribing) and gives it back afterwards: if Claude was 'thinking' or
  // 'working' when push-to-talk started (or became so meanwhile, via the Claude
  // Code hooks), that status is restored instead of a misleading 'idle'. If
  // something else changed the status after voice's last update, voice leaves
  // it alone. Without deps.agentStatus, voice falls back to 'idle'.

  /** The state voice last set, or null when voice is not holding the indicator. */
  let held: AgentState | null = null;
  /** The non-voice status underneath (what to restore). */
  let underlying: AgentStatus | null = null;

  function currentStatus(): AgentStatus | null {
    try { return deps.agentStatus?.() ?? null; } catch { return null; }
  }

  function updateStatus(): void {
    const want: AgentState = listening.size ? 'listening' : busy ? 'transcribing' : 'idle';
    const cur = currentStatus();
    if (want !== 'idle') {
      if (held === null) underlying = cur;
      else if (cur && cur.state !== held) underlying = cur; // a hook changed it while voice held it
      if (want !== held || (cur && cur.state !== want)) {
        deps.setAgentStatus(want, want === 'listening' ? 'Listening…' : 'Transcribing…');
      }
      held = want;
      return;
    }
    if (held === null) return;
    if (!cur || cur.state === held) {
      const u = underlying;
      if (u && (u.state === 'thinking' || u.state === 'working')) deps.setAgentStatus(u.state, u.detail);
      else deps.setAgentStatus('idle');
    } // else: changed by someone else after voice's last update → theirs is newer
    held = null;
    underlying = null;
  }

  function sendResult(clientId: string | undefined, msg: Extract<ServerMessage, { type: 'voice.result' }>): void {
    if (clientId) deps.send(clientId, msg);
    else deps.broadcast(msg);
  }

  function drop(u: Utterance, reason: string): void {
    if (u.stale) clearTimeout(u.stale);
    const k = key(u.clientId, u.id);
    if (listening.get(k) === u) listening.delete(k); // never a newer utterance that reused the id
    deps.log('warn', `voice: dropped utterance ${u.id} from ${u.clientId}: ${reason}`);
    updateStatus();
  }

  function touch(u: Utterance): void {
    if (u.stale) clearTimeout(u.stale);
    u.stale = setTimeout(() => drop(u, `no audio or voice.end for ${staleMs} ms`), staleMs);
    u.stale.unref?.();
  }

  // ------------------------------------------------------------------ routing

  function describe(id: string | undefined): { name?: string; widget?: string } {
    if (!id || !deps.describeEntity) return {};
    try { return deps.describeEntity(id) ?? {}; } catch { return {}; }
  }

  /** Context handed to Claude with a request (field names match apps/mcp-bridge askToNotification). */
  function agentContext(ctx: Record<string, unknown>, ents: ContextEntities, extra: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { source: 'voice', kind: 'voice', ...extra };
    const t = describe(ents.target);
    if (ents.target) {
      out.target = ents.target;
      if (t.name) out.target_name = t.name;
      if (t.widget) out.target_widget = t.widget;
    }
    if (ents.selected) {
      out.selected = ents.selected;
      const s = describe(ents.selected);
      if (s.name) out.selected_name = s.name;
    }
    const c = ctx as VoiceContext;
    if (c.focus) out.focus = c.focus;
    if (c.gaze) out.gaze = c.gaze;
    if (ents.focus && ents.focus !== ents.target) {
      const f = describe(ents.focus);
      out.focused = { entity: ents.focus, ...(f.name ? { name: f.name } : {}) };
    }
    return out;
  }

  async function route(
    text: string,
    ctx: Record<string, unknown>,
    meta: { clientId?: string; utteranceId: string; simulated?: boolean; oneshot?: boolean; extra?: Record<string, unknown> },
  ): Promise<RouteOutcome> {
    await ready;
    deps.say(text, 'heard');
    const ents = contextEntities(ctx);
    const base = {
      utteranceId: meta.utteranceId,
      ...(meta.clientId ? { clientId: meta.clientId } : {}),
      ...(meta.simulated ? { simulated: true } : {}),
      text,
      normalized: normalize(text),
      ...(ents.target ? { target: ents.target } : {}),
      ...meta.extra,
    };
    if (meta.oneshot && deps.oneshotAsk) {
      // The one-off key means "give this to a one-off agent": never a fast-path command.
      sendResult(meta.clientId, { type: 'voice.result', utteranceId: meta.utteranceId, text, route: 'agent' });
      deps.event('voice.utterance', { ...base, route: 'agent', agent: 'oneshot' });
      deps.oneshotAsk(text, agentContext(ctx, ents, {
        utteranceId: meta.utteranceId,
        ...(ctx.head ? { head: ctx.head } : {}), // the agent's orb floats where the user was
        ...(meta.clientId ? { clientId: meta.clientId } : {}),
        ...(meta.simulated ? { simulated: true } : {}),
      }));
      return { route: 'agent' };
    }
    const m = matchCommand(text, library.commands);
    if (m) {
      const def = m.command.def;
      const label = def.id;
      if (def.command === NOOP_COMMAND) {
        sendResult(meta.clientId, { type: 'voice.result', utteranceId: meta.utteranceId, text, route: 'fastpath', command: label });
        deps.event('voice.utterance', { ...base, route: 'fastpath', command: label, run: NOOP_COMMAND });
        return { route: 'fastpath', command: label };
      }
      let args: Record<string, unknown> | undefined;
      try {
        args = substituteArgs(def.args, { groups: m.groups, entities: ents, text: m.text, transcript: text, head: ctx.head });
      } catch (e) {
        if (!(e instanceof MissingVariableError)) throw e;
        const msg = /^(target|focus|selected|gaze)$/.test(e.variable)
          ? `"${text}": nothing is targeted. Point at (or select) something and try again.`
          : `"${text}": ${e.message}`;
        deps.say(msg, 'info');
        sendResult(meta.clientId, { type: 'voice.result', utteranceId: meta.utteranceId, text, route: 'none', command: label });
        deps.event('voice.utterance', { ...base, route: 'none', command: label, error: e.message });
        return { route: 'none', command: label };
      }
      let declined = false;
      try {
        await deps.runCommand(def.command, args, { clientId: meta.clientId });
        deps.event('voice.utterance', { ...base, route: 'fastpath', command: label, run: def.command, ...(args ? { args } : {}) });
      } catch (e) {
        // A command that declines (e.g. "spawn <not a widget>") was the wrong match: Claude takes it.
        declined = (e as { passToAgent?: unknown }).passToAgent === true;
        if (!declined) {
          const msg = (e as Error).message;
          deps.say(`Voice command "${label}" failed: ${msg}`, 'error');
          deps.event('voice.utterance', { ...base, route: 'fastpath', command: label, run: def.command, ...(args ? { args } : {}), error: msg });
        }
      }
      if (!declined) {
        sendResult(meta.clientId, { type: 'voice.result', utteranceId: meta.utteranceId, text, route: 'fastpath', command: label });
        return { route: 'fastpath', command: label };
      }
    }
    // Not a fast-path command → Claude. The voice status returns to idle when
    // finish() completes (synchronously after this, before any HTTP request can be
    // handled); the MCP bridge then sets 'thinking' once it delivers the request.
    sendResult(meta.clientId, { type: 'voice.result', utteranceId: meta.utteranceId, text, route: 'agent' });
    deps.event('voice.utterance', { ...base, route: 'agent' });
    deps.agentAsk(text, agentContext(ctx, ents, {
      utteranceId: meta.utteranceId,
      ...(meta.clientId ? { clientId: meta.clientId } : {}),
      ...(meta.simulated ? { simulated: true } : {}),
    }));
    return { route: 'agent' };
  }

  /** Drop empty / hallucinated transcripts. Returns the cleaned text ('' = nothing heard). */
  function cleanTranscript(r: SttResult, prompt: string): string {
    const text = r.text.replace(/\s+/g, ' ').trim();
    const norm = normalize(text);
    if (!norm) return '';
    const speech = r.speech_duration ?? r.duration;
    if (HALLUCINATIONS.has(norm) && speech < 0.6) return '';
    if (r.segments.length && r.segments.every((s) => (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8)) return '';
    // Whisper sometimes regurgitates its prompt on unclear audio.
    if (norm.split(' ').length >= 4 && normalize(prompt).includes(norm)) return '';
    return text;
  }

  /**
   * STT unreachable: ask the supervisor to (re)start the "stt" source, at most
   * once per restartCooldownMs (a crash-looping service must not be hammered).
   * Returns true if a restart was issued.
   */
  async function restartStt(): Promise<boolean> {
    const t = now();
    if (sttSourceId === null || t - lastRestart < restartCooldownMs) return false;
    // Right after server start the supervisor is still booting the source (its
    // socket is not bound yet); restarting it then would only delay it further.
    if (t - createdAt < startupGraceMs) return false;
    lastRestart = t;
    try {
      await deps.runCommand('source.restart', { id: sttSourceId }, {});
      deps.log('warn', `voice: STT unreachable at ${stt.url}; restarted source '${sttSourceId}'`);
      return true;
    } catch (e) {
      deps.log('warn', `voice: could not restart source '${sttSourceId}': ${(e as Error).message}`);
      return false;
    }
  }

  async function finish(u: Utterance): Promise<void> {
    const t0 = now();
    const durationMs = (u.samples / u.sampleRate) * 1000;
    const base = { utteranceId: u.id, clientId: u.clientId, durationMs: Math.round(durationMs) };
    const nothing = (reason: string, extra: Record<string, unknown> = {}) => {
      sendResult(u.clientId, { type: 'voice.result', utteranceId: u.id, text: '', route: 'none' });
      deps.event('voice.utterance', { ...base, text: '', route: 'none', reason, ...extra });
    };
    if (durationMs < minMs) {
      nothing('too-short');
      return;
    }
    const pcm = new Int16Array(u.samples);
    let off = 0;
    for (const c of u.chunks) { pcm.set(c, off); off += c.length; }
    u.chunks = [];
    let prompt = '';
    try { prompt = buildPrompt(deps.vocabulary()); } catch (e) { deps.log('warn', `voice: vocabulary() failed: ${(e as Error).message}`); prompt = buildPrompt([]); }
    let r: SttResult;
    try {
      r = await stt.transcribe(pcm, u.sampleRate, prompt);
    } catch (e) {
      const err = e as Error;
      const kind = err instanceof SttError ? err.kind : 'failed';
      const restarting = kind === 'unavailable' && (await restartStt());
      const booting = now() - createdAt < startupGraceMs;
      const msg = kind === 'unavailable'
        ? restarting
          ? 'Speech recognition was not running; starting it now. Try again in a few seconds.'
          : booting
            ? 'Speech recognition is still starting up; try again in a few seconds.'
            : 'Speech recognition is not running (source "stt"). Check GET /api/sources/stt.'
        : kind === 'loading' ? 'Speech recognition is still starting up; try again in a moment.'
          : kind === 'timeout' ? 'Speech recognition timed out.'
            : `Speech recognition failed: ${err.message}`;
      deps.log('error', `voice: ${err.message}`);
      deps.say(msg, 'error');
      nothing('stt-error', { error: err.message });
      return;
    }
    const sttMs = now() - t0;
    if (closed) return; // shutting down: do not run commands any more
    const text = cleanTranscript(r, prompt);
    deps.log('info', `voice: ${u.id} ${durationMs.toFixed(0)} ms audio → "${text}" (stt ${sttMs} ms${r.model ? `, ${r.model}` : ''})`);
    if (!text) {
      nothing('no-speech', { sttMs, raw: r.text });
      return;
    }
    await route(text, u.context as Record<string, unknown>, {
      clientId: u.clientId,
      utteranceId: u.id,
      oneshot: u.oneshot,
      extra: { durationMs: Math.round(durationMs), sttMs, ...(r.model ? { model: r.model } : {}), ...(u.truncated ? { truncated: true } : {}) },
    });
  }

  // ------------------------------------------------------------------ service

  return {
    onBegin(clientId: string, msg: VoiceBegin): void {
      if (closed) return;
      const id = typeof msg.utteranceId === 'string' ? msg.utteranceId.slice(0, 36) : '';
      const rate = msg.sampleRate;
      if (!id) { deps.log('warn', `voice: voice.begin without utteranceId from ${clientId}`); return; }
      if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) {
        deps.log('warn', `voice: voice.begin ${id} with unsupported sampleRate ${String(rate)}`);
        deps.say(`Microphone sample rate ${String(rate)} is not supported (8000–48000 Hz).`, 'error');
        return;
      }
      // A client has one live utterance: a new begin supersedes a lost one.
      const previous = [...listening.values()].filter((p) => p.clientId === clientId);
      const u: Utterance = {
        id, clientId, sampleRate: rate,
        context: msg.context && typeof msg.context === 'object' ? msg.context : {},
        oneshot: msg.agent === 'oneshot',
        chunks: [], samples: 0, maxSamples: Math.round((rate * maxMs) / 1000), truncated: false,
        startedAt: now(), stale: null,
      };
      listening.set(key(clientId, id), u); // first, so dropping the old one never reads as "voice idle"
      for (const p of previous) {
        if (p.id !== id) drop(p, 'superseded by a new voice.begin');
        else if (p.stale) clearTimeout(p.stale); // repeated begin for the same id: replaced above
      }
      touch(u);
      updateStatus();
    },

    onAudio(clientId: string, utteranceId: string, pcm: Int16Array): void {
      const u = listening.get(key(clientId, utteranceId));
      if (!u) return; // late frames after end / cancelled, or another client's id: ignore
      touch(u);
      if (u.truncated) return;
      const room = u.maxSamples - u.samples;
      if (pcm.length > room) {
        u.truncated = true;
        deps.log('warn', `voice: utterance ${u.id} exceeded ${maxMs} ms; extra audio dropped`);
        deps.say(`Voice input is limited to ${Math.round(maxMs / 1000)} s; the rest was cut off.`, 'info');
      }
      const take = Math.min(room, pcm.length);
      if (take > 0) {
        u.chunks.push(pcm.slice(0, take)); // copy: the frame buffer may be reused
        u.samples += take;
      }
    },

    onEnd(clientId: string, msg: VoiceEnd): void {
      // Same 36-char truncation as onBegin (and the AudioFrame id field).
      const id = typeof msg.utteranceId === 'string' ? msg.utteranceId.slice(0, 36) : '';
      const u = listening.get(key(clientId, id));
      if (!u) return;
      if (u.stale) clearTimeout(u.stale);
      listening.delete(key(clientId, id));
      if (msg.cancelled || closed) {
        deps.event('voice.utterance', { utteranceId: u.id, clientId, text: '', route: 'none', reason: 'cancelled' });
        updateStatus();
        return;
      }
      busy++;
      updateStatus();
      void finish(u)
        .catch((e: Error) => {
          deps.log('error', `voice: utterance ${u.id} failed: ${e.stack ?? e.message}`);
          deps.say(`Voice processing failed: ${e.message}`, 'error');
        })
        .finally(() => { busy--; updateStatus(); });
    },

    onDisconnect(clientId: string): void {
      // Audio can't arrive any more: drop the client's recordings now (not after staleMs).
      // Utterances already being transcribed still route (the user finished speaking).
      for (const u of [...listening.values()]) {
        if (u.clientId !== clientId) continue;
        deps.event('voice.utterance', { utteranceId: u.id, clientId, text: '', route: 'none', reason: 'disconnected' });
        drop(u, 'client disconnected');
      }
    },

    async simulate(text: string, context?: Record<string, unknown>, opts?: { agent?: 'oneshot' }) {
      const id = `sim-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const t = text.replace(/\s+/g, ' ').trim();
      if (!t) return { route: 'none' as const };
      return route(t, context ?? {}, { utteranceId: id, simulated: true, oneshot: opts?.agent === 'oneshot' });
    },

    commands(): VoiceCommand[] {
      return library.definitions();
    },

    async close(): Promise<void> {
      closed = true;
      for (const u of listening.values()) if (u.stale) clearTimeout(u.stale);
      listening.clear();
      await ready;
      await library.close();
    },
  };
}
