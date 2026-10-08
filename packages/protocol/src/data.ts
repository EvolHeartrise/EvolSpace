// Data bus. The server holds named channels, each with a latest value. Anything
// can publish (widgets via links, Python/Rust/bash via HTTP or WS, server-side
// sources) and anything can subscribe. Channel names are dot-separated, e.g.
// "weather.seattle", "interp.resid.proj", "ui.lens.layer".

export type DType = 'f32' | 'f16' | 'i32' | 'u32' | 'i16' | 'u16' | 'i8' | 'u8';

export interface TensorValue {
  /** Discriminator; JSON values never have this key. */
  $tensor: true;
  dtype: DType;
  shape: number[];
  /** Row-major. In the browser f16 is delivered as Uint16Array (raw halves). */
  data: Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
}

/** A channel value is either JSON or a tensor. */
export type ChannelValue = unknown | TensorValue;

export interface ChannelInfo {
  name: string;
  kind: 'json' | 'tensor';
  /** For tensors. */
  dtype?: DType;
  shape?: number[];
  /** Bytes of the latest value. */
  size: number;
  updatedAt: number;
  /** Increments on every publish. */
  seq: number;
  /** Free-form producer label ("interp", "weather-source", "widget:<entityId>"). */
  producer?: string;
  description?: string;
}

/**
 * Binary tensor frame layout (WebSocket binary messages and HTTP bodies with
 * Content-Type application/x-evol-tensor):
 *   bytes 0..3   : u32 LE = header length H
 *   bytes 4..4+H : UTF-8 JSON header (TensorFrameHeader)
 *   pad with zero bytes to the next multiple of 8
 *   remaining    : raw little-endian tensor data
 */
export interface TensorFrameHeader {
  type: 'channel.value';
  channel: string;
  dtype: DType;
  shape: number[];
  seq?: number;
  producer?: string;
}

/** Server-side long-running data source: library/sources/<id>/source.json */
export interface SourceSpec {
  description: string;
  /** Command + args; cwd defaults to the source's folder. Use "{python}" for the repo's default Python. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  autostart?: boolean;
  /** Restart on crash (with backoff). Default true. */
  restart?: boolean;
}

export interface SourceStatus {
  id: string;
  running: boolean;
  pid?: number;
  restarts: number;
  lastExit?: { code: number | null; at: number };
  /** Tail of combined stdout/stderr. */
  logTail: string[];
}
