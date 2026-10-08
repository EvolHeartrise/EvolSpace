// Cross-language codec check driven by tests/test_codec.py: decodes Python-made
// tensor frames with packages/protocol's codec and emits TS-made frames for Python.
// usage: tsx ts_codec_roundtrip.ts <in.json: base64 frames[]> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeTensorFrame, encodeTensorFrame, makeTensor, tensorToJson } from '../../../packages/protocol/src/codec.ts';

const [inPath, outPath] = process.argv.slice(2);
const frames = JSON.parse(readFileSync(inPath, 'utf8')) as string[];
const decoded = frames.map((b64) => {
  const { header, tensor } = decodeTensorFrame(new Uint8Array(Buffer.from(b64, 'base64')));
  return { header, data: Array.from(tensor.data as ArrayLike<number>, Number), json: tensorToJson(tensor) };
});
const b64 = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const made = {
  f32: b64(encodeTensorFrame({ channel: 'ts.f32', seq: 7, producer: 'ts' }, makeTensor('f32', [2, 3], new Float32Array([1, 2, 3, 4, 5, 6.5])))),
  u8: b64(encodeTensorFrame({ channel: 'ts.u8' }, makeTensor('u8', [5], new Uint8Array([0, 1, 2, 254, 255])))),
  i16: b64(encodeTensorFrame({ channel: 'ts.i16.longer-name_x' }, makeTensor('i16', [2, 2], new Int16Array([-32768, -1, 0, 32767])))),
  f16: b64(encodeTensorFrame({ channel: 'ts.f16' }, makeTensor('f16', [3], new Uint16Array([0x3c00, 0xc000, 0x7bff])))),
  empty: b64(encodeTensorFrame({ channel: 'ts.empty' }, makeTensor('f32', [0, 4], new Float32Array(0)))),
};
writeFileSync(outPath, JSON.stringify({ decoded, made }));
