// Thin typed HTTP client for the EvolSpace server API (packages/protocol/src/api.ts).
// All failures are turned into errors whose message is directly actionable by
// Claude: "server not running → how to start it", "HTTP 404 → server's message".

import { REPO_ROOT } from './paths.ts';

export class EvolServerDownError extends Error {
  constructor(readonly baseUrl: string, detail?: string) {
    super(
      `EvolSpace server is not running at ${baseUrl}` +
        (detail ? ` (${detail})` : '') +
        `. Start it with: npm run dev (in ${REPO_ROOT}).`,
    );
    this.name = 'EvolServerDownError';
  }
}

export class EvolTimeoutError extends Error {
  constructor(readonly baseUrl: string, readonly route: string, readonly timeoutMs: number) {
    super(`EvolSpace server at ${baseUrl} did not answer ${route} within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'EvolTimeoutError';
  }
}

export class EvolApiError extends Error {
  constructor(readonly status: number, readonly route: string, readonly serverMessage: string) {
    super(`${route} failed (HTTP ${status}): ${serverMessage}`);
    this.name = 'EvolApiError';
  }
}

export interface RequestOptions {
  /** Query parameters; undefined values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body (serialized) or raw bytes. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BinaryResponse {
  contentType: string;
  bytes: Uint8Array;
}

export interface EvolApiOptions {
  baseUrl: string;
  /** Default per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EvolApi {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EvolApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get<T = unknown>(route: string, opts?: RequestOptions): Promise<T> {
    return this.json<T>('GET', route, opts);
  }
  post<T = unknown>(route: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.json<T>('POST', route, { ...opts, body });
  }
  put<T = unknown>(route: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.json<T>('PUT', route, { ...opts, body });
  }

  /** Request expecting a JSON response (an empty body yields `{}`). */
  async json<T = unknown>(method: string, route: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, route, opts);
    const text = await res.text();
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EvolApiError(res.status, `${method} ${route}`, `expected JSON, got: ${text.slice(0, 200)}`);
    }
  }

  /** Request returning raw bytes + content type (images, tensors). */
  async binary(method: string, route: string, opts: RequestOptions = {}): Promise<BinaryResponse> {
    const res = await this.request(method, route, opts);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { contentType: res.headers.get('content-type') ?? '', bytes };
  }

  /** Low-level request: resolves only for 2xx; maps network errors to actionable messages. */
  async request(method: string, route: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + route);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const headers: Record<string, string> = { ...opts.headers };
    let body: BodyInit | undefined;
    if (opts.body instanceof Uint8Array) {
      body = opts.body as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }
    const label = `${method} ${route}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // caller cancelled: propagate as-is
      if (timeout.aborted) throw new EvolTimeoutError(this.baseUrl, label, timeoutMs);
      throw new EvolServerDownError(this.baseUrl, networkDetail(err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EvolApiError(res.status, label, extractServerMessage(text) || res.statusText || 'no details');
    }
    return res;
  }
}

/** Server errors are JSON `{error}` by convention; fall back to the raw text. */
export function extractServerMessage(text: string): string {
  const t = text.trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t) as { error?: unknown; message?: unknown };
    const m = j.error ?? j.message;
    if (typeof m === 'string') return m;
    if (m !== undefined) return JSON.stringify(m).slice(0, 1000);
  } catch {
    /* not JSON */
  }
  return t.slice(0, 1000);
}

function networkDetail(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code ?? undefined;
}

/** True when the error means "server unreachable" (vs. a request-level failure). */
export function isServerDown(err: unknown): boolean {
  return err instanceof EvolServerDownError || err instanceof EvolTimeoutError;
}
