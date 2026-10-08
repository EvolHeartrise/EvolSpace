#!/usr/bin/env node
// Serializes npm invocations across concurrent agents/processes sharing this repo.
// Usage: node scripts/npm-locked.mjs install <pkg> -w @evolspace/server
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = path.join(root, '.npm-lock');
const deadline = Date.now() + 15 * 60_000;
for (;;) {
  try { mkdirSync(lock); break; } catch {
    try { if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true }); } catch {}
    if (Date.now() > deadline) { console.error('npm-locked: timed out waiting for lock'); process.exit(1); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}
let code = 1;
try {
  const r = spawnSync('npm', process.argv.slice(2), { cwd: root, stdio: 'inherit', shell: true });
  code = r.status ?? 1;
} finally { rmSync(lock, { recursive: true, force: true }); }
process.exit(code);
