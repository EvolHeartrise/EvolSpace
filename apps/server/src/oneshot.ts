// One-off agents: a push-to-talk request made with the one-off key (desktop: hold B,
// command 'voice.ptt.oneshot') is not sent to the user's main Claude Code session.
// It runs in a fresh headless `claude -p` process in the repo instead:
//
//   - none of the main session's context (a new session; CLAUDE.md + MCP tools only),
//   - nothing persisted (--no-session-persistence), no interactive prompts
//     (--permission-prompts none: anything that would ask is denied),
//   - the process exits — the agent expires — as soon as the task is done; its
//     final message is shown in the XR agent panel.
//
// The child's evolspace MCP bridge runs without the voice channel
// (EVOL_BRIDGE_CHANNEL=0) and its Claude Code hooks don't drive the shared status
// indicator (EVOL_STATUS_HOOK=0), so it never steals the main session's requests
// or clobbers its "working" line.
//
// Env: EVOL_CLAUDE_BIN (default 'claude'), EVOL_ONESHOT_PERMISSION_MODE (default 'auto').
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { ServerEventType } from '@evolspace/protocol';

export interface OneshotDeps {
  repoRoot: string;
  /** The server's local API URL (EVOL_URL for the child's MCP bridge). */
  baseUrl(): string;
  say(text: string, kind: 'reply' | 'info' | 'error'): void;
  event(type: ServerEventType, data: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface OneshotOptions {
  bin?: string;
  permissionMode?: string;
  /** A one-off agent still running after this long is killed. Default 20 min. */
  timeoutMs?: number;
  /** Requests beyond this many running agents are refused. Default 3. */
  maxConcurrent?: number;
  spawn?: typeof nodeSpawn;
  now?: () => number;
}

/** Session identity the server inherits when it was launched from a Claude Code session. */
const SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_EFFORT',
];

const PREAMBLE = [
  'You are a one-off EvolSpace agent: a fresh, headless Claude Code session started for this single request, which the user',
  'made with the one-off push-to-talk key. You share no context with their main Claude session, nobody watches this terminal,',
  'nothing can be approved interactively, and this process ends when you finish.',
  'Do the task, then end with a short spoken-style reply (1–3 sentences). That final message is shown to the user in XR',
  'automatically, so do not also send it with `say` (use `status`/`say` only for progress during long work).',
  'Do not ask questions: if the request is ambiguous, take the sensible reading and say what you did.',
].join('\n');

const attr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/[\r\n]+/g, ' ').replace(/"/g, "'").slice(0, 200) : undefined;

/** The prompt piped to `claude -p`: preamble + the request in the same tag shape as main-session channel events. */
export function oneshotPrompt(text: string, context: Record<string, unknown>): string {
  const meta: Record<string, string | undefined> = {
    source: 'evolspace',
    kind: 'oneshot',
    target: attr(context.target),
    target_widget: attr(context.target_widget),
    target_name: attr(context.target_name),
    selected: attr(context.selected),
    selected_name: attr(context.selected_name),
  };
  const attrs = Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `${PREAMBLE}\n\n<channel ${attrs}>${text}</channel>\n`;
}

interface Running {
  id: number;
  child: ChildProcess;
  text: string;
  startedAt: number;
  timedOut: boolean;
}

export class OneshotAgents {
  private readonly running = new Map<number, Running>();
  private nextId = 1;
  private closed = false;
  private readonly bin: string;
  private readonly permissionMode: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly spawn: typeof nodeSpawn;
  private readonly now: () => number;

  constructor(private readonly deps: OneshotDeps, opts: OneshotOptions = {}) {
    this.bin = opts.bin ?? process.env.EVOL_CLAUDE_BIN ?? 'claude';
    const mode = opts.permissionMode ?? process.env.EVOL_ONESHOT_PERMISSION_MODE ?? 'auto';
    this.permissionMode = /^[A-Za-z]+$/.test(mode) ? mode : 'auto'; // a bare token: argv may go through a shell on Windows
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
  }

  get count(): number { return this.running.size; }

  /** Start a one-off agent for `text`. Returns its id, or null if refused. */
  ask(text: string, context: Record<string, unknown> = {}): number | null {
    if (this.closed) return null;
    if (this.running.size >= this.maxConcurrent) {
      this.deps.say(`Already running ${this.running.size} one-off agents; try again when one finishes.`, 'info');
      return null;
    }
    const id = this.nextId++;
    const env: NodeJS.ProcessEnv = { ...process.env, EVOL_URL: this.deps.baseUrl(), EVOL_STATUS_HOOK: '0', EVOL_BRIDGE_CHANNEL: '0' };
    for (const k of SESSION_ENV) delete env[k];
    const args = [
      '-p', '--output-format', 'json', '--no-session-persistence',
      '--permission-mode', this.permissionMode, '--permission-prompts', 'none',
      '--disallowedTools', 'AskUserQuestion',
    ];
    let child: ChildProcess;
    try {
      child = this.spawn(this.bin, args, {
        cwd: this.deps.repoRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32', // resolves claude.cmd; every arg above is a plain token
      });
    } catch (e) {
      this.fail(id, text, `could not start ${this.bin}: ${(e as Error).message}`);
      return null;
    }
    const r: Running = { id, child, text, startedAt: this.now(), timedOut: false };
    this.running.set(id, r);

    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => { if (out.length < 1_000_000) out += c; });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => { err = (err + c).slice(-4000); });
    child.stdin?.on('error', () => { /* the exit handler reports it */ });
    child.stdin?.end(oneshotPrompt(text, context));

    const timer = setTimeout(() => { r.timedOut = true; child.kill(); }, this.timeoutMs);
    timer.unref?.();
    let done = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.running.delete(id);
      this.finish(r, code, out, err, spawnError);
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));

    this.deps.log('info', `one-off agent #${id} started (pid ${child.pid ?? '?'}): ${text}`);
    this.deps.event('agent.oneshot', { id, phase: 'start', text, ...(context.utteranceId ? { utteranceId: context.utteranceId } : {}) });
    this.deps.say('One-off agent is on it.', 'info');
    return id;
  }

  /** Kill every running one-off agent (server shutdown). */
  close(): void {
    this.closed = true;
    for (const r of this.running.values()) r.child.kill();
  }

  private finish(r: Running, code: number | null, out: string, err: string, spawnError?: Error): void {
    const durationMs = this.now() - r.startedAt;
    const base = { id: r.id, phase: 'end', text: r.text, durationMs, exitCode: code };
    if (spawnError) {
      const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
      this.fail(r.id, r.text, missing ? `'${this.bin}' (Claude Code CLI) is not on the server's PATH (set EVOL_CLAUDE_BIN)` : spawnError.message, base);
      return;
    }
    if (r.timedOut) {
      this.fail(r.id, r.text, `timed out after ${Math.round(this.timeoutMs / 60_000)} min and was stopped`, base);
      return;
    }
    let res: { is_error?: boolean; result?: string; subtype?: string; total_cost_usd?: number; num_turns?: number } | null = null;
    try { res = JSON.parse(out.trim()); } catch { /* not JSON: report stderr below */ }
    const result = typeof res?.result === 'string' ? res.result.trim() : '';
    if (!res || res.is_error || code !== 0) {
      const why = result || res?.subtype || err.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
      this.fail(r.id, r.text, why, { ...base, ...(res?.total_cost_usd !== undefined ? { costUsd: res.total_cost_usd } : {}) });
      return;
    }
    this.deps.log('info', `one-off agent #${r.id} done in ${(durationMs / 1000).toFixed(1)} s (${res.num_turns ?? '?'} turns, $${res.total_cost_usd?.toFixed(3) ?? '?'})`);
    this.deps.event('agent.oneshot', { ...base, ok: true, result, ...(res.total_cost_usd !== undefined ? { costUsd: res.total_cost_usd } : {}), ...(res.num_turns !== undefined ? { turns: res.num_turns } : {}) });
    this.deps.say(result || 'One-off agent finished.', 'reply');
  }

  private fail(id: number, text: string, why: string, base: Record<string, unknown> = { id, phase: 'end', text }): void {
    const msg = why.length > 300 ? `${why.slice(0, 299)}…` : why;
    this.deps.log('warn', `one-off agent #${id} failed: ${msg}`);
    this.deps.event('agent.oneshot', { ...base, ok: false, error: msg });
    this.deps.say(`One-off agent failed: ${msg}`, 'error');
  }
}
