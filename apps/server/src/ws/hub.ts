// WebSocket hub: client registry, roles, primary-xr election, broadcast and
// keepalive. Message semantics live in handlers.ts; this file is transport.
//
// Protocol notes:
// - The server sends nothing until the client's `hello`; it then replies with
//   `hello` + initial state (see app.ts onHello). Messages before hello are
//   handled with role 'tool'.
// - Primary election: among xr clients that want it (wantPrimary defaults to
//   true), the most recent hello wins. When the primary disconnects, the most
//   recently connected remaining xr client is promoted. Clients whose primary
//   flag changes get a fresh `hello` message carrying the new flag.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { ClientRole, ServerMessage } from '@evolspace/protocol';
import { ClientConnection } from './client.ts';
import { shortId } from '../util/ids.ts';
import type { Logger } from '../log.ts';

export interface HubOptions {
  highWaterMark: number;
  serverVersion: string;
  log: Logger;
  /** Called after a client's hello has been processed and acknowledged. */
  onHello?: (c: ClientConnection) => void;
  onText?: (c: ClientConnection, msg: Record<string, unknown> & { type: string }) => void;
  onBinary?: (c: ClientConnection, bytes: Uint8Array) => void;
  onClose?: (c: ClientConnection) => void;
  onPrimaryChange?: (primary: ClientConnection | null, previous: ClientConnection | null) => void;
  /** Keepalive interval (ms). */
  pingMs?: number;
  maxPayload?: number;
}

const ROLES: ClientRole[] = ['xr', 'desktop', 'mirror', 'tool'];

export class WsHub {
  readonly clients = new Map<string, ClientConnection>();
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<string, WebSocket>();
  private alive = new Map<string, boolean>();
  private pingTimer: NodeJS.Timeout;

