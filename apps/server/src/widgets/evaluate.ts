// Evaluate a compiled widget bundle in an isolated worker thread to read the
// static fields of its default-exported WidgetDefinition. A worker (not the
// main thread) is used so a widget that loops/blocks at top level or pollutes
// globals cannot hurt the server; it is terminated after a timeout.
import { Worker } from 'node:worker_threads';
import type { InteractionBinding, PortSpec, PropSpec, Vec3 } from '@evolspace/protocol';

export interface WidgetStatics {
  description: string;
  version?: string;
  props: Record<string, PropSpec>;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  interactions: InteractionBinding[];
  size?: Vec3;
}

// Runs inside the worker (CommonJS eval context; dynamic import works there).
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const mod = await import(workerData.url);
    const def = mod.default;
    if (!def || typeof def !== 'object') {
      parentPort.postMessage({ ok: false, error: 'widget.ts must \`export default\` a WidgetDefinition object ({ description, props?, inputs?, outputs?, create(ctx) {...} })' });
      return;
    }
    const pick = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    parentPort.postMessage({ ok: true, statics: {
      description: def.description, version: def.version, props: pick(def.props), inputs: pick(def.inputs),
      outputs: pick(def.outputs), interactions: pick(def.interactions), size: pick(def.size),
      hasCreate: typeof def.create === 'function',
    }});
  } catch (e) {
    parentPort.postMessage({ ok: false, thrown: true, error: (e && e.stack) ? String(e.stack).split('\\n').slice(0, 4).join('\\n') : String(e) });
  }
})();
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const PROP_TYPES = ['number', 'integer', 'boolean', 'string', 'color', 'vec3', 'enum', 'json', 'channel'];
const PORT_TYPES = ['number', 'boolean', 'string', 'vec3', 'color', 'json', 'tensor', 'event', 'any'];

/** Validate the shape of the definition's static fields; returns an error string or null. */
export function checkStatics(s: Record<string, unknown>): string | null {
  if (typeof s.description !== 'string' || !s.description.trim()) return `definition.description must be a non-empty string (one or two sentences, shown to the agent)`;
  if (s.hasCreate !== true) return `definition.create must be a function create(ctx) returning a WidgetInstance`;
  if (s.version !== undefined && typeof s.version !== 'string') return `definition.version must be a string`;
  for (const [field, types] of [['props', PROP_TYPES], ['inputs', PORT_TYPES], ['outputs', PORT_TYPES]] as const) {
    const v = s[field];
    if (v === undefined) continue;
    if (!isObj(v)) return `definition.${field} must be an object of name → spec`;
    for (const [name, spec] of Object.entries(v)) {
      if (!isObj(spec) || !types.includes(spec.type as string)) return `definition.${field}.${name}.type must be one of ${types.join(', ')}`;
      if (field === 'props' && spec.type === 'enum' && !Array.isArray(spec.options)) return `definition.props.${name}: enum props need options: string[]`;
    }
  }
  if (s.interactions !== undefined && !Array.isArray(s.interactions)) return `definition.interactions must be an array of InteractionBinding`;
  if (s.size !== undefined && !(Array.isArray(s.size) && s.size.length === 3 && s.size.every((n) => typeof n === 'number'))) return `definition.size must be [x, y, z] meters`;
  return null;
}

export async function evaluateWidget(code: string, timeoutMs = 5000): Promise<{ ok: true; statics: WidgetStatics } | { ok: false; error: string }> {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { url },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true, // swallow console output from widget top-level code
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (r: { ok: true; statics: WidgetStatics } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `evaluating the module took longer than ${timeoutMs}ms — top-level code must be side-effect free (do work inside create())` }), timeoutMs);
    worker.on('message', (m: { ok: boolean; statics?: Record<string, unknown>; error?: string; thrown?: boolean }) => {
      if (!m.ok) {
        const hint = m.thrown
          ? `\n(The server evaluates the module in Node to read the definition's static fields: module top-level code must not touch DOM/window/document or run side effects — do that inside create(ctx).)`
          : '';
        finish({ ok: false, error: `${m.error}${hint}` });
        return;
      }
      const s = m.statics!;
      const problem = checkStatics(s);
      if (problem) { finish({ ok: false, error: problem }); return; }
      finish({
        ok: true,
        statics: {
          description: s.description as string,
          version: s.version as string | undefined,
          props: (s.props as Record<string, PropSpec>) ?? {},
          inputs: (s.inputs as Record<string, PortSpec>) ?? {},
          outputs: (s.outputs as Record<string, PortSpec>) ?? {},
          interactions: (s.interactions as InteractionBinding[]) ?? [],
          size: s.size as Vec3 | undefined,
        },
      });
    });
    worker.on('error', (e: Error) => finish({ ok: false, error: `module evaluation failed: ${e.message}` }));
    worker.on('exit', (code) => finish({ ok: false, error: `module evaluation worker exited (code ${code})` }));
  });
}
