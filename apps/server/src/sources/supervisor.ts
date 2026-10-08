// Sources supervisor: long-running data-driver processes declared in
// library/sources/<id>/source.json (SourceSpec). Restarts crashed processes with
// exponential backoff, keeps a log tail, emits source.exit events and kills
// whole process trees on stop.
import path from 'node:path';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'chokidar';
import type { SourceSpec, SourceStatus } from '@evolspace/protocol';
import { atomicWriteSync, readJson, readJsonOr } from '../util/fs.ts';
import { keyedDebounce } from '../util/timing.ts';
import { imageOf, killPidTree, killTree, processImage, resolveCommand, spawnOptions } from './process.ts';
import type { Logger } from '../log.ts';

export interface SourceInfo extends SourceStatus {
  description: string;
  autostart: boolean;
  /** source.json problem, if any. */
  error?: string;
}

export interface SupervisorOptions {
  sourcesDir: string;
  repoRoot: string;
  /** Base URL handed to children as EVOL_URL. */
  baseUrl: () => string;
  log: Logger;
  onExit?: (data: Record<string, unknown>) => void;
  watch?: boolean;
  /** Backoff tuning (tests shorten these). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A run longer than this resets the backoff. */
  stableAfterMs?: number;
  logLines?: number;
  /**
   * Where running children are recorded (data/sources.pids.json). If the server
   * dies without cleaning up (hard kill: Task Manager, `tsx watch` restarts on
   * Windows), the next boot kills those orphans before starting sources again —
   * otherwise e.g. an old STT process keeps its port and the new one crash-loops.
   */
  pidFile?: string;
}

interface PidRecord { pid: number; image: string; startedAt: number }

interface State {
  id: string;
  dir: string;
  spec: SourceSpec | null;
  specText: string;
  error?: string;
  child: ChildProcess | null;
  /** The user/boot wants it running (drives auto-restart). */
  wanted: boolean;
  restarts: number;
  failures: number;
  startedAt: number;
  lastExit?: { code: number | null; at: number };
  logTail: string[];
  partial: { out: string; err: string };
  backoff: NodeJS.Timeout | null;
  exited: Promise<void> | null;
  /** Executable image of the running child (pid-file sanity check). */
  image?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class SourceError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'SourceError'; }
}

export class SourceSupervisor {
  private states = new Map<string, State>();
  private watcher: FSWatcher | null = null;
  private closed = false;
  private readonly o: Required<Pick<SupervisorOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'stableAfterMs' | 'logLines'>> & SupervisorOptions;

  constructor(opts: SupervisorOptions) {
    this.o = { backoffBaseMs: 500, backoffMaxMs: 30_000, stableAfterMs: 30_000, logLines: 200, ...opts };
  }

  async init(autostart: boolean): Promise<void> {
    mkdirSync(this.o.sourcesDir, { recursive: true });
    await this.reapOrphans();
    const dirents = await fsp.readdir(this.o.sourcesDir, { withFileTypes: true });
    for (const d of dirents) if (d.isDirectory() && ID_RE.test(d.name)) await this.loadSpec(d.name);
    if (autostart) {
      for (const s of this.states.values()) if (s.spec?.autostart) this.start(s.id);
    }
    if (this.o.watch !== false) await this.startWatching(autostart);
  }

  list(): SourceInfo[] { return [...this.states.values()].sort((a, b) => a.id.localeCompare(b.id)).map((s) => this.status(s)); }

  get(id: string): SourceInfo | undefined {
    const s = this.states.get(id);
    return s && this.status(s);
  }

  start(id: string): SourceInfo {
    const s = this.require(id);
    s.wanted = true;
    if (s.backoff) { clearTimeout(s.backoff); s.backoff = null; }
    if (!s.child) { s.failures = 0; this.spawn(s); }
    return this.status(s);
  }

  async stop(id: string): Promise<SourceInfo> {
    const s = this.require(id);
    s.wanted = false;
    if (s.backoff) { clearTimeout(s.backoff); s.backoff = null; }
    await this.kill(s);
    return this.status(s);
  }

