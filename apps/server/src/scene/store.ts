// Authoritative scene store.
//
// - apply(ops): validates + applies an op batch atomically (all or nothing),
//   normalizes ops (assigned ids, defaulted props, full entities) so every
//   client applies exactly the same thing, bumps the version once, and records
//   inverse ops for undo.
// - Undo history groups batches that share a `group` id (one grab gesture), or
//   that come from the same interactive source within a short time window.
//   Batches that change nothing are not recorded. Undo is exact: prop keys an
//   edit created are deleted again (internal UNSET_PROPS), which clients learn
//   through onResync (a snapshot), since a patch can't delete keys.
// - The store is synchronous and side-effect free apart from the onPatch /
//   onChange callbacks (broadcast + persistence are wired in app.ts).
import type { Entity, EntityPatch, Link, SceneOp, SceneState, WidgetManifest, Transform, OpSource } from '@evolspace/protocol';
import { IDENTITY_TRANSFORM } from '@evolspace/protocol';
import { shortId } from '../util/ids.ts';
import {
  SceneError, checkAnchor, checkId, checkInteractions, checkLinkTransform, checkPartialTransform, checkPortRefShape,
  checkProps, checkTags, describe, isObj, mergeTransform, propDefaults,
} from './validate.ts';

export { SceneError };

export interface WidgetCatalog {
  /** Latest manifest (last good build) or undefined if never built. */
  manifest(id: string): WidgetManifest | undefined;
  /** True if the widget exists in the library (source present), even if it failed to build. */
  exists(id: string): boolean;
  /** For error messages. */
  ids(): string[];
}

export interface ApplyOptions {
  source: OpSource | string;
  /** Batches sharing a group id are undone together (e.g. one grab gesture). */
  group?: string;
  /** Record in undo history (default true). */
  record?: boolean;
}

export interface ApplyResult {
  version: number;
  /** Ids of added entities/links, in op order. */
  ids: string[];
  /** Normalized ops as broadcast to clients. */
  ops: SceneOp[];
  /** Non-fatal issues (e.g. unknown props). */
  warnings: string[];
}

interface HistoryEntry {
  forward: SceneOp[];
  inverse: SceneOp[];
  source: string;
  group?: string;
  ts: number;
}

export interface SceneStoreOptions {
  catalog: WidgetCatalog;
  /** Called after every applied batch (including undo/redo) with the normalized ops. */
  onPatch?: (version: number, ops: SceneOp[], source: string) => void;
  /** Called after a wholesale replacement (load/new). */
  onReset?: (scene: SceneState) => void;
  /**
   * Called after a change that a `scene.patch` can't express exactly (undo/redo
   * deleting prop keys) or that isn't an op at all (save-as renaming the
   * workspace): clients should be re-sent the full scene (they diff snapshots).
   */
  onResync?: (scene: SceneState) => void;
  /** Called after any change (persistence hook). */
  onChange?: () => void;
  historyLimit?: number;
  /** Batches from interactive sources without a group merge into one undo step within this window. */
  mergeWindowMs?: number;
  now?: () => number;
}

/** Sources whose rapid-fire batches merge into one undo step (time window). */
const MERGEABLE_SOURCES = new Set(['user', 'widget', 'voice']);

interface OpOutcome {
  normalized: SceneOp;
  inverse: SceneOp[];
  addedId?: string;
  /** The op left the scene exactly as it was (e.g. an update to the current values). */
  noop?: boolean;
}

interface Ctx {
  /** Internal ops (undo/redo/rollback): skip catalog checks and default filling; allow UNSET_PROPS. */
  trusted: boolean;
  warnings: string[];
  /** Set when an op deleted prop keys (not expressible in a client patch → resync). */
  resync?: boolean;
}

/**
 * Internal-only patch field used by inverse ops: prop keys to delete. Props
 * that did not exist before an update are deleted on undo (not set to a
 * default/null). Rejected in untrusted (client/agent) batches and never broadcast.
 */
