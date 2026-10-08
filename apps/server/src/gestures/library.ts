// Gesture definitions: library/poses/*.json (PoseDef) and
// library/interactions/*.json (InteractionSet), validated and hot-reloaded.
// Invalid files are reported in `errors` (and logged) and skipped, so one bad
// edit doesn't take every other gesture down. Files that load but look wrong
// (unknown feature names, bad binding hand values, ... — checked with
// @evolspace/input's validators when available) are reported in `warnings`.
// Every reload calls onLoad (app.ts records a 'gestures.load' event) so the
// agent sees typos right after editing a file.
import path from 'node:path';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import type { InteractionSet, PoseDef } from '@evolspace/protocol';
import { readJson } from '../util/fs.ts';
import { debounce } from '../util/timing.ts';
import type { Logger } from '../log.ts';
import type { InputModule } from './input.ts';

export type GestureValidators = Pick<InputModule, 'validatePoseDef' | 'validateInteractionSet'>;

export interface GestureDefs {
  poses: PoseDef[];
  interactions: Record<string, InteractionSet>;
  /** file (relative to library/) → problem (the file was skipped, or for dangling pose refs, loaded anyway) */
  errors: Record<string, string>;
  /** file (relative to library/) → non-fatal problems (the file is loaded); likely typos. */
  warnings: Record<string, string[]>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HANDS = ['left', 'right', 'either'];
const TARGETS = ['ray', 'touch', 'near', 'none'];

export function validatePose(p: unknown, id: string): PoseDef {
  if (!isObj(p)) throw new Error('expected a PoseDef object');
  if (p.id !== undefined && p.id !== id) throw new Error(`"id" is "${String(p.id)}" but must equal the file name "${id}"`);
  if (!HANDS.includes(p.hand as string)) throw new Error(`"hand" must be one of ${HANDS.join(', ')}`);
  if (!Array.isArray(p.conditions) || p.conditions.length === 0) throw new Error(`"conditions" must be a non-empty array of {feature, min?, max?}`);
  p.conditions.forEach((c, i) => {
    if (!isObj(c) || typeof c.feature !== 'string') throw new Error(`conditions[${i}] needs a "feature" name (see packages/input/FEATURES.md)`);
    if (c.min === undefined && c.max === undefined) throw new Error(`conditions[${i}] (${c.feature}) needs "min" and/or "max"`);
    for (const k of ['min', 'max'] as const) if (c[k] !== undefined && typeof c[k] !== 'number') throw new Error(`conditions[${i}].${k} must be a number`);
  });
  for (const k of ['enterMs', 'exitSlack'] as const) if (p[k] !== undefined && typeof p[k] !== 'number') throw new Error(`"${k}" must be a number`);
  return { ...(p as unknown as PoseDef), id, description: typeof p.description === 'string' ? p.description : '', source: (p.source as PoseDef['source']) ?? 'manual' };
}

export function validateInteractionSet(s: unknown): InteractionSet {
  if (!isObj(s)) throw new Error('expected an InteractionSet object {description, scope, bindings}');
  if (s.scope !== 'global' && s.scope !== 'entity-default') throw new Error(`"scope" must be 'global' or 'entity-default'`);
  if (!Array.isArray(s.bindings)) throw new Error(`"bindings" must be an array`);
  s.bindings.forEach((b, i) => {
    const w = `bindings[${i}]`;
    if (!isObj(b)) throw new Error(`${w} must be an object`);
    if (typeof b.id !== 'string' || !b.id) throw new Error(`${w}.id is required`);
    if (typeof b.pose !== 'string' || !b.pose) throw new Error(`${w}.pose is required`);
    if (!TARGETS.includes(b.target as string)) throw new Error(`${w}.target must be one of ${TARGETS.join(', ')}`);
    if (!isObj(b.action) || typeof b.action.type !== 'string') throw new Error(`${w}.action must be {type: grab|scale|widget|command|channel, ...}`);
    const a = b.action;
    if (a.type === 'widget' && typeof a.handler !== 'string') throw new Error(`${w}.action.handler is required for widget actions`);
    if (a.type === 'command' && typeof a.command !== 'string') throw new Error(`${w}.action.command is required for command actions`);
    if (a.type === 'channel' && typeof a.channel !== 'string') throw new Error(`${w}.action.channel is required for channel actions`);
    if (!['grab', 'scale', 'widget', 'command', 'channel'].includes(a.type as string)) throw new Error(`${w}.action.type '${a.type}' is unknown`);
  });
  return { ...(s as unknown as InteractionSet), description: typeof s.description === 'string' ? s.description : '' };
}

export class GestureLibrary {
  readonly posesDir: string;
  readonly interactionsDir: string;
  private defs: GestureDefs = { poses: [], interactions: {}, errors: {}, warnings: {} };
  private watcher: FSWatcher | null = null;

