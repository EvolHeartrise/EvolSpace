// One connected WebSocket client: role, primary flag, channel subscriptions and
// a backpressure-aware send path.
//
// Backpressure: scene/agent/control messages are always queued (they must not be
// lost). Channel values are *state*, so when the socket's bufferedAmount is above
// the high-water mark we keep only the latest value per channel and flush those
// when the buffer drains. A slow Quest on Wi-Fi therefore receives the newest
// tensors at the rate it can absorb instead of an ever-growing backlog.
import type { ClientRole, ServerMessage } from '@evolspace/protocol';
import { DataBus, matchesPattern, type Channel } from '../data/bus.ts';

/** Subset of ws.WebSocket used here (lets tests inject a fake socket). */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export class ClientConnection {
  role: ClientRole = 'tool';
  primary = false;
  wantPrimary = true;
  helloed = false;
  userAgent?: string;
  capabilities: string[] = [];
  readonly connectedAt = Date.now();
  /** When this client last asked to be primary (most recent wins). */
  primaryRequestedAt = 0;
  /** A malformed user.pose was already reported (avoid a 30 Hz warning flood). */
  badPoseWarned = false;

  private exact = new Set<string>();
  private patterns = new Set<string>();
  private pending = new Map<string, Channel>();
  private flushTimer: NodeJS.Timeout | null = null;
  readonly stats = { sent: 0, coalesced: 0, bytes: 0 };

  constructor(
    readonly id: string,
    private readonly socket: SocketLike,
    private readonly highWaterMark: number,
    readonly remoteAddress = '',
  ) {}

  get open(): boolean { return this.socket.readyState === OPEN; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }

  /** Send a control message (never dropped). Accepts a pre-serialized string for broadcasts. */
  send(msg: ServerMessage | string): void {
    if (!this.open) return;
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.raw(text);
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.open) this.raw(bytes);
  }

  // ------------------------------------------------------------ channels

  subscribe(names: string[]): void {
    for (const n of names) (n === '*' || n.endsWith('.*') ? this.patterns : this.exact).add(n);
  }
  unsubscribe(names: string[]): void {
    for (const n of names) {
      this.exact.delete(n);
      this.patterns.delete(n);
      if (!this.isSubscribed(n)) this.pending.delete(n);
    }
  }
  isSubscribed(name: string): boolean {
    if (this.exact.has(name)) return true;
    for (const p of this.patterns) if (matchesPattern(p, name)) return true;
    return false;
  }
  subscriptions(): string[] { return [...this.exact, ...this.patterns]; }

  /** Deliver a channel value, coalescing latest-per-channel under backpressure. */
  sendChannel(ch: Channel): void {
    if (!this.open) return;
    const name = ch.info.name;
    if (this.pending.size > 0 || this.socket.bufferedAmount > this.highWaterMark) {
      if (this.pending.has(name)) this.stats.coalesced++;
      this.pending.delete(name); // re-insert at the end: flush order follows recency
      this.pending.set(name, ch);
      this.scheduleFlush();
      return;
    }
    this.writeChannel(ch);
  }

  /** Values currently held back by backpressure (for tests/diagnostics). */
  get pendingChannels(): number { return this.pending.size; }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
  }

  private writeChannel(ch: Channel): void {
    if (ch.tensor) this.raw(DataBus.tensorFrame(ch));
    else this.raw(DataBus.jsonMessage(ch));
  }

  private raw(data: string | Uint8Array): void {
    this.stats.sent++;
    this.stats.bytes += typeof data === 'string' ? data.length : data.byteLength;
    try {
      this.socket.send(data);
    } catch {
      /* socket closing; the close handler cleans up */
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 8);
  }

  private flush(): void {
    if (!this.open) { this.pending.clear(); return; }
    while (this.pending.size > 0 && this.socket.bufferedAmount <= this.highWaterMark) {
      const [name, ch] = this.pending.entries().next().value as [string, Channel];
      this.pending.delete(name);
      this.writeChannel(ch);
    }
    if (this.pending.size > 0) this.scheduleFlush();
  }
}
