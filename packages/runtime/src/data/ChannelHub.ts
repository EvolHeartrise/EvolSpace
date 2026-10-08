// Client-side view of the data bus: latest value per channel, local listeners,
// and optimistic local publish.
//
// - Values arriving from the server (JSON `channel.value` or binary tensor
//   frames) are cached and fanned out to local listeners.
// - `subscribe` holds one NetClient channel ref per channel (NetClient batches
//   the server subscribe/unsubscribe) and fires immediately with a cached value.
// - `publish` delivers locally right away, then sends to the server. The server
//   echo of an older local value (when 'no-echo' isn't honoured, or values race)
//   is swallowed so consumers never jump back; values from other producers pass.
// - The cache entry is evicted once the last listener is gone, checked on a
//   microtask so a same-tick release+resubscribe (widget re-create) keeps it.
//
// NOTE: reconstructed on Linux from its callers, tests and README after the
// original was lost to an over-broad `data/` gitignore rule.
import { encodeTensorFrame, isTensor, type ChannelValue, type TensorValue } from '@evolspace/protocol';
import type { NetPort } from '../net/types.ts';

type Listener = (value: ChannelValue) => void;

/** Max local publishes remembered per channel for echo suppression. */
const MAX_PENDING_ECHOES = 64;

function echoKey(v: ChannelValue): string {
  if (isTensor(v)) {
    const t = v as TensorValue;
    return `\0tensor:${t.dtype}:${t.shape.join(',')}:${t.data.byteLength}`;
  }
  try { return JSON.stringify(v) ?? '\0undefined'; } catch { return '\0unserializable'; }
}

export class ChannelHub {
  private values = new Map<string, ChannelValue>();
  private seqs = new Map<string, number>();
  private listeners = new Map<string, Set<Listener>>();
  private netRefs = new Map<string, () => void>();
  private pendingEchoes = new Map<string, string[]>();
  private offs: Array<() => void>;

  constructor(
    private readonly net: NetPort,
    private readonly onListenerError?: (channel: string, err: unknown) => void,
  ) {
    this.offs = [
      net.on('channel.value', (m) => this.receive(m.channel, m.value, m.seq)),
      net.onTensor((channel, tensor, seq) => this.receive(channel, tensor, seq)),
    ];
  }

  get(name: string): ChannelValue | undefined { return this.values.get(name); }

  /** Server seq of the latest value seen on `name` (undefined before any). */
  seq(name: string): number | undefined { return this.seqs.get(name); }

  subscribe(name: string, cb: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(cb);
    if (!this.netRefs.has(name)) this.netRefs.set(name, this.net.subscribe(name));
    if (this.values.has(name)) this.call(name, cb, this.values.get(name));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.listeners.get(name);
      if (!s) return;
      s.delete(cb);
      if (s.size > 0) return;
      this.listeners.delete(name);
      this.netRefs.get(name)?.();
      this.netRefs.delete(name);
      queueMicrotask(() => {
        if (this.listeners.has(name)) return; // resubscribed in the same tick
        this.values.delete(name);
        this.seqs.delete(name);
        this.pendingEchoes.delete(name);
      });
    };
  }

  /** Optimistic publish: local listeners first, then the server. */
  publish(name: string, value: ChannelValue): void {
    this.values.set(name, value);
    const pending = this.pendingEchoes.get(name) ?? [];
    pending.push(echoKey(value));
    if (pending.length > MAX_PENDING_ECHOES) pending.shift();
    this.pendingEchoes.set(name, pending);
    this.notify(name, value);
    if (isTensor(value)) this.net.sendBinary(encodeTensorFrame({ channel: name }, value as TensorValue));
    else this.net.send({ type: 'channel.publish', channel: name, value });
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    for (const release of this.netRefs.values()) release();
    this.netRefs.clear();
    this.listeners.clear();
    this.values.clear();
    this.seqs.clear();
    this.pendingEchoes.clear();
  }

  private receive(name: string, value: ChannelValue, seq: number): void {
    this.seqs.set(name, seq);
    const pending = this.pendingEchoes.get(name);
    if (pending?.length) {
      const i = pending.indexOf(echoKey(value));
      if (i >= 0) {
        // Our own value coming back (older or current): already delivered locally.
        pending.splice(0, i + 1);
        if (!pending.length) this.pendingEchoes.delete(name);
        return;
      }
    }
    this.values.set(name, value);
    this.notify(name, value);
  }

  private notify(name: string, value: ChannelValue): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) this.call(name, cb, value);
  }

  private call(name: string, cb: Listener, value: ChannelValue): void {
    try { cb(value); } catch (err) { this.onListenerError?.(name, err); }
  }
}
