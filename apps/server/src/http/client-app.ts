// Serving the client app (apps/client):
// - dev:  Vite in middlewareMode, mounted on both servers; HMR websocket is
//         attached to the primary (HTTPS) server and HMR upgrades arriving on
//         the plain HTTP server are forwarded to it.
// - prod: static files from apps/client/dist with an SPA fallback to index.html.
import path from 'node:path';
import { existsSync, promises as fsp, createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Logger } from '../log.ts';
import { isInside } from '../util/fs.ts';

export type ClientHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface ClientApp {
  handle: ClientHandler;
  close(): Promise<void>;
  /** True if the given upgrade request is Vite HMR. */
  isHmrUpgrade(req: IncomingMessage): boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ktx2': 'image/ktx2',
};

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

const notFound = (res: ServerResponse, msg: string) => {
  if (res.headersSent) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
};

/** Serve files under `root`; unknown non-asset paths fall back to index.html (SPA). */
export function staticHandler(root: string): ClientHandler {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      let rel: string;
      try { rel = decodeURIComponent(url.pathname); } catch { notFound(res, 'bad path'); return; }
      let file = path.join(root, rel);
      if (!isInside(root, file)) { notFound(res, 'not found'); return; }
      let st = await fsp.stat(file).catch(() => null);
      if (st?.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
      if (!st && !path.extname(rel)) { file = path.join(root, 'index.html'); st = await fsp.stat(file).catch(() => null); }
      if (!st) { notFound(res, `not found: ${rel}`); return; }
      const hashed = /[.-][0-9a-zA-Z_-]{8,}\.(js|css|woff2?)$/.test(file);
      res.writeHead(200, {
        'Content-Type': mimeType(file),
        'Content-Length': String(st.size),
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).pipe(res);
    })();
  };
}

export async function createClientApp(opts: {
  mode: 'vite' | 'static' | 'none';
  clientDir: string;
  /** Server the Vite HMR websocket attaches to. */
  hmrServer: HttpServer;
  log: Logger;
}): Promise<ClientApp> {
  const none: ClientApp = {
    handle: (_req, res) => notFound(res, 'client app not served (EVOL_CLIENT=none)'),
    close: async () => {},
    isHmrUpgrade: () => false,
  };
  if (opts.mode === 'none') return none;

  if (opts.mode === 'static') {
    const dist = path.join(opts.clientDir, 'dist');
    if (!existsSync(path.join(dist, 'index.html'))) opts.log.warn(`EVOL_PROD: ${dist}/index.html not found — build the client first (npm run build -w @evolspace/client)`);
    return { handle: staticHandler(dist), close: async () => {}, isHmrUpgrade: () => false };
  }

  if (!existsSync(opts.clientDir)) {
    opts.log.warn(`client folder ${opts.clientDir} missing; serving API only`);
    return none;
  }
  try {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: opts.clientDir,
      appType: 'spa',
      clearScreen: false,
      logLevel: 'warn',
      server: {
        middlewareMode: true,
        ws: { server: opts.hmrServer },
      },
    });
    opts.log.info(`vite dev middleware ready (root ${path.relative(process.cwd(), opts.clientDir) || '.'})`);
    return {
      handle: (req, res) => vite.middlewares(req, res, () => notFound(res, `not found: ${req.url}`)),
      close: () => vite.close(),
      isHmrUpgrade: (req) => {
        const p = req.headers['sec-websocket-protocol'];
        return p === 'vite-hmr' || p === 'vite-ping';
      },
    };
  } catch (e) {
    opts.log.error(`vite failed to start (${(e as Error).message}); serving API only`);
    return none;
  }
}
