// Verifies the fonts the runtime references exist in apps/client/public/fonts
// and are well-formed TrueType files (sfnt header + required tables).

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FONTS } from '../src/ui/fonts.ts';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/client/public/fonts');

function tables(buf: Buffer): Map<string, { offset: number; length: number }> {
  const n = buf.readUInt16BE(4);
  const out = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    out.set(buf.toString('latin1', o, o + 4), { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) });
  }
  return out;
}

/** Family name (nameID 1) from the 'name' table, UTF-16BE Windows records. */
function familyName(buf: Buffer, name: { offset: number }): string | null {
  const base = name.offset;
  const count = buf.readUInt16BE(base + 2);
  const strOff = base + buf.readUInt16BE(base + 4);
  for (let i = 0; i < count; i++) {
    const r = base + 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const nameId = buf.readUInt16BE(r + 6);
    if (platform === 3 && nameId === 1) {
      const len = buf.readUInt16BE(r + 8);
      const off = strOff + buf.readUInt16BE(r + 10);
      const s = buf.subarray(off, off + len);
      let out = '';
      for (let j = 0; j < s.length; j += 2) out += String.fromCharCode(s.readUInt16BE(j));
      return out;
    }
  }
  return null;
}

describe('bundled fonts', () => {
  for (const [key, file] of Object.entries(FONTS)) {
    it(`${key}: ${file} is a valid TrueType font`, () => {
      const p = join(FONT_DIR, file);
      expect(existsSync(p), p).toBe(true);
      const buf = readFileSync(p);
      expect(buf.length).toBeGreaterThan(50_000);
      expect(buf.readUInt32BE(0)).toBe(0x00010000);
      const t = tables(buf);
      for (const req of ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name']) expect(t.has(req), req).toBe(true);
      for (const { offset, length } of t.values()) expect(offset + length).toBeLessThanOrEqual(buf.length);
      const fam = familyName(buf, t.get('name')!);
      expect(fam).toMatch(file.startsWith('Inter') ? /^Inter/ : /^JetBrains Mono/);
    });
  }

  it('glyph coverage table (src/ui/glyphCoverage.ts) matches the font files', async () => {
    // @ts-expect-error — plain JS helper shared with scripts/gen-glyph-coverage.mjs
    const { readCmap, toRanges } = await import('../scripts/font-cmap.mjs');
    const { SANS_RANGES, MONO_RANGES } = await import('../src/ui/glyphCoverage.ts');
    const cmap = (f: string): Set<number> => readCmap(readFileSync(join(FONT_DIR, f)));
    const regular = cmap(FONTS.sans);
    const semibold = cmap(FONTS.sansSemiBold);
    const sans = new Set([...regular].filter((c) => semibold.has(c)));
    const hint = 'regenerate with: node packages/runtime/scripts/gen-glyph-coverage.mjs';
    expect(toRanges(sans), hint).toEqual(SANS_RANGES);
    expect(toRanges(cmap(FONTS.mono)), hint).toEqual(MONO_RANGES);
  });

  it('ships the licenses', () => {
    expect(existsSync(join(FONT_DIR, 'Inter-LICENSE.txt'))).toBe(true);
    expect(existsSync(join(FONT_DIR, 'JetBrainsMono-LICENSE.txt'))).toBe(true);
  });
});