  constructor(private readonly o: HubOptions) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: o.maxPayload ?? 512 * 1024 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.pingTimer = setInterval(() => this.keepalive(), o.pingMs ?? 15_000);
    this.pingTimer.unref();
  }

  /** Accept an HTTP upgrade for /ws. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  get primary(): ClientConnection | null {
    for (const c of this.clients.values()) if (c.primary) return c;
    return null;
  }

  get(id: string): ClientConnection | undefined { return this.clients.get(id); }

  send(clientId: string, msg: ServerMessage): void { this.clients.get(clientId)?.send(msg); }

  /** Send to every helloed client matching the filter. Serializes once. */
  broadcast(msg: ServerMessage, filter?: (c: ClientConnection) => boolean): number {
    const text = JSON.stringify(msg);
    let n = 0;
    for (const c of this.clients.values()) {
      if (!c.helloed || (filter && !filter(c))) continue;
      c.send(text);
      n++;
    }
    return n;
  }

  /** Process a client hello: set role, maybe elect, ack. */
  hello(c: ClientConnection, msg: { role?: unknown; userAgent?: unknown; capabilities?: unknown; wantPrimary?: unknown }): void {
    const role = ROLES.includes(msg.role as ClientRole) ? (msg.role as ClientRole) : 'tool';
    const prevPrimary = this.primary; // before this hello possibly demotes c (re-hello with another role)
    c.role = role;
    c.userAgent = typeof msg.userAgent === 'string' ? msg.userAgent.slice(0, 300) : undefined;
    c.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === 'string') : [];
    c.wantPrimary = msg.wantPrimary !== false;
    c.helloed = true;
    if (role === 'xr' && c.wantPrimary) c.primaryRequestedAt = Date.now() + Math.random() * 1e-3; // tie-break
    if (role !== 'xr' && c.primary) c.primary = false;
    const changed = this.elect(prevPrimary);
    // Ack (unless elect() already sent this client an updated hello).
    if (!changed.has(c.id)) c.send({ type: 'hello', clientId: c.id, serverVersion: this.o.serverVersion, primary: c.primary });
    this.o.log.info(`client ${c.id} hello role=${role}${c.primary ? ' (primary)' : ''}${c.userAgent ? ` ua="${c.userAgent.slice(0, 60)}"` : ''}`);
    this.o.onHello?.(c);
  }

  /**
   * Re-run primary election. Returns ids of clients whose primary flag changed (they were sent a new hello).
   * `previous`: the primary before the triggering change (a departed or just-demoted client), if known.
   */
  elect(previous?: ClientConnection | null): Set<string> {
    const prev = previous !== undefined ? previous : this.primary;
    const xr = [...this.clients.values()].filter((c) => c.helloed && c.role === 'xr' && c.open);
    const wanting = xr.filter((c) => c.wantPrimary);
    const pool = wanting.length ? wanting : xr;
    let best: ClientConnection | null = null;
    for (const c of pool) {
      const key = Math.max(c.primaryRequestedAt, c.connectedAt);
      if (!best || key > Math.max(best.primaryRequestedAt, best.connectedAt)) best = c;
    }
    const changed = new Set<string>();
    if (best === prev) return changed;
    for (const c of this.clients.values()) {
      const should = c === best;
      if (c.primary !== should) {
        c.primary = should;
        changed.add(c.id);
        if (c.helloed) c.send({ type: 'hello', clientId: c.id, serverVersion: this.o.serverVersion, primary: should });
      }
    }
    this.o.onPrimaryChange?.(best, prev);
    return changed;
  }

  summary(): Array<{ id: string; role: ClientRole; primary: boolean; userAgent?: string; address: string; connectedAt: number; subscriptions: number; pending: number }> {
    return [...this.clients.values()].filter((c) => c.helloed).map((c) => ({
      id: c.id, role: c.role, primary: c.primary, ...(c.userAgent ? { userAgent: c.userAgent } : {}),
      address: c.remoteAddress, connectedAt: c.connectedAt, subscriptions: c.subscriptions().length, pending: c.pendingChannels,
    }));
  }

  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const ws of this.sockets.values()) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    // Give close frames a moment, then terminate stragglers.
    await new Promise((r) => setTimeout(r, 100));
    for (const ws of this.sockets.values()) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // ------------------------------------------------------------------ internals

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const id = shortId('c', (x) => this.clients.has(x));
    const c = new ClientConnection(id, ws, this.o.highWaterMark, req.socket.remoteAddress ?? '');
    this.clients.set(id, c);
    this.sockets.set(id, ws);
    this.alive.set(id, true);
    ws.on('pong', () => this.alive.set(id, true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.alive.set(id, true);
      try {
        if (isBinary) {
          const buf = toU8(data);
          // Plain Uint8Array view: Buffer.slice() aliases pooled memory, which breaks decoders that copy via slice().
          this.o.onBinary?.(c, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          return;
        }
        const text = toU8(data).toString();
        let msg: unknown;
        try { msg = JSON.parse(text); } catch {
          this.o.log.warn(`client ${id}: invalid JSON message`);
          return;
        }
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
          this.o.log.warn(`client ${id}: message without a "type"`);
          return;
        }
        const m = msg as Record<string, unknown> & { type: string };
        if (m.type === 'hello') this.hello(c, m as Parameters<WsHub['hello']>[1]);
        else this.o.onText?.(c, m);
      } catch (e) {
        this.o.log.error(`client ${id}: handler error: ${(e as Error).stack ?? e}`);
      }
    });
    ws.on('close', () => {
      this.clients.delete(id);
      this.sockets.delete(id);
      this.alive.delete(id);
      c.dispose();
      const wasPrimary = c.primary;
      c.primary = false;
      if (c.helloed) this.o.log.info(`client ${id} (${c.role}) disconnected`);
      this.o.onClose?.(c);
      if (wasPrimary) this.elect(c);
    });
    ws.on('error', (e) => this.o.log.warn(`client ${id} socket error: ${e.message}`));
  }

  private keepalive(): void {
    for (const [id, ws] of this.sockets) {
      if (!this.alive.get(id)) { ws.terminate(); continue; }
      this.alive.set(id, false);
      try { ws.ping(); } catch { /* closing */ }
    }
  }
}

function toU8(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
