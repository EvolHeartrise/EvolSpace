// Voice command library: library/voice/commands.json (VoiceCommand[]).
//
// Parsing is lenient per entry: a bad entry (missing id, invalid regex, ...) is
// skipped with a problem report; the rest still load. If the file itself is
// unreadable / not JSON, the previous good set stays active.
import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { VoiceCommand } from '@evolspace/protocol';

export interface CompiledCommand {
  def: VoiceCommand;
  /** Whole-utterance, case-insensitive, unicode regexes. */
  regexes: RegExp[];
}

export interface ParseResult {
  commands: CompiledCommand[];
  /** Human-readable problems ("commands[3] (delete-this): patterns[0]: Invalid regular expression ..."). */
  problems: string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Wrap a pattern so it must match the whole (normalized) utterance. */
export function compilePattern(p: string): RegExp {
  return new RegExp(`^(?:${p})$`, 'iu');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate + compile parsed JSON (the file content). Never throws. */
export function parseCommands(json: unknown): ParseResult {
  const problems: string[] = [];
  const commands: CompiledCommand[] = [];
  const list = Array.isArray(json) ? json : isPlainObject(json) && Array.isArray(json.commands) ? json.commands : null;
  if (!list) return { commands, problems: ['commands.json must be an array of VoiceCommand objects'] };
  const ids = new Set<string>();
  list.forEach((raw: unknown, i: number) => {
    const where = `commands[${i}]`;
    if (!isPlainObject(raw)) { problems.push(`${where}: not an object`); return; }
    const id = raw.id;
    const label = typeof id === 'string' ? `${where} (${id})` : where;
    if (typeof id !== 'string' || !ID_RE.test(id)) { problems.push(`${label}: "id" must be a non-empty string of letters, digits, '-', '_', '.', ':'`); return; }
    if (ids.has(id)) { problems.push(`${label}: duplicate id (first one wins)`); return; }
    if (typeof raw.command !== 'string' || !raw.command.trim()) { problems.push(`${label}: "command" must be a non-empty string`); return; }
    if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) { problems.push(`${label}: "patterns" must be a non-empty array of regex strings`); return; }
    if (raw.args !== undefined && !isPlainObject(raw.args)) { problems.push(`${label}: "args" must be an object`); return; }
    if (raw.description !== undefined && typeof raw.description !== 'string') { problems.push(`${label}: "description" must be a string`); return; }
    const regexes: RegExp[] = [];
    const patterns: string[] = [];
    raw.patterns.forEach((p: unknown, j: number) => {
      if (typeof p !== 'string' || !p.trim()) { problems.push(`${label}: patterns[${j}] must be a non-empty string`); return; }
      try {
        regexes.push(compilePattern(p));
        patterns.push(p);
      } catch (e) {
        problems.push(`${label}: patterns[${j}]: ${(e as Error).message}`);
      }
    });
    if (!regexes.length) { problems.push(`${label}: no valid patterns; entry skipped`); return; }
    ids.add(id);
    const def: VoiceCommand = {
      id,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      patterns,
      command: raw.command.trim(),
      ...(raw.args !== undefined ? { args: raw.args as Record<string, unknown> } : {}),
    };
    commands.push({ def, regexes });
  });
  return { commands, problems };
}

export interface CommandLibraryOptions {
  dir: string;
  watch?: boolean;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Called after every (re)load attempt with the problems found (empty = clean). */
  onReload?: (r: { count: number; problems: string[]; initial: boolean }) => void;
  debounceMs?: number;
}

/** Holds the compiled command set and hot-reloads commands.json. */
export class CommandLibrary {
  private compiled: CompiledCommand[] = [];
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private loading: Promise<void> = Promise.resolve();
  problems: string[] = [];
  readonly file: string;
  /** Content of the last successfully parsed file (skip no-op reloads). */
  private lastText: string | null = null;

  constructor(private readonly o: CommandLibraryOptions) {
    this.file = path.join(o.dir, 'commands.json');
  }

  get commands(): CompiledCommand[] { return this.compiled; }
  definitions(): VoiceCommand[] { return this.compiled.map((c) => c.def); }

  /** Initial load (+ start watching). Resolves once the first load finished. */
  async init(): Promise<void> {
    await this.reload(true);
    if (this.o.watch !== false) {
      mkdirSync(this.o.dir, { recursive: true });
      // Watch the directory (not the file) so create/delete/atomic-rename editors all work.
      this.watcher = watch(this.o.dir, { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 } });
      const onChange = (p: string) => { if (path.resolve(p) === path.resolve(this.file)) this.schedule(); };
      this.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
      this.watcher.on('error', (e) => this.o.log('warn', `voice: watcher error: ${(e as Error).message}`));
      // Edits made before the watcher is ready would be missed; wait (bounded).
      const w = this.watcher;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        w.once('ready', () => { clearTimeout(t); resolve(); });
      });
      // Catch an edit that raced the watcher start-up.
      await this.reload(false);
    }
  }

  /** Wait for any in-flight reload (tests). */
  settled(): Promise<void> { return this.loading; }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.reload(false); }, this.o.debounceMs ?? 50);
  }

  reload(initial = false): Promise<void> {
    this.loading = this.loading.then(() => this.doReload(initial));
    return this.loading;
  }

  private async doReload(initial: boolean): Promise<void> {
    if (!existsSync(this.file)) {
      this.lastText = null;
      this.compiled = [];
      this.problems = [`${this.file} does not exist; no fast-path voice commands (everything goes to Claude)`];
      this.o.log('warn', `voice: ${this.problems[0]}`);
      this.o.onReload?.({ count: 0, problems: this.problems, initial });
      return;
    }
    let json: unknown;
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      if (text === this.lastText) return; // duplicate watcher event / unchanged
      json = JSON.parse(text.replace(/^﻿/, ''));
      this.lastText = text;
    } catch (e) {
      // Keep the last good set (a half-saved file must not wipe the commands).
      // Forget the last text so reverting to it re-parses and clears this problem.
      this.lastText = null;
      this.problems = [`commands.json: ${(e as Error).message} (keeping the previous ${this.compiled.length} commands)`];
      this.o.log('error', `voice: ${this.problems[0]}`);
      this.o.onReload?.({ count: this.compiled.length, problems: this.problems, initial });
      return;
    }
    const r = parseCommands(json);
    this.compiled = r.commands;
    this.problems = r.problems;
    for (const p of r.problems) this.o.log('warn', `voice: ${p}`);
    this.o.log('info', `voice: ${initial ? 'loaded' : 'reloaded'} ${r.commands.length} fast-path commands${r.problems.length ? ` (${r.problems.length} problems)` : ''}`);
    this.o.onReload?.({ count: r.commands.length, problems: r.problems, initial });
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}
