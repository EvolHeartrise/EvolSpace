// Server configuration. Paths are derived from the module location (never the
// CWD) and can be overridden by env vars; tests construct a ServerConfig directly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { PORTS } from '@evolspace/protocol';
import { originsFromEnv } from './http/origin.ts';

export interface ServerConfig {
  repoRoot: string;
  /** data/ (workspaces, screenshots, state). */
  dataDir: string;
  /** library/ (widgets, shared, prefabs, poses, interactions, voice, sources). */
  libraryDir: string;
  /** certs/ (cached self-signed TLS cert). */
  certsDir: string;
  /** apps/client (Vite root). */
  clientDir: string;
  /** Plain HTTP port on httpHost. 0 = random (tests). */
  httpPort: number;
  httpHost: string;
  /** HTTPS port on httpsHost; null disables HTTPS (tests). */
  httpsPort: number | null;
  httpsHost: string;
  /** 'vite' = dev middleware with HMR, 'static' = serve apps/client/dist, 'none' = API only (tests). */
  clientMode: 'vite' | 'static' | 'none';
  /** Start sources with autostart: true on boot. */
  autostartSources: boolean;
  /** Watch library files (disable in some tests for determinism). */
  watch: boolean;
  serverVersion: string;
  /** WS backpressure: above this many buffered bytes, channel values are coalesced latest-per-channel. */
  wsHighWaterMark: number;
  /** Extra browser origins allowed to call the API / open /ws (EVOL_ALLOWED_ORIGINS, comma-separated). */
  allowedOrigins?: string[];
}

/** apps/server/src → repo root. */
export function repoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const repoRoot = repoRootFromModule();
  const prod = env.EVOL_PROD === '1' || env.EVOL_PROD === 'true';
  const httpsDisabled = env.EVOL_HTTPS_PORT === 'off' || env.EVOL_HTTPS_PORT === '-1';
  return {
    repoRoot,
    dataDir: path.resolve(env.EVOL_DATA_DIR || path.join(repoRoot, 'data')),
    libraryDir: path.resolve(env.EVOL_LIBRARY_DIR || path.join(repoRoot, 'library')),
    certsDir: path.resolve(env.EVOL_CERTS_DIR || path.join(repoRoot, 'certs')),
    clientDir: path.join(repoRoot, 'apps', 'client'),
    httpPort: intEnv(env, 'EVOL_HTTP_PORT', PORTS.http),
    httpHost: env.EVOL_HTTP_HOST || '127.0.0.1',
    httpsPort: httpsDisabled ? null : intEnv(env, 'EVOL_HTTPS_PORT', PORTS.https),
    httpsHost: env.EVOL_HTTPS_HOST || '0.0.0.0',
    clientMode: env.EVOL_CLIENT === 'none' ? 'none' : prod ? 'static' : 'vite',
    autostartSources: env.EVOL_NO_AUTOSTART !== '1',
    watch: true,
    serverVersion: serverVersion(),
    wsHighWaterMark: 1 << 20,
    allowedOrigins: originsFromEnv(env),
  };
}

/** Well-known library sub-paths. */
export function libraryPaths(libraryDir: string) {
  return {
    widgets: path.join(libraryDir, 'widgets'),
    shared: path.join(libraryDir, 'shared'),
    prefabs: path.join(libraryDir, 'prefabs'),
    poses: path.join(libraryDir, 'poses'),
    interactions: path.join(libraryDir, 'interactions'),
    voice: path.join(libraryDir, 'voice'),
    sources: path.join(libraryDir, 'sources'),
  };
}
