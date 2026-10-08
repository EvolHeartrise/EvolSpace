// Full-stack e2e harness: boots a real apps/server child process on free test
// ports with an isolated data dir and a temp COPY of the real library (so pose
// recordings and source edits never touch library/ or the user's running server,
// which watches it), plus small HTTP / PNG / process helpers.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Screenshots worth looking at are kept here (data/ is gitignored). */
export const OUT_DIR = path.join(ROOT, 'data', 'e2e');
/** Ports the user's real stack uses — never touched by the suite. */
export const RESERVED_PORTS = [8787, 8443, 8790];

export const E2E_ENABLED = process.env.EVOL_E2E === '1' || process.env.EVOL_E2E === 'true';

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!RESERVED_PORTS.includes(port)) return port;
  }
}

export async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value (returned) or the deadline passes (throws with `what`). */
export async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000, everyMs = 150): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await sleep(everyMs);
  }
}

/** Kills a process and all its children (Windows: taskkill /T /F). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

export interface TestServer {
  url: string;
  port: number;
  tmp: string;
  dataDir: string;
  libraryDir: string;
  proc: ChildProcess;
  log(): string;
  stop(): Promise<void>;
}

/**
 * Copy library/ into `dest`. Source definitions' relative `cwd` would resolve
 * against the copy, so they are rewritten to absolute paths in the real repo.
 */
export function copyLibrary(dest: string): void {
  const src = path.join(ROOT, 'library');
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|__pycache__|\.venv)([\\/]|$)/.test(p),
  });
  const sourcesDir = path.join(dest, 'sources');
  if (!existsSync(sourcesDir)) return;
  for (const id of readdirSync(sourcesDir)) {
    const file = path.join(sourcesDir, id, 'source.json');
    if (!existsSync(file)) continue;
    const def = JSON.parse(readFileSync(file, 'utf8')) as { cwd?: string; autostart?: boolean };
    if (def.cwd && !path.isAbsolute(def.cwd)) def.cwd = path.resolve(src, 'sources', id, def.cwd);
    def.autostart = false;
    writeFileSync(file, JSON.stringify(def, null, 2));
  }
}

export async function startServer(opts: { env?: Record<string, string> } = {}): Promise<TestServer> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'evol-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const libraryDir = path.join(tmp, 'library');
  mkdirSync(dataDir, { recursive: true });
  copyLibrary(libraryDir);
  const port = await freePort();
  const viteCache = path.join(OUT_DIR, '.vite-cache');
  mkdirSync(viteCache, { recursive: true });
  let out = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'apps', 'server', 'src', 'main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      EVOL_HTTP_PORT: String(port),
      EVOL_HTTPS_PORT: 'off',
      EVOL_DATA_DIR: dataDir,
      EVOL_LIBRARY_DIR: libraryDir,
      EVOL_NO_AUTOSTART: '1',
      EVOL_VITE_CACHE_DIR: viteCache,
      EVOL_LOG_LEVEL: process.env.EVOL_LOG_LEVEL ?? 'info',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout!.on('data', (d) => { out += d; });
  proc.stderr!.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  const server: TestServer = {
    url, port, tmp, dataDir, libraryDir, proc,
    log: () => out,
    async stop() {
      // Stop supervised sources through the API first (they are separate process trees).
      try {
        const list = (await (await fetch(`${url}/api/sources`, { signal: AbortSignal.timeout(3000) })).json()) as Array<{ id: string; running: boolean }>;
        for (const s of list) {
          if (s.running) {
            await fetch(`${url}/api/sources/${s.id}/stop`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
          }
        }
      } catch { /* server already gone */ }
      killTree(proc.pid);
      await until(async () => proc.exitCode !== null || proc.signalCode !== null, 'server exit', 10_000).catch(() => {});
      await until(async () => !(await portInUse(port)), `port ${port} to be released`, 10_000).catch(() => {});
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort (Windows locks) */ }
    },
  };
  try {
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode}:\n${out}`);
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      return r.ok;
    }, 'the test server to answer /api/health', 60_000, 250);
    // The widget library builds asynchronously: wait for the widgets the suite uses.
    await until(async () => {
      const list = (await (await fetch(`${url}/api/widgets`)).json()) as Array<{ id: string; error?: string; url?: string }>;
      const need = ['box', 'slider', 'number', 'resid-flow'];
      return need.every((id) => list.some((w) => w.id === id && !w.error));
    }, 'widgets to build', 60_000, 300);
  } catch (e) {
    await server.stop();
    throw e;
  }
  return server;
}

export function api(base: string) {
  async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, body?: unknown) => call<T>('POST', p, body ?? {}),
    put: <T>(p: string, body: unknown) => call<T>('PUT', p, body),
    async png(req: unknown): Promise<Buffer> {
      const r = await fetch(`${base}/api/screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) throw new Error(`screenshot → ${r.status} ${buf.toString('utf8').slice(0, 300)}`);
      return buf;
    },
  };
}

export function saveShot(name: string, png: Buffer | Uint8Array): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, png);
  return file;
}
