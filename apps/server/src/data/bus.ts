// Data bus: named channels holding their latest value (JSON or tensor) plus
// ChannelInfo bookkeeping. Every publish creates a new immutable Channel snapshot
// so consumers that hold one back (WS backpressure coalescing) always flush the
// value they were given; per-snapshot encodings (tensor frame, channel.value
// JSON) are computed lazily and cached on the snapshot, shared by all clients.
//
// NOTE: reconstructed on Linux from its callers, tests and README after the
// original was lost to an over-broad `data/` gitignore rule.
import {
  DTYPE_BYTES, encodeTensorFrame, isTensor, makeTensor, tensorFromJson,
  type ChannelInfo, type DType, type TensorValue,
} from '@evolspace/protocol';
import { isChannelName } from '../scene/validate.ts';

/** Bad channel name/value; `status` is the HTTP status to answer with. */
export class ChannelError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ChannelError';
  }
}

/** One published value. Immutable once published; encodings are cached lazily. */
export interface Channel {
  readonly info: ChannelInfo;
  /** JSON value (undefined for tensor channels). */
  readonly value?: unknown;
  readonly tensor?: TensorValue;
  /** Cached binary tensor frame (see DataBus.tensorFrame). */
  frame?: Uint8Array;
  /** Cached `channel.value` message text (see DataBus.jsonMessage). */
  json?: string;
}

export interface PublishOptions {
  producer?: string;
  description?: string;
  /** WS client id of the publisher (for `no-echo`). */
  origin?: string;
}

export type PublishListener = (ch: Channel, origin?: string) => void;

/** Subscription pattern match: exact name, `*` (everything) or `prefix.*` (anything below `prefix.`). */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** "2,3" → [2, 3]; "" → [] (scalar). */
export function parseShape(s: string): number[] {
  const t = s.trim();
  if (t === '') return [];
  return t.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 0) throw new ChannelError(`bad shape '${s}' (expected comma-separated non-negative integers)`);
    return n;
  });
}

const elements = (shape: number[]) => shape.reduce((a, b) => a * b, 1);

function checkDtype(dtype: string): DType {
  if (!Object.hasOwn(DTYPE_BYTES, dtype)) throw new ChannelError(`unknown dtype '${dtype}' (one of ${Object.keys(DTYPE_BYTES).join(', ')})`);
  return dtype as DType;
}

function checkShape(shape: unknown): number[] {
  if (!Array.isArray(shape) || !shape.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new ChannelError(`tensor shape must be an array of non-negative integers, got ${JSON.stringify(shape)}`);
  }
  return shape;
}

/** Normalize a published value: tensors (live or JSON {$tensor, dtype, shape, b64}) are validated. */
function toTensor(v: unknown): TensorValue {
  const t = v as Partial<TensorValue> & { b64?: unknown };
  const dtype = checkDtype(String(t.dtype));
  const shape = checkShape(t.shape);
  let tensor: TensorValue;
  if (t.data && ArrayBuffer.isView(t.data)) tensor = { $tensor: true, dtype, shape, data: t.data };
  else if (typeof t.b64 === 'string') {
    try { tensor = tensorFromJson({ dtype, shape, b64: t.b64 }); } catch (e) { throw new ChannelError(`bad tensor b64: ${(e as Error).message}`); }
  } else throw new ChannelError('tensor value needs data (binary) or b64 (JSON form)');
  const need = elements(shape) * DTYPE_BYTES[dtype];
  if (tensor.data.byteLength !== need) {
    throw new ChannelError(`tensor ${dtype}[${shape.join(',')}] needs ${need} bytes, got ${tensor.data.byteLength}`);
  }
  return tensor;
}

export class DataBus {
  private channels = new Map<string, Channel>();
  private listeners = new Set<PublishListener>();

  /** Publish a JSON value or a tensor. Returns the channel's new info. Throws ChannelError. */
  publish(name: string, value: unknown, opts: PublishOptions = {}): ChannelInfo {
    if (!isChannelName(name)) throw new ChannelError(`invalid channel name ${JSON.stringify(name)} (dot-separated [A-Za-z0-9_:-], ≤200 chars)`);
    if (value === undefined) throw new ChannelError(`no value for channel '${name}'`);
    const prev = this.channels.get(name);
    const base = {
      name,
      updatedAt: Date.now(),
      seq: (prev?.info.seq ?? 0) + 1,
      ...((opts.producer ?? prev?.info.producer) !== undefined ? { producer: opts.producer ?? prev?.info.producer } : {}),
      ...((opts.description ?? prev?.info.description) !== undefined ? { description: opts.description ?? prev?.info.description } : {}),
    };
    let ch: Channel;
    if (isTensor(value)) {
      const tensor = toTensor(value);
      ch = { info: { ...base, kind: 'tensor', dtype: tensor.dtype, shape: tensor.shape, size: tensor.data.byteLength }, tensor };
    } else {
      let text: string;
      try { text = JSON.stringify(value); } catch (e) { throw new ChannelError(`value is not JSON-serializable: ${(e as Error).message}`); }
      if (text === undefined) throw new ChannelError(`value for channel '${name}' is not JSON`);
      ch = { info: { ...base, kind: 'json', size: Buffer.byteLength(text) }, value };
    }
    this.channels.set(name, ch);
    for (const l of [...this.listeners]) {
      try { l(ch, opts.origin); } catch { /* one bad listener must not break delivery to the rest */ }
    }
    return ch.info;
  }

  /** Publish raw little-endian bytes as a tensor (HTTP PUT with X-Dtype/X-Shape). */
  publishRaw(name: string, dtype: string, shape: number[], bytes: Uint8Array, opts: PublishOptions = {}): ChannelInfo {
    const dt = checkDtype(dtype);
    const need = elements(shape) * DTYPE_BYTES[dt];
    if (bytes.byteLength !== need) throw new ChannelError(`${dt}[${shape.join(',')}] needs ${need} bytes, got ${bytes.byteLength}`);
    return this.publish(name, makeTensor(dt, shape, bytes.slice()), opts);
  }

  get(name: string): Channel | undefined { return this.channels.get(name); }
  names(): string[] { return [...this.channels.keys()]; }
  list(): ChannelInfo[] { return [...this.channels.values()].map((c) => c.info).sort((a, b) => a.name.localeCompare(b.name)); }
  delete(name: string): boolean { return this.channels.delete(name); }

  /** Called after every publish with the new snapshot and the publisher's client id (if any). Returns an unsubscribe fn. */
  onPublish(cb: PublishListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Binary tensor frame for a tensor channel (cached per snapshot). */
  static tensorFrame(ch: Channel): Uint8Array {
    if (!ch.tensor) throw new Error(`channel '${ch.info.name}' is not a tensor`);
    return (ch.frame ??= encodeTensorFrame({
      channel: ch.info.name,
      seq: ch.info.seq,
      ...(ch.info.producer !== undefined ? { producer: ch.info.producer } : {}),
    }, ch.tensor));
  }

  /** `channel.value` message text for a JSON channel (cached per snapshot). */
  static jsonMessage(ch: Channel): string {
    return (ch.json ??= JSON.stringify({ type: 'channel.value', channel: ch.info.name, value: ch.value, seq: ch.info.seq }));
  }
}
