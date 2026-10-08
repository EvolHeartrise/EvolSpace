// Repo-relative locations, discovered from this module's location (never the CWD).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute repo root (…/EvolSpace), with forward slashes for readable output on Windows. */
export const REPO_ROOT = toSlash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));

export const LIBRARY_DIR = `${REPO_ROOT}/library`;

export function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export const DEFAULT_EVOL_URL = 'http://127.0.0.1:8787';
