import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { SourceSupervisor } from '../src/sources/supervisor.ts';
import { resolveCommand, resolvePython } from '../src/sources/process.ts';
import { silentLogger } from '../src/log.ts';
import { tempDir, rmDir, until, writeFiles } from './helpers.ts';

const TICKER = `
let n = 0;
console.log('ticker up', process.env.EVOL_URL, process.argv.slice(2).join(','));
setInterval(() => console.log('tick', ++n), 20);
`;
const CRASHER = `console.log('about to crash'); console.error('boom'); process.exit(3);`;
// Spawns a grandchild so we can check the whole tree is killed.
const PARENT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('SourceSupervisor', () => {
  let dir: string;
  let sup: SourceSupervisor;
  const exits: Array<Record<string, unknown>> = [];
  const pidFile = () => path.join(dir, 'grandchild.pid');

  beforeAll(async () => {
    dir = tempDir('evol-src-');
    writeFiles(dir, {
      'sources/ticker/source.json': JSON.stringify({ description: 'ticks', command: 'node', args: ['tick.cjs', 'a', '{source}'], autostart: true }),
      'sources/ticker/tick.cjs': TICKER,
      'sources/crasher/source.json': JSON.stringify({ description: 'crashes', command: 'node', args: ['crash.cjs'] }),
      'sources/crasher/crash.cjs': CRASHER,
      'sources/norestart/source.json': JSON.stringify({ description: 'one shot', command: 'node', args: ['crash.cjs'], restart: false }),
      'sources/norestart/crash.cjs': CRASHER,
      'sources/tree/source.json': JSON.stringify({ description: 'has a grandchild', command: 'node', args: ['parent.cjs', path.join(dir, 'grandchild.pid')] }),
      'sources/tree/parent.cjs': PARENT,
      'sources/broken/source.json': '{ not json',
      'sources/missing/source.json': JSON.stringify({ description: 'no such exe', command: 'definitely-not-a-real-command-xyz' }),
    });
    sup = new SourceSupervisor({
      sourcesDir: path.join(dir, 'sources'), repoRoot: dir, baseUrl: () => 'http://127.0.0.1:1', log: silentLogger,
      onExit: (d) => exits.push(d), watch: false, backoffBaseMs: 50, backoffMaxMs: 200,
    });
    await sup.init(true);
  });
  afterAll(async () => { await sup?.close(); rmDir(dir); });

  it('autostarts, captures output, substitutes placeholders and env', async () => {
    await until(() => (sup.get('ticker')?.logTail ?? []).some((l) => l.startsWith('tick')));
    const st = sup.get('ticker')!;
    expect(st.running).toBe(true);
    expect(st.pid).toBeGreaterThan(0);
    expect(st.autostart).toBe(true);
    const up = st.logTail.find((l) => l.startsWith('ticker up'))!;
    expect(up).toContain('http://127.0.0.1:1');
    expect(up).toContain(`a,${path.join(dir, 'sources', 'ticker')}`);
    expect(sup.get('crasher')!.running).toBe(false); // not autostart
  });

  it('restarts crashed sources with backoff and reports source.exit', async () => {
    sup.start('crasher');
    await until(() => (sup.get('crasher')!.restarts >= 2));
    const ev = exits.filter((e) => e.id === 'crasher');
    expect(ev[0]).toMatchObject({ code: 3, restarting: true });
    expect((ev[0].logTail as string[]).some((l) => l.includes('! boom'))).toBe(true);
    await sup.stop('crasher');
    const r = sup.get('crasher')!.restarts;
    await new Promise((res) => setTimeout(res, 400));
    expect(sup.get('crasher')!.restarts).toBe(r); // stopped → no more restarts
    expect(sup.get('crasher')!.running).toBe(false);
  });

  it('honours restart:false', async () => {
    sup.start('norestart');
    await until(() => exits.some((e) => e.id === 'norestart'));
    expect(exits.find((e) => e.id === 'norestart')).toMatchObject({ restarting: false });
    await new Promise((res) => setTimeout(res, 200));
    expect(sup.get('norestart')!.running).toBe(false);
  });

  it('stop kills the whole process tree', async () => {
    sup.start('tree');
    await until(() => existsSync(pidFile()));
    const { readFileSync } = await import('node:fs');
    await until(() => readFileSync(pidFile(), 'utf8').length > 0);
    const grandchild = Number(readFileSync(pidFile(), 'utf8'));
    expect(alive(grandchild)).toBe(true);
    await sup.stop('tree');
    await until(() => !alive(grandchild), 5000);
  });

  it('restart re-spawns; bad specs and missing executables are reported, not thrown', async () => {
    const pid1 = sup.get('ticker')!.pid;
    const st = await sup.restart('ticker');
    expect(st.running).toBe(true);
    expect(st.pid).not.toBe(pid1);
    expect(sup.get('broken')!.error).toMatch(/invalid JSON/);
    sup.start('broken');
    expect(sup.get('broken')!.running).toBe(false);
    sup.start('missing');
    await until(() => (sup.get('missing')!.logTail).some((l) => l.includes('failed to start')));
    await sup.stop('missing');
    expect(() => sup.start('nope')).toThrow(/unknown source 'nope'/);
  });
});

describe('command resolution', () => {
  it('resolves {python} to the nearest .venv walking up from cwd, then the source dir', () => {
    const repo = tempDir('evol-py-');
    const venvExe = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
    const proj = path.join(repo, 'python', 'stt');
    mkdirSync(path.join(proj, ...venvExe.slice(0, -1)), { recursive: true });
    writeFileSync(path.join(proj, ...venvExe), '');
    const sourceDir = path.join(repo, 'library', 'sources', 'stt');
    mkdirSync(sourceDir, { recursive: true });
    const r = resolveCommand({ command: '{python}', args: ['-m', 'stt'], cwd: '../../../python/stt/src' }, { sourceDir, repoRoot: repo, baseUrl: 'x' });
    expect(r.command).toBe(path.join(proj, ...venvExe));
    expect(r.cwd).toBe(path.join(proj, 'src'));
    expect(r.env.PYTHONUNBUFFERED).toBe('1');
    expect(resolvePython('{python:python/stt}', { cwd: sourceDir, sourceDir, repoRoot: repo })).toBe(path.join(proj, ...venvExe));
    expect(resolvePython('{python}', { cwd: sourceDir, sourceDir, repoRoot: repo })).toBe('python');
    expect(() => resolvePython('{python:python/nope}', { cwd: sourceDir, sourceDir, repoRoot: repo })).toThrow(/uv venv/);
    rmDir(repo);
  });
});
