// Binary codecs shared by server, runtime and tests. No DOM / Node APIs.
import type { DType, TensorValue, TensorFrameHeader } from './data.ts';
import { AUDIO_FRAME_MAGIC } from './messages.ts';

const CTORS = {
  f32: Float32Array, f16: Uint16Array, i32: Int32Array, u32: Uint32Array,
  i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array,
} as const;

export const DTYPE_BYTES: Record<DType, number> = { f32: 4, f16: 2, i32: 4, u32: 4, i16: 2, u16: 2, i8: 1, u8: 1 };

export function isTensor(v: unknown): v is TensorValue {
  return typeof v === 'object' && v !== null && (v as { $tensor?: unknown }).$tensor === true;
}

export function makeTensor(dtype: DType, shape: number[], data: ArrayBufferView | ArrayBuffer): TensorValue {
  const Ctor = CTORS[dtype];
  const n = shape.reduce((a, b) => a * b, 1);
  const buf = (data instanceof ArrayBuffer ? data : data.buffer) as ArrayBuffer;
  const off = data instanceof ArrayBuffer ? 0 : data.byteOffset;
  // Copy if misaligned so the typed array view is valid.
  const view = off % Ctor.BYTES_PER_ELEMENT === 0
    ? new Ctor(buf, off, n)
    : new Ctor(new Uint8Array(buf, off, n * Ctor.BYTES_PER_ELEMENT).slice().buffer);
  return { $tensor: true, dtype, shape, data: view };
}

/**
 * Header fields besides `channel` are optional; `dtype`/`shape` always come from
 * the tensor (any values passed in the header are ignored).
 */
export function encodeTensorFrame(
  header: Omit<TensorFrameHeader, 'type' | 'dtype' | 'shape'> & Partial<Pick<TensorFrameHeader, 'dtype' | 'shape'>>,
  t: TensorValue,
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ ...header, type: 'channel.value', dtype: t.dtype, shape: t.shape }));
  const headEnd = 4 + json.length;
  const dataStart = Math.ceil(headEnd / 8) * 8;
  const bytes = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength);
  const out = new Uint8Array(dataStart + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(bytes, dataStart);
  return out;
}

export function decodeTensorFrame(frame: ArrayBuffer | Uint8Array): { header: TensorFrameHeader; tensor: TensorValue } {
  // Re-view as a plain Uint8Array: Node Buffers are Uint8Arrays whose slice() is a view into a pooled buffer.
  const u8 = frame instanceof Uint8Array ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hlen))) as TensorFrameHeader;
  const dataStart = Math.ceil((4 + hlen) / 8) * 8;
  const body = u8.slice(dataStart); // copy → aligned, owned buffer
  return { header, tensor: makeTensor(header.dtype, header.shape, body.buffer) };
}

export function isAudioFrame(frame: Uint8Array): boolean {
  return frame.length >= 40 && String.fromCharCode(frame[0], frame[1], frame[2], frame[3]) === AUDIO_FRAME_MAGIC;
}

export function encodeAudioFrame(utteranceId: string, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(40 + pcm.byteLength);
  for (let i = 0; i < 4; i++) out[i] = AUDIO_FRAME_MAGIC.charCodeAt(i);
  for (let i = 0; i < Math.min(36, utteranceId.length); i++) out[4 + i] = utteranceId.charCodeAt(i);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 40);
  return out;
}

export function decodeAudioFrame(frame: Uint8Array): { utteranceId: string; pcm: Int16Array } {
  let id = '';
  for (let i = 4; i < 40 && frame[i] !== 0; i++) id += String.fromCharCode(frame[i]);
  // Copy via a plain Uint8Array view (Node Buffer.slice() would alias a pooled buffer).
  const pcm = new Int16Array(new Uint8Array(frame.buffer, frame.byteOffset + 40, (frame.byteLength - 40) & ~1).slice().buffer);
  return { utteranceId: id, pcm };
}

/** JSON-safe form for SSE / HTTP JSON responses: {$tensor, dtype, shape, b64}. */
export function tensorToJson(t: TensorValue): { $tensor: true; dtype: DType; shape: number[]; b64: string } {
  const bytes = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { $tensor: true, dtype: t.dtype, shape: t.shape, b64: btoa(s) };
}

export function tensorFromJson(j: { dtype: DType; shape: number[]; b64: string }): TensorValue {
  const s = atob(j.b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return makeTensor(j.dtype, j.shape, bytes.buffer);
}