  constructor(private readonly opts: {
    libraryDir: string;
    log: Logger;
    onChange?: (d: GestureDefs) => void;
    /** After every (re)load, including the initial one. */
    onLoad?: (d: GestureDefs) => void;
    /** @evolspace/input validators (lazy; null/rejection = skip the extra checks). */
    validators?: () => Promise<GestureValidators | null>;
    watch?: boolean;
  }) {
    this.posesDir = path.join(opts.libraryDir, 'poses');
    this.interactionsDir = path.join(opts.libraryDir, 'interactions');
  }

  get current(): GestureDefs { return this.defs; }

  async init(): Promise<void> {
    mkdirSync(this.posesDir, { recursive: true });
    mkdirSync(this.interactionsDir, { recursive: true });
    await this.reload();
    if (this.opts.watch !== false) {
      const again = debounce(() => { void this.reload().then((d) => this.opts.onChange?.(d)); }, 150);
      this.watcher = watch([this.posesDir, this.interactionsDir], { ignoreInitial: true, depth: 0 });
      this.watcher.on('all', (_e, f) => { if (String(f).endsWith('.json')) again(); });
      await new Promise<void>((r) => this.watcher!.once('ready', () => r()));
    }
  }

  async reload(): Promise<GestureDefs> {
    const errors: Record<string, string> = {};
    const poses: PoseDef[] = [];
    const interactions: Record<string, InteractionSet> = {};
    for (const f of await jsonFiles(this.posesDir)) {
      const id = f.slice(0, -5);
      try { poses.push(validatePose(await readJson(path.join(this.posesDir, f)), id)); } catch (e) { errors[`poses/${f}`] = (e as Error).message; }
    }
    for (const f of await jsonFiles(this.interactionsDir)) {
      try { interactions[f.slice(0, -5)] = validateInteractionSet(await readJson(path.join(this.interactionsDir, f))); } catch (e) { errors[`interactions/${f}`] = (e as Error).message; }
    }
    // Cross-check: bindings should reference known poses (warning only; poses may be added later).
    const poseIds = new Set(poses.map((p) => p.id));
    for (const [name, set] of Object.entries(interactions)) {
      const missing = [...new Set(set.bindings.map((b) => b.pose).filter((p) => !poseIds.has(p)))];
      if (missing.length) errors[`interactions/${name}.json`] = `references unknown pose(s): ${missing.join(', ')}`;
    }
    const warnings = await this.lint(poses, interactions, errors);
    for (const [f, msg] of Object.entries(errors)) this.opts.log.warn(`${f}: ${msg}`);
    for (const [f, list] of Object.entries(warnings)) for (const w of list) this.opts.log.warn(`${f}: ${w}`);
    this.defs = { poses, interactions, errors, warnings };
    try { this.opts.onLoad?.(this.defs); } catch (e) { this.opts.log.error(`gestures onLoad failed: ${(e as Error).message}`); }
    return this.defs;
  }

  /** Extra checks with @evolspace/input's validators on the loaded (normalized) definitions. */
  private async lint(poses: PoseDef[], interactions: Record<string, InteractionSet>, errors: Record<string, string>): Promise<Record<string, string[]>> {
    const warnings: Record<string, string[]> = {};
    let v: GestureValidators | null = null;
    try { v = (await this.opts.validators?.()) ?? null; } catch { v = null; }
    if (!v) return warnings;
    const add = (file: string, list: string[]) => {
      const fresh = list.filter((w) => !errors[file]?.includes(w));
      if (fresh.length) warnings[file] = [...(warnings[file] ?? []), ...fresh];
    };
    if (typeof v.validatePoseDef === 'function') {
      for (const p of poses) {
        try {
          const r = v.validatePoseDef(p, p.id);
          add(`poses/${p.id}.json`, [...r.errors, ...r.warnings]);
        } catch (e) { add(`poses/${p.id}.json`, [`validator failed: ${(e as Error).message}`]); }
      }
    }
    if (typeof v.validateInteractionSet === 'function') {
      const poseIds = poses.map((p) => p.id);
      for (const [name, set] of Object.entries(interactions)) {
        const file = `interactions/${name}.json`;
        try {
          const r = v.validateInteractionSet(set, poseIds);
          // Dangling pose references are already reported in `errors`.
          add(file, [...r.errors, ...r.warnings].filter((w) => !(errors[file] && /does not exist in library\/poses/.test(w))));
        } catch (e) { add(file, [`validator failed: ${(e as Error).message}`]); }
      }
    }
    return warnings;
  }

  async close(): Promise<void> { await this.watcher?.close(); }
}

async function jsonFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
}
