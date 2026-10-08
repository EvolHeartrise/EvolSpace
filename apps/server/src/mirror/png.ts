// Minimal PNG decoder + image statistics. Enough for what Chromium's
// canvas.toDataURL('image/png') produces (8-bit RGB/RGBA/gray, non-interlaced),
// used to sanity-check captures (blank/uniform detection) and in tests.
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(buf: Uint8Array): boolean {
  return buf.length > 8 && SIGNATURE.every((b, i) => buf[i] === b);
}

/** Decodes a data URL ("data:image/png;base64,...") into raw PNG bytes. */
export function pngFromDataUrl(url: string): Buffer {
  const m = /^data:image\/png;base64,(.*)$/s.exec(url);
  if (!m) throw new Error(`mirror: expected a PNG data URL, got ${url.slice(0, 40)}…`);
  const buf = Buffer.from(m[1], 'base64');
  if (!isPng(buf)) throw new Error('mirror: data URL does not contain a valid PNG');
  return buf;
}

export function decodePng(buf: Uint8Array): DecodedPng {
  if (!isPng(buf)) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bitDepth ${bitDepth}, interlace ${interlace})`);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }

  // Expand to RGBA.
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels >= 3) {
      data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2];
      data[o + 3] = channels === 4 ? px[j + 3] : 255;
    } else {
      data[o] = data[o + 1] = data[o + 2] = px[j];
      data[o + 3] = channels === 2 ? px[j + 1] : 255;
    }
  }
  return { width, height, data };
}

export interface ImageStats {
  width: number;
  height: number;
  /** Mean luminance 0..255 over all pixels. */
  mean: number;
  /** Variance of luminance. ~0 means the image is a single flat color. */
  variance: number;
  /** Fraction of pixels whose alpha is < 255. */
  transparentFraction: number;
  /** Number of distinct (quantized) colors, capped at 4096. */
  distinctColors: number;
}

/** Cheap statistics used to detect blank/uniform renders. */
export function imageStats(png: Uint8Array | DecodedPng): ImageStats {
  const img = png instanceof Uint8Array ? decodePng(png) : png;
  const n = img.width * img.height;
  let sum = 0, sumSq = 0, transparent = 0;
  const colors = new Set<number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2], a = img.data[o + 3];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sumSq += l * l;
    if (a < 255) transparent++;
    if (colors.size < 4096) colors.add(((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3));
  }
  const mean = n ? sum / n : 0;
  return {
    width: img.width,
    height: img.height,
    mean,
    variance: n ? sumSq / n - mean * mean : 0,
    transparentFraction: n ? transparent / n : 0,
    distinctColors: colors.size,
  };
}
