// Client-side copy of the server's SceneState. Pure data (no three.js):
// applies snapshots and op batches with the exact semantics of scene.ts and
// returns a SceneDiff the reconciler/widget host turn into scene-graph work.
//
// Entities are replaced immutably on change, so consumers can keep references
// to the previous version for diffing.

import type { Entity, EntityPatch, Link, SceneOp, SceneState, Transform } from '@evolspace/protocol';
import { cloneJson, deepEqual } from '../util/equal.ts';
import { randomId } from '../util/ids.ts';
import { isFiniteVec } from '../util/math.ts';

export interface EntityChange {
  transform?: boolean;
  props?: boolean;
  widget?: boolean;
  parent?: boolean;
  anchor?: boolean;
  visible?: boolean;
  /** name, tags, interactions, locked */
  meta?: boolean;
}

export interface SceneDiff {
  /** Entities to create (process after `removed`). */
  added: string[];
  /** Entities to tear down (descendants included). */
  removed: string[];
  changed: Map<string, EntityChange>;
  linksChanged: boolean;
  /** Non-fatal problems (ops referencing unknown ids, malformed entities). */
  warnings: string[];
}

export function emptyDiff(): SceneDiff {
  return { added: [], removed: [], changed: new Map(), linksChanged: false, warnings: [] };
}

export function isEmptyDiff(d: SceneDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.size && !d.linksChanged;
}

const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

export function normalizeTransform(t: Partial<Transform> | undefined, base: Transform = IDENTITY): Transform {
  return {
    position: isFiniteVec(t?.position, 3) ? [...t!.position] as Transform['position'] : [...base.position] as Transform['position'],
    rotation: isFiniteVec(t?.rotation, 4) ? [...t!.rotation] as Transform['rotation'] : [...base.rotation] as Transform['rotation'],
    scale: isFiniteVec(t?.scale, 3) ? [...t!.scale] as Transform['scale'] : [...base.scale] as Transform['scale'],
  };
}

export function normalizeEntity(e: Partial<Entity> & Pick<Entity, 'widget'>, id: string): Entity {
  const out: Entity = {
    id,
    parent: typeof e.parent === 'string' && e.parent !== id ? e.parent : null,
    widget: String(e.widget),
    props: e.props && typeof e.props === 'object' ? cloneJson(e.props) : {},
    transform: normalizeTransform(e.transform),
    visible: e.visible !== false,
  };
  if (e.name != null) out.name = e.name;
  if (e.anchor) out.anchor = cloneJson(e.anchor);
  if (e.tags) out.tags = [...e.tags];
  if (e.interactions) out.interactions = cloneJson(e.interactions);
  if (e.locked) out.locked = true;
  return out;
}

export function entityChanges(a: Entity, b: Entity): EntityChange | null {
  const c: EntityChange = {};
  let any = false;
  if (!deepEqual(a.transform, b.transform)) { c.transform = true; any = true; }
  if (!deepEqual(a.props, b.props)) { c.props = true; any = true; }
  if (a.widget !== b.widget) { c.widget = true; any = true; }
  if (a.parent !== b.parent) { c.parent = true; any = true; }
  if (!deepEqual(a.anchor, b.anchor)) { c.anchor = true; any = true; }
  if (a.visible !== b.visible) { c.visible = true; any = true; }
  if (a.name !== b.name || !deepEqual(a.tags, b.tags) || !deepEqual(a.interactions, b.interactions) || !!a.locked !== !!b.locked) {
    c.meta = true; any = true;
  }
  return any ? c : null;
}

function mergeChange(into: EntityChange, c: EntityChange): void {
  for (const k of Object.keys(c) as (keyof EntityChange)[]) if (c[k]) into[k] = true;
}

export class SceneMirror {
  state: SceneState = { version: 0, entities: {}, links: {}, workspace: '' };
  private children = new Map<string | null, Set<string>>();

  get version(): number {
    return this.state.version;
  }

  entity(id: string): Entity | undefined {
    return this.state.entities[id];
  }

  /** Ids of entities whose declared parent is `id` (null = roots). */
  childrenOf(id: string | null): ReadonlySet<string> {
    return this.children.get(id) ?? EMPTY;
  }

