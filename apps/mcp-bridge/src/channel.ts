// Voice → Claude channel loop.
//
// Long-polls the server event log for `agent.ask` events (voice requests that
// missed the fast path, widget askAgent calls, …) and pushes each one into the
// running Claude Code session as a `notifications/claude/channel` notification.
// Claude sees it as <channel source="evolspace" kind="voice" target="e-12" …>text</channel>.
//
// Delivery rules:
// - Never replay history: on startup, asks older than the bridge start are skipped.
// - After a disconnect (server down/restarted), asks that arrived while we were
//   away are delivered once (dedupe by seq+ts+text), older ones are not.
// - Never crash: every failure is logged to stderr and retried with backoff.
import type { SceneState, ServerEvent } from '@evolspace/protocol';
import { isServerDown, type EvolApi } from './api.ts';
import { truncate } from './format.ts';
import type { Logger } from './log.ts';

export interface ChannelPumpStats {
  connected: boolean;
  delivered: number;
  lastAsk?: { text: string; at: number };
  lastError?: string;
}

export interface ChannelPumpOptions {
  api: EvolApi;
  /** Sends the channel notification to Claude Code. */
  push(content: string, meta: Record<string, string>): Promise<void>;
  log: Logger;
  /** Long-poll wait passed to the server (ms). */
  waitMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Clock (tests). */
  now?: () => number;
  /** Re-delivery window after a reconnect: asks with ts >= lastOk - slack are candidates (dedupe prevents doubles). */
  reconnectSlackMs?: number;
  /**
   * Black-hole detector: if, this long after a push, Claude has neither called a tool
   * (see `activity`) nor changed the agent status (hooks), assume the session did not
   * register the channel and tell the user in XR. 0 disables. Default 45 s.
   */
  unansweredMs?: number;
  /** Timestamp (this.now() clock) of the latest MCP tool call from the client. */
  activity?: () => number;
}

interface EventsResponse {
  events: ServerEvent[];
  next: number;
}

