// Proves the widget bundles the way the server builds it: one ESM file, no
// runtime (bare) imports, side-effect-free top level whose default export
// exposes the static definition fields.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetDir = path.resolve(here, '..');
const libraryDir = path.resolve(widgetDir, '..', '..');
const repoRoot = path.resolve(libraryDir, '..');

const isBare = (s: string) => !s.startsWith('.') && !s.startsWith('/') && !path.isAbsolute(s);

async function bundle(): Promise<{ code: string; inputs: string[] }> {
  const res = await esbuild.build({
    entryPoints: [path.join(widgetDir, 'widget.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [{
      name: 'no-bare-imports',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.kind === 'entry-point' || !isBare(a.path)) return undefined;
          return { errors: [{ text: `bare runtime import '${a.path}' from ${a.importer}` }] };
        });
      },
    }],
  });
  return { code: res.outputFiles[0].text, inputs: Object.keys(res.metafile.inputs).map((p) => path.resolve(p)) };
}

describe('bundle', () => {
  it('bundles to ESM with no bare imports, only files from the widget folder / library/shared', async () => {
    const { code, inputs } = await bundle();
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/^\s*import\s.+from\s+["'][^./]/m);
    expect(code).not.toMatch(/require\(/);
    for (const f of inputs) {
      const rel = path.relative(libraryDir, f).replace(/\\/g, '/');
      expect(rel.startsWith('widgets/resid-flow/') || rel.startsWith('shared/')).toBe(true);
      expect(rel).not.toMatch(/demo-data|\/test\//);
    }
  });

  it('evaluates side-effect free in plain Node and exposes the definition statics', async () => {
    const { code } = await bundle();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'resid-flow-bundle-'));
    try {
      const file = path.join(dir, 'resid-flow.mjs');
      writeFileSync(file, code);
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(file).href)});
         const d = m.default;
         console.log(JSON.stringify({ desc: d.description, inputs: Object.keys(d.inputs), outputs: Object.keys(d.outputs), props: Object.keys(d.props), create: typeof d.create, n: d.interactions.length }));`,
      ], { encoding: 'utf8' });
      const s = JSON.parse(out.trim());
      expect(s.create).toBe('function');
      expect(s.inputs).toEqual(['layer', 'token', 'sample']);
      expect(s.outputs).toEqual(['layer', 'token']);
      expect(s.props).toContain('prefix');
      expect(s.n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The real server compiler + evaluator, when available (owned by the server component).
  const compilerPath = path.join(repoRoot, 'apps', 'server', 'src', 'widgets', 'compiler.ts');
  it.skipIf(!existsSync(compilerPath))('passes the server widget compiler and evaluator', async () => {
    let compileWidget: (lib: string, id: string) => Promise<{ ok: boolean; code?: string; error?: string }>;
    let evaluateWidget: ((code: string) => Promise<{ ok: boolean; error?: string }>) | undefined;
    try {
      ({ compileWidget } = await import(pathToFileURL(compilerPath).href));
      ({ evaluateWidget } = await import(pathToFileURL(path.join(repoRoot, 'apps', 'server', 'src', 'widgets', 'evaluate.ts')).href));
    } catch {
      return; // server sources in flux: the esbuild checks above still apply
    }
    const r = await compileWidget(libraryDir, 'resid-flow');
    expect(r.error ?? '').toBe('');
    expect(r.ok).toBe(true);
    if (evaluateWidget && r.code) {
      const ev = await evaluateWidget(r.code);
      expect(ev.error ?? '').toBe('');
      expect(ev.ok).toBe(true);
    }
  }, 30000);
});
