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
// While it runs, clients show it as a small orb floating where the user was when
// they invoked it (OneshotAgentStatus, ServerMessage 'agent.oneshots'): its
// activity comes from the child's stream-json output (tool calls → the same
// labels as the main session's status hook). A finished agent lingers there for
// a few seconds, then disappears.
//
// The child's evolspace MCP bridge runs without the voice channel
// (EVOL_BRIDGE_CHANNEL=0) and its Claude Code hooks don't drive the shared status
// indicator (EVOL_STATUS_HOOK=0), so it never steals the main session's requests
// or clobbers its "working" line.
//
// Env: EVOL_CLAUDE_BIN (default 'claude'), EVOL_ONESHOT_PERMISSION_MODE (default 'auto').
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { OneshotAgentStatus, ServerEventType, Vec3 } from '@evolspace/protocol';
import { describeTool, short } from '../../../scripts/hooks/status.mjs';
import { headPose, placeInFront } from './commands.ts';

export interface OneshotDeps {
  repoRoot: string;
  /** The server's local API URL (EVOL_URL for the child's MCP bridge). */
  baseUrl(): string;
  say(text: string, kind: 'reply' | 'info' | 'error'): void;
  event(type: ServerEventType, data: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** The list of shown agents changed (broadcast it to clients). */
  onChange?(agents: OneshotAgentStatus[]): void;
}

export interface OneshotOptions {
  bin?: string;
  permissionMode?: string;
  /** A one-off agent still running after this long is killed. Default 20 min. */
  timeoutMs?: number;
  /** Requests beyond this many running agents are refused. Default 3. */
  maxConcurrent?: number;
  /** How long a finished agent stays visible. Default 8 s. */
  lingerMs?: number;
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
  'automatically, so do not also send it with `say`. Your progress is already shown in the space; do not call `status`.',
  'Do not ask questions: if the request is ambiguous, take the sensible reading and say what you did.',
].join('\n');

/** Agents invoked from (nearly) the same spot stack upwards instead of overlapping. */
const STACK_RADIUS = 0.12;
const STACK_STEP = 0.08;

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

interface StreamResult { is_error?: boolean; result?: string; subtype?: string; total_cost_usd?: number; num_turns?: number }

/**
 * One line of `claude -p --output-format stream-json`: the activity it implies
 * (tool call → working + label, text → thinking) and/or the final result.
 */
export function parseStreamLine(line: string): { activity?: { state: 'thinking' | 'working'; detail: string }; result?: StreamResult } {
  let m: { type?: string; message?: { content?: unknown } } & StreamResult;
  try { m = JSON.parse(line); } catch { return {}; }
  if (m?.type === 'result') return { result: m };
  if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) return {};
  const blocks = m.message.content as Array<{ type?: string; name?: string; input?: unknown }>;
  const tool = blocks.filter((b) => b?.type === 'tool_use').at(-1);
  if (tool) return { activity: { state: 'working', detail: short(describeTool(String(tool.name ?? ''), tool.input) ?? 'Working', 70) } };
  if (blocks.some((b) => b?.type === 'text' || b?.type === 'thinking')) return { activity: { state: 'thinking', detail: 'Thinking' } };
  return {};
}

interface Agent {
  id: number;
  child: ChildProcess | null;
  status: OneshotAgentStatus;
  timedOut: boolean;
}

export class OneshotAgents {
  private readonly agents = new Map<number, Agent>();
  private nextId = 1;
  private closed = false;
  private readonly bin: string;
  private readonly permissionMode: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly lingerMs: number;
  private readonly spawn: typeof nodeSpawn;
  private readonly now: () => number;

  constructor(private readonly deps: OneshotDeps, opts: OneshotOptions = {}) {
    this.bin = opts.bin ?? process.env.EVOL_CLAUDE_BIN ?? 'claude';
    const mode = opts.permissionMode ?? process.env.EVOL_ONESHOT_PERMISSION_MODE ?? 'auto';
    this.permissionMode = /^[A-Za-z]+$/.test(mode) ? mode : 'auto'; // a bare token: argv may go through a shell on Windows
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.lingerMs = opts.lingerMs ?? 8_000;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
  }

  /** Running agents (finished ones still lingering on screen don't count). */
  get count(): number {
    let n = 0;
    for (const a of this.agents.values()) if (!a.status.done) n++;
    return n;
  }

  /** What clients show: running agents and recently finished ones. */
  list(): OneshotAgentStatus[] {
    return [...this.agents.values()].map((a) => ({ ...a.status }));
  }

