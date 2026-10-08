// Server event log: a bounded ring buffer of ServerEvents with monotonically
// increasing seq numbers, plus long-poll waiters (GET /api/events?since&wait&types).
// This is how Claude (via the MCP bridge) learns about voice requests, build
// errors, client errors, source crashes, etc.
import type { ServerEvent, ServerEventType } from '@evolspace/protocol';

export interface EventQuery {
  /** Return events with seq > since. Omitted → the most recent `limit` events. */
  since?: number;
  types?: readonly string[];
  /** Max events returned (default 200). */
  limit?: number;
}

export interface EventPage {
  events: ServerEvent[];
  /** Pass as `since` next time. */
  next: number;
}

interface Waiter {
  query: EventQuery;
  resolve: (page: EventPage) => void;
  timer: NodeJS.Timeout;
}

export class EventLog {
  private buf: ServerEvent[] = [];
  private seq = 0;
  private waiters = new Set<Waiter>();
  private listeners = new Set<(e: ServerEvent) => void>();

  constructor(private readonly capacity = 2000) {}

  get lastSeq(): number { return this.seq; }

  emit(type: ServerEventType, data: Record<string, unknown>): ServerEvent {
    const e: ServerEvent = { seq: ++this.seq, ts: Date.now(), type, data };
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    for (const l of this.listeners) {
      try { l(e); } catch { /* listener errors must not break emitters */ }
    }
    for (const w of [...this.waiters]) {
      const page = this.query(w.query);
      if (page.events.length) {
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve(page);
      }
    }
    return e;
  }

  /** Subscribe to every event as it is emitted. */
  onEvent(cb: (e: ServerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * A cursor ahead of the head was issued by a previous server run (seq restarts
   * at 0): treat it as 0 so the caller gets everything retained right away and
   * sees `next` drop below its cursor (= "log reset") instead of waiting for
   * seq to catch up.
   */
  private rebase(q: EventQuery): EventQuery {
    return q.since !== undefined && q.since > this.seq ? { ...q, since: 0 } : q;
  }

  query(query: EventQuery): EventPage {
    const q = this.rebase(query);
    const limit = Math.max(1, Math.min(Number.isFinite(q.limit) ? q.limit! : 200, 2000));
    const types = q.types && q.types.length ? new Set(q.types) : null;
    let matching = this.buf.filter((e) => (q.since === undefined || e.seq > q.since) && (!types || types.has(e.type)));
    if (q.since === undefined) {
      matching = matching.slice(-limit);
      return { events: matching, next: this.seq };
    }
    if (matching.length > limit) {
      matching = matching.slice(0, limit);
      return { events: matching, next: matching[matching.length - 1].seq };
    }
    // Everything up to the head has been scanned (filtered-out events are skipped for good).
    return { events: matching, next: Math.max(q.since, this.seq) };
  }

  /** Long-poll: resolve as soon as at least one matching event exists, or after waitMs with an empty page. */
  wait(query: EventQuery, waitMs: number): Promise<EventPage> {
    const q = this.rebase(query);
    const page = this.query(q);
    if (page.events.length || waitMs <= 0) return Promise.resolve(page);
    // Pin `since` so events emitted while waiting are found even when the caller omitted it.
    const pinned: EventQuery = { ...q, since: q.since ?? this.seq };
    return new Promise((resolve) => {
      const w: Waiter = {
        query: pinned,
        resolve,
        timer: setTimeout(() => { this.waiters.delete(w); resolve(this.query(pinned)); }, waitMs),
      };
      this.waiters.add(w);
    });
  }

  /** Resolve all pending long-polls (shutdown). */
  close(): void {
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(this.query(w.query)); }
    this.waiters.clear();
  }
}
