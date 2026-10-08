// VoiceService end-to-end against a fake STT HTTP server (no Python needed).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentStatus, ServerMessage, VoiceCommand, VoiceContext } from '@evolspace/protocol';
import { createVoice, type VoiceService } from '../index.ts';
import type { VoiceDeps } from '../types.ts';

// ---------------------------------------------------------------- fake STT

interface SttCall { sampleRate: number; prompt: string; bytes: number }
type SttReply = { status?: number; body?: unknown; delayMs?: number };

class FakeStt {
  calls: SttCall[] = [];
  /** Next replies (FIFO); default: echo `text`. */
  replies: SttReply[] = [];
  text = '';
  private server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (url.pathname === '/health') { res.end(JSON.stringify({ ok: true, ready: true })); return; }
      const bytes = Buffer.concat(chunks).length;
      this.calls.push({ sampleRate: Number(url.searchParams.get('sample_rate')), prompt: url.searchParams.get('prompt') ?? '', bytes });
      const r = this.replies.shift() ?? {};
      const body = r.body ?? { text: this.text, language: 'en', duration: bytes / 2 / 16000, segments: [{ start: 0, end: 1, text: this.text, avg_logprob: -0.2, no_speech_prob: 0.01 }], latency_ms: 12, model: 'fake' };
      setTimeout(() => {
        res.statusCode = r.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      }, r.delayMs ?? 0);
    });
  });
  url = '';
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}

// ---------------------------------------------------------------- fake deps

interface Recorder {
  deps: VoiceDeps;
  said: Array<{ text: string; kind: string }>;
  sent: Array<{ clientId: string; msg: ServerMessage }>;
  broadcasts: ServerMessage[];
  events: Array<{ type: string; data: Record<string, unknown> }>;
  statuses: string[];
  commands: Array<{ name: string; args: Record<string, unknown> | undefined; clientId?: string }>;
  asks: Array<{ text: string; context: Record<string, unknown> }>;
}

function makeDeps(voiceDir: string, opts: { failCommand?: string } = {}): Recorder {
  const r: Omit<Recorder, 'deps'> = { said: [], sent: [], broadcasts: [], events: [], statuses: [], commands: [], asks: [] };
  const deps: VoiceDeps = {
    voiceDir,
    runCommand: async (name, args, origin) => {
      r.commands.push({ name, args, clientId: origin.clientId });
      if (name === opts.failCommand) throw new Error(`entity 'zzz' does not exist`);
      return { ok: true };
    },
    agentAsk: (text, context) => { r.asks.push({ text, context }); },
    say: (text, kind) => { r.said.push({ text, kind }); },
    setAgentStatus: (state) => { r.statuses.push(state); },
    send: (clientId, msg) => { r.sent.push({ clientId, msg }); },
    broadcast: (msg) => { r.broadcasts.push(msg); },
    event: (type, data) => { r.events.push({ type, data }); },
    vocabulary: () => ['resid-flow', 'Seattle weather'],
    log: () => {},
    describeEntity: (id) => (id === 'e-chart' ? { name: 'Seattle weather', widget: 'line-chart' } : id === 'e-sel' ? { name: 'Picked', widget: 'box' } : undefined),
  };
  return { ...r, deps };
}

const COMMANDS: VoiceCommand[] = [
  { id: 'cancel', patterns: ['never ?mind', 'cancel'], command: 'none' },
  { id: 'undo', patterns: ['undo( that)?'], command: 'undo' },
  { id: 'delete-target', patterns: ['(delete|remove) (this|that|it)'], command: 'delete', args: { entity: '$target' } },
  { id: 'mode-ar', patterns: ['switch to (ar|passthrough|pass through)'], command: 'broadcast', args: { name: 'session.mode', args: { mode: 'ar' } } },
  { id: 'set-layer', patterns: ['set layer (?<n>[a-z0-9 ]+)'], command: 'channel.set', args: { channel: 'interp.ctl.layer', value: '$n:number' } },
];

function pcm(ms: number, rate = 16000): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 10) * 3000);
  return a;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const POINTING: VoiceContext = { focus: { right: { entity: 'e-chart', point: [0, 1, -1] } }, selected: 'e-sel' };

