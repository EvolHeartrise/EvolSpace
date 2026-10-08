// File helpers: atomic writes (Windows-safe), JSON reading with good errors.
import { promises as fsp, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Write a file atomically: write a sibling temp file, then rename over the
 * target. On Windows the rename can transiently fail with EPERM/EBUSY when an
 * antivirus/indexer holds the target open, so it is retried a few times.
 */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await fsp.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 8) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

/** Synchronous variant for shutdown paths where the event loop may not run again. */
export function atomicWriteSync(file: string, data: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 8) throw e;
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* brief spin; shutdown path only */ }
    }
  }
}

/** Read + parse JSON; errors mention the file and the parse problem. */
export async function readJson<T = unknown>(file: string): Promise<T> {
  const text = await fsp.readFile(file, 'utf8');
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch (e) {
    throw new Error(`${path.basename(file)}: invalid JSON (${(e as Error).message})`);
  }
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try { return await readJson<T>(file); } catch { return fallback; }
}

/** True if `child` is inside (or equal to) `parent`. Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Normalize a path for use as a map key (forward slashes, lowercase drive on Windows). */
export function normPath(p: string): string {
  const r = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
