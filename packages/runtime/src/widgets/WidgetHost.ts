// Widget host: owns one WidgetRecord per entity and drives the widget
// lifecycle (load → create → update/onProps/onInput/onInteraction → dispose).
//
// - Bundles load via dynamic import(manifest.url) with the content hash in the
//   query string (cache-busting); definitions are cached per (widget, hash).
// - Props are defaulted/validated against the manifest before create/onProps.
// - Hot reload: a new hash re-creates only that widget's instances. The new
//   instance is built in a hidden group and swapped in when ready (no flicker).
// - Isolation: every call into widget code is guarded; a throw disposes that
//   instance and shows a wireframe fallback with the error, reported to the
//   server as client.error (deduplicated). Other widgets are unaffected.

import * as THREE from 'three';
import type { Entity, InteractionEvent, Theme, UserView, WidgetDefinition, WidgetInstance, WidgetManifest } from '@evolspace/protocol';
import type { ChannelHub } from '../data/ChannelHub.ts';
import type { LinkEngine } from '../links/LinkEngine.ts';
import type { NetPort } from '../net/types.ts';
import type { EntityChange, SceneMirror } from '../scene/SceneMirror.ts';
import type { EntityNode } from '../scene/Reconciler.ts';
import type { SceneWriter } from '../scene/SceneWriter.ts';
import type { RuntimeUiKit } from '../ui/UiKit.ts';
import { deepEqual } from '../util/equal.ts';
import { Deduper } from '../util/rate.ts';
import { createWidgetContext, formatArgs, InstanceState, type ContextEnv } from './context.ts';
import { createFallback } from './fallback.ts';
import { disposeSubtree } from './dispose.ts';
import { resolveProps } from './props.ts';
import { effectivelyVisible } from '../util/object.ts';

export type ModuleLoader = (url: string) => Promise<unknown>;

export type WidgetStatus = 'pending' | 'loading' | 'ready' | 'error' | 'missing';

export interface WidgetRecord {
  readonly entityId: string;
  widgetId: string;
  node: EntityNode;
  status: WidgetStatus;
  error: string | null;
  instance: WidgetInstance | null;
  state: InstanceState | null;
  /** ctx.root of the live instance. */
  content: THREE.Group | null;
  fallback: THREE.Object3D | null;
  /** Values received on input ports (persist across re-creates). */
  inputs: Map<string, unknown>;
  /** Bumped on every (re)instantiation/removal; stale async work checks it. */
  generation: number;
}

export interface WidgetHostDeps {
  ui: RuntimeUiKit;
  theme: Theme;
  net: NetPort;
  channels: ChannelHub;
  links: LinkEngine;
  writer: SceneWriter;
  mirror: SceneMirror;
  user: UserView;
  isMirror: boolean;
  /** Defaults to native dynamic import. */
  loadModule?: ModuleLoader;
  /** Base URL that manifest.url is resolved against (the server's HTTP origin). */
  baseUrl?: string;
  /** User-visible error hook (toasts). */
  onError?: (message: string, info: { entity?: string; widget?: string }) => void;
  /** Content of an entity changed (bounds caches should refresh). */
  onContentChanged?: (entity: string) => void;
}

interface CachedDefinition {
  hash: string;
  promise: Promise<WidgetDefinition>;
}

const nativeImport: ModuleLoader = (url) => import(/* @vite-ignore */ url);

export class WidgetHost {
  private records = new Map<string, WidgetRecord>();
  private manifests = new Map<string, WidgetManifest>();
  private definitions = new Map<string, CachedDefinition>();
  private catalogLoaded = false;
  private pending = new Set<Promise<void>>();
  private errors = new Deduper(15_000);
  private readonly env: ContextEnv;
  private readonly loadModule: ModuleLoader;

  constructor(private deps: WidgetHostDeps) {
    this.loadModule = deps.loadModule ?? nativeImport;
    this.env = {
      theme: deps.theme,
      ui: deps.ui,
      net: deps.net,
      channels: deps.channels,
      links: deps.links,
      writer: deps.writer,
      user: deps.user,
      isMirror: deps.isMirror,
      input: (entity, port) => this.inputValue(entity, port),
      reportError: (entity, widget, message, detail, fromWidget) => {
        this.report(message, { entity, widget, detail, fromWidget });
      },
    };
  }

  // ------------------------------------------------------------------ catalog

  manifest(widget: string): WidgetManifest | undefined {
    return this.manifests.get(widget);
  }

  get catalog(): WidgetManifest[] {
    return [...this.manifests.values()];
  }