const UNSET_PROPS = '$unsetProps';

const clone = <T>(v: T): T => structuredClone(v);

export class SceneStore {
  private state: SceneState = { version: 0, entities: {}, links: {}, workspace: 'default' };
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly opts: Required<Pick<SceneStoreOptions, 'historyLimit' | 'mergeWindowMs' | 'now'>> & SceneStoreOptions;

  constructor(opts: SceneStoreOptions) {
    this.opts = { historyLimit: 300, mergeWindowMs: 400, now: Date.now, ...opts };
  }

  /** Live scene state. Treat as read-only. */
  get scene(): SceneState { return this.state; }
  get version(): number { return this.state.version; }
  get workspace(): string { return this.state.workspace; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  entity(id: string): Entity | undefined { return this.state.entities[id]; }

  /** Replace the whole scene (workspace load/new). Clears history; the version keeps increasing. */
  reset(content: { entities?: Record<string, Entity>; links?: Record<string, Link> }, workspace: string): SceneState {
    this.state = {
      version: this.state.version + 1,
      entities: clone(content.entities ?? {}),
      links: clone(content.links ?? {}),
      workspace,
    };
    this.undoStack = [];
    this.redoStack = [];
    this.opts.onReset?.(this.state);
    this.opts.onChange?.();
    return this.state;
  }

  /** Rename the current workspace (save-as) without touching content. */
  setWorkspaceName(name: string): void {
    if (name === this.state.workspace) return;
    this.state.workspace = name;
    this.opts.onResync?.(this.state); // clients' SceneState.workspace must not go stale
  }

  apply(ops: SceneOp[], options: ApplyOptions): ApplyResult {
    if (!Array.isArray(ops)) throw new SceneError(`ops must be an array of SceneOp, got ${describe(ops)}`);
    if (ops.length === 0) return { version: this.state.version, ids: [], ops: [], warnings: [] };
    const { outcomes, warnings } = this.applyBatch(ops, { trusted: false, warnings: [] });
    const normalized = outcomes.map((o) => o.normalized);
    const inverse = outcomes.slice().reverse().flatMap((o) => o.inverse);
    // A batch that changed nothing (e.g. re-setting current values) is not an undo step
    // (and must not clear the redo stack).
    const changed = outcomes.some((o) => !o.noop);
    if (options.record !== false && changed) this.record({ forward: normalized, inverse, source: options.source, group: options.group, ts: this.opts.now() });
    this.commit(normalized, options.source);
    return {
      version: this.state.version,
      ids: outcomes.filter((o) => o.addedId !== undefined).map((o) => o.addedId!),
      ops: normalized,
      warnings,
    };
  }

  /**
   * Undo the latest step. History is linear and every mutation is recorded, so
   * inverses should always apply; if one doesn't (a bug, or a reset racing a
   * client), the scene is left untouched (batches are atomic), the history is
   * cleared rather than left inconsistent, and the reason is returned.
   */
  undo(): { version: number; ok: boolean; error?: string } {
    const entry = this.undoStack.pop();
    if (!entry) return { version: this.state.version, ok: false };
    try {
      const ctx: Ctx = { trusted: true, warnings: [] };
      const { outcomes } = this.applyBatch(entry.inverse, ctx);
      this.redoStack.push(entry);
      this.commit(outcomes.map((o) => o.normalized), 'undo', ctx.resync);
      return { version: this.state.version, ok: true };
    } catch (e) {
      return this.historyBroken('undo', e);
    }
  }

  redo(): { version: number; ok: boolean; error?: string } {
    const entry = this.redoStack.pop();
    if (!entry) return { version: this.state.version, ok: false };
    try {
      const ctx: Ctx = { trusted: true, warnings: [] };
      const { outcomes } = this.applyBatch(entry.forward, ctx);
      this.undoStack.push({ ...entry, ts: 0 }); // ts 0: never merge new edits into a redone step
      this.commit(outcomes.map((o) => o.normalized), 'redo', ctx.resync);
      return { version: this.state.version, ok: true };
    } catch (e) {
      return this.historyBroken('redo', e);
    }
  }

  private historyBroken(what: string, e: unknown): { version: number; ok: false; error: string } {
    this.undoStack = [];
    this.redoStack = [];
    return { version: this.state.version, ok: false, error: `${what} failed and the undo history was cleared: ${(e as Error).message}` };
  }

  /** Ids of `id` and all its descendants, parents before children. */
  subtree(id: string): string[] {
    const children = this.childIndex();
    const out: string[] = [];
    const walk = (e: string) => { out.push(e); for (const c of children.get(e) ?? []) walk(c); };
    if (this.state.entities[id]) walk(id);
    return out;
  }

  // ------------------------------------------------------------------ internals

  private commit(ops: SceneOp[], source: string, resync = false): void {
    this.state.version++;
    this.opts.onPatch?.(this.state.version, ops, source);
    if (resync) this.opts.onResync?.(this.state);
    this.opts.onChange?.();
  }

  private record(entry: HistoryEntry): void {
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    const sameGroup = !!entry.group && top?.group === entry.group && top.source === entry.source;
    const sameBurst = !entry.group && !!top && !top.group && top.source === entry.source
      && MERGEABLE_SOURCES.has(entry.source) && entry.ts - top.ts <= this.opts.mergeWindowMs;
    if (top && (sameGroup || sameBurst)) {
      top.forward.push(...entry.forward);
      top.inverse = [...entry.inverse, ...top.inverse];
      top.ts = entry.ts;
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.opts.historyLimit) this.undoStack.splice(0, this.undoStack.length - this.opts.historyLimit);
  }

  /** Apply ops in order; on any failure roll back what was applied and rethrow with the op index. */
  private applyBatch(ops: SceneOp[], ctx: Ctx): { outcomes: OpOutcome[]; warnings: string[] } {
    const outcomes: OpOutcome[] = [];
    try {
      ops.forEach((op, i) => {
        try {
          outcomes.push(this.applyOne(op, ctx));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new SceneError(ops.length > 1 ? `op[${i}] (${describe((op as { op?: unknown })?.op)}): ${msg}` : msg, i);
        }
      });
    } catch (e) {
      for (const o of outcomes.slice().reverse()) {
        for (const inv of o.inverse) this.applyOne(inv, { trusted: true, warnings: [] });
      }
      throw e;
    }
    return { outcomes, warnings: ctx.warnings };
  }

  private applyOne(op: SceneOp, ctx: Ctx): OpOutcome {
    if (!isObj(op)) throw new SceneError(`op must be an object, got ${describe(op)}`);
    switch (op.op) {
      case 'add': return this.opAdd(op.entity, ctx);
      case 'update': return this.opUpdate(op.id, op.patch, ctx);
      case 'remove': return this.opRemove(op.id);
      case 'link.add': return this.opLinkAdd(op.link, ctx);
      case 'link.update': return this.opLinkUpdate(op.id, op.patch, ctx);
      case 'link.remove': return this.opLinkRemove(op.id);
      case 'clear': return this.opClear();
      default:
        throw new SceneError(`unknown op ${describe((op as { op?: unknown }).op)} (expected add, update, remove, link.add, link.update, link.remove, clear)`);
    }
  }

  private checkWidget(widget: unknown, ctx: Ctx): string {
    if (typeof widget !== 'string' || !widget) throw new SceneError(`entity.widget must be a widget id, got ${describe(widget)}`);
    if (!ctx.trusted && !this.opts.catalog.exists(widget)) {
      const ids = this.opts.catalog.ids();
      throw new SceneError(`unknown widget '${widget}'${ids.length ? ` (available: ${ids.join(', ')})` : ' (the widget library is empty)'}`);
    }
    return widget;
  }

  private checkProps(widget: string, props: Record<string, unknown>, ctx: Ctx, entityId: string): void {
    if (ctx.trusted) return;
    const r = checkProps(this.opts.catalog.manifest(widget), widget, props);
    if (r.errors.length) throw new SceneError(`entity '${entityId}': ${r.errors.join('; ')}`);
    for (const w of r.warnings) ctx.warnings.push(`entity '${entityId}': ${w}`);
  }

  private opAdd(input: unknown, ctx: Ctx): OpOutcome {
    if (!isObj(input)) throw new SceneError(`add.entity must be an object with at least {widget}, got ${describe(input)}`);
    const widget = this.checkWidget(input.widget, ctx);
    let id: string;
    if (input.id !== undefined) {
      id = checkId(input.id, 'entity.id');
      if (this.state.entities[id]) throw new SceneError(`entity id '${id}' already exists (omit id to have one generated)`);
    } else {
      id = shortId('e', (x) => x in this.state.entities);
    }
    const parent = input.parent ?? null;
    if (parent !== null) {
      if (typeof parent !== 'string' || !this.state.entities[parent]) throw new SceneError(`parent '${String(parent)}' does not exist`);
    }
    const userProps = input.props === undefined ? {} : input.props;
    if (!isObj(userProps)) throw new SceneError(`entity.props must be an object, got ${describe(userProps)}`);
    this.checkProps(widget, userProps, ctx, id);
    const transform = mergeTransform(IDENTITY_TRANSFORM, checkPartialTransform(input.transform, 'entity.transform'));
    const entity: Entity = {
      id,
      parent,
      widget,
      props: { ...propDefaults(this.opts.catalog.manifest(widget)), ...clone(userProps) },
      transform,
      visible: input.visible === undefined ? true : !!input.visible,
    };
    if (input.name !== undefined && input.name !== null) {
      if (typeof input.name !== 'string') throw new SceneError(`entity.name must be a string`);
      entity.name = input.name;
    }
    if (input.anchor != null) entity.anchor = checkAnchor(input.anchor);
    if (input.tags != null) entity.tags = [...checkTags(input.tags)];
    if (input.interactions != null) entity.interactions = clone(checkInteractions(input.interactions));
    if (input.locked != null) entity.locked = !!input.locked;
    for (const k of Object.keys(input)) {
      if (!ENTITY_KEYS.has(k)) ctx.warnings.push(`entity '${id}': ignored unknown field '${k}'`);
    }
    this.state.entities[id] = entity;
    return { normalized: { op: 'add', entity: clone(entity) }, inverse: [{ op: 'remove', id }], addedId: id };
  }

  private opUpdate(id: unknown, patch: unknown, ctx: Ctx): OpOutcome {
    if (typeof id !== 'string' || !this.state.entities[id]) throw new SceneError(`entity '${String(id)}' does not exist`);
    if (!isObj(patch)) throw new SceneError(`update.patch must be an object, got ${describe(patch)}`);
    const e = this.state.entities[id];
    const prev: Record<string, unknown> = {};
    const norm: Record<string, unknown> = {};
    const next: Entity = { ...e, props: { ...e.props }, transform: e.transform };
    /** Prop keys this update creates: the inverse deletes them (exact undo). */
    const created = new Set<string>();

    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'widget': {
          const w = this.checkWidget(value, ctx);
          if (w !== e.widget) {
            prev.widget = e.widget;
            next.widget = w;
            norm.widget = w;
            // Fill defaults for the new widget's props that aren't set yet. Not for
            // internal ops: redo carries the filled defaults explicitly, and undo
            // must restore the previous props exactly.
            if (!ctx.trusted) {
              const defs = propDefaults(this.opts.catalog.manifest(w));
              const added: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(defs)) if (!(k in next.props)) { next.props[k] = v; added[k] = v; created.add(k); }
              if (Object.keys(added).length) norm.props = { ...(norm.props as object | undefined), ...added };
            }
          }
          break;
        }
        case 'parent': {
          const p = value ?? null;
          if (p !== null) {
            if (typeof p !== 'string' || !this.state.entities[p]) throw new SceneError(`parent '${String(p)}' does not exist`);
            if (this.subtree(id).includes(p)) throw new SceneError(`cannot parent '${id}' to '${p}': that would create a cycle`);
          }
          prev.parent = e.parent;
          next.parent = p as string | null;
          norm.parent = p;
          break;
        }
        case 'props':
          break; // handled after widget so defaults/validation use the final widget
        case UNSET_PROPS:
          if (!ctx.trusted) throw new SceneError(`patch has unknown field '${key}' (allowed: props, transform, parent, name, visible, anchor, tags, interactions, locked, widget)`);
          break; // handled after props
        case 'transform': {
          const t = checkPartialTransform(value, 'patch.transform');
          prev.transform = clone(e.transform);
          next.transform = mergeTransform(e.transform, t);
          // Broadcast the normalized quaternion so clients hold exactly the server's state.
          norm.transform = { ...clone(t), ...(t.rotation ? { rotation: [...next.transform.rotation] } : {}) };
          break;
        }
        case 'visible':
          if (typeof value !== 'boolean') throw new SceneError(`patch.visible must be a boolean`);
          prev.visible = e.visible; next.visible = value; norm.visible = value;
          break;
        case 'name':
          if (value !== null && typeof value !== 'string') throw new SceneError(`patch.name must be a string (or null to clear)`);
          prev.name = e.name ?? null; setOpt(next, 'name', value); norm.name = value;
          break;
        case 'anchor':
          prev.anchor = e.anchor ?? null; setOpt(next, 'anchor', value === null ? null : checkAnchor(value)); norm.anchor = value;
          break;
        case 'tags':
          prev.tags = e.tags ?? null; setOpt(next, 'tags', value === null ? null : [...checkTags(value)]); norm.tags = value;
          break;
        case 'interactions':
          prev.interactions = e.interactions ?? null; setOpt(next, 'interactions', value === null ? null : clone(checkInteractions(value))); norm.interactions = value;
          break;
        case 'locked':
          if (value !== null && typeof value !== 'boolean') throw new SceneError(`patch.locked must be a boolean`);
          prev.locked = e.locked ?? null; setOpt(next, 'locked', value); norm.locked = value;
          break;
        default:
          throw new SceneError(`patch has unknown field '${key}' (allowed: props, transform, parent, name, visible, anchor, tags, interactions, locked, widget)`);
      }
    }

    const prevProps: Record<string, unknown> = {};
    if (patch.props !== undefined) {
      if (!isObj(patch.props)) throw new SceneError(`patch.props must be an object, got ${describe(patch.props)}`);
      this.checkProps(next.widget, patch.props, ctx, id);
      for (const [k, v] of Object.entries(patch.props)) {
        // Absent before → the inverse deletes the key (exact undo, not a default/null).
        if (k in e.props) prevProps[k] = clone(e.props[k]);
        else created.add(k);
        next.props[k] = clone(v);
      }
      norm.props = { ...(norm.props as object | undefined), ...clone(patch.props) };
    }

    // Internal (inverse) deletion of prop keys. A scene.patch can't express "delete
    // key", so the store asks for a client resync (snapshot) after the batch.
    const unset = (patch as Record<string, unknown>)[UNSET_PROPS];
    const deleted: Record<string, unknown> = {};
    if (ctx.trusted && Array.isArray(unset)) {
      for (const k of unset) {
        if (typeof k !== 'string' || !(k in next.props)) continue;
        if (k in e.props) deleted[k] = clone(e.props[k]);
        delete next.props[k];
        if (norm.props) delete (norm.props as Record<string, unknown>)[k];
        created.delete(k);
        ctx.resync = true;
      }
      if (norm.props && Object.keys(norm.props).length === 0) delete norm.props;
    }

    Object.assign(prevProps, deleted); // inverse of a deletion restores the value (rollback of an undo)
    if (Object.keys(prevProps).length) prev.props = prevProps;
    if (created.size) prev[UNSET_PROPS] = [...created];

    // Compare only what the patch touched (props may hold large arrays).
    const touchedProps = isObj(patch.props) ? Object.keys(patch.props) : [];
    const noop = created.size === 0 && Object.keys(deleted).length === 0
      && Object.keys(patch).every((k) => k === 'props' || k === UNSET_PROPS
        || sameJson((e as unknown as Record<string, unknown>)[k], (next as unknown as Record<string, unknown>)[k]))
      && touchedProps.every((k) => sameJson(e.props[k], next.props[k]));

    this.state.entities[id] = next;
    return {
      normalized: { op: 'update', id, patch: norm as EntityPatch },
      inverse: [{ op: 'update', id, patch: prev as EntityPatch }],
      noop,
    };
  }

  private opRemove(id: unknown): OpOutcome {
    if (typeof id !== 'string' || !this.state.entities[id]) throw new SceneError(`entity '${String(id)}' does not exist`);
    const ids = this.subtree(id);
    const idSet = new Set(ids);
    const removedEntities = ids.map((x) => this.state.entities[x]);
    const removedLinks = Object.values(this.state.links).filter((l) => touches(l, idSet));
    for (const x of ids) delete this.state.entities[x];
    for (const l of removedLinks) delete this.state.links[l.id];
    return {
      normalized: { op: 'remove', id },
      inverse: [
        ...removedEntities.map((entity): SceneOp => ({ op: 'add', entity: clone(entity) })),
        ...removedLinks.map((link): SceneOp => ({ op: 'link.add', link: clone(link) })),
      ],
    };
  }

  private checkPortRef(ref: unknown, what: 'from' | 'to', ctx: Ctx) {
    const p = checkPortRefShape(ref, `link.${what}`);
    if (p.kind === 'port') {
      const e = this.state.entities[p.entity];
      if (!e) throw new SceneError(`link.${what}: entity '${p.entity}' does not exist`);
      const m = this.opts.catalog.manifest(e.widget);
      if (!ctx.trusted && m?.hash) {
        const ports = what === 'from' ? m.outputs : m.inputs;
        if (!(p.port in (ports ?? {}))) {
          const kind = what === 'from' ? 'output' : 'input';
          const names = Object.keys(ports ?? {});
          throw new SceneError(`link.${what}: widget '${e.widget}' (entity '${p.entity}') has no ${kind} port '${p.port}'${names.length ? ` (${kind}s: ${names.join(', ')})` : ` (it has no ${kind}s)`}`);
        }
      }
    }
    return p;
  }

  private opLinkAdd(input: unknown, ctx: Ctx): OpOutcome {
    if (!isObj(input)) throw new SceneError(`link.add.link must be an object {from, to, transform?}, got ${describe(input)}`);
    let id: string;
    if (input.id !== undefined) {
      id = checkId(input.id, 'link.id');
      if (this.state.links[id]) throw new SceneError(`link id '${id}' already exists`);
    } else {
      id = shortId('l', (x) => x in this.state.links);
    }
    const from = this.checkPortRef(input.from, 'from', ctx);
    const to = this.checkPortRef(input.to, 'to', ctx);
    if (from.kind === 'channel' && to.kind === 'channel') throw new SceneError(`a link needs at least one port end; channel→channel links are not supported`);
    const link: Link = { id, from, to, enabled: input.enabled === undefined ? true : !!input.enabled };
    const transform = checkLinkTransform(input.transform);
    if (transform) link.transform = transform;
    this.state.links[id] = link;
    return { normalized: { op: 'link.add', link: clone(link) }, inverse: [{ op: 'link.remove', id }], addedId: id };
  }

  private opLinkUpdate(id: unknown, patch: unknown, ctx: Ctx): OpOutcome {
    if (typeof id !== 'string' || !this.state.links[id]) throw new SceneError(`link '${String(id)}' does not exist`);
    if (!isObj(patch)) throw new SceneError(`link.update.patch must be an object`);
    const l = this.state.links[id];
    const next: Link = { ...l };
    const prev: Record<string, unknown> = {};
    const norm: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'from': case 'to':
          prev[key] = clone(l[key]); next[key] = this.checkPortRef(value, key, ctx); norm[key] = clone(next[key]); break;
        case 'enabled':
          if (typeof value !== 'boolean') throw new SceneError(`link patch.enabled must be a boolean`);
          prev.enabled = l.enabled; next.enabled = value; norm.enabled = value; break;
        case 'transform': {
          prev.transform = l.transform ?? null;
          const t = checkLinkTransform(value);
          if (t) next.transform = t; else delete next.transform;
          norm.transform = t ?? null; // null = cleared (clients treat a falsy transform as identity)
          break;
        }
        default:
          throw new SceneError(`link patch has unknown field '${key}' (allowed: from, to, transform, enabled)`);
      }
    }
    if (!ctx.trusted && next.from.kind === 'channel' && next.to.kind === 'channel') throw new SceneError(`a link needs at least one port end; channel→channel links are not supported`);
    this.state.links[id] = next;
    return {
      normalized: { op: 'link.update', id, patch: norm as Partial<Omit<Link, 'id'>> },
      inverse: [{ op: 'link.update', id, patch: prev as Partial<Omit<Link, 'id'>> }],
      noop: sameJson(l, next),
    };
  }

  private opLinkRemove(id: unknown): OpOutcome {
    if (typeof id !== 'string' || !this.state.links[id]) throw new SceneError(`link '${String(id)}' does not exist`);
    const link = this.state.links[id];
    delete this.state.links[id];
    return { normalized: { op: 'link.remove', id }, inverse: [{ op: 'link.add', link: clone(link) }] };
  }

  private opClear(): OpOutcome {
    const noop = Object.keys(this.state.entities).length === 0 && Object.keys(this.state.links).length === 0;
    const order: string[] = [];
    const children = this.childIndex();
    const walk = (id: string) => { order.push(id); for (const c of children.get(id) ?? []) walk(c); };
    for (const e of Object.values(this.state.entities)) if (e.parent === null || !this.state.entities[e.parent]) walk(e.id);
    const inverse: SceneOp[] = [
      ...order.map((id): SceneOp => ({ op: 'add', entity: clone(this.state.entities[id]) })),
      ...Object.values(this.state.links).map((link): SceneOp => ({ op: 'link.add', link: clone(link) })),
    ];
    this.state.entities = {};
    this.state.links = {};
    return { normalized: { op: 'clear' }, inverse, noop };
  }

  private childIndex(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const e of Object.values(this.state.entities)) {
      if (e.parent === null) continue;
      const list = m.get(e.parent);
      if (list) list.push(e.id); else m.set(e.parent, [e.id]);
    }
    return m;
  }
}

const ENTITY_KEYS = new Set(['id', 'parent', 'name', 'widget', 'props', 'transform', 'visible', 'anchor', 'tags', 'interactions', 'locked']);

/** Optional entity fields: null (or undefined) deletes the key. */
function setOpt<K extends 'name' | 'anchor' | 'tags' | 'interactions' | 'locked'>(e: Entity, key: K, value: unknown): void {
  if (value === null || value === undefined) delete e[key];
  else (e as unknown as Record<string, unknown>)[key] = value;
}

/** Structural equality of JSON-like values (key order insensitive; undefined-valued keys count as absent). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => bo[k] !== undefined && sameJson(ao[k], bo[k]));
}

function touches(l: Link, ids: Set<string>): boolean {
  return (l.from.kind === 'port' && ids.has(l.from.entity)) || (l.to.kind === 'port' && ids.has(l.to.entity));
}

export type { Transform };
