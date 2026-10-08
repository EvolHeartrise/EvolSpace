// Minimal programmable stand-in for the EvolSpace HTTP API (tests only).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '@evolspace/protocol';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json(): any;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  body?: Uint8Array | string;
  contentType?: string;
}

export type Handler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export class FakeEvol {
  readonly requests: FakeRequest[] = [];
  readonly routes = new Map<string, Handler>();
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = '';

  /** Register `METHOD /path` (exact) or `METHOD /prefix/*`. */
  on(route: string, h: Handler | FakeResponse): this {
    this.routes.set(route, typeof h === 'function' ? h : () => h);
    return this;
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  find(method: string, path: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://x');
    const body = Buffer.concat(chunks);
    const fr: FakeRequest = {
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers: req.headers,
      body,
      json: () => JSON.parse(body.toString('utf8') || 'null'),
    };
    this.requests.push(fr);
    const key = `${fr.method} ${fr.path}`;
    let h = this.routes.get(key);
    if (!h) {
      for (const [k, v] of this.routes) if (k.endsWith('/*') && key.startsWith(k.slice(0, -1))) { h = v; break; }
    }
    let out: FakeResponse;
    try {
      out = h ? await h(fr) : { status: 404, json: { error: `no route ${key}` } };
    } catch (e) {
      out = { status: 500, json: { error: (e as Error).message } };
    }
    if (res.destroyed) return;
    const status = out.status ?? 200;
    if (out.json !== undefined) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    } else {
      res.writeHead(status, { 'content-type': out.contentType ?? 'application/octet-stream' });
      res.end(out.body ?? '');
    }
  }
}

/**
 * An in-memory event log with long-poll semantics matching the API contract:
 * GET /api/events?since=<seq>&wait=<ms>&types=a,b → events with seq > since; next = last seq (or head).
 */
export class EventLog {
  events: ServerEvent[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];

  add(type: ServerEvent['type'], data: Record<string, unknown>, ts = Date.now()): ServerEvent {
    const ev = { seq: ++this.seq, ts, type, data };
    this.events.push(ev);
    for (const w of this.waiters.splice(0)) w();
    return ev;
  }

  /** Simulate a server restart: empty log, seq restarts at 0. */
  reset(): void {
    this.events = [];
    this.seq = 0;
  }

  /** Same semantics as apps/server/src/events.ts EventLog.query. */
  query(sinceParam: number | undefined, types: string[] | undefined, limitParam?: number): { events: ServerEvent[]; next: number } {
    const limit = Math.max(1, Math.min(limitParam ?? 200, 2000));
    let matching = this.events.filter((e) => (sinceParam === undefined || e.seq > sinceParam) && (!types || types.includes(e.type)));
    if (sinceParam === undefined) return { events: matching.slice(-limit), next: this.seq };
    if (matching.length > limit) {
      matching = matching.slice(0, limit);
      return { events: matching, next: matching[matching.length - 1]!.seq };
    }
    return { events: matching, next: Math.max(sinceParam, this.seq) };
  }

  handler(): Handler {
    return async (req) => {
      const s = req.query.get('since');
      let since = s === null ? undefined : Number(s);
      const limit = req.query.get('limit') ? Number(req.query.get('limit')) : undefined;
      const wait = Math.min(Number(req.query.get('wait') ?? 0), 2000);
      const types = req.query.get('types')?.split(',').filter(Boolean);
      let page = this.query(since, types, limit);
      if (!page.events.length && wait > 0) {
        since ??= this.seq; // pin, like the server
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          this.waiters.push(() => { clearTimeout(t); resolve(); });
        });
        page = this.query(since, types, limit);
      }
      return { json: page };
    };
  }
}

export const PNG_1x1 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

export async function until(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A port with nothing listening (for "server down" tests). */
export async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
