// Widget library: watches library/widgets/** and library/shared/**, rebuilds
// affected widgets, keeps the last good bundle per widget, and derives the
// catalog (WidgetManifest[]) that clients and Claude read.
import path from 'node:path';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import type { WidgetManifest } from '@evolspace/protocol';
import { compileWidget } from './compiler.ts';
import { evaluateWidget } from './evaluate.ts';
import { normPath } from '../util/fs.ts';
import { keyedDebounce } from '../util/timing.ts';
import type { Logger } from '../log.ts';

export interface BuildEvent {
  widget: string;
  ok: boolean;
  hash?: string;
  error?: string;
  warnings?: string[];
  ms: number;
}

export interface WidgetLibraryOptions {
  libraryDir: string;
  log: Logger;
  watch?: boolean;
  /** An existing widget was rebuilt (or its build failed / thumbnail changed). */
  onUpdated?: (m: WidgetManifest) => void;
  /** The set of widgets changed (added/removed). */
  onCatalog?: (all: WidgetManifest[]) => void;
  onBuild?: (e: BuildEvent) => void;
  debounceMs?: number;
}

interface Entry {
  id: string;
  manifest: WidgetManifest;
  /** Last good bundle. */
  code?: string;
  /** normPath()s of all files the last build(s) read. */
  inputs: Set<string>;
}

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export class WidgetLibrary {
  readonly widgetsDir: string;
  readonly sharedDir: string;
  private entries = new Map<string, Entry>();
  /** Per-widget build serialization. */
  private chains = new Map<string, Promise<unknown>>();
  private watcher: FSWatcher | null = null;
  private initializing = true;
  private readonly rebuildSoon: ReturnType<typeof keyedDebounce>;

  constructor(private readonly opts: WidgetLibraryOptions) {
    this.widgetsDir = path.join(opts.libraryDir, 'widgets');
    this.sharedDir = path.join(opts.libraryDir, 'shared');
    this.rebuildSoon = keyedDebounce((id) => { void this.build(id); }, opts.debounceMs ?? 120);
  }

  async init(): Promise<void> {
    mkdirSync(this.widgetsDir, { recursive: true });
    mkdirSync(this.sharedDir, { recursive: true });
    const ids = await this.scanIds();
    // Bounded parallelism: esbuild is fast, workers are the main cost.
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await this.build(id);
    }));
    this.initializing = false;
    if (this.opts.watch !== false) await this.startWatching();
    const bad = this.list().filter((m) => m.error).map((m) => m.id);
    this.opts.log.info(`${this.entries.size} widget(s) built${bad.length ? `, failing: ${bad.join(', ')}` : ''}`);
  }

  list(): WidgetManifest[] {
    return [...this.entries.values()].map((e) => e.manifest).sort((a, b) => a.id.localeCompare(b.id));
  }

  ids(): string[] { return this.list().map((m) => m.id); }

  manifest(id: string): WidgetManifest | undefined { return this.entries.get(id)?.manifest; }

  /** Widget exists in the library (built or not). */
  exists(id: string): boolean {
    return this.entries.has(id) || (WIDGET_ID_RE.test(id) && existsSync(this.entryFile(id)));
  }

  bundle(id: string): { code: string; hash: string } | undefined {
    const e = this.entries.get(id);
    return e?.code ? { code: e.code, hash: e.manifest.hash } : undefined;
  }

  async source(id: string): Promise<string | undefined> {
    if (!WIDGET_ID_RE.test(id)) return undefined;
    try { return await fsp.readFile(this.entryFile(id), 'utf8'); } catch { return undefined; }
  }

  thumbnailPath(id: string): string { return path.join(this.widgetsDir, id, 'thumbnail.png'); }

  /** Re-check thumbnail.png presence and broadcast if it changed. */
  refreshThumbnail(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    const has = existsSync(this.thumbnailPath(id));
    if (has !== e.manifest.hasThumbnail || has) {
      e.manifest = { ...e.manifest, hasThumbnail: has };
      this.opts.onUpdated?.(e.manifest);
    }
  }

  /** Build (or rebuild) one widget. Builds of the same widget are serialized. */
  build(id: string): Promise<{ ok: boolean; error?: string; manifest?: WidgetManifest }> {
    if (!WIDGET_ID_RE.test(id)) return Promise.resolve({ ok: false, error: `invalid widget id '${id}' (folder names: letters, digits, '-', '_')` });
    const run = (this.chains.get(id) ?? Promise.resolve()).then(() => this.doBuild(id));
    const settled = run.catch(() => {});
    this.chains.set(id, settled);
    void settled.then(() => { if (this.chains.get(id) === settled) this.chains.delete(id); });
    return run;
  }

  async close(): Promise<void> {
    this.rebuildSoon.cancelAll();
    await this.watcher?.close();
    this.watcher = null;
  }

  // ------------------------------------------------------------------ internals

  private entryFile(id: string): string { return path.join(this.widgetsDir, id, 'widget.ts'); }

  private async scanIds(): Promise<string[]> {
    const dirents = await fsp.readdir(this.widgetsDir, { withFileTypes: true }).catch(() => []);
    return dirents.filter((d) => d.isDirectory() && WIDGET_ID_RE.test(d.name) && existsSync(this.entryFile(d.name))).map((d) => d.name).sort();
  }

  private async doBuild(id: string): Promise<{ ok: boolean; error?: string; manifest?: WidgetManifest }> {
    if (!existsSync(this.entryFile(id))) {
      this.remove(id);
      return { ok: false, error: `widget '${id}' has no library/widgets/${id}/widget.ts` };
    }
    const t0 = performance.now();
    let entry = this.entries.get(id);
    const isNew = !entry;
    if (!entry) {
      entry = { id, manifest: this.emptyManifest(id), inputs: new Set([normPath(this.entryFile(id))]) };
      this.entries.set(id, entry);
    }
    const compiled = await compileWidget(this.opts.libraryDir, id);
    for (const p of compiled.inputs) entry.inputs.add(normPath(p));
    let error: string | undefined;
    let warnings: string[] | undefined;
    if (!compiled.ok) {
      error = compiled.error;
    } else {
      warnings = compiled.warnings.length ? compiled.warnings : undefined;
      entry.inputs = new Set(compiled.inputs.map(normPath)); // exact deps after a successful build
      const ev = await evaluateWidget(compiled.code);
      if (!ev.ok) {
        error = ev.error;
      } else {
        entry.code = compiled.code;
        entry.manifest = {
          id,
          description: ev.statics.description,
          ...(ev.statics.version !== undefined ? { version: ev.statics.version } : {}),
          props: ev.statics.props,
          inputs: ev.statics.inputs,
          outputs: ev.statics.outputs,
          interactions: ev.statics.interactions,
          ...(ev.statics.size ? { size: ev.statics.size } : {}),
          hash: compiled.hash,
          url: `/widgets/${encodeURIComponent(id)}.js?h=${compiled.hash}`,
          hasThumbnail: existsSync(this.thumbnailPath(id)),
        };
      }
    }
    if (error) {
      // Keep the last good bundle (if any) and flag the error on the manifest.
      entry.manifest = { ...entry.manifest, hasThumbnail: existsSync(this.thumbnailPath(id)), error };
    }
    const ms = Math.round(performance.now() - t0);
    this.opts.onBuild?.({ widget: id, ok: !error, ...(error ? { error } : { hash: entry.manifest.hash }), ...(warnings ? { warnings } : {}), ms });
    if (error) this.opts.log.warn(`widget '${id}' build failed: ${error.split('\n')[0]}`);
    else this.opts.log.info(`widget '${id}' built (${entry.manifest.hash}, ${ms}ms)`);
    if (!this.initializing) {
      if (isNew) this.opts.onCatalog?.(this.list());
      else this.opts.onUpdated?.(entry.manifest);
    }
    return error ? { ok: false, error, manifest: entry.manifest } : { ok: true, manifest: entry.manifest };
  }

  private emptyManifest(id: string): WidgetManifest {
    return { id, description: '', props: {}, inputs: {}, outputs: {}, interactions: [], hash: '', url: '', hasThumbnail: existsSync(this.thumbnailPath(id)) };
  }

  private remove(id: string): void {
    if (!this.entries.delete(id)) return;
    this.opts.log.info(`widget '${id}' removed`);
    this.opts.onCatalog?.(this.list());
  }

  /** library/widgets/<id>/... → id */
  private widgetIdOf(file: string): string | null {
    const rel = path.relative(this.widgetsDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const id = rel.split(/[\\/]/)[0];
    return id && WIDGET_ID_RE.test(id) ? id : null;
  }

  private async startWatching(): Promise<void> {
    this.watcher = watch([this.widgetsDir, this.sharedDir], {
      ignoreInitial: true,
      ignored: (p: string) => /[\\/](node_modules|\.git)([\\/]|$)|\.tmp-\d+|~$|\.swp$/.test(p),
    });
    const onFile = (event: 'add' | 'change' | 'unlink', file: string) => {
      const id = this.widgetIdOf(file);
      const base = path.basename(file);
      if (id && base === 'thumbnail.png') { this.refreshThumbnail(id); return; }
      const affected = new Set<string>();
      const key = normPath(file);
      for (const e of this.entries.values()) if (e.inputs.has(key)) affected.add(e.id);
      if (id && (this.entries.has(id) || base === 'widget.ts')) affected.add(id);
      if (event === 'unlink' && id && base === 'widget.ts') { this.remove(id); affected.delete(id); }
      for (const a of affected) this.rebuildSoon(a);
    };
    this.watcher.on('add', (f) => onFile('add', f));
    this.watcher.on('change', (f) => onFile('change', f));
    this.watcher.on('unlink', (f) => onFile('unlink', f));
    this.watcher.on('unlinkDir', (d) => {
      const id = this.widgetIdOf(d);
      if (id && path.resolve(d) === path.join(this.widgetsDir, id)) this.remove(id);
    });
    this.watcher.on('error', (e) => this.opts.log.error(`watcher: ${(e as Error).message}`));
    await new Promise<void>((r) => this.watcher!.once('ready', () => r()));
  }
}
