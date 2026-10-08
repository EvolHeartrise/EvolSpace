// Test harness: a minimal stand-in for apps/server that is just enough for the
// mirror page: Vite serving apps/client (TS + workspace packages + /fonts),
// /?role=mirror → a page that imports apps/client/src/mirror/index.ts,
// /widgets/<id>.js → fixture bundles, and a fake WebSocket server on /ws that
// sends hello + catalog + gestures + a scene snapshot.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, SceneOp, SceneState, ServerMessage, WidgetManifest } from '@evolspace/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '../../../../client');
const fixtures = path.join(here, 'fixtures');

export interface FakeServer {
  baseUrl: string;
  /** Messages received from clients (hello, client.error, ...). */
  received: ClientMessage[];
  /** Broadcast a server message to every connected client. */
  broadcast(m: ServerMessage): void;
  /**
   * Apply ops as the real server would: the version (served by /api/scene/summary)
   * bumps immediately, the scene.patch is broadcast after `delayMs` (simulates
   * the WS message still being in flight when a screenshot is requested).
   */
  patch(ops: SceneOp[], delayMs?: number): number;
  /** While silent, hellos are not answered (a stuck/slow server); unmuting answers the pending ones. */
  setSilent(silent: boolean): void;
  /** Replace a manifest served by /api/widgets WITHOUT broadcasting widgets.updated. */
  setManifest(id: string, extra: Partial<WidgetManifest>): void;
  close(): Promise<void>;
}

function manifest(id: string, extra: Partial<WidgetManifest> = {}): WidgetManifest {
  return {
    id,
    description: `${id} (test fixture)`,
    version: '1',
    props: {},
    inputs: {},
    outputs: {},
    interactions: [],
    hash: 'h1',
    url: `/widgets/${id}.js?h=h1`,
    hasThumbnail: false,
    ...extra,
  };
}

export const FIXTURE_WIDGETS = ['box', 'slow', 'broken', 'nan', 'chatty', 'rebuilt'];

/** What the real server would derive from each fixture's static definition fields. */
const FIXTURE_MANIFESTS: Record<string, Partial<WidgetManifest>> = {
  box: {
    props: { size: { type: 'number', default: 0.3 }, label: { type: 'string', default: 'box' } },
    size: [0.3, 0.3, 0.3],
  },
  slow: { size: [0.4, 0.4, 0.2] },
  broken: {},
  nan: {},
  chatty: {},
  rebuilt: { size: [0.3, 0.3, 0.3] },
};

export interface FakeServerOptions {
  /** Alias @evolspace/runtime to fixtures/mock-runtime.ts instead of the real runtime. */
  mockRuntime?: boolean;
}

export async function startFakeServer(scene: SceneState, opts: FakeServerOptions = {}): Promise<FakeServer> {
  const received: ClientMessage[] = [];
  let version = scene.version;
  let silent = false;
  const pendingHello = new Set<WebSocket>();
  const manifests = new Map(FIXTURE_WIDGETS.map((id) => [id, manifest(id, FIXTURE_MANIFESTS[id])]));
  const json = (res: import('node:http').ServerResponse, body: unknown): void => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const send = (ws: WebSocket, m: ServerMessage): void => ws.send(JSON.stringify(m));
  const greet = (ws: WebSocket): void => {
    send(ws, { type: 'hello', clientId: `c${sockets.size}`, serverVersion: 'test', primary: false });
    send(ws, { type: 'widgets.catalog', widgets: [...manifests.values()] });
    send(ws, { type: 'gestures.defs', poses: [], interactions: {} });
    send(ws, { type: 'scene.snapshot', scene: { ...scene, version } });
  };
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(data)) as ClientMessage;
      received.push(m);
      if (m.type === 'hello') {
        if (silent) pendingHello.add(ws);
        else greet(ws);
      }
    });
  });

  const plugin: Plugin = {
    name: 'evol-mirror-fake-server',
    configureServer(server: ViteDevServer) {
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/ws')) return; // leave anything else to Vite
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x');
          const widget = /^\/widgets\/([\w-]+)\.js$/.exec(url.pathname);
          if (widget) {
            const src = await readFile(path.join(fixtures, `${widget[1]}.js`), 'utf8');
            res.setHeader('Content-Type', 'text/javascript');
            res.end(src);
            return;
          }
          if (url.pathname === '/api/scene/summary') {
            json(res, { version, workspace: scene.workspace, roots: [], links: [] });
            return;
          }
          if (url.pathname === '/api/widgets') {
            json(res, [...manifests.values()]);
            return;
          }
          if (url.pathname === '/' && url.searchParams.get('role') === 'mirror') {
            const html = await server.transformIndexHtml(
              req.url ?? '/',
              '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
                '<script type="module" src="/src/mirror/index.ts"></script></body></html>',
            );
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
            return;
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
          return;
        }
        next();
      });
    },
  };

  const vite = await createServer({
    configFile: false,
    root: clientRoot,
    logLevel: 'warn',
    // Keep the test's dep-optimizer cache away from the client's own Vite cache.
    cacheDir: path.join(tmpdir(), 'evol-mirror-test-vite'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { include: ['three', 'troika-three-text'], noDiscovery: true },
    plugins: [plugin],
    resolve: opts.mockRuntime ? { alias: { '@evolspace/runtime': path.join(fixtures, 'mock-runtime.ts') } } : {},
  });
  await vite.listen();
  const addr = vite.httpServer!.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    received,
    broadcast(m) {
      for (const ws of sockets) send(ws, m);
    },
    patch(ops, delayMs = 0) {
      const v = ++version;
      const out: ServerMessage = { type: 'scene.patch', version: v, ops, source: 'agent' };
      setTimeout(() => { for (const ws of sockets) send(ws, out); }, delayMs);
      return v;
    },
    setSilent(v) {
      silent = v;
      if (v) return;
      for (const ws of pendingHello) if (ws.readyState === ws.OPEN) greet(ws);
      pendingHello.clear();
    },
    setManifest(id, extra) {
      manifests.set(id, manifest(id, { ...FIXTURE_MANIFESTS[id], ...extra }));
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await vite.close();
    },
  };
}
