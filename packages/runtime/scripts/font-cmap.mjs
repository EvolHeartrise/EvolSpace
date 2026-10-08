// Minimal TrueType 'cmap' reader (formats 4 and 12): the set of Unicode code
// points a font maps to a real glyph. Used by gen-glyph-coverage.mjs and by
// test/fonts.test.ts to keep src/ui/glyphCoverage.ts in sync with the fonts.

/** @param {Uint8Array} bytes  @returns {Set<number>} */
export function readCmap(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o);
  const i16 = (o) => dv.getInt16(o);
  const u32 = (o) => dv.getUint32(o);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);

  let cmap = -1;
  for (let i = 0, n = u16(4); i < n; i++) {
    const r = 12 + i * 16;
    if (tag(r) === 'cmap') cmap = u32(r + 8);
  }
  if (cmap < 0) throw new Error('font has no cmap table');

  const out = new Set();
  for (let i = 0, n = u16(cmap + 2); i < n; i++) {
    const r = cmap + 4 + i * 8;
    const platform = u16(r);
    const encoding = u16(r + 2);
    // Unicode subtables only: platform 0 (Unicode) or 3/1, 3/10 (Windows BMP / full).
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const sub = cmap + u32(r + 4);
    const format = u16(sub);
    if (format === 4) {
      const segX2 = u16(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + 2 * s);
        const start = u16(starts + 2 * s);
        const delta = i16(deltas + 2 * s);
        const ro = u16(offsets + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            g = u16(offsets + 2 * s + ro + 2 * (c - start));
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) out.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0, n2 = u32(sub + 12); g < n2; g++) {
        const r2 = sub + 16 + g * 12;
        const a = u32(r2);
        const b = u32(r2 + 4);
        const glyph = u32(r2 + 8);
        for (let c = a; c <= b; c++) if (glyph + (c - a)) out.add(c);
      }
    }
  }
  return out;
}

/** Sorted code points → flat [start, end, start, end, …] inclusive ranges. */
export function toRanges(set) {
  const cps = [...set].sort((a, b) => a - b);
  const out = [];
  for (const c of cps) {
    if (out.length && out[out.length - 1] === c - 1) out[out.length - 1] = c;
    else out.push(c, c);
  }
  return out;
}