  /**
   * Start a one-off agent for `text`. `context.head` (the invoking head pose)
   * places its orb. Returns its id, or null if refused.
   */
  ask(text: string, context: Record<string, unknown> = {}): number | null {
    if (this.closed) return null;
    if (this.count >= this.maxConcurrent) {
      this.deps.say(`Already running ${this.count} one-off agents; try again when one finishes.`, 'info');
      return null;
    }
    const id = this.nextId++;
    const env: NodeJS.ProcessEnv = { ...process.env, EVOL_URL: this.deps.baseUrl(), EVOL_STATUS_HOOK: '0', EVOL_BRIDGE_CHANNEL: '0' };
    for (const k of SESSION_ENV) delete env[k];
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
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
    const { position, rotation } = this.place(context.head);
    const a: Agent = {
      id, child, timedOut: false,
      status: { id, text, state: 'thinking', detail: 'Starting', since: this.now(), position, rotation },
    };
    this.agents.set(id, a);

    let result: StreamResult | null = null;
    let buf = '';
    let err = '';
    const onLine = (line: string) => {
      if (!line.trim()) return;
      const p = parseStreamLine(line);
      if (p.result) result = p.result;
      if (p.activity && !a.status.done && (p.activity.state !== a.status.state || p.activity.detail !== a.status.detail)) {
        a.status = { ...a.status, ...p.activity };
        this.changed();
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      if (buf.length > 4_000_000) buf = ''; // a runaway line: drop it
    });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => { err = (err + c).slice(-4000); });
    child.stdin?.on('error', () => { /* the exit handler reports it */ });
    child.stdin?.end(oneshotPrompt(text, context));

    const timer = setTimeout(() => { a.timedOut = true; child.kill(); }, this.timeoutMs);
    timer.unref?.();
    let ended = false;
    const end = (code: number | null, spawnError?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      onLine(buf);
      this.finish(a, code, result, err, spawnError);
    };
    child.on('error', (e) => end(null, e));
    child.on('close', (code) => end(code));

    this.deps.log('info', `one-off agent #${id} started (pid ${child.pid ?? '?'}): ${text}`);
    this.deps.event('agent.oneshot', { id, phase: 'start', text, position, ...(context.utteranceId ? { utteranceId: context.utteranceId } : {}) });
    this.changed();
    return id;
  }

  /** Kill every running one-off agent (server shutdown). */
  close(): void {
    this.closed = true;
    for (const a of this.agents.values()) a.child?.kill();
  }

  /** In front of the invoking head pose (like a spawned widget), stacked above agents already there. */
  private place(head: unknown): { position: Vec3; rotation: OneshotAgentStatus['rotation'] } {
    const t = placeInFront(headPose(head), [0.3, 0.3, 0.3]);
    const p: Vec3 = [t.position[0], t.position[1], t.position[2]];
    const others = [...this.agents.values()].map((a) => a.status.position);
    while (others.some((o) => Math.hypot(o[0] - p[0], o[2] - p[2]) < STACK_RADIUS && Math.abs(o[1] - p[1]) < STACK_STEP * 0.9)) p[1] += STACK_STEP;
    return { position: p, rotation: t.rotation };
  }

  private changed(): void {
    try { this.deps.onChange?.(this.list()); } catch (e) { this.deps.log('warn', `one-off agents: onChange failed: ${(e as Error).message}`); }
  }

  /** Mark an agent done (it stays visible for lingerMs) and tell clients. */
  private settle(a: Agent, state: 'idle' | 'error', detail: string): void {
    a.child = null;
    a.status = { ...a.status, state, detail, done: true };
    this.changed();
    const t = setTimeout(() => {
      if (this.agents.get(a.id) === a) { this.agents.delete(a.id); this.changed(); }
    }, this.lingerMs);
    t.unref?.();
  }

  private finish(a: Agent, code: number | null, res: StreamResult | null, err: string, spawnError?: Error): void {
    const durationMs = this.now() - a.status.since;
    const secs = `${Math.round(durationMs / 1000)}s`;
    const base = { id: a.id, phase: 'end', text: a.status.text, durationMs, exitCode: code };
    let why: string | null = null;
    if (spawnError) {
      why = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? `'${this.bin}' (Claude Code CLI) is not on the server's PATH (set EVOL_CLAUDE_BIN)`
        : spawnError.message;
    } else if (a.timedOut) {
      why = `timed out after ${Math.round(this.timeoutMs / 60_000)} min and was stopped`;
    }
    const result = typeof res?.result === 'string' ? res.result.trim() : '';
    if (!why && (!res || res.is_error || code !== 0)) {
      why = result || res?.subtype || err.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
    }
    if (why) {
      this.fail(a.id, a.status.text, why, { ...base, ...(res?.total_cost_usd !== undefined ? { costUsd: res.total_cost_usd } : {}) });
      this.settle(a, 'error', `Failed after ${secs}`);
      return;
    }
    this.deps.log('info', `one-off agent #${a.id} done in ${(durationMs / 1000).toFixed(1)} s (${res!.num_turns ?? '?'} turns, $${res!.total_cost_usd?.toFixed(3) ?? '?'})`);
    this.deps.event('agent.oneshot', { ...base, ok: true, result, ...(res!.total_cost_usd !== undefined ? { costUsd: res!.total_cost_usd } : {}), ...(res!.num_turns !== undefined ? { turns: res!.num_turns } : {}) });
    this.deps.say(result || 'One-off agent finished.', 'reply');
    this.settle(a, 'idle', `Done in ${secs}`);
  }

  private fail(id: number, text: string, why: string, base: Record<string, unknown> = { id, phase: 'end', text }): void {
    const msg = why.length > 300 ? `${why.slice(0, 299)}…` : why;
    this.deps.log('warn', `one-off agent #${id} failed: ${msg}`);
    this.deps.event('agent.oneshot', { ...base, ok: false, error: msg });
    this.deps.say(`One-off agent failed: ${msg}`, 'error');
  }
}