  /** All descendants of `id` (excluding itself), parent-first. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...this.childrenOf(id)];
    const seen = new Set<string>([id]);
    while (stack.length) {
      const c = stack.shift()!;
      if (seen.has(c)) continue; // defensive: cycles in malformed data
      seen.add(c);
      out.push(c);
      for (const g of this.childrenOf(c)) stack.push(g);
    }
    return out;
  }

  // ------------------------------------------------------------------ snapshot

  applySnapshot(scene: SceneState): SceneDiff {
    const diff = emptyDiff();
    const prev = this.state.entities;
    const next: Record<string, Entity> = {};
    for (const [id, e] of Object.entries(scene.entities ?? {})) {
      if (!e || typeof e.widget !== 'string') {
        diff.warnings.push(`snapshot: entity ${id} is malformed`);
        continue;
      }
      next[id] = normalizeEntity(e, id);
    }
    for (const id of Object.keys(prev)) if (!next[id]) diff.removed.push(id);
    for (const [id, e] of Object.entries(next)) {
      const old = prev[id];
      if (!old) diff.added.push(id);
      else {
        const c = entityChanges(old, e);
        if (c) diff.changed.set(id, c);
        else next[id] = old; // keep identity for unchanged entities
      }
    }
    const links: Record<string, Link> = {};
    for (const [id, l] of Object.entries(scene.links ?? {})) links[id] = { ...cloneJson(l), id, enabled: l.enabled !== false };
    diff.linksChanged = !deepEqual(this.state.links, links);
    this.state = { version: scene.version ?? 0, entities: next, links, workspace: scene.workspace ?? '' };
    this.rebuildChildren();
    return diff;
  }

  // ------------------------------------------------------------------ ops

  /**
   * Apply an op batch. `version` (from scene.patch) is recorded; batches whose
   * version is not newer than the current one are ignored (duplicates after a
   * reconnect snapshot). Pass no version for local scenes (mirror studio).
   */
  applyOps(ops: SceneOp[], version?: number): SceneDiff {
    const diff = emptyDiff();
    if (version !== undefined) {
      if (version <= this.state.version) {
        diff.warnings.push(`stale patch v${version} <= v${this.state.version} ignored`);
        return diff;
      }
    }
    const added = new Set<string>();
    const removed = new Set<string>();
    const changed = new Map<string, EntityChange>();
    const ents = this.state.entities;

    const removeEntity = (id: string) => {
      if (!ents[id]) return;
      const ids = [id, ...this.descendants(id)];
      for (const r of ids) {
        const e = ents[r];
        if (!e) continue;
        this.unindex(r, e.parent);
        delete ents[r];
        changed.delete(r);
        if (added.has(r)) added.delete(r);
        else removed.add(r);
      }
      const gone = new Set(ids);
      for (const [lid, l] of Object.entries(this.state.links)) {
        if ((l.from.kind === 'port' && gone.has(l.from.entity)) || (l.to.kind === 'port' && gone.has(l.to.entity))) {
          delete this.state.links[lid];
          diff.linksChanged = true;
        }
      }
    };

    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      switch (op.op) {
        case 'add': {
          if (!op.entity || typeof op.entity.widget !== 'string') {
            diff.warnings.push('add: missing widget');
            break;
          }
          let id = op.entity.id;
          if (!id) {
            id = randomId('local-');
            diff.warnings.push(`add: entity without id got local id ${id}`);
          }
          const e = normalizeEntity(op.entity, id);
          const old = ents[id];
          if (old) {
            // Re-adding an existing id replaces it in place.
            const c = entityChanges(old, e);
            this.unindex(id, old.parent);
            ents[id] = e;
            this.index(id, e.parent);
            if (c && !added.has(id)) mergeChange(this.changeFor(changed, id), c);
          } else {
            ents[id] = e;
            this.index(id, e.parent);
            added.add(id);
          }
          break;
        }
        case 'update': {
          const old = ents[op.id];
          if (!old) {
            diff.warnings.push(`update: unknown entity ${op.id}`);
            break;
          }
          const e = applyPatch(old, op.patch ?? {});
          const c = entityChanges(old, e);
          if (!c) break;
          if (c.parent) {
            if (e.parent && (e.parent === e.id || this.isAncestor(e.id, e.parent))) {
              diff.warnings.push(`update: reparenting ${e.id} under ${e.parent} would create a cycle`);
              e.parent = old.parent;
              delete c.parent;
            } else {
              this.unindex(e.id, old.parent);
              this.index(e.id, e.parent);
            }
          }
          ents[op.id] = e;
          if (!added.has(op.id)) mergeChange(this.changeFor(changed, op.id), c);
          break;
        }
        case 'remove':
          if (!ents[op.id]) diff.warnings.push(`remove: unknown entity ${op.id}`);
          removeEntity(op.id);
          break;
        case 'link.add': {
          const id = op.link.id ?? randomId('local-link-');
          this.state.links[id] = { ...cloneJson(op.link), id, enabled: op.link.enabled !== false } as Link;
          diff.linksChanged = true;
          break;
        }
        case 'link.update': {
          const l = this.state.links[op.id];
          if (!l) {
            diff.warnings.push(`link.update: unknown link ${op.id}`);
            break;
          }
          this.state.links[op.id] = { ...l, ...cloneJson(op.patch), id: op.id };
          diff.linksChanged = true;
          break;
        }
        case 'link.remove':
          if (this.state.links[op.id]) {
            delete this.state.links[op.id];
            diff.linksChanged = true;
          }
          break;
        case 'clear':
          for (const id of Object.keys(ents)) {
            if (ents[id] && ents[id].parent === null) removeEntity(id);
          }
          for (const id of Object.keys(ents)) removeEntity(id); // orphans
          if (Object.keys(this.state.links).length) diff.linksChanged = true;
          this.state.links = {};
          break;
        default:
          diff.warnings.push(`unknown op ${(op as { op?: string }).op}`);
      }
    }
    if (version !== undefined) this.state.version = version;
    diff.added = [...added];
    diff.removed = [...removed];
    for (const [id, c] of changed) if (ents[id] && !added.has(id)) diff.changed.set(id, c);
    return diff;
  }

  /**
   * Optimistically merge props into an entity (widget setProps) without a
   * diff. Returns false if nothing changed or the entity is unknown.
   */
  applyLocalProps(id: string, patch: Record<string, unknown>): boolean {
    const old = this.state.entities[id];
    if (!old) return false;
    const props = { ...old.props, ...cloneJson(patch) };
    if (deepEqual(props, old.props)) return false;
    this.state.entities[id] = { ...old, props };
    return true;
  }

  private isAncestor(ancestor: string, id: string): boolean {
    let cur: string | null = id;
    let guard = 0;
    while (cur && guard++ < 10_000) {
      if (cur === ancestor) return true;
      cur = this.state.entities[cur]?.parent ?? null;
    }
    return false;
  }

  private changeFor(m: Map<string, EntityChange>, id: string): EntityChange {
    let c = m.get(id);
    if (!c) m.set(id, (c = {}));
    return c;
  }

  private index(id: string, parent: string | null): void {
    let s = this.children.get(parent);
    if (!s) this.children.set(parent, (s = new Set()));
    s.add(id);
  }

  private unindex(id: string, parent: string | null): void {
    const s = this.children.get(parent);
    if (!s) return;
    s.delete(id);
    if (!s.size) this.children.delete(parent);
  }

  private rebuildChildren(): void {
    this.children.clear();
    for (const e of Object.values(this.state.entities)) this.index(e.id, e.parent);
  }
}

const EMPTY: ReadonlySet<string> = new Set();

/** Apply an EntityPatch: props shallow-merged, transform field-merged, other fields replaced (null clears optional fields). */
export function applyPatch(old: Entity, patch: EntityPatch): Entity {
  const e: Entity = { ...old };
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (k === 'props' || k === 'transform' || k === 'id') continue;
    const v = p[k];
    if (v === null || v === undefined) {
      if (k === 'parent') e.parent = null;
      else if (k === 'visible') e.visible = true;
      else if (k !== 'widget') delete (e as unknown as Record<string, unknown>)[k];
    } else {
      (e as unknown as Record<string, unknown>)[k] = cloneJson(v);
    }
  }
  if (patch.props) e.props = { ...old.props, ...cloneJson(patch.props) };
  if (patch.transform) e.transform = normalizeTransform({ ...old.transform, ...patch.transform }, old.transform);
  if (typeof e.visible !== 'boolean') e.visible = !!e.visible;
  return e;
}
