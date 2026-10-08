// Child-process helpers for the sources supervisor: command/placeholder
// resolution and killing whole process trees (Windows needs taskkill /T).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { isInside } from '../util/fs.ts';

const isWin = process.platform === 'win32';

export function venvPython(dir: string): string | null {
  const exe = isWin ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
  return existsSync(exe) ? exe : null;
}

/**
 * Resolve "{python}": the nearest .venv walking up from the source's cwd (e.g.
 * cwd "../../../python/stt" → python/stt/.venv), stopping at the repo root, then
 * the source folder's own .venv, else "python" ("python3" off Windows) from PATH.
 * "{python:python/stt}" names a project folder (relative to the repo root) explicitly.
 */
export function resolvePython(spec: string, ctx: { cwd: string; sourceDir: string; repoRoot: string }): string {
  const explicit = /^\{python:(.+)\}$/.exec(spec);
  if (explicit) {
    const dir = path.resolve(ctx.repoRoot, explicit[1]);
    const py = venvPython(dir);
    if (!py) throw new Error(`${spec}: no virtualenv at ${path.join(dir, '.venv')} (create it with \`uv venv --python 3.12\` in that folder)`);
    return py;
  }
  let dir = ctx.cwd;
  for (;;) {
    const py = venvPython(dir);
    if (py) return py;
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(ctx.repoRoot, parent)) break;
    dir = parent;
  }
  return venvPython(ctx.sourceDir) ?? (isWin ? 'python' : 'python3'); // Debian/Ubuntu ship no bare `python`
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run through the shell (Windows .cmd/.bat shims); command is then the full quoted command line and args is empty. */
  shell?: boolean;
}

/** npm-style shims that are .cmd files on Windows. */
const WIN_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsx', 'vite', 'vitest', 'tsc']);

/** cmd.exe quoting for one argument. */
export function quoteWinArg(a: string): string {
  return a !== '' && !/[\s"&|<>^()%!,;=]/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

/**
 * Windows can't spawn .cmd/.bat files without a shell (Node refuses with EINVAL
 * since the 2024 BatBadBut fix; "npx" alone is ENOENT because spawn ignores
 * PATHEXT). Such commands are run as one quoted command line through cmd.exe.
 */
export function withWindowsShell(cmd: ResolvedCommand, platform: NodeJS.Platform = process.platform): ResolvedCommand {
  if (platform !== 'win32') return cmd;
  const base = path.basename(cmd.command).toLowerCase();
  if (!/\.(cmd|bat)$/.test(base) && !WIN_SHIMS.has(base)) return cmd;
  return { ...cmd, command: [cmd.command, ...cmd.args].map(quoteWinArg).join(' '), args: [], shell: true };
}

/** Expand {python}, {repo}, {source} and resolve relative executables. */
export function resolveCommand(
  spec: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> },
  ctx: { sourceDir: string; repoRoot: string; baseUrl: string },
): ResolvedCommand {
  const cwd = spec.cwd ? path.resolve(ctx.sourceDir, spec.cwd) : ctx.sourceDir;
  const sub = (s: string) => s.replace(/\{repo\}/g, ctx.repoRoot).replace(/\{source\}/g, ctx.sourceDir);
  let command = spec.command.trim();
  if (/^\{python(:[^}]+)?\}$/.test(command)) command = resolvePython(command, { cwd, sourceDir: ctx.sourceDir, repoRoot: ctx.repoRoot });
  else if (command === 'node') command = process.execPath; // same Node as the server
  else {
    command = sub(command);
    if (command.startsWith('.')) command = path.resolve(cwd, command);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    EVOL_URL: ctx.baseUrl,
    EVOL_REPO: ctx.repoRoot,
    ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, sub(String(v))])),
  };
  return withWindowsShell({ command, args: (spec.args ?? []).map((a) => sub(String(a))), cwd, env });
}

/** Kill a process and all its descendants. Resolves when the kill has been issued. */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (isWin) {
    return new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('exit', () => resolve());
      tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); });
    });
  }
  try {
    process.kill(-pid, 'SIGTERM'); // detached → own process group
  } catch {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  return Promise.resolve();
}

export const spawnOptions = { detached: !isWin, windowsHide: true } as const;

/** Kill a process tree by pid (no ChildProcess handle: orphans from a previous server run). */
export function killPidTree(pid: number): Promise<void> {
  if (isWin) {
    return new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('exit', () => resolve());
      tk.on('error', () => resolve());
    });
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  return Promise.resolve();
}

/**
 * Executable image name of a running process (lowercase, e.g. "python.exe"),
 * or null if no such process. Used to make sure a pid from the pid file still
 * belongs to the process we started before killing it.
 */
export function processImage(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve(null); return; }
    if (isWin) {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
        const m = !err && /^"([^"]+)","(\d+)"/m.exec(stdout);
        resolve(m && Number(m[2]) === pid ? m[1].toLowerCase() : null);
      });
      return;
    }
    if (process.platform === 'linux') {
      // argv[0] as we spawned it. `ps -o comm=` is the thread name instead: Node renames
      // its main thread "MainThread", and a venv's python symlink shows as "python3.12".
      readFile(`/proc/${pid}/cmdline`, 'utf8').then(
        (cmdline) => { const argv0 = cmdline.split('\0')[0]; resolve(argv0 ? path.basename(argv0).toLowerCase() : null); },
        () => resolve(null),
      );
      return;
    }
    execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 10_000 }, (err, stdout) => {
      const name = stdout?.trim();
      resolve(!err && name ? path.basename(name).toLowerCase() : null);
    });
  });
}

/** Image name we expect for a spawned command (what processImage reports). */
export function imageOf(cmd: ResolvedCommand): string {
  if (cmd.shell) return isWin ? 'cmd.exe' : 'sh';
  const base = path.basename(cmd.command).toLowerCase();
  return isWin && !path.extname(base) ? `${base}.exe` : base;
}
