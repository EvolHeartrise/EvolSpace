// WebSocket client for the EvolSpace server.
//
// - Auto-reconnect with exponential backoff + jitter; never gives up.
// - Sends `hello` on every (re)connect, then re-subscribes all channels that
//   still have references, then flushes queued messages.
// - Text frames: JSON ServerMessage, dispatched to typed `on(type)` listeners.
// - Binary frames: tensor channel values (codec.ts) → `onTensor` listeners.
// - Channel subscriptions are ref-counted: `subscribe(name)` returns a release
//   fn; the server only sees subscribe/unsubscribe on 0↔1 transitions, batched
//   per microtask.
// - While disconnected, "durable" messages (scene ops, commands, publishes,
//   errors…) are queued (bounded); ephemeral ones (poses, audio, voice) drop.

import {
  decodeTensorFrame,
  isAudioFrame,
  type ClientMessage,
  type ClientRole,
  type ServerMessage,
  type TensorValue,
} from '@evolspace/protocol';

/** Minimal surface of the browser WebSocket we rely on (lets tests inject a mock). */
export interface WebSocketLike {
  readonly readyState: number;
  /** Bytes queued but not yet sent (browser WebSocket; optional for mocks). */
  readonly bufferedAmount?: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

export type HelloMessage = Extract<ClientMessage, { type: 'hello' }>;
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
export type TensorListener = (channel: string, tensor: TensorValue, seq: number) => void;

export interface NetStatus {
  /** Socket is open. */
  connected: boolean;
  /** Server hello received on the current socket. */
  ready: boolean;
  /** Reconnect attempts since the last successful open. */
  attempt: number;
}

export interface NetClientOptions {
  /** WebSocket implementation (defaults to globalThis.WebSocket). */
  WebSocketImpl?: WebSocketCtor;
  /** Connect in the constructor (default true). */
  autoConnect?: boolean;
  /** Extra hello fields (userAgent, capabilities, wantPrimary). */
  hello?: Partial<Omit<HelloMessage, 'type' | 'role'>>;
  backoff?: { minMs?: number; maxMs?: number; factor?: number; jitter?: number };
  /** Max queued durable messages while disconnected (default 256). */
  maxQueue?: number;
  /**
   * Give up on a socket that is still CONNECTING after this long and retry
   * (default 8000 ms). A TCP connect to a sleeping/unreachable PC can hang for
   * a minute, during which reconnectNow() could not help.
   */
  connectTimeoutMs?: number;
  /**
   * Ask the server not to echo this client's own channel publishes back
   * (hello capability 'no-echo'; default true). Local publishes are already
   * delivered locally by the ChannelHub, so the echo is redundant traffic.
   */
  noEcho?: boolean;
  /** Timer functions (tests can inject fake ones). */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  /** Diagnostics sink (default console). */
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

/**
 * High-rate state that a newer message supersedes: skipped while the socket's
 * send buffer is backed up (Wi-Fi stall), so it can't delay ops and commands.
 */
const SUPERSEDED: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>(['user.pose']);
const BACKLOG_BYTES = 256 * 1024;

/** Message types that are worth delivering late (after a reconnect). */
const DURABLE: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>([
  'scene.ops', 'scene.undo', 'scene.redo', 'channel.publish', 'widget.event',
  'client.error', 'client.log', 'agent.ask', 'command', 'pose.recording',
]);

export class NetClient {
  readonly url: string;
  readonly role: ClientRole;

  clientId: string | null = null;
  primary = false;
  serverVersion: string | null = null;

  private ws: WebSocketLike | null = null;
  private readonly WS: WebSocketCtor | undefined;
  private readonly opts: NetClientOptions;
  private listeners = new Map<string, Set<(m: ServerMessage) => void>>();
  private anyListeners = new Set<(m: ServerMessage) => void>();
  private tensorListeners = new Set<TensorListener>();
  private statusListeners = new Set<(s: NetStatus) => void>();
  private queue: (ClientMessage)[] = [];
  private channelRefs = new Map<string, number>();
  private pendingSub = new Set<string>();
  private pendingUnsub = new Set<string>();
  private flushScheduled = false;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private connectTimer: unknown = null;
  private closedByUser = false;
  private isReady = false;
  private readonly timers: NonNullable<NetClientOptions['timers']>;

  constructor(url: string, role: ClientRole, opts: NetClientOptions = {}) {
    this.url = url;
    this.role = role;
    this.opts = opts;
    this.WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    if (opts.autoConnect !== false) this.connect();
  }

