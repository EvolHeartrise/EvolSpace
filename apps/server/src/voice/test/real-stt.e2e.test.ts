// Full-stack voice test: real python/stt service (faster-whisper) + VoiceService
// + the real library/voice/commands.json, fed with Windows SAPI speech.
// Opt-in (loads a Whisper model):  EVOL_STT_E2E=1 npx vitest run apps/server/src/voice/test/real-stt.e2e.test.ts
// Needs python/stt/.venv (uv sync in python/stt) and Windows (SAPI).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from '@evolspace/protocol';
import { createVoice, type VoiceService } from '../index.ts';
import type { VoiceDeps } from '../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const sttDir = path.join(repo, 'python', 'stt');
const python = path.join(sttDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const enabled = !!process.env.EVOL_STT_E2E && process.platform === 'win32' && existsSync(python);

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** Read a 16-bit PCM WAV (SAPI output) → samples + rate. */
function readWav(file: string): { pcm: Int16Array; rate: number } {
  const b = readFileSync(file);
  let off = 12;
  let rate = 16000;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') {
      const data = b.subarray(off + 8, off + 8 + size);
      return { pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

const PHRASES: Array<{ id: string; text: string; route: 'fastpath' | 'agent'; command?: string }> = [
  { id: 'undo', text: 'Undo.', route: 'fastpath', command: 'undo' },
  { id: 'delete', text: 'Delete this.', route: 'fastpath', command: 'delete-target' },
  { id: 'ar', text: 'Switch to passthrough.', route: 'fastpath', command: 'mode-ar' },
  { id: 'vr', text: 'Switch to VR.', route: 'fastpath', command: 'mode-vr' },
  { id: 'save', text: 'Save the workspace.', route: 'fastpath', command: 'save-workspace' },
  { id: 'nevermind', text: 'Never mind.', route: 'fastpath', command: 'cancel' },
  { id: 'polite', text: 'Okay, undo that, please.', route: 'fastpath', command: 'undo' },
  { id: 'claude', text: 'Make this sphere twice as big and color it red.', route: 'agent' },
];

describe.skipIf(!enabled)('voice with the real STT service', () => {
  let child: ChildProcess;
  let url = '';
  let wavDir = '';
  let voice: VoiceService;
  const sent: ServerMessage[] = [];
  const commands: Array<{ name: string; args: unknown }> = [];
  const asks: string[] = [];

  beforeAll(async () => {
    wavDir = mkdtempSync(path.join(tmpdir(), 'evol-voice-e2e-'));
    const phrasesFile = path.join(wavDir, 'phrases.json');
    writeFileSync(phrasesFile, JSON.stringify(PHRASES.map(({ id, text }) => ({ id, text }))));
    const tts = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sttDir, 'bench', 'tts.ps1'), '-OutDir', wavDir, '-Phrases', phrasesFile]);
    if (tts.status !== 0) throw new Error(`tts failed: ${tts.stderr.toString()}`);

    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    child = spawn(python, ['-m', 'evol_stt'], { cwd: sttDir, env: { ...process.env, EVOL_STT_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 300_000) throw new Error('STT did not become ready');
      try {
        const h = (await (await fetch(`${url}/health`)).json()) as { ready: boolean };
        if (h.ready) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const deps: VoiceDeps = {
      voiceDir: path.join(repo, 'library', 'voice'),
      runCommand: async (name, args) => { commands.push({ name, args }); return {}; },
      agentAsk: (text) => { asks.push(text); },
      say: () => {},
      setAgentStatus: () => {},
      send: (_id, m) => { sent.push(m); },
      broadcast: () => {},
      event: () => {},
      vocabulary: () => ['sphere', 'resid-flow'],
      log: () => {},
    };
    voice = createVoice(deps, { sttUrl: url, watch: false });
  }, 330_000);

  afterAll(async () => {
    await voice?.close();
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    if (wavDir) rmSync(wavDir, { recursive: true, force: true });
  });

  it.each(PHRASES)('$text → $route', async (p) => {
    const { pcm, rate } = readWav(path.join(wavDir, `${p.id}.wav`));
    const before = sent.length;
    const t0 = performance.now();
    const ctx = { focus: { right: { entity: 'e-sphere', point: [0, 1, -1] as [number, number, number] } } };
    voice.onBegin('c1', { type: 'voice.begin', utteranceId: `u-${p.id}`, sampleRate: rate, context: ctx });
    for (let i = 0; i < pcm.length; i += 1600) voice.onAudio('c1', `u-${p.id}`, pcm.subarray(i, i + 1600));
    voice.onEnd('c1', { type: 'voice.end', utteranceId: `u-${p.id}` });
    while (sent.length === before) await new Promise((r) => setTimeout(r, 5));
    const ms = performance.now() - t0;
    const res = sent.at(-1) as Extract<ServerMessage, { type: 'voice.result' }>;
    console.log(`  ${p.id.padEnd(10)} ${ms.toFixed(0).padStart(5)} ms end→result  "${res.text}" → ${res.route}${res.command ? ` (${res.command})` : ''}`);
    expect(res.route).toBe(p.route);
    if (p.command) expect(res.command).toBe(p.command);
    expect(ms).toBeLessThan(1000);
  }, 30_000);

  it('ran the right server commands', () => {
    expect(commands).toContainEqual({ name: 'undo', args: undefined });
    expect(commands).toContainEqual({ name: 'delete', args: { entity: 'e-sphere' } });
    expect(commands).toContainEqual({ name: 'broadcast', args: { name: 'session.mode', args: { mode: 'ar' } } });
    expect(asks).toHaveLength(1);
  });
});