/** Simulate a client push-to-talk: begin, audio in 100 ms frames, end. */
function speak(v: VoiceService, client: string, id: string, ms: number, context: VoiceContext = {}, rate = 16000, cancelled = false): void {
  v.onBegin(client, { type: 'voice.begin', utteranceId: id, sampleRate: rate, context });
  const all = pcm(ms, rate);
  const frame = rate / 10;
  for (let i = 0; i < all.length; i += frame) v.onAudio(client, id, all.subarray(i, Math.min(all.length, i + frame)));
  v.onEnd(client, { type: 'voice.end', utteranceId: id, ...(cancelled ? { cancelled: true } : {}) });
}

const results = (r: Recorder) => r.sent.filter((s) => s.msg.type === 'voice.result').map((s) => ({ clientId: s.clientId, ...(s.msg as Extract<ServerMessage, { type: 'voice.result' }>) }));

// ---------------------------------------------------------------- tests

describe('VoiceService (fake STT)', () => {
  const stt = new FakeStt();
  let dir: string;
  let rec: Recorder;
  let voice: VoiceService;

  beforeAll(async () => { await stt.start(); });
  afterAll(async () => { await stt.stop(); });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'evol-voice-'));
    writeFileSync(path.join(dir, 'commands.json'), JSON.stringify(COMMANDS));
    stt.calls = []; stt.replies = []; stt.text = '';
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false });
    await voice.simulate(''); // waits for nothing; ensure construction finished
  });
  afterEach(async () => {
    await voice.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the loaded commands', async () => {
    await until(() => voice.commands().length === COMMANDS.length);
    expect(voice.commands().map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id));
  });

  it('fast path: transcribes, echoes, runs the command with $target, replies to the client', async () => {
    stt.text = ' Delete this.';
    speak(voice, 'c1', 'u1', 800, POINTING);
    await until(() => results(rec).length === 1);
    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0].sampleRate).toBe(16000);
    expect(stt.calls[0].bytes).toBe(800 * 16 * 2);
    expect(stt.calls[0].prompt).toMatch(/Claude/);
    expect(stt.calls[0].prompt).toMatch(/Seattle weather/);
    expect(rec.said).toEqual([{ text: 'Delete this.', kind: 'heard' }]);
    expect(rec.commands).toEqual([{ name: 'delete', args: { entity: 'e-chart' }, clientId: 'c1' }]);
    expect(results(rec)[0]).toMatchObject({ clientId: 'c1', utteranceId: 'u1', route: 'fastpath', command: 'delete-target', text: 'Delete this.' });
    const ev = rec.events.find((e) => e.type === 'voice.utterance')!;
    expect(ev.data).toMatchObject({ utteranceId: 'u1', route: 'fastpath', command: 'delete-target', run: 'delete', args: { entity: 'e-chart' } });
    expect(rec.asks).toHaveLength(0);
    await until(() => rec.statuses.at(-1) === 'idle');
    expect(rec.statuses).toEqual(['listening', 'transcribing', 'idle']);
  });

  it('nested args + typed groups (broadcast, number words)', async () => {
    stt.text = 'Switch to pass-through.';
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    expect(rec.commands[0]).toMatchObject({ name: 'broadcast', args: { name: 'session.mode', args: { mode: 'ar' } } });
    stt.text = 'Set layer twenty one';
    speak(voice, 'c1', 'u2', 600);
    await until(() => results(rec).length === 2);
    expect(rec.commands[1]).toMatchObject({ name: 'channel.set', args: { channel: 'interp.ctl.layer', value: 21 } });
  });

  it('everything else goes to Claude with deictic context (ids + names)', async () => {
    stt.text = 'Make this bigger and color it red.';
    speak(voice, 'c1', 'u7', 1500, { ...POINTING, gaze: { entity: 'e-gaze', point: [0, 0, 0] } });
    await until(() => rec.asks.length === 1);
    const ask = rec.asks[0];
    expect(ask.text).toBe('Make this bigger and color it red.');
    expect(ask.context).toMatchObject({
      source: 'voice', utteranceId: 'u7', clientId: 'c1',
      target: 'e-chart', target_name: 'Seattle weather', target_widget: 'line-chart',
      selected: 'e-sel', selected_name: 'Picked',
      focus: POINTING.focus, gaze: { entity: 'e-gaze' },
    });
    expect(rec.said[0]).toEqual({ text: 'Make this bigger and color it red.', kind: 'heard' });
    await until(() => results(rec).length === 1);
    expect(results(rec)[0]).toMatchObject({ route: 'agent', utteranceId: 'u7' });
    expect(rec.commands).toHaveLength(0);
    await until(() => rec.statuses.at(-1) === 'idle');
  });

  it('missing target: tells the user, does not run the command', async () => {
    stt.text = 'Delete this';
    speak(voice, 'c1', 'u1', 600, {});
    await until(() => results(rec).length === 1);
    expect(rec.commands).toHaveLength(0);
    expect(results(rec)[0]).toMatchObject({ route: 'none', command: 'delete-target' });
    expect(rec.said.some((s) => s.kind === 'info' && /Point at/.test(s.text))).toBe(true);
  });

  it('command failure is reported in XR', async () => {
    await voice.close();
    rec = makeDeps(dir, { failCommand: 'delete' });
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false });
    stt.text = 'remove it';
    speak(voice, 'c1', 'u1', 600, POINTING);
    await until(() => results(rec).length === 1);
    expect(rec.said.some((s) => s.kind === 'error' && /does not exist/.test(s.text))).toBe(true);
    expect(rec.events.find((e) => e.type === 'voice.utterance')!.data.error).toMatch(/does not exist/);
  });

  it('no-op command (never mind) routes fastpath without running anything', async () => {
    stt.text = 'Never mind.';
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    expect(results(rec)[0]).toMatchObject({ route: 'fastpath', command: 'cancel' });
    expect(rec.commands).toHaveLength(0);
    expect(rec.asks).toHaveLength(0);
  });

  it('too-short utterances are ignored without calling STT', async () => {
    speak(voice, 'c1', 'u1', 100);
    await until(() => results(rec).length === 1);
    expect(stt.calls).toHaveLength(0);
    expect(results(rec)[0]).toMatchObject({ route: 'none', text: '' });
    expect(rec.said).toHaveLength(0);
  });

  it('cancelled utterances do nothing', async () => {
    speak(voice, 'c1', 'u1', 800, {}, 16000, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(stt.calls).toHaveLength(0);
    expect(results(rec)).toHaveLength(0);
    expect(rec.statuses).toEqual(['listening', 'idle']);
  });

  it('empty and hallucinated transcripts are dropped', async () => {
    stt.text = '';
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    stt.replies.push({ body: { text: ' Thank you.', duration: 0.6, speech_duration: 0.1, segments: [], latency_ms: 5 } });
    speak(voice, 'c1', 'u2', 600);
    await until(() => results(rec).length === 2);
    expect(results(rec).map((r) => r.route)).toEqual(['none', 'none']);
    expect(rec.said).toHaveLength(0);
    expect(rec.asks).toHaveLength(0);
  });

  it('STT down: says an error in XR and recovers to idle', async () => {
    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: 'http://127.0.0.1:9', watch: false, sttTimeoutMs: 2000, startupGraceMs: 0 });
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    // First failure: asks the supervisor to restart the stt source.
    expect(rec.commands).toEqual([{ name: 'source.restart', args: { id: 'stt' }, clientId: undefined }]);
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/starting it now/) });
    expect(results(rec)[0]).toMatchObject({ route: 'none' });
    expect(rec.events.find((e) => e.type === 'voice.utterance')!.data).toMatchObject({ reason: 'stt-error' });
    await until(() => rec.statuses.at(-1) === 'idle');
    // Within the cooldown: no second restart, plain error.
    speak(voice, 'c1', 'u2', 600);
    await until(() => results(rec).length === 2);
    expect(rec.commands).toHaveLength(1);
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/not running/) });
  });

  it('STT still loading (503) and timeouts are reported', async () => {
    stt.replies.push({ status: 503, body: { error: 'model is still loading' } });
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/starting up/) });

    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false, sttTimeoutMs: 100 });
    stt.replies.push({ delayMs: 400 });
    speak(voice, 'c1', 'u2', 600);
    await until(() => results(rec).length === 1);
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/timed out/) });
  });

  it('caps an utterance at maxDurationMs and passes non-16k rates through', async () => {
    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false, maxDurationMs: 1000 });
    stt.text = 'undo';
    speak(voice, 'c1', 'u1', 2500, {}, 48000);
    await until(() => results(rec).length === 1);
    expect(stt.calls[0]).toMatchObject({ sampleRate: 48000, bytes: 48000 * 2 });
    expect(rec.said.some((s) => s.kind === 'info' && /limited to 1 s/.test(s.text))).toBe(true);
    expect(rec.commands[0].name).toBe('undo');
  });

  it('ignores audio from other clients and unknown utterances; rejects bad sample rates', async () => {
    stt.text = 'undo';
    voice.onBegin('c1', { type: 'voice.begin', utteranceId: 'u1', sampleRate: 16000, context: {} });
    voice.onAudio('c2', 'u1', pcm(500)); // wrong client
    voice.onAudio('c1', 'nope', pcm(500)); // unknown id
    voice.onAudio('c1', 'u1', pcm(400));
    voice.onEnd('c2', { type: 'voice.end', utteranceId: 'u1' }); // wrong client: ignored
    voice.onEnd('c1', { type: 'voice.end', utteranceId: 'u1' });
    await until(() => results(rec).length === 1);
    expect(stt.calls[0].bytes).toBe(400 * 16 * 2);

    voice.onBegin('c1', { type: 'voice.begin', utteranceId: 'u2', sampleRate: 1234, context: {} });
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('drops stale utterances whose client vanished', async () => {
    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false, staleMs: 50 });
    voice.onBegin('c1', { type: 'voice.begin', utteranceId: 'u1', sampleRate: 16000, context: {} });
    voice.onAudio('c1', 'u1', pcm(500));
    await until(() => rec.statuses.at(-1) === 'idle');
    voice.onEnd('c1', { type: 'voice.end', utteranceId: 'u1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(stt.calls).toHaveLength(0);
  });

  it('STT down right after server start: no restart (the supervisor is still booting it)', async () => {
    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: 'http://127.0.0.1:9', watch: false, sttTimeoutMs: 2000 }); // default grace
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    expect(rec.commands).toHaveLength(0);
    expect(rec.said.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/still starting up/) });
  });

  it("restores Claude's thinking/working status after an utterance instead of idle", async () => {
    await voice.close();
    rec = makeDeps(dir);
    let status: AgentStatus = { state: 'working', detail: 'Running Bash', since: 1 };
    const set: Array<{ state: string; detail?: string }> = [];
    rec.deps.agentStatus = () => status;
    rec.deps.setAgentStatus = (state, detail) => { status = { state, ...(detail ? { detail } : {}), since: 2 }; set.push({ state, ...(detail ? { detail } : {}) }); };
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false });
    stt.text = 'undo';
    speak(voice, 'c1', 'u1', 600);
    await until(() => results(rec).length === 1);
    await until(() => set.length === 3);
    expect(set.map((s) => s.state)).toEqual(['listening', 'transcribing', 'working']);
    expect(set[2]).toEqual({ state: 'working', detail: 'Running Bash' });

    // A hook changes the status while voice holds it (Claude finished: idle) → restore that.
    set.length = 0;
    stt.replies.push({ delayMs: 150 });
    speak(voice, 'c1', 'u2', 600);
    await until(() => set.length === 2); // listening, transcribing
    status = { state: 'idle', since: 3 }; // Stop hook while transcribing
    await until(() => results(rec).length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(set.map((s) => s.state)).toEqual(['listening', 'transcribing']); // voice left the hook's status alone
    expect(status.state).toBe('idle');
  });

  it('two clients using the same utterance id do not clobber each other', async () => {
    await voice.close();
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: stt.url, watch: false, staleMs: 80 });
    stt.text = 'undo';
    voice.onBegin('c1', { type: 'voice.begin', utteranceId: 'same', sampleRate: 16000, context: {} });
    voice.onBegin('c2', { type: 'voice.begin', utteranceId: 'same', sampleRate: 16000, context: {} });
    voice.onAudio('c1', 'same', pcm(400));
    voice.onAudio('c2', 'same', pcm(600));
    voice.onEnd('c1', { type: 'voice.end', utteranceId: 'same' });
    voice.onEnd('c2', { type: 'voice.end', utteranceId: 'same' });
    await until(() => results(rec).length === 2);
    expect(stt.calls.map((c) => c.bytes).sort()).toEqual([400 * 32, 600 * 32]);
    expect(results(rec).map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
  });

  it('accepts a voice.end whose (over-long) id was truncated like the audio frames', async () => {
    stt.text = 'undo';
    const long = 'x'.repeat(50);
    voice.onBegin('c1', { type: 'voice.begin', utteranceId: long, sampleRate: 16000, context: {} });
    voice.onAudio('c1', long.slice(0, 36), pcm(500)); // decodeAudioFrame yields at most 36 chars
    voice.onEnd('c1', { type: 'voice.end', utteranceId: long });
    await until(() => results(rec).length === 1);
    expect(stt.calls[0].bytes).toBe(500 * 32);
  });

  it('simulate routes text without audio (broadcasts the result)', async () => {
    expect(await voice.simulate('Undo.')).toEqual({ route: 'fastpath', command: 'undo' });
    expect(await voice.simulate('delete that', { focus: { right: { entity: 'e-1', point: [0, 0, 0] } } })).toEqual({ route: 'fastpath', command: 'delete-target' });
    expect(rec.commands.at(-1)).toMatchObject({ name: 'delete', args: { entity: 'e-1' } });
    expect(await voice.simulate('delete that', { target: 'e-2' })).toMatchObject({ route: 'fastpath' });
    expect(rec.commands.at(-1)).toMatchObject({ args: { entity: 'e-2' } });
    expect(await voice.simulate('Write me a poem')).toEqual({ route: 'agent' });
    expect(rec.asks.at(-1)).toMatchObject({ text: 'Write me a poem', context: { simulated: true, source: 'voice' } });
    expect(await voice.simulate('   ')).toEqual({ route: 'none' });
    expect(rec.broadcasts.filter((m) => m.type === 'voice.result')).toHaveLength(4);
    expect(rec.events.filter((e) => e.type === 'voice.utterance').every((e) => e.data.simulated === true)).toBe(true);
  });
});

