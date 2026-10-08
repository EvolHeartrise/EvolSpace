// Browser origin policy for the HTTP API and WebSocket.
//
// Why: the API drives Claude Code (agent.ask events are pushed into the
// session as user requests) and exposes the user's pose, scene and
// screenshots. Without a check, any web page open in the user's desktop
// browser could POST to http://127.0.0.1:8787 (a "simple" text/plain request
// needs no CORS preflight) or open ws://127.0.0.1:8787/ws (WebSockets are not
// subject to CORS) and inject requests.
//
// Rules:
// 1. Host header: must name this machine (loopback, one of its IPs, its
//    hostname with any domain suffix) or a host listed in EVOL_ALLOWED_ORIGINS.
//    This defeats DNS rebinding (evil.example re-resolving to 127.0.0.1 makes
//    the attacker page "same origin", but its Host header is still evil.example).
// 2. Origin header: requests without one (curl, Python, Node fetch, the MCP
//    bridge, hooks) pass. With one, the origin must be this server itself
//    (same host as the Host header), loopback (Vite standalone dev server on
//    localhost:5173, the mirror), one of this machine's addresses/hostname, or
//    listed in EVOL_ALLOWED_ORIGINS. EVOL_ALLOWED_ORIGINS=* disables both checks.
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import { lanInterfaces } from '../net/lan.ts';

export interface OriginPolicy {
  /** True if the request may proceed. */
  allowed(req: IncomingMessage): boolean;
  /** Value for Access-Control-Allow-Origin, or null (no CORS header). */
  corsOrigin(req: IncomingMessage): string | null;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1)$/i;

const stripBrackets = (h: string) => h.replace(/^\[|\]$/g, '').toLowerCase();

export function createOriginPolicy(opts: { extraOrigins?: string[]; refreshMs?: number } = {}): OriginPolicy {
  const extra = new Set((opts.extraOrigins ?? []).map((o) => o.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean));
  const allowAll = extra.has('*');
  const extraHosts = new Set([...extra].map((o) => { try { return new URL(o).hostname; } catch { return ''; } }).filter(Boolean));
  const hostname = os.hostname().toLowerCase();

  let own: Set<string> | null = null;
  let ownAt = 0;
  const ownAddresses = (): Set<string> => {
    const now = Date.now();
    if (!own || now - ownAt > (opts.refreshMs ?? 30_000)) {
      own = new Set(lanInterfaces().map((i) => i.address));
      ownAt = now;
    }
    return own;
  };

  const isOwnHost = (h: string): boolean => {
    const name = stripBrackets(h);
    if (LOOPBACK.test(name) || extraHosts.has(name) || ownAddresses().has(name)) return true;
    // "my-pc", "my-pc.local", "my-pc.lan", ... (first label = this machine's hostname)
    return name.split('.')[0] === hostname;
  };

  const check = (req: IncomingMessage): { ok: boolean; origin?: string } => {
    if (allowAll) return { ok: true, ...(req.headers.origin ? { origin: String(req.headers.origin) } : {}) };
    const host = req.headers.host;
    if (host) {
      let name: string;
      try { name = new URL(`http://${host}`).hostname; } catch { return { ok: false }; }
      if (!isOwnHost(name)) return { ok: false };
    }
    const origin = req.headers.origin;
    if (origin === undefined) return { ok: true };
    const o = String(origin).toLowerCase();
    if (extra.has(o)) return { ok: true, origin: String(origin) };
    let url: URL;
    try { url = new URL(o); } catch { return { ok: false }; } // "null", garbage
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false };
    if (host && url.host === host.toLowerCase()) return { ok: true, origin: String(origin) }; // same origin
    if (isOwnHost(url.hostname)) return { ok: true, origin: String(origin) };
    return { ok: false };
  };

  return {
    allowed: (req) => check(req).ok,
    corsOrigin: (req) => check(req).origin ?? null,
  };
}

/** EVOL_ALLOWED_ORIGINS="https://a.example,http://b:3000" → list ("*" allows everything). */
export function originsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.EVOL_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
