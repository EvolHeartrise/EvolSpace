// Widget compiler: library/widgets/<id>/widget.ts → one browser ESM bundle.
//
// Rules enforced at build time (with messages aimed at Claude):
// - No runtime imports of npm packages ('three', ...): widgets get three.js as
//   ctx.THREE. `import type` is erased by esbuild and therefore fine.
//   Exception: '@evolspace/protocol' is pure TS (no DOM/Node) and may be bundled.
// - Relative imports must stay inside the library (own folder, library/shared).
// The bundle is then evaluated in an isolated worker to read the definition's
// static fields (see evaluate.ts).
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { isInside } from '../util/fs.ts';
import { repoRootFromModule } from '../config.ts';

/** Bare imports allowed for bundling resolve from the repo's node_modules, wherever the library lives. */
const NODE_PATHS = [path.join(repoRootFromModule(), 'node_modules')];

export interface CompileOk {
  ok: true;
  code: string;
  hash: string;
  /** Absolute paths of every source file that went into the bundle. */
  inputs: string[];
  warnings: string[];
}
export interface CompileErr {
  ok: false;
  error: string;
  /** Inputs known so far (for watch dependency tracking), may be empty. */
  inputs: string[];
}
export type CompileResult = CompileOk | CompileErr;

/** Bare specifiers that may be bundled (pure, isomorphic). */
const BUNDLABLE_PACKAGES = new Set(['@evolspace/protocol']);

function isBare(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !path.isAbsolute(spec) && !spec.startsWith('data:');
}

function guardPlugin(widgetId: string, libraryDir: string): esbuild.Plugin {
  return {
    name: 'evol-widget-guard',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (isBare(args.path)) {
          const pkg = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
          if (BUNDLABLE_PACKAGES.has(pkg)) return undefined;
          if (args.path.startsWith('node:') || ['fs', 'path', 'os', 'child_process', 'http', 'https', 'crypto'].includes(pkg)) {
            return { errors: [{ text: `Widget '${widgetId}' imports Node module '${args.path}'. Widgets run in the headset browser; Node APIs are unavailable. Fetch data via channels (ctx.channels) or a source in library/sources instead.` }] };
          }
          const hint = pkg === 'three' || pkg.startsWith('three/')
            ? `use ctx.THREE (e.g. \`const { THREE } = ctx; new THREE.Mesh(...)\`) and \`import type * as THREE from 'three'\` for types`
            : `copy the code you need into library/shared/ and import it relatively, or use \`import type\` if you only need types`;
          return { errors: [{ text: `Widget '${widgetId}' imports '${args.path}' at runtime. Widgets must not import npm packages: ${hint}.` }] };
        }
        // Only police relative imports made by library code (not inside bundlable packages).
        if (!args.path.startsWith('.') || !isInside(libraryDir, args.importer)) return undefined;
        const resolved = path.resolve(args.resolveDir, args.path);
        if (!isInside(libraryDir, resolved)) {
          return { errors: [{ text: `Widget '${widgetId}' imports '${args.path}', which resolves outside library/ (${resolved}). Only files in the widget's folder and library/shared/ can be bundled.` }] };
        }
        return undefined;
      });
    },
  };
}

function formatMessages(msgs: esbuild.Message[], libraryDir: string): string {
  return msgs.map((m) => {
    const loc = m.location ? `${path.relative(libraryDir, path.resolve(libraryDir, m.location.file)).replace(/\\/g, '/')}:${m.location.line}:${m.location.column + 1}: ` : '';
    const line = m.location?.lineText ? `\n    ${m.location.lineText.trim()}` : '';
    return `${loc}${m.text}${line}`;
  }).join('\n');
}

export async function compileWidget(libraryDir: string, id: string): Promise<CompileResult> {
  const entry = path.join(libraryDir, 'widgets', id, 'widget.ts');
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: libraryDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
      sourcemap: 'inline',
      sourcesContent: true,
      logLevel: 'silent',
      charset: 'utf8',
      legalComments: 'none',
      // Pin TS semantics so the build doesn't depend on whatever tsconfig is nearby.
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: true } },
      nodePaths: NODE_PATHS,
      plugins: [guardPlugin(id, libraryDir)],
    });
    const out = result.outputFiles[0];
    const code = out.text;
    const inputs = Object.keys(result.metafile.inputs).map((p) => path.resolve(libraryDir, p));
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);
    return { ok: true, code, hash, inputs, warnings: result.warnings.map((w) => formatMessages([w], libraryDir)) };
  } catch (e) {
    const err = e as { errors?: esbuild.Message[]; message?: string };
    const msg = err.errors?.length ? formatMessages(err.errors, libraryDir) : String(err.message ?? e);
    return { ok: false, error: msg, inputs: [entry] };
  }
}