  async restart(id: string): Promise<SourceInfo> {
    const s = this.require(id);
    s.wanted = false;
    if (s.backoff) { clearTimeout(s.backoff); s.backoff = null; }
    await this.kill(s);
    await this.loadSpec(id); // pick up edits to source.json
    s.restarts++;
    return this.start(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.watcher?.close();
    await Promise.all([...this.states.values()].map(async (s) => {
      s.wanted = false;
      if (s.backoff) clearTimeout(s.backoff);
      await this.kill(s);
    }));
  }

  // ------------------------------------------------------------------ internals

  private require(id: string): State {
    const s = this.states.get(id);
    if (!s) throw new SourceError(`unknown source '${id}' (have: ${[...this.states.keys()].join(', ') || 'none'}; add library/sources/${id}/source.json)`, 404);
    return s;
  }

  private status(s: State): SourceInfo {
    return {
      id: s.id,
      description: s.spec?.description ?? '',
      autostart: !!s.spec?.autostart,
      running: !!s.child,
      ...(s.child?.pid !== undefined ? { pid: s.child.pid } : {}),
      restarts: s.restarts,
      ...(s.lastExit ? { lastExit: s.lastExit } : {}),
      logTail: s.logTail.slice(-50),
      ...(s.error ? { error: s.error } : {}),
    };
  }

  /** (Re)read source.json. Returns true if the spec changed. */
  private async loadSpec(id: string): Promise<boolean> {
    const dir = path.join(this.o.sourcesDir, id);
    const file = path.join(dir, 'source.json');
    let s = this.states.get(id);
    if (!s) {
      s = { id, dir, spec: null, specText: '', child: null, wanted: false, restarts: 0, failures: 0, startedAt: 0, logTail: [], partial: { out: '', err: '' }, backoff: null, exited: null };
      this.states.set(id, s);
    }
    if (!existsSync(file)) {
      s.spec = null; s.error = `missing library/sources/${id}/source.json`;
      return true;
    }
    try {
      const text = await fsp.readFile(file, 'utf8');
      if (text === s.specText && s.spec) return false;
      const spec = await readJson<SourceSpec>(file);
      if (typeof spec.command !== 'string' || !spec.command) throw new Error(`source.json needs "command" (e.g. "{python}" or "node")`);
      if (spec.args !== undefined && !Array.isArray(spec.args)) throw new Error(`source.json "args" must be an array of strings`);
      s.spec = spec; s.specText = text; delete s.error;
      return true;
    } catch (e) {
      s.error = (e as Error).message;
      this.o.log.warn(`source '${id}': ${s.error}`);
      return true;
    }
  }

  private pushLog(s: State, line: string): void {
    s.logTail.push(line.length > 2000 ? line.slice(0, 2000) + '…' : line);
    if (s.logTail.length > this.o.logLines) s.logTail.splice(0, s.logTail.length - this.o.logLines);
  }

  private onData(s: State, stream: 'out' | 'err', chunk: Buffer): void {
    const text = s.partial[stream] + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    s.partial[stream] = lines.pop() ?? '';
    for (const l of lines) this.pushLog(s, stream === 'err' ? `! ${l}` : l);
  }

  private spawn(s: State): void {
    if (this.closed) return;
    if (!s.spec) {
      this.pushLog(s, `[supervisor] cannot start: ${s.error ?? 'no spec'}`);
      return;
    }
    let cmd;
    try {
      cmd = resolveCommand(s.spec, { sourceDir: s.dir, repoRoot: this.o.repoRoot, baseUrl: this.o.baseUrl() });
    } catch (e) {
      s.error = (e as Error).message;
      this.pushLog(s, `[supervisor] ${s.error}`);
      return;
    }
    this.pushLog(s, `[supervisor] start: ${cmd.command} ${cmd.args.join(' ')} (cwd ${path.relative(this.o.repoRoot, cmd.cwd) || '.'})`);
    const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions, ...(cmd.shell ? { shell: true } : {}) });
    s.child = child;
    s.startedAt = Date.now();
    s.image = imageOf(cmd);
    this.savePids();
    child.stdout?.on('data', (c: Buffer) => this.onData(s, 'out', c));
    child.stderr?.on('data', (c: Buffer) => this.onData(s, 'err', c));
    let resolveExited!: () => void;
    s.exited = new Promise((r) => { resolveExited = r; });
    let finished = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      for (const k of ['out', 'err'] as const) if (s.partial[k]) { this.pushLog(s, s.partial[k]); s.partial[k] = ''; }
      if (spawnError) this.pushLog(s, `[supervisor] failed to start: ${spawnError.message}`);
      s.child = null;
      s.lastExit = { code, at: Date.now() };
      this.savePids();
      const ranMs = Date.now() - s.startedAt;
      if (ranMs > this.o.stableAfterMs) s.failures = 0;
      const restarting = s.wanted && s.spec?.restart !== false && !this.closed;
      this.pushLog(s, `[supervisor] exited code=${code}${signal ? ` signal=${signal}` : ''} after ${ranMs}ms${restarting ? '' : ' (not restarting)'}`);
      this.o.onExit?.({ id: s.id, code, signal, ranMs, restarting, restarts: s.restarts, logTail: s.logTail.slice(-20) });
      if (restarting) {
        const delay = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** s.failures);
        s.failures++;
        s.backoff = setTimeout(() => {
          s.backoff = null;
          if (s.wanted && !s.child && !this.closed) { s.restarts++; this.spawn(s); }
        }, delay);
      }
      resolveExited();
    };
    child.on('exit', (code, signal) => onEnd(code, signal));
    child.on('error', (e) => onEnd(null, null, e));
  }

  /** Persist pids of running children (sync + tiny; called on spawn/exit). */
  private savePids(): void {
    if (!this.o.pidFile) return;
    const rec: Record<string, PidRecord> = {};
    for (const st of this.states.values()) {
      if (st.child?.pid !== undefined && st.image) rec[st.id] = { pid: st.child.pid, image: st.image, startedAt: st.startedAt };
    }
    try { atomicWriteSync(this.o.pidFile, JSON.stringify(rec, null, 1)); } catch (e) { this.o.log.warn(`could not write ${this.o.pidFile}: ${(e as Error).message}`); }
  }

  /** Kill children a previous (hard-killed) server run left behind. */
  private async reapOrphans(): Promise<void> {
    if (!this.o.pidFile) return;
    const rec = await readJsonOr<Record<string, PidRecord>>(this.o.pidFile, {});
    await Promise.all(Object.entries(rec).map(async ([id, r]) => {
      if (!r || !Number.isInteger(r.pid) || r.pid === process.pid || typeof r.image !== 'string') return;
      const image = await processImage(r.pid);
      // Only kill if the pid still runs the same executable (pids get reused).
      if (!image || image !== r.image.toLowerCase()) return;
      this.o.log.warn(`killing orphaned source '${id}' (pid ${r.pid}, ${image}) left by a previous server run`);
      await killPidTree(r.pid);
    }));
    this.savePids();
  }

  private async kill(s: State): Promise<void> {
    const child = s.child;
    if (!child) return;
    const exited = s.exited;
    await killTree(child);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }

  private async startWatching(autostart: boolean): Promise<void> {
    const reload = keyedDebounce((id: string) => {
      void (async () => {
        const known = this.states.has(id);
        const changed = await this.loadSpec(id);
        const s = this.states.get(id)!;
        if (!changed) return;
        this.o.log.info(`source '${id}' spec ${known ? 'changed' : 'added'}`);
        if (s.child) await this.restart(id);
        else if (!known && autostart && s.spec?.autostart) this.start(id);
      })().catch((e) => this.o.log.error(`source '${id}' reload: ${(e as Error).message}`));
    }, 200);
    this.watcher = watch(this.o.sourcesDir, { ignoreInitial: true, depth: 1 });
    const onFile = (f: string) => {
      if (path.basename(f) !== 'source.json') return;
      const id = path.basename(path.dirname(f));
      if (ID_RE.test(id)) reload(id);
    };
    this.watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
    await new Promise<void>((r) => this.watcher!.once('ready', () => r()));
  }
}