  setCatalog(list: WidgetManifest[]): void {
    this.catalogLoaded = true;
    const changed = new Set<string>();
    // Widgets deleted from the library: forget them. Running instances keep
    // their loaded code; a later re-create reports them as missing.
    const ids = new Set(list.map((m) => m.id));
    for (const id of [...this.manifests.keys()]) {
      if (!ids.has(id)) {
        this.manifests.delete(id);
        this.definitions.delete(id);
      }
    }
    for (const m of list) {
      const old = this.manifests.get(m.id);
      this.manifests.set(m.id, m);
      if (!old || old.hash !== m.hash) changed.add(m.id);
    }
    for (const rec of this.records.values()) {
      // New/changed bundles, entities waiting for the first catalog, and
      // missing widgets that may now exist.
      if (changed.has(rec.widgetId) || rec.status === 'pending' || (rec.status === 'missing' && this.manifests.has(rec.widgetId))) {
        this.instantiate(rec);
      }
    }
  }

  /** widgets.updated: re-import and re-create only this widget's instances. */
  updateManifest(m: WidgetManifest): void {
    const old = this.manifests.get(m.id);
    this.manifests.set(m.id, m);
    if (old && old.hash === m.hash && !m.error) return;
    if (old && old.hash === m.hash && m.error) {
      // Build failed; the last good bundle is still served. Tell the user once.
      this.report(`widget '${m.id}' failed to build (still running the last good version): ${m.error}`, { widget: m.id });
      return;
    }
    this.definitions.delete(m.id);
    for (const rec of this.records.values()) if (rec.widgetId === m.id) this.instantiate(rec);
  }

  // ------------------------------------------------------------------ reconciler hooks

  onAdded(e: Entity, node: EntityNode): void {
    const rec: WidgetRecord = {
      entityId: e.id,
      widgetId: e.widget,
      node,
      status: 'pending',
      error: null,
      instance: null,
      state: null,
      content: null,
      fallback: null,
      inputs: new Map(),
      generation: 0,
    };
    this.records.set(e.id, rec);
    this.instantiate(rec);
  }

  onRemoved(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.generation++;
    this.teardown(rec);
    this.records.delete(id);
    this.deps.links.forgetEntity(id);
  }

