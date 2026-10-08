// Tiny typed router on node:http. Routes are "METHOD /path/:param" patterns;
// handlers return a value (sent as JSON), a Reply (status/headers/body), or
// undefined after writing to `res` themselves (streams, SSE).
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface Reply {
  $reply: true;
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export function reply(body: string | Uint8Array, contentType: string, status = 200, headers: Record<string, string> = {}): Reply {
  return { $reply: true, status, body, headers: { 'Content-Type': contentType, ...headers } };
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  path: string;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      // ":id" or ":id.js" (param followed by a literal suffix)
      const m = /^:([A-Za-z_]\w*)(.*)$/.exec(seg);
      if (m) { keys.push(m[1]); return `([^/]+?)${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${src}/?$`), keys };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler, ...compile(pattern) });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  /** Returns false if no route matched the path (so the caller can fall through, e.g. to Vite). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = (req.method ?? 'GET').toUpperCase();
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        sendJson(res, 400, { error: 'bad URL encoding' });
        return true;
      }
      try {
        const out = await r.handler({ req, res, params, query: url.searchParams, path: url.pathname });
        if (res.headersSent || res.writableEnded) return true;
        if (out === undefined) { res.writeHead(204).end(); return true; }
        if (isReply(out)) {
          res.writeHead(out.status ?? 200, out.headers ?? {});
          res.end(out.body ?? '');
          return true;
        }
        sendJson(res, 200, out);
      } catch (e) {
        if (res.headersSent) { res.destroy(); return true; }
        const status = (e as { status?: unknown }).status;
        if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, ...e.extra });
        else if (typeof status === 'number' && status >= 400 && status < 600) sendJson(res, status, { error: (e as Error).message });
        else {
          sendJson(res, 500, { error: (e as Error)?.message ?? String(e) });
          console.error(`[http] ${method} ${url.pathname} failed:`, e);
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: `method ${method} not allowed for ${url.pathname}` });
      return true;
    }
    return false;
  }

  /** "METHOD pattern" list (for the 404 help text). */
  describe(): string[] { return this.routes.map((r) => `${r.method} ${r.pattern}`); }
}

function isReply(v: unknown): v is Reply {
  return typeof v === 'object' && v !== null && (v as Reply).$reply === true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
