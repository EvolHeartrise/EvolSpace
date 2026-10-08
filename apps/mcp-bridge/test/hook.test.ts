// Tests for scripts/hooks/status.mjs (Claude Code hooks → XR status indicator).
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeTool, fileLabel, mapHookEvent } from '../../../scripts/hooks/status.mjs';
import { deadUrl, FakeEvol, until } from './fake-evol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'status.mjs');

function runHook(event: string, payload: unknown, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT, event], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

describe('mapHookEvent', () => {
  it('maps the lifecycle events', () => {
    expect(mapHookEvent('UserPromptSubmit', { prompt: 'build a weather widget' })).toEqual({ state: 'thinking', detail: 'Thinking about: build a weather widget' });
    expect(mapHookEvent('UserPromptSubmit', {})).toEqual({ state: 'thinking', detail: 'Thinking' });
    // Voice requests arrive as channel-wrapped prompts: show only the spoken text.
    expect(mapHookEvent('UserPromptSubmit', { prompt: '<channel source="evolspace" kind="voice" target="e-1">make it\nblue</channel>' }))
      .toEqual({ state: 'thinking', detail: 'Thinking about: make it blue' });
    expect(mapHookEvent('Stop', {})).toEqual({ state: 'idle' });
    expect(mapHookEvent('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' })).toEqual({ state: 'error', detail: 'Stopped: 429 Too Many Requests' });
    expect(mapHookEvent('SessionStart', { source: 'startup' })?.state).toBe('idle');
    expect(mapHookEvent('SessionEnd', {})?.state).toBe('idle');
    expect(mapHookEvent('PostToolUse', {})).toBeNull();
    expect(mapHookEvent(undefined, { hook_event_name: 'Stop' })).toEqual({ state: 'idle' });
  });

  it('maps notifications to attention / idle', () => {
    expect(mapHookEvent('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }))
      .toEqual({ state: 'working', detail: 'Needs your permission in the terminal' });
    expect(mapHookEvent('Notification', { notification_type: 'idle_prompt' })).toEqual({ state: 'idle' });
    expect(mapHookEvent('Notification', { notification_type: 'auth_success' })).toBeNull();
  });

  it('describes tool calls for humans', () => {
    const pre = (tool_name: string, tool_input: unknown) => mapHookEvent('PreToolUse', { tool_name, tool_input });
    expect(pre('Edit', { file_path: 'D:\\Git\\EvolSpace\\library\\widgets\\slider\\widget.ts' })).toEqual({ state: 'working', detail: 'Editing slider/widget.ts' });
    expect(pre('Write', { file_path: '/repo/docs/notes.md' })?.detail).toBe('Writing notes.md');
    expect(pre('Bash', { command: 'npm test' })?.detail).toBe('Running: npm test');
    expect(pre('Bash', { command: 'cd "D:/Git/EvolSpace" && npx vitest run\nsecond line' })?.detail).toBe('Running: npx vitest run');
    expect(pre('mcp__evolspace__screenshot', { view: 'user' })?.detail).toBe('Taking screenshot');
    expect(pre('mcp__evolspace__spawn', { widget: 'slider' })?.detail).toBe('Spawning slider');
    expect(pre('mcp__evolspace__status', { detail: 'x' })).toBeNull(); // the tool sets its own line
    expect(pre('mcp__github__create_issue', {})?.detail).toBe('Using github create issue');
    expect(pre('Grep', { pattern: 'onInput' })?.detail).toBe('Searching for "onInput"');
    expect(pre('WebFetch', { url: 'https://example.com/a' })?.detail).toBe('Fetching example.com');
    expect(pre('SomeNewTool', {})?.detail).toBe('Using SomeNewTool');
    expect(describeTool('Bash', { command: 'x'.repeat(200) })!.length).toBeLessThanOrEqual(60);
  });

  it('labels files compactly', () => {
    expect(fileLabel('a/b/c/plot.ts')).toBe('plot.ts');
    expect(fileLabel('library/sources/stt/source.json')).toBe('stt/source.json');
    expect(fileLabel(undefined)).toBe('file');
  });
});

describe('status.mjs process', () => {
  let fake: FakeEvol;
  beforeAll(async () => {
    fake = await new FakeEvol().on('POST /api/agent/status', { json: {} }).start();
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('POSTs the mapped status, prints nothing, exits 0', async () => {
    const r = await runHook('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, { EVOL_URL: fake.url });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    await until(() => fake.find('POST', '/api/agent/status').length === 1);
    expect(fake.find('POST', '/api/agent/status')[0]!.json()).toEqual({ state: 'working', detail: 'Running: npm test' });
  });

  it('exits 0 silently on malformed input and unmapped events', async () => {
    expect(await runHook('Stop', 'not json{', { EVOL_URL: fake.url })).toMatchObject({ code: 0, stdout: '' });
    expect(await runHook('PostToolUse', {}, { EVOL_URL: fake.url })).toMatchObject({ code: 0, stdout: '' });
  });

  it('exits fast and silently when the server is down', async () => {
    const r = await runHook('UserPromptSubmit', { prompt: 'hi' }, { EVOL_URL: await deadUrl() });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(1500); // node startup + immediate ECONNREFUSED
  });

  it('enforces the hard deadline when the server hangs', async () => {
    const hang = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    try {
      const r = await runHook('Stop', {}, { EVOL_URL: `http://127.0.0.1:${(hang.address() as AddressInfo).port}` });
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(1500); // 400 ms deadline + node startup
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it('posts promptly even if the caller keeps stdin open', async () => {
    // Regression: waiting for EOF burned the whole deadline, then the POST was aborted.
    const before = fake.find('POST', '/api/agent/status').length;
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT, 'UserPromptSubmit'], { cwd: ROOT, env: { ...process.env, EVOL_URL: fake.url }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.write(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'keep open' }));
    const code = await new Promise<number | null>((r) => p.on('close', r));
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    const posts = fake.find('POST', '/api/agent/status');
    expect(posts.length).toBe(before + 1);
    expect(posts.at(-1)!.json()).toEqual({ state: 'thinking', detail: 'Thinking about: keep open' });
  });

  it('can be disabled with EVOL_STATUS_HOOK=0', async () => {
    const before = fake.requests.length;
    expect(await runHook('Stop', {}, { EVOL_URL: fake.url, EVOL_STATUS_HOOK: '0' })).toMatchObject({ code: 0, stdout: '' });
    expect(fake.requests.length).toBe(before);
  });
});