describe('commands.json hot reload', () => {
  let dir: string;
  let rec: Recorder;
  let voice: VoiceService;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'evol-voice-watch-'));
    writeFileSync(path.join(dir, 'commands.json'), JSON.stringify([COMMANDS[1]]));
    rec = makeDeps(dir);
    voice = createVoice(rec.deps, { sttUrl: 'http://127.0.0.1:9' });
  });
  afterEach(async () => {
    await voice.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks up edits, keeps the last good set on broken JSON, reports bad entries', async () => {
    await until(() => voice.commands().length === 1);
    expect(await voice.simulate('dance')).toEqual({ route: 'agent' });

    writeFileSync(path.join(dir, 'commands.json'), JSON.stringify([COMMANDS[1], { id: 'dance', patterns: ['dance'], command: 'say', args: { text: 'no' } }]));
    await until(() => voice.commands().length === 2, 5000);
    expect(await voice.simulate('Dance!')).toEqual({ route: 'fastpath', command: 'dance' });

    writeFileSync(path.join(dir, 'commands.json'), '[{ "id": "half-written"');
    await until(() => rec.said.some((s) => s.kind === 'error' && /keeping the previous 2/.test(s.text)), 5000);
    expect(voice.commands()).toHaveLength(2);

    writeFileSync(path.join(dir, 'commands.json'), JSON.stringify([COMMANDS[1], { id: 'oops', patterns: ['(('], command: 'x' }]));
    await until(() => voice.commands().length === 1, 5000);
    expect(rec.said.some((s) => s.kind === 'error' && /oops/.test(s.text))).toBe(true);
  }, 20_000);

  it('reverting a broken file to the last good content clears the problem and says so', async () => {
    await until(() => voice.commands().length === 1);
    const good = JSON.stringify([COMMANDS[1]]); // identical to the initial content
    writeFileSync(path.join(dir, 'commands.json'), '[ broken');
    await until(() => rec.said.some((s) => s.kind === 'error'), 5000);
    writeFileSync(path.join(dir, 'commands.json'), good);
    await until(() => rec.said.some((s) => s.kind === 'info' && /OK again: 1 loaded/.test(s.text)), 5000);
    expect(voice.commands()).toHaveLength(1);
  }, 20_000);
});