/** meta keys Claude Code accepts: [A-Za-z0-9_] (others are silently dropped). */
export function sanitizeMeta(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = k.replace(/[^A-Za-z0-9_]/g, '_');
    if (!key || v === undefined || v === null) continue;
    const s = (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').trim();
    if (s) out[key] = truncate(s.replace(/[\r\n]+/g, ' '), 200);
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const hitEntity = (v: unknown): string | undefined => str(obj(v)?.entity);

/**
 * Extract the request text + deictic context from an agent.ask event. Accepts
 * fields at the top level of `data` or nested under `data.context` (the
 * server's VoiceDeps.agentAsk(text, context) leaves the exact shape open).
 */
export function askToNotification(data: Record<string, unknown>): { content: string; meta: Record<string, unknown> } | null {
  const ctx = { ...obj(data.context), ...data };
  const content = str(data.text) ?? str(ctx.text) ?? str(ctx.utterance);
  if (!content) return null;
  const focus = obj(ctx.focus);
  const utteranceId = str(ctx.utteranceId) ?? str(ctx.utterance_id);
  const selected = str(ctx.selected);
  const target =
    str(ctx.target) ?? str(ctx.entity) ?? str(ctx.entityId) ??
    hitEntity(focus?.right) ?? hitEntity(focus?.left) ?? hitEntity(ctx.gaze) ?? selected;
  const kind =
    str(ctx.kind) ?? str(ctx.source) ??
    (utteranceId ? 'voice' : str(ctx.widget) || str(ctx.entity) ? 'widget' : ctx.origin === 'voice' ? 'voice' : 'request');
  return {
    content,
    meta: {
      kind,
      target,
      target_widget: str(ctx.target_widget) ?? str(ctx.widget),
      target_name: str(ctx.target_name) ?? str(ctx.name),
      selected,
      selected_name: selected ? str(ctx.selected_name) : undefined,
      utterance_id: utteranceId,
      // voice_simulate (often Claude itself testing routing) — flagged so it is not mistaken for the user.
      simulated: ctx.simulated === true ? 'true' : undefined,
    },
  };
}

export class ChannelPump {
  readonly stats: ChannelPumpStats = { connected: false, delivered: 0 };
  private running = false;
  private abort = new AbortController();
  private loopDone?: Promise<void>;
  private readonly startedAt: number;
  private readonly now: () => number;
  /** Recently delivered keys (bounded) — prevents double delivery across resyncs. */
  private readonly delivered = new Set<string>();
  /** Pending unanswered-ask checks (cleared on stop). */
  private readonly checks = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ChannelPumpOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopDone = this.loop().catch((e) => this.opts.log.error('channel loop crashed (bug):', e));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    for (const t of this.checks) clearTimeout(t);
    this.checks.clear();
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    const { api, log } = this.opts;
    const waitMs = this.opts.waitMs ?? 25_000;
    const backoffInitial = this.opts.backoffInitialMs ?? 500;
    const backoffMax = this.opts.backoffMaxMs ?? 10_000;
    const slack = this.opts.reconnectSlackMs ?? 2_000;
    let backoff = backoffInitial;
    let cursor: number | undefined; // undefined = need (re)sync
    let floorTs = this.startedAt; // asks older than this are never delivered on (re)sync
    let lastOkAt = this.startedAt;

    while (this.running) {
      try {
        if (cursor === undefined) {
          cursor = await this.resync(floorTs);
          lastOkAt = this.now();
          backoff = backoffInitial;
        }
        const t0 = this.now();
        const r = checkPage(await api.get<EventsResponse>('/api/events', {
          query: { since: cursor, types: 'agent.ask', wait: waitMs },
          timeoutMs: waitMs + 15_000,
          signal: this.abort.signal,
        }));
        if (!r.events.length && this.now() - t0 < waitMs / 2) {
          // The server answered an empty long-poll early (ignores `wait`?): don't spin.
          await sleep(Math.min(1000, waitMs), this.abort.signal);
        }
        const prevOkAt = lastOkAt;
        lastOkAt = this.now();
        this.stats.connected = true;
        backoff = backoffInitial;
        // A server restart between two polls (no connection error seen) leaves our cursor above
        // the fresh log's head. Servers may clamp `next` to our cursor, so on an empty page also
        // ask for the head explicitly.
        const reset = r.next < cursor || (!r.events.length && (await this.headBelow(cursor)));
        if (reset) {
          log.info('event log reset (server restarted); resyncing');
          floorTs = Math.max(this.startedAt, prevOkAt - slack);
          cursor = undefined;
          continue;
        }
        for (const ev of sortBySeq(r.events)) await this.deliver(ev);
        cursor = r.next;
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (this.stats.connected || this.stats.lastError !== msg) {
          (isServerDown(err) ? log.info : log.warn)(`voice channel: ${msg} — retrying`);
        }
        this.stats.connected = false;
        this.stats.lastError = msg;
        // Resync after the outage: deliver asks that arrived while we were away, not older ones.
        floorTs = Math.max(this.startedAt, lastOkAt - slack);
        cursor = undefined;
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoffMax, backoff * 2);
      }
    }
    this.stats.connected = false;
  }

  /**
   * Read the whole (agent.ask-filtered) log once with wait=0, delivering only
   * asks newer than floorTs. Returns the cursor for subsequent long-polls.
   */
  private async resync(floorTs: number): Promise<number> {
    let cursor = 0;
    for (let page = 0; page < 100; page++) {
      const r = checkPage(await this.opts.api.get<EventsResponse>('/api/events', {
        query: { since: cursor, types: 'agent.ask', wait: 0 },
        timeoutMs: 10_000,
        signal: this.abort.signal,
      }));
      if (!this.stats.connected) {
        this.opts.log.info(`voice channel connected to ${this.opts.api.baseUrl}`);
        this.stats.connected = true;
      }
      for (const ev of sortBySeq(r.events)) if (ev.ts >= floorTs) await this.deliver(ev);
      if (!r.events.length || r.next <= cursor) return r.next;
      cursor = r.next;
    }
    return cursor;
  }

  /** True if the server's event head is below `cursor` (its log was reset). Omitting `since` returns next = head. */
  private async headBelow(cursor: number): Promise<boolean> {
    const r = checkPage(await this.opts.api.get<EventsResponse>('/api/events', {
      query: { types: 'agent.ask', limit: 1, wait: 0 },
      timeoutMs: 5_000,
      signal: this.abort.signal,
    }));
    return r.next < cursor;
  }

  private async deliver(ev: ServerEvent): Promise<void> {
    if (ev.type !== 'agent.ask') return;
    const n = askToNotification(ev.data ?? {});
    if (!n) return;
    const key = `${ev.seq}|${ev.ts}|${n.content}`;
    if (this.delivered.has(key)) return;
    this.delivered.add(key);
    if (this.delivered.size > 500) this.delivered.delete(this.delivered.values().next().value as string);

    const heard = `Heard: ${truncate(n.content, 80)}`;
    // If Claude is mid-task the event just queues behind it, so "no reaction yet" means nothing.
    // (Read before our own status post below overwrites it.)
    const busy = !n.meta.simulated && (this.opts.unansweredMs ?? 45_000) > 0 && (await this.agentBusy());
    // Let the headset show that Claude picked the request up (fire-and-forget, before the
    // scene lookup so the feedback is immediate). Not for simulated asks: those are
    // Claude's own routing tests, not the user talking.
    if (!n.meta.simulated) {
      this.opts.api
        .post('/api/agent/status', { state: 'thinking', detail: heard }, { timeoutMs: 3000 })
        .catch((e) => this.opts.log.debug('status post failed:', e));
    }
    const meta = await this.enrich(n.meta);
    try {
      await this.opts.push(n.content, sanitizeMeta(meta));
      this.stats.delivered++;
      this.stats.lastAsk = { text: n.content, at: this.now() };
      if (!n.meta.simulated && !busy) this.watchUnanswered(n.content, heard, this.now());
      this.opts.log.info(`→ Claude: "${truncate(n.content, 80)}"`);
    } catch (e) {
      // The MCP client went away; nothing to retry against. Log and move on.
      this.opts.log.error('failed to push channel notification:', e);
    }
  }

  /** Is the agent status currently thinking/working (per the hooks)? Best effort: false on errors. */
  private async agentBusy(): Promise<boolean> {
    try {
      const r = await this.opts.api.get<{ status?: { state?: string } }>('/api/agent/status', { timeoutMs: 1000, signal: this.abort.signal });
      return r?.status?.state === 'thinking' || r?.status?.state === 'working';
    } catch {
      return false;
    }
  }

  private watchUnanswered(text: string, heard: string, pushedAt: number): void {
    const ms = this.opts.unansweredMs ?? 45_000;
    if (ms <= 0) return;
    const t = setTimeout(() => {
      this.checks.delete(t);
      void this.checkUnanswered(text, heard, pushedAt).catch((e) => this.opts.log.debug('unanswered check failed:', e));
    }, ms);
    t.unref?.();
    this.checks.add(t);
  }

  /**
   * Claude Code drops channel events silently when the session was not started with
   * --dangerously-load-development-channels server:evolspace (or the protocol/provider/org
   * policy gates refuse it). Without this check the headset would show "Heard: …" forever.
   */
  private async checkUnanswered(text: string, heard: string, pushedAt: number): Promise<void> {
    if (!this.running) return;
    if ((this.opts.activity?.() ?? 0) >= pushedAt) return; // Claude called one of our tools: it is on it
    // Hooks replace the status line as soon as Claude starts working (UserPromptSubmit / PreToolUse).
    const r = await this.opts.api.get<{ status?: { state?: string; detail?: string } }>('/api/agent/status', { timeoutMs: 3000 });
    if (r?.status?.detail !== heard) return;
    this.opts.log.warn(`no reaction from Claude Code to "${truncate(text, 60)}" — is the session running with the evolspace channel?`);
    await Promise.allSettled([
      this.opts.api.post('/api/agent/status', { state: 'idle', detail: 'Claude Code did not pick up the request' }, { timeoutMs: 3000 }),
      this.opts.api.post('/api/agent/say', {
        kind: 'error',
        text: `Claude Code hasn't reacted to "${truncate(text, 60)}". Is it running with the voice channel? Start it with scripts/claude.ps1 (or scripts/claude.sh).`,
      }, { timeoutMs: 3000 }),
    ]);
  }

  /** Fill target_widget/target_name from the scene when the event only carries an id. */
  private async enrich(meta: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = meta.target as string | undefined;
    if (!target || (meta.target_widget && meta.target_name)) return meta;
    try {
      const scene = await this.opts.api.get<SceneState>('/api/scene', { timeoutMs: 2000, signal: this.abort.signal });
      const e = scene.entities?.[target];
      if (e) return { ...meta, target_widget: meta.target_widget ?? e.widget, target_name: meta.target_name ?? e.name };
    } catch {
      /* best effort */
    }
    return meta;
  }
}

/** Reject malformed /api/events pages (e.g. a different server on the port) so the loop backs off. */
function checkPage(r: EventsResponse): EventsResponse {
  if (!r || !Array.isArray(r.events) || typeof r.next !== 'number') {
    throw new Error('unexpected /api/events response (is EVOL_URL pointing at an EvolSpace server?)');
  }
  return r;
}

function sortBySeq(events: ServerEvent[] | undefined): ServerEvent[] {
  return [...(events ?? [])].sort((a, b) => a.seq - b.seq);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
