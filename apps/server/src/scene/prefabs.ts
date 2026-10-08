// Prefabs: library/prefabs/<id>.json → op batch with fresh ids (links remapped).
import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import type { Prefab, SceneOp, Transform, Entity, PortRef } from '@evolspace/protocol';
import { IDENTITY_TRANSFORM } from '@evolspace/protocol';
import { readJson } from '../util/fs.ts';
import { isSafeName, shortId } from '../util/ids.ts';
import { SceneError, checkPartialTransform, isObj, mergeTransform } from './validate.ts';
import { composeTransforms } from './math.ts';

export interface InstantiateOptions {
  /** Placement of the prefab origin; composed with each root's own transform. */
  transform?: Partial<Transform>;
  /** Parent for the prefab roots (default: scene root). */
  parent?: string | null;
  /** Prop overrides keyed by prefab-local id. */
  props?: Record<string, Record<string, unknown>>;
}

export interface PrefabPlan {
  ops: SceneOp[];
  /** prefab-local id → new scene id */
  ids: Record<string, string>;
}

export async function listPrefabs(dir: string): Promise<Array<{ id: string; description: string }>> {
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; description: string }> = [];
  for (const f of (await fsp.readdir(dir)).sort()) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    try {
      const p = await readJson<Prefab>(path.join(dir, f));
      out.push({ id, description: String(p.description ?? '') });
    } catch (e) {
      out.push({ id, description: `(invalid: ${(e as Error).message})` });
    }
  }
  return out;
}

export async function loadPrefab(dir: string, id: string): Promise<Prefab> {
  if (!isSafeName(id)) throw new SceneError(`invalid prefab id '${id}'`);
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) {
    const available = (await listPrefabs(dir)).map((p) => p.id);
    throw new SceneError(`prefab '${id}' not found in library/prefabs${available.length ? ` (available: ${available.join(', ')})` : ''}`);
  }
  const p = await readJson<Prefab>(file);
  if (!isObj(p) || !Array.isArray(p.entities)) throw new SceneError(`prefab '${id}': expected {description, entities: [...], links: [...]}`);
  return p;
}

/**
 * Build the op batch for a prefab instance. Every prefab-local id is mapped to
 * a fresh scene id; parents and port links are remapped; channel ends are kept.
 */
export function planPrefab(prefab: Prefab, opts: InstantiateOptions, taken: (id: string) => boolean): PrefabPlan {
  const ids: Record<string, string> = {};
  const used = new Set<string>();
  for (const e of prefab.entities) {
    if (typeof e.id !== 'string' || !e.id) throw new SceneError(`prefab entity without an id`);
    if (ids[e.id]) throw new SceneError(`prefab has duplicate entity id '${e.id}'`);
    ids[e.id] = shortId('e', (x) => taken(x) || used.has(x));
    used.add(ids[e.id]);
  }
  for (const key of Object.keys(opts.props ?? {})) {
    if (!ids[key]) throw new SceneError(`props override for '${key}', which is not an entity of this prefab (ids: ${Object.keys(ids).join(', ')})`);
  }
  const place = opts.transform ? mergeTransform(IDENTITY_TRANSFORM, checkPartialTransform(opts.transform, 'transform')) : null;

  // Parents must be added before children: order entities topologically.
  const order: typeof prefab.entities = [];
  const pending = [...prefab.entities];
  const placed = new Set<string>();
  while (pending.length) {
    const before = pending.length;
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      const parent = e.parent ?? null;
      if (parent === null || placed.has(parent)) {
        order.push(e); placed.add(e.id); pending.splice(i, 1); i--;
      } else if (!ids[parent]) {
        throw new SceneError(`prefab entity '${e.id}' has parent '${parent}', which is not in the prefab`);
      }
    }
    if (pending.length === before) throw new SceneError(`prefab has a parent cycle among: ${pending.map((e) => e.id).join(', ')}`);
  }

  const ops: SceneOp[] = order.map((e) => {
    const isRoot = (e.parent ?? null) === null;
    const entity: Partial<Entity> & { widget: string } = { ...structuredClone(e), id: ids[e.id] };
    entity.parent = isRoot ? (opts.parent ?? null) : ids[e.parent!];
    if (isRoot && place) entity.transform = composeTransforms(place, mergeTransform(IDENTITY_TRANSFORM, checkPartialTransform(e.transform)));
    const override = opts.props?.[e.id];
    if (override) entity.props = { ...(e.props ?? {}), ...override };
    return { op: 'add', entity };
  });

  const remap = (p: PortRef, where: string): PortRef => {
    if (!isObj(p)) throw new SceneError(`prefab link ${where} is not a PortRef`);
    if (p.kind !== 'port') return { ...p };
    if (!ids[p.entity]) throw new SceneError(`prefab link ${where} references '${p.entity}', which is not in the prefab`);
    return { ...p, entity: ids[p.entity] };
  };
  (prefab.links ?? []).forEach((l, i) => {
    // Links get fresh ids too: an id copied from the file would collide on the second instantiation.
    const { id: _ignored, ...rest } = structuredClone(l) as typeof l & { id?: unknown };
    ops.push({ op: 'link.add', link: { ...rest, from: remap(l.from, `[${i}].from`), to: remap(l.to, `[${i}].to`) } });
  });
  return { ops, ids };
}