  onChanged(e: Entity, change: EntityChange, node: EntityNode): void {
    const rec = this.records.get(e.id);
    if (!rec) return;
    rec.node = node;
    if (change.widget) {
      rec.widgetId = e.widget;
      this.instantiate(rec);
      return;
    }
    if (!change.props) return;
    if (rec.status !== 'ready' || !rec.instance || !rec.state) {
      // A broken widget gets another chance when its props change (the agent
      // is probably fixing the props that broke it).
      if (rec.status === 'error') this.instantiate(rec);
      return;
    }
    const m = this.manifests.get(rec.widgetId);
    const { props, issues } = resolveProps(m?.props, e.props);
    this.reportPropIssues(rec, issues);
    if (deepEqual(props, rec.state.props)) return;
    const inst = rec.instance;
    if (typeof inst.onProps === 'function') {
      const prev = { ...rec.state.props };
      const live = rec.state.props;
      for (const k of Object.keys(live)) if (!(k in props)) delete live[k];
      Object.assign(live, props);
      this.guard(rec, 'onProps', () => inst.onProps!(live, prev));
      this.deps.onContentChanged?.(rec.entityId);
    } else {
      this.instantiate(rec);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  private instantiate(rec: WidgetRecord): void {
    const p = this.doInstantiate(rec).catch((err) => {
      this.fail(rec, rec.generation, `widget host error: ${(err as Error)?.message ?? err}`, err);
    });
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  private async doInstantiate(rec: WidgetRecord): Promise<void> {
    const gen = ++rec.generation;
    const m = this.manifests.get(rec.widgetId);
    if (!m) {
      if (!this.catalogLoaded) {
        rec.status = 'pending';
        return;
      }
      this.teardown(rec);
      this.showFallback(rec, `unknown widget '${rec.widgetId}'`, undefined);
      rec.status = 'missing';
      rec.error = `unknown widget '${rec.widgetId}' (not in the widget catalog)`;
      this.report(`entity ${rec.entityId}: unknown widget '${rec.widgetId}'`, { entity: rec.entityId, widget: rec.widgetId });
      return;
    }
    if (!m.url) {
      // The server lists widgets whose first build failed with an empty url/hash.
      this.fail(rec, gen, `widget '${m.id}' has no successful build${m.error ? `: ${m.error}` : ''}`);
      return;
    }
    if (rec.status !== 'ready') rec.status = 'loading';

    let def: WidgetDefinition;
    try {
      def = await this.definition(m);
    } catch (err) {
      if (gen !== rec.generation) return;
      this.fail(rec, gen, `failed to load widget '${m.id}': ${(err as Error)?.message ?? err}`, err);
      return;
    }
    if (gen !== rec.generation) return;
    const entity = this.deps.mirror.entity(rec.entityId);
    if (!entity) return;

    const rawProps = entity.props; // entities are replaced immutably on change
    const { props, issues } = resolveProps(m.props, rawProps);
    this.reportPropIssues(rec, issues);
    const content = new THREE.Group();
    content.name = `widget:${m.id}`;
    content.userData.widgetContent = rec.entityId;
    const swapping = !!rec.content || !!rec.fallback;
    if (swapping) content.visible = false;
    rec.node.object.add(content);
    const state = new InstanceState(props);
    const ctx = createWidgetContext(this.env, rec.entityId, m, content, state);

    let inst: WidgetInstance;
    try {
      inst = await def.create(ctx);
      if (!inst || typeof inst !== 'object') inst = {};
    } catch (err) {
      state.release();
      content.removeFromParent();
      disposeSubtree(content);
      if (gen !== rec.generation) return;
      this.fail(rec, gen, `${m.id}.create() threw: ${(err as Error)?.message ?? err}`, err);
      return;
    }
    if (gen !== rec.generation || !this.deps.mirror.entity(rec.entityId)) {
      // Superseded while creating (entity removed / newer reload): discard.
      safeDispose(inst);
      state.release();
      content.removeFromParent();
      disposeSubtree(content);
      return;
    }
    this.teardown(rec);
    rec.instance = inst;
    rec.state = state;
    rec.content = content;
    rec.status = 'ready';
    rec.error = null;
    content.visible = true;
    this.deps.onContentChanged?.(rec.entityId);
    // Replay inputs that arrived before (or across) this instance.
    if (typeof inst.onInput === 'function') {
      for (const [port, v] of rec.inputs) {
        if (rec.instance !== inst) break;
        this.guard(rec, 'onInput', () => inst.onInput!(port, v));
      }
    }
    // Props may have changed while an async create() was running (those
    // changes went to the previous instance or nowhere): catch up now.
    const latest = this.deps.mirror.entity(rec.entityId);
    if (latest && latest.props !== rawProps && rec.instance === inst) this.onChanged(latest, { props: true }, rec.node);
  }

  private async definition(m: WidgetManifest): Promise<WidgetDefinition> {
    const cached = this.definitions.get(m.id);
    if (cached && cached.hash === m.hash) return cached.promise;
    const url = this.resolveUrl(m);
    const promise = this.loadModule(url).then((mod) => {
      const def = (mod as { default?: WidgetDefinition })?.default ?? (mod as WidgetDefinition);
      if (!def || typeof def.create !== 'function') throw new Error(`bundle ${url} has no default export with create()`);
      return def;
    });
    this.definitions.set(m.id, { hash: m.hash, promise });
    promise.catch(() => {
      // Don't cache failures: the next attempt (e.g. after a rebuild) retries.
      if (this.definitions.get(m.id)?.promise === promise) this.definitions.delete(m.id);
    });
    return promise;
  }

  resolveUrl(m: WidgetManifest): string {
    const base = this.deps.baseUrl ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/');
    let u: URL;
    try {
      u = new URL(m.url, base);
    } catch {
      return m.url;
    }
    if (m.hash && !u.search.includes(m.hash)) u.searchParams.set('h', m.hash);
    return u.toString();
  }

  /** Dispose the live instance / fallback of a record (not the record itself). */
  private teardown(rec: WidgetRecord): void {
    if (rec.instance) {
      const inst = rec.instance;
      rec.instance = null;
      if (typeof inst.dispose === 'function') {
        try { inst.dispose(); } catch (err) {
          this.report(`${rec.widgetId}.dispose() threw: ${(err as Error)?.message ?? err}`, { entity: rec.entityId, widget: rec.widgetId, detail: err });
        }
      }
    }
    rec.state?.release();
    rec.state = null;
    if (rec.content) {
      rec.content.removeFromParent();
      disposeSubtree(rec.content);
      rec.content = null;
    }
    if (rec.fallback) {
      rec.fallback.removeFromParent();
      disposeSubtree(rec.fallback);
      rec.fallback = null;
    }
  }

  private fail(rec: WidgetRecord, gen: number, message: string, err?: unknown): void {
    if (gen !== rec.generation || !this.records.has(rec.entityId)) return;
    this.teardown(rec);
    rec.status = 'error';
    rec.error = message;
    this.showFallback(rec, message, this.manifests.get(rec.widgetId)?.size);
    this.report(message, { entity: rec.entityId, widget: rec.widgetId, detail: err });
  }

  private showFallback(rec: WidgetRecord, message: string, size: WidgetManifest['size']): void {
    const fb = createFallback(this.deps.ui, rec.widgetId, message, size);
    rec.node.object.add(fb);
    rec.fallback = fb;
    this.deps.onContentChanged?.(rec.entityId);
  }

  /** Run widget code; on throw, replace the instance with the fallback. */
  private guard(rec: WidgetRecord, what: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.fail(rec, rec.generation, `${rec.widgetId}.${what}() threw: ${(err as Error)?.message ?? err}`, err);
      return false;
    }
  }

  // ------------------------------------------------------------------ dataflow & interaction

  deliverInput(entity: string, port: string, value: unknown): void {
    const rec = this.records.get(entity);
    if (!rec) return;
    rec.inputs.set(port, value);
    const inst = rec.instance;
    if (rec.status === 'ready' && inst && typeof inst.onInput === 'function') {
      this.guard(rec, 'onInput', () => inst.onInput!(port, value));
    }
  }

  inputValue(entity: string, port: string): unknown {
    const rec = this.records.get(entity);
    if (rec && rec.inputs.has(port)) return rec.inputs.get(port);
    const m = rec ? this.manifests.get(rec.widgetId) : undefined;
    return m?.inputs?.[port]?.default;
  }

  /** Returns true if the widget handled (received) the event. */
  deliverInteraction(entity: string, e: InteractionEvent): boolean {
    const rec = this.records.get(entity);
    const inst = rec?.instance;
    if (!rec || rec.status !== 'ready' || !inst || typeof inst.onInteraction !== 'function') return false;
    return this.guard(rec, 'onInteraction', () => inst.onInteraction!(e));
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number, t: number): void {
    for (const rec of this.records.values()) {
      const inst = rec.instance;
      if (rec.status !== 'ready' || !inst || typeof inst.update !== 'function') continue;
      if (!effectivelyVisible(rec.node.object)) continue;
      try {
        inst.update(dt, t);
      } catch (err) {
        this.fail(rec, rec.generation, `${rec.widgetId}.update() threw: ${(err as Error)?.message ?? err}`, err);
      }
    }
  }

  // ------------------------------------------------------------------ queries

  record(entity: string): WidgetRecord | undefined {
    return this.records.get(entity);
  }

  allRecords(): IterableIterator<WidgetRecord> {
    return this.records.values();
  }

  interactivesOf(entity: string): ReadonlySet<THREE.Object3D> | undefined {
    return this.records.get(entity)?.state?.interactives;
  }

  /** Content object of an entity (widget root or fallback), excluding child entities. */
  contentOf(entity: string): THREE.Object3D | null {
    const rec = this.records.get(entity);
    return rec?.content ?? rec?.fallback ?? null;
  }

  /** Resolves when all in-flight loads/creates have settled (tests, mirror screenshots). */
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  dispose(): void {
    for (const rec of this.records.values()) {
      rec.generation++;
      this.teardown(rec);
    }
    this.records.clear();
  }

  // ------------------------------------------------------------------ errors

  private reportPropIssues(rec: WidgetRecord, issues: { prop: string; message: string }[]): void {
    for (const i of issues) {
      const msg = `entity ${rec.entityId} (${rec.widgetId}) prop '${i.prop}': ${i.message}`;
      if (this.errors.allow(msg)) this.deps.net.send({ type: 'client.log', level: 'warn', message: msg, entity: rec.entityId });
    }
  }

  private report(message: string, o: { entity?: string; widget?: string; detail?: unknown; fromWidget?: boolean }): void {
    if (!this.errors.allow(`${o.entity ?? ''}|${message}`)) return;
    const detail = o.detail;
    let stack: string | undefined;
    if (detail instanceof Error) stack = detail.stack;
    else if (detail !== undefined) stack = formatArgs([detail]);
    console.error(`[widget] ${message}`, detail ?? '');
    this.deps.net.send({ type: 'client.error', message, stack, entity: o.entity, widget: o.widget });
    this.deps.onError?.(message, { entity: o.entity, widget: o.widget });
  }
}

function safeDispose(inst: WidgetInstance): void {
  try { inst.dispose?.(); } catch { /* ignore */ }
}