  // ------------------------------------------------------------------ state

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN;
  }

  /** True once the server's hello arrived on the current connection. */
  get ready(): boolean {
    return this.connected && this.isReady;
  }

  get status(): NetStatus {
    return { connected: this.connected, ready: this.ready, attempt: this.attempt };
  }

  /** HTTP(S) origin of the server derived from the WS URL (for widget bundles, API calls). */
  get httpBase(): string {
    try {
      const u = new URL(this.url);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = '/';
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return '/';
    }
  }

  // ------------------------------------------------------------------ connection

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === WS_OPEN)) return;
    this.clearReconnect();
    if (!this.WS) {
      this.log('error', 'NetClient: no WebSocket implementation available');
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.log('warn', `NetClient: failed to open ${this.url}`, err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.isReady = false;
    const timeoutMs = this.opts.connectTimeoutMs ?? 8000;
    if (timeoutMs > 0) {
      this.connectTimer = this.timers.setTimeout(() => {
        this.connectTimer = null;
        if (this.ws !== ws || ws.readyState === WS_OPEN) return;
        this.log('warn', `NetClient: connecting to ${this.url} timed out after ${timeoutMs} ms`);
        this.abandon(ws);
      }, timeoutMs);
    }
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.sendRaw(this.helloMessage());
      const chans = [...this.channelRefs.keys()];
      this.pendingSub.clear();
      this.pendingUnsub.clear();
      if (chans.length) this.sendRaw({ type: 'channel.subscribe', channels: chans });
      const q = this.queue;
      this.queue = [];
      for (const m of q) this.sendRaw(m);
      this.emitStatus();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.receive(ev.data);
    };
    ws.onerror = () => {
      /* onclose follows; reconnect is handled there */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.abandon(ws);
    };
  }

  /** Drop the current socket (closed or hung) and schedule a reconnect. */
  private abandon(ws: WebSocketLike): void {
    if (this.ws !== ws) return;
    this.clearConnectTimer();
    this.ws = null;
    this.isReady = false;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (ws.readyState === 0 || ws.readyState === WS_OPEN) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.emitStatus();
    if (!this.closedByUser) this.scheduleReconnect();
  }

  private helloMessage(): HelloMessage {
    const extra = this.opts.hello ?? {};
    const caps = [...(extra.capabilities ?? [])];
    if (this.opts.noEcho !== false && !caps.includes('no-echo')) caps.push('no-echo');
    return { ...extra, type: 'hello', role: this.role, capabilities: caps };
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Close and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    this.clearReconnect();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    this.isReady = false;
    if (ws) {
      try { ws.close(1000, 'client closing'); } catch { /* ignore */ }
    }
    this.emitStatus();
  }

  /** Skip the backoff wait and try now (e.g. when the page becomes visible again). */
  reconnectNow(): void {
    if (this.connected || this.closedByUser) return;
    this.clearReconnect();
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closedByUser) return;
    const b = this.opts.backoff ?? {};
    const min = b.minMs ?? 500;
    const max = b.maxMs ?? 10_000;
    const factor = b.factor ?? 1.7;
    const jitter = b.jitter ?? 0.25;
    const base = Math.min(max, min * Math.pow(factor, this.attempt));
    const delay = Math.max(0, base * (1 + (Math.random() * 2 - 1) * jitter));
    this.attempt++;
    this.emitStatus();
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ------------------------------------------------------------------ sending

  send(m: ClientMessage): void {
    if (this.connected) {
      if (SUPERSEDED.has(m.type) && (this.ws!.bufferedAmount ?? 0) > BACKLOG_BYTES) return;
      this.sendRaw(m);
      return;
    }
    if (DURABLE.has(m.type)) {
      const max = this.opts.maxQueue ?? 256;
      if (this.queue.length >= max) this.queue.shift();
      this.queue.push(m);
    }
  }

  /** Binary frames (audio, tensors) are dropped while disconnected. */
  sendBinary(b: Uint8Array): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(b);
    } catch (err) {
      this.log('warn', 'NetClient: binary send failed', err);
    }
  }

  private sendRaw(m: ClientMessage): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(m));
    } catch (err) {
      this.log('warn', `NetClient: send ${m.type} failed`, err);
    }
  }

  // ------------------------------------------------------------------ channels

  /** Ref-counted channel subscription. Returns a release fn (idempotent). */
  subscribe(channel: string): () => void {
    const n = this.channelRefs.get(channel) ?? 0;
    this.channelRefs.set(channel, n + 1);
    if (n === 0) {
      if (this.pendingUnsub.has(channel)) this.pendingUnsub.delete(channel);
      else this.pendingSub.add(channel);
      this.scheduleChannelFlush();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const c = this.channelRefs.get(channel) ?? 0;
      if (c <= 1) {
        this.channelRefs.delete(channel);
        if (this.pendingSub.has(channel)) this.pendingSub.delete(channel);
        else this.pendingUnsub.add(channel);
        this.scheduleChannelFlush();
      } else {
        this.channelRefs.set(channel, c - 1);
      }
    };
  }

  /** Channels with at least one reference. */
  subscribedChannels(): string[] {
    return [...this.channelRefs.keys()];
  }

  private scheduleChannelFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushChannels());
  }

  /** Sends pending subscribe/unsubscribe batches now (normally runs on a microtask). */
  flushChannels(): void {
    this.flushScheduled = false;
    if (!this.connected) {
      // The reconnect handshake re-subscribes everything with refs.
      this.pendingSub.clear();
      this.pendingUnsub.clear();
      return;
    }
    if (this.pendingSub.size) this.sendRaw({ type: 'channel.subscribe', channels: [...this.pendingSub] });
    if (this.pendingUnsub.size) this.sendRaw({ type: 'channel.unsubscribe', channels: [...this.pendingUnsub] });
    this.pendingSub.clear();
    this.pendingUnsub.clear();
  }

  // ------------------------------------------------------------------ receiving

  on<T extends ServerMessage['type']>(type: T, cb: (m: ServerMessageOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const fn = cb as (m: ServerMessage) => void;
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** Every JSON message (after typed listeners). */
  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.anyListeners.add(cb);
    return () => { this.anyListeners.delete(cb); };
  }

  onTensor(cb: TensorListener): () => void {
    this.tensorListeners.add(cb);
    return () => { this.tensorListeners.delete(cb); };
  }

  onStatus(cb: (s: NetStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  /** Feed a raw frame as if it came from the socket (used by tests and local loopback). */
  receive(data: unknown): void {
    if (typeof data === 'string') {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch (err) {
        this.log('warn', 'NetClient: bad JSON frame', err);
        return;
      }
      this.dispatch(msg);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const u8 = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.receiveBinary(u8);
      return;
    }
    // Blob (if binaryType could not be set): decode asynchronously.
    const blob = data as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (blob && typeof blob.arrayBuffer === 'function') {
      blob.arrayBuffer().then((b) => this.receiveBinary(new Uint8Array(b)), (err) => this.log('warn', 'NetClient: blob read failed', err));
    }
  }

  private receiveBinary(u8: Uint8Array): void {
    if (u8.length < 4 || isAudioFrame(u8)) return; // audio is client→server only
    let decoded: ReturnType<typeof decodeTensorFrame>;
    try {
      decoded = decodeTensorFrame(u8);
    } catch (err) {
      this.log('warn', 'NetClient: bad tensor frame', err);
      return;
    }
    const { header, tensor } = decoded;
    for (const cb of this.tensorListeners) {
      try { cb(header.channel, tensor, header.seq ?? 0); } catch (err) { this.log('error', 'NetClient: tensor listener threw', err); }
    }
  }

  private dispatch(msg: ServerMessage): void {
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    if (msg.type === 'hello') {
      this.clientId = msg.clientId;
      this.primary = msg.primary;
      this.serverVersion = msg.serverVersion;
      this.isReady = true;
      this.emitStatus();
    }
    const set = this.listeners.get(msg.type);
    if (set) {
      for (const cb of [...set]) {
        try { cb(msg); } catch (err) { this.log('error', `NetClient: listener for ${msg.type} threw`, err); }
      }
    }
    for (const cb of this.anyListeners) {
      try { cb(msg); } catch (err) { this.log('error', 'NetClient: listener threw', err); }
    }
  }

  private emitStatus(): void {
    const s = this.status;
    for (const cb of this.statusListeners) {
      try { cb(s); } catch (err) { this.log('error', 'NetClient: status listener threw', err); }
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
    if (this.opts.log) this.opts.log(level, message, detail);
    else if (level === 'error') console.error(message, detail ?? '');
    else if (level === 'warn') console.warn(message, detail ?? '');
  }
}
