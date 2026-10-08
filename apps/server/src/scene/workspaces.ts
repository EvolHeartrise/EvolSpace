// Workspace persistence: data/workspaces/<name>.json (debounced, atomic writes)
// and data/state.json remembers the last workspace so it reloads on boot.
import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import type { Entity, Link } from '@evolspace/protocol';
import type { SceneStore } from './store.ts';
import { SceneError } from './validate.ts';
import { sanitizeScene } from './sanitize.ts';
import { atomicWrite, atomicWriteSync, readJson, readJsonOr } from '../util/fs.ts';
import { debounce, type Debounced } from '../util/timing.ts';
import { isSafeName } from '../util/ids.ts';
import type { Logger } from '../log.ts';

export interface WorkspaceFile {
  format: 1;
  workspace: string;
  savedAt: string;
  entities: Record<string, Entity>;
  links: Record<string, Link>;
}

interface ServerState {
  lastWorkspace?: string;
}

export class Workspaces {
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly saveSoon: Debounced;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly store: SceneStore,
    private readonly log: Logger,
    debounceMs = 750,
  ) {
    this.dir = path.join(dataDir, 'workspaces');
    this.stateFile = path.join(dataDir, 'state.json');
    // maxWait: a continuous drag (ops every ~50 ms) still gets saved every few seconds.
    this.saveSoon = debounce(() => { void this.save().catch((e) => this.log.error(`autosave failed: ${(e as Error).message}`)); }, debounceMs, Math.max(debounceMs, 3000));
  }

  get current(): string { return this.store.workspace; }

  fileFor(name: string): string {
    if (!isSafeName(name)) throw new SceneError(`invalid workspace name '${name}' (use letters, digits, '-', '_', '.')`);
    return path.join(this.dir, `${name}.json`);
  }

  /** Load the last-used workspace (or 'default'). */
  async init(): Promise<void> {
    const state = await readJsonOr<ServerState>(this.stateFile, {});
    const name = state.lastWorkspace && isSafeName(state.lastWorkspace) ? state.lastWorkspace : 'default';
    const file = this.fileFor(name);
    try {
      if (existsSync(file)) {
        await this.load(name, { flush: false });
        return;
      }
    } catch (e) {
      // Never let the next autosave overwrite a file we failed to read: move it aside first.
      const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { await fsp.rename(file, backup); } catch { /* keep going; it may be locked */ }
      this.log.error(`could not load workspace '${name}': ${(e as Error).message}; starting empty (the file was moved to ${backup})`);
    }
    this.store.reset({}, name);
    this.saveSoon.cancel(); // nothing to save yet
  }

  /** Called on every scene change. */
  markDirty(): void { this.saveSoon(); }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  /** Save the scene (optionally under a new name, which becomes current). */
  async save(name?: string): Promise<string> {
    if (name && name !== this.store.workspace) {
      this.fileFor(name); // validate
      this.store.setWorkspaceName(name);
    }
    this.saveSoon.cancel();
    const target = this.store.workspace;
    const body = this.serialize();
    // Serialize writes so an older snapshot never lands after a newer one.
    const run = this.writing.then(async () => {
      await atomicWrite(this.fileFor(target), body);
      await atomicWrite(this.stateFile, JSON.stringify({ lastWorkspace: target } satisfies ServerState, null, 2));
    });
    this.writing = run.catch(() => {});
    await run;
    return target;
  }

  async load(name: string, opts: { flush?: boolean } = {}): Promise<void> {
    const file = this.fileFor(name);
    if (!existsSync(file)) {
      const list = await this.list();
      throw new SceneError(`workspace '${name}' does not exist${list.length ? ` (have: ${list.join(', ')})` : ''}`);
    }
    if (opts.flush !== false) await this.flush();
    const data = await readJson<Partial<WorkspaceFile>>(file);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SceneError(`workspace '${name}': expected {entities, links}`);
    const clean = sanitizeScene(data.entities ?? {}, data.links ?? {});
    for (const p of clean.problems) this.log.warn(`workspace '${name}': ${p}`);
    this.store.reset({ entities: clean.entities, links: clean.links }, name);
    this.saveSoon.cancel();
    await atomicWrite(this.stateFile, JSON.stringify({ lastWorkspace: name } satisfies ServerState, null, 2));
  }

  /** Start a new empty workspace (the current one is saved first). Refuses to overwrite an existing one. */
  async create(name: string): Promise<void> {
    if (existsSync(this.fileFor(name))) throw new SceneError(`workspace '${name}' already exists (load it, or pick another name)`);
    await this.flush();
    this.store.reset({}, name);
    await this.save();
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    if (this.saveSoon.pending) await this.save();
    await this.writing;
  }

  /** Synchronous flush for process exit. */
  flushSync(): void {
    if (!this.saveSoon.pending) return;
    this.saveSoon.cancel();
    atomicWriteSync(this.fileFor(this.store.workspace), this.serialize());
    atomicWriteSync(this.stateFile, JSON.stringify({ lastWorkspace: this.store.workspace }, null, 2));
  }

  private serialize(): string {
    const s = this.store.scene;
    const file: WorkspaceFile = { format: 1, workspace: s.workspace, savedAt: new Date().toISOString(), entities: s.entities, links: s.links };
    return JSON.stringify(file, null, 1);
  }
}
