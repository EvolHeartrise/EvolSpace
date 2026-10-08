// Every standard widget compiles the way the server compiles it (esbuild,
// format esm, bundle, browser platform, NO bare runtime imports) and its
// bundle evaluates in plain Node (no DOM) — i.e. module top-level code is
// side-effect free — yielding a definition whose static fields are valid.
//
// Mirrors apps/server/src/widgets/{compiler,evaluate}.ts without importing
// them, so this suite keeps working while the server evolves.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDefinition } from './lint.ts';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_OURS = new Set<string>();
export const WIDGETS = readdirSync(path.join(LIBRARY, 'widgets'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !NOT_OURS.has(d.name) && existsSync(path.join(LIBRARY, 'widgets', d.name, 'widget.ts')))
  .map((d) => d.name)
  .sort();

const isBare = (s: string) => !s.startsWith('.') && !s.startsWith('/') && !path.isAbsolute(s) && !s.startsWith('data:');

/** Same rules as the server's guard plugin, but strict: no bare imports at all survive into the bundle. */
const guard: esbuild.Plugin = {
  name: 'library-guard',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      if (isBare(args.path)) return { errors: [{ text: `runtime import of '${args.path}' (widgets must use ctx.THREE / import type only)` }] };
      const resolved = path.resolve(args.resolveDir, args.path);
      if (!resolved.startsWith(LIBRARY + path.sep)) return { errors: [{ text: `import '${args.path}' resolves outside library/` }] };
      return undefined;
    });
  },
};

let outDir = '';
beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 'evol-widgets-'));
});
afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('widget bundles', () => {
  it('finds the standard widgets', () => {
    for (const id of ['shape', 'box', 'group', 'text', 'panel', 'slider', 'button', 'toggle', 'number', 'line-plot', 'bar-chart', 'heatmap', 'points', 'line', 'arrow', 'axes', 'image', 'channel-view', 'gauge']) {
      expect(WIDGETS).toContain(id);
    }
  });

  for (const id of WIDGETS) {
    it(`${id}: compiles (esm, no bare imports) and evaluates side-effect free`, async () => {
      const result = await esbuild.build({
        entryPoints: [path.join(LIBRARY, 'widgets', id, 'widget.ts')],
        absWorkingDir: LIBRARY,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        write: false,
        metafile: true,
        logLevel: 'silent',
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: true } },
        plugins: [guard],
      });
      expect(result.errors).toEqual([]);
      const code = result.outputFiles[0].text;
      // Only library files went in; nothing from node_modules.
      for (const input of Object.keys(result.metafile.inputs)) expect(input).not.toMatch(/node_modules/);
      expect(code).not.toMatch(/^\s*import\s.+from\s+['"](?!\.)/m);
      expect(code.length).toBeLessThan(120_000);
      // Evaluate in Node: no DOM globals exist here, so touching window/document at top level would throw.
      const file = path.join(outDir, `${id}.mjs`);
      writeFileSync(file, code);
      const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default?: unknown };
      expect(typeof mod.default).toBe('object');
      expect(checkDefinition(mod.default)).toEqual([]);
    }, 30_000); // esbuild under a loaded full-suite run (resid-flow is the largest bundle)
  }
});
