// Outgoing scene edits from widgets (setProps, spawnChild, ChildHandle) and
// other local sources.
//
// - Optimistic: every edit is applied locally right away (via `applyLocal`).
// - Throttled: `update` patches are merged per entity and sent at most every
//   `intervalMs` (leading + trailing edge), so a widget calling setProps every
//   frame produces ~10 ops/s, not 90.
// - Echo-safe: fields edited locally are "owned" for `ownMs` after the last
//   send. Incoming server ops touching owned fields are stripped of them
//   (`filterIncoming`), so delayed echoes of intermediate values can't make a
//   dragged slider jump back.

import type { Entity, EntityPatch, SceneOp } from '@evolspace/protocol';
import type { NetPort } from '../net/types.ts';
import { cloneJson } from '../util/equal.ts';
import { now as nowMs } from '../util/rate.ts';

type Source = 'user' | 'widget';

interface PendingUpdate {
  patch: EntityPatch;
  source: Source;
}

export interface SceneWriterOptions {
  intervalMs?: number;
  ownMs?: number;
}

export class SceneWriter {
  private pending = new Map<string, PendingUpdate>();
  private lastSent = new Map<string, number>();
  /** entity → field ("transform" | "props.<key>") → owned-until (ms). */
  private owned = new Map<string, Map<string, number>>();
  private readonly intervalMs: number;
  private readonly ownMs: number;

  constructor(
    private net: Pick<NetPort, 'send'>,
    private applyLocal: (ops: SceneOp[]) => void,
    opts: SceneWriterOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 100;
    this.ownMs = opts.ownMs ?? 1200;
  }

  add(entity: Partial<Entity> & Pick<Entity, 'id' | 'widget'>, source: Source = 'widget'): void {
    this.flushAll();
    const op: SceneOp = { op: 'add', entity: cloneJson(entity) };
    this.applyLocal([op]);
    this.net.send({ type: 'scene.ops', ops: [op], source });
  }

  remove(id: string, source: Source = 'widget'): void {
    this.pending.delete(id);
    this.owned.delete(id);
    const op: SceneOp = { op: 'remove', id };
    this.applyLocal([op]);
    this.net.send({ type: 'scene.ops', ops: [op], source });
  }

  /** The entity is gone (removed by anyone): drop pending edits and bookkeeping. */
  forget(id: string): void {
    this.pending.delete(id);
    this.lastSent.delete(id);
    this.owned.delete(id);
  }

  /** Merge a patch for `id`; applied locally now, sent throttled. */
  update(id: string, patch: EntityPatch, source: Source = 'widget', t = nowMs()): void {
    const p = cloneJson(patch);
    this.applyLocal([{ op: 'update', id, patch: p }]);
    this.own(id, p, t);
    const cur = this.pending.get(id);
    if (cur) mergePatch(cur.patch, p);
    else this.pending.set(id, { patch: p, source });
    const last = this.lastSent.get(id) ?? -Infinity;
    if (t - last >= this.intervalMs) this.flushOne(id, t);
  }

  /** Send due trailing updates. Call once per frame. */
  flush(t = nowMs()): void {
    if (!this.pending.size) return;
    const due: SceneOp[] = [];
    let source: Source = 'widget';
    for (const [id, p] of this.pending) {
      if (t - (this.lastSent.get(id) ?? -Infinity) < this.intervalMs) continue;
      due.push({ op: 'update', id, patch: p.patch });
      source = p.source;
      this.pending.delete(id);
      this.lastSent.set(id, t);
      this.own(id, p.patch, t);
    }
    if (due.length) this.net.send({ type: 'scene.ops', ops: due, source });
  }

  /** Send everything pending now (before adds/removes, to keep op order). */
  flushAll(t = nowMs()): void {
    for (const id of [...this.pending.keys()]) this.flushOne(id, t);
  }

  private flushOne(id: string, t: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.lastSent.set(id, t);
    this.own(id, p.patch, t);
    this.net.send({ type: 'scene.ops', ops: [{ op: 'update', id, patch: p.patch }], source: p.source });
  }

  private own(id: string, patch: EntityPatch, t: number): void {
    let m = this.owned.get(id);
    if (!m) this.owned.set(id, (m = new Map()));
    const until = t + this.ownMs;
    if (patch.transform) m.set('transform', until);
    if (patch.props) for (const k of Object.keys(patch.props)) m.set('props.' + k, until);
  }

  /** Strip locally-owned fields from incoming server ops (see header). */
  filterIncoming(ops: SceneOp[], current: (id: string) => Entity | undefined, t = nowMs()): SceneOp[] {
    if (!this.owned.size) return ops;
    let out: SceneOp[] | null = null;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const id = op.op === 'update' ? op.id : op.op === 'add' ? op.entity.id : undefined;
      const owned = id ? this.liveOwned(id, t) : null;
      if (!owned) {
        out?.push(op);
        continue;
      }
      if (!out) out = ops.slice(0, i);
      if (op.op === 'update') {
        const patch = { ...op.patch } as EntityPatch;
        if (patch.transform && owned.has('transform')) delete patch.transform;
        if (patch.props) {
          const props = { ...patch.props };
          for (const k of Object.keys(props)) if (owned.has('props.' + k)) delete props[k];
          if (Object.keys(props).length) patch.props = props;
          else delete patch.props;
        }
        if (Object.keys(patch).length) out.push({ op: 'update', id: op.id, patch });
      } else if (op.op === 'add') {
        const local = current(op.entity.id!);
        if (!local) {
          out.push(op);
          continue;
        }
        const entity = { ...op.entity, props: { ...(op.entity.props ?? {}) } };
        if (owned.has('transform')) entity.transform = cloneJson(local.transform);
        for (const f of owned) if (f.startsWith('props.')) {
          const k = f.slice(6);
          if (k in local.props) entity.props[k] = cloneJson(local.props[k]);
        }
        out.push({ op: 'add', entity });
      }
    }
    return out ?? ops;
  }

  private liveOwned(id: string, t: number): Set<string> | null {
    const m = this.owned.get(id);
    if (!m) return null;
    let live: Set<string> | null = null;
    for (const [f, until] of m) {
      if (until <= t && !this.pending.has(id)) m.delete(f);
      else (live ??= new Set()).add(f);
    }
    if (!m.size) this.owned.delete(id);
    return live;
  }
}

function mergePatch(into: EntityPatch, p: EntityPatch): void {
  for (const k of Object.keys(p) as (keyof EntityPatch)[]) {
    if (k === 'props') into.props = { ...(into.props ?? {}), ...p.props };
    else if (k === 'transform') into.transform = { ...(into.transform ?? {}), ...p.transform };
    else (into as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k];
  }
}
