// Test helpers: temp library/data dirs, an in-process server on random ports,
// a WS test client and a static widget catalog for store unit tests.
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { ServerMessage, WidgetManifest } from '@evolspace/protocol';
import { startApp, type AppOverrides, type RunningApp } from '../src/app.ts';
import type { ServerConfig } from '../src/config.ts';
import { repoRootFromModule } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import type { WidgetCatalog } from '../src/scene/store.ts';

export function tempDir(prefix = 'evol-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file locks; temp dir anyway */ }
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
}

export const BOX_WIDGET = `
import type { WidgetDefinition } from '@evolspace/protocol';
import { clamp } from '../../shared/math.ts';
const def: WidgetDefinition = {
  description: 'A test box.',
  version: '1.0.0',
  props: {
    size: { type: 'number', default: 0.2, min: 0 },
    color: { type: 'color', default: '#44aaff' },
    mode: { type: 'enum', options: ['a', 'b'], default: 'a' },
  },
  inputs: { value: { type: 'number' } },
  outputs: { changed: { type: 'number' } },
  size: [0.2, 0.2, 0.2],
  create(ctx) {
    const { THREE } = ctx;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    ctx.root.add(mesh);
    return { onInput(_p, v) { ctx.emit('changed', clamp(Number(v), 0, 1)); } };
  },
};
export default def;
`;

export const SHARED_MATH = `export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));\n`;

export function makeLibrary(extra: Record<string, string> = {}): string {
  const lib = tempDir('evol-lib-');
  writeFiles(lib, {
    'widgets/box/widget.ts': BOX_WIDGET,
    'shared/math.ts': SHARED_MATH,
    ...extra,
  });
  for (const d of ['prefabs', 'poses', 'interactions', 'voice', 'sources']) mkdirSync(path.join(lib, d), { recursive: true });
  return lib;
}

export function testConfig(libraryDir: string, dataDir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  const repoRoot = repoRootFromModule();
  return {
    repoRoot,
    dataDir,
    libraryDir,
    certsDir: path.join(dataDir, 'certs'),
    clientDir: path.join(repoRoot, 'apps', 'client'),
    httpPort: 0,
    httpHost: '127.0.0.1',
    httpsPort: null,
    httpsHost: '127.0.0.1',
    clientMode: 'none',
    autostartSources: false,
    watch: false,
    serverVersion: 'test',
    wsHighWaterMark: 1 << 20,
    ...over,
  };
}

export interface TestServer {
  app: RunningApp;
  url: string;
  wsUrl: string;
  lib: string;
  data: string;
  close(): Promise<void>;
}

export async function startTestServer(opts: { lib?: string; data?: string; config?: Partial<ServerConfig>; overrides?: AppOverrides } = {}): Promise<TestServer> {
  const lib = opts.lib ?? makeLibrary();
  const data = opts.data ?? tempDir('evol-data-');
  const app = await startApp(testConfig(lib, data, opts.config), {
    log: silentLogger,
    startMirror: async () => ({
      screenshot: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      thumbnail: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      close: async () => {},
    }),
    // Deterministic voice stub (the real voice component talks to the STT service).
    createVoice: (deps) => ({
      onBegin() {}, onAudio() {}, onEnd() {},
      async simulate(text, context) { deps.agentAsk(text, context ?? {}); return { route: 'agent' as const }; },
      commands: () => [],
      close: async () => {},
    }),
    workspaceDebounceMs: 50,
    ...opts.overrides,
  });
  const url = `http://127.0.0.1:${app.httpPort}`;
  return {
    app, url, wsUrl: `ws://127.0.0.1:${app.httpPort}/ws`, lib, data,
    close: async () => { await app.stop(); if (!opts.lib) rmDir(lib); if (!opts.data) rmDir(data); },
  };
}

export async function api<T = any>(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T };
}

/** WS client that records every message and can await specific ones. */
export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly binary: Buffer[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  private binWaiters: Array<{ pred: (b: Buffer) => boolean; resolve: (b: Buffer) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const b = data as Buffer;
        this.binary.push(b);
        this.binWaiters = this.binWaiters.filter((w) => (w.pred(b) ? (w.resolve(b), false) : true));
        return;
      }
      const m = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  static async connect(url: string, hello?: Record<string, unknown>): Promise<TestClient> {
    const c = new TestClient(url);
    await new Promise<void>((res, rej) => { c.ws.once('open', () => res()); c.ws.once('error', rej); });
    if (hello) {
      const ack = c.next('hello');
      c.send({ type: 'hello', ...hello });
      await ack;
    }
    return c;
  }

  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }

  next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 5000): Promise<Extract<ServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { type: T }>); },
      });
    });
  }

  nextBinary(pred: (b: Buffer) => boolean = () => true, timeoutMs = 5000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for binary frame')), timeoutMs);
      this.binWaiters.push({ pred, resolve: (b) => { clearTimeout(timer); resolve(b); } });
    });
  }

  of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((m) => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((r) => { this.ws.once('close', () => r()); this.ws.close(); });
  }
}

/** Static catalog for store unit tests. */
export function staticCatalog(manifests: Array<Partial<WidgetManifest> & { id: string }>): WidgetCatalog {
  const map = new Map(manifests.map((m) => [m.id, {
    description: '', props: {}, inputs: {}, outputs: {}, interactions: [], hash: 'h', url: '', hasThumbnail: false, ...m,
  } as WidgetManifest]));
  return { manifest: (id) => map.get(id), exists: (id) => map.has(id), ids: () => [...map.keys()] };
}

export const until = async (cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 20): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
};
