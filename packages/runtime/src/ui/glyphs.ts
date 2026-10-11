// Keeps every string handed to troika inside the bundled fonts' glyph coverage.
//
// Why: for a character the font lacks, troika asks unicode-font-resolver,
// which fetches fallback fonts from cdn.jsdelivr.net. That breaks the "never
// load fonts from a CDN" rule, and when the headset is offline the fetch
// fails and the text never finishes typesetting (it simply stays blank).
// Claude's replies and widget labels routinely contain emoji / dingbats, so
// we map uncovered characters to covered ones before they reach troika.
//
// Rules: CR/CRLF → LF, tab → two spaces, other control and invisible
// format characters (variation selectors, ZWJ…) are dropped, a few common
// emoji map to covered look-alikes, everything else uncovered becomes '□'.
//
// Fallback fonts: once the server confirms it can serve unicode-font-resolver's
// fonts same-origin (GET /fonts/unicode/available, cached under data/fonts),
// setFontFallback(true) lets uncovered non-emoji characters through — Japanese,
// Arabic, combining marks, … — and troika loads the matching Noto font from there.
// Emoji stay mapped (troika draws one color, so they would be plain outlines).
// A leading newline gets a space in front (troika resolves a font for the
// first character even when it is whitespace, and no font has U+000A).

import { MONO_RANGES, SANS_RANGES } from './glyphCoverage.ts';

export type GlyphSet = 'sans' | 'mono';

const REPLACEMENT = '□'; // □ — covered by Inter and JetBrains Mono

/** Look-alikes for frequent uncovered symbols (targets are checked against coverage at use). */
const LOOKALIKE: Record<number, string> = {
  0x2705: '✓', // ✅ → ✓
  0x2714: '✓', // ✔ → ✓
  0x2611: '✓', // ☑ → ✓
  0x274c: '×', // ❌ → ×
  0x2716: '×', // ✖ → ×
  0x274e: '×', // ❎ → ×
  0x2757: '!', // ❗
  0x2755: '!', // ❕
  0x2753: '?', // ❓
  0x2754: '?', // ❔
  0x27a1: '→', // ➡ → →
  0x2b05: '←', // ⬅ → ←
  0x2b06: '↑', // ⬆ → ↑
  0x2b07: '↓', // ⬇ → ↓
  0x1f449: '→', // 👉 → →
  0x1f534: '●', // 🔴 → ●
  0x1f7e2: '●', // 🟢 → ●
  0x1f7e1: '●', // 🟡 → ●
  0x2b50: '★', // ⭐ → ★
  0x1f680: '→', // 🚀 → →
};

function covered(ranges: readonly number[], cp: number): boolean {
  // Binary search over [start, end] pairs.
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = ranges[mid * 2];
    if (cp < s) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** True if the font family has a glyph for code point `cp`. */
export function hasGlyph(set: GlyphSet, cp: number): boolean {
  return covered(set === 'mono' ? MONO_RANGES : SANS_RANGES, cp);
}

/**
 * Marks that belong to a script's own spelling (Devanagari, Arabic, Hebrew, Thai, …: U+0590 and up, outside the
 * generic combining blocks) — kept, the fallback font for that script draws them.
 */
function isScriptMark(cp: number): boolean {
  const generic = (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff)
    || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f);
  return !generic;
}

/** Invisible format characters that are safe to drop (VS1–16, ZWJ/ZWNJ/ZWSP, word joiner, BOM, tags, VS17+). */
function isIgnorable(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff
    || (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

let fallback = false;
/** Let uncovered (non-emoji) characters through to troika's same-origin fallback fonts. */
export function setFontFallback(on: boolean): void { fallback = on; }
export function fontFallback(): boolean { return fallback; }
const PICTO = /\p{Extended_Pictographic}/u;
/** Combining marks: drawn on top of the previous letter by the same font, so an uncovered one is dropped (□ would break the word). */
const MARK = /\p{M}/u;

// Printable ASCII + LF: covered by both fonts (checked in tests) — the fast path.
const SAFE = /^[\x20-\x7e\n]*$/;

/** Map `text` onto characters the font family covers (see header). */
export function sanitizeText(text: string, set: GlyphSet = 'sans'): string {
  if (SAFE.test(text)) return text.charCodeAt(0) === 10 ? ' ' + text : text;
  const ranges = set === 'mono' ? MONO_RANGES : SANS_RANGES;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // surrogate pair
    if (cp === 10) { out += '\n'; continue; }
    if (cp === 13) {
      if (text.charCodeAt(i + 1) !== 10) out += '\n'; // lone CR; CRLF collapses to the LF that follows
      continue;
    }
    if (cp === 9) { out += '  '; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // other control characters
    if (covered(ranges, cp)) { out += String.fromCodePoint(cp); continue; }
    if (isIgnorable(cp)) continue;
    const ch = String.fromCodePoint(cp);
    if (MARK.test(ch) && !isScriptMark(cp)) continue; // e.g. "Z̴̢a̵l̶g̷o" → "Zalgo"
    if (fallback && !PICTO.test(ch)) { out += ch; continue; }
    const alt = LOOKALIKE[cp];
    out += alt && covered(ranges, alt.codePointAt(0)!) ? alt : REPLACEMENT;
  }
  return out.charCodeAt(0) === 10 ? ' ' + out : out;
}

/** The glyph set for a font URL produced by fontUrl(), or null for a foreign font (left alone). */
export function glyphSetOfFont(font: string | null | undefined): GlyphSet | null {
  if (!font) return 'sans'; // troika's default font is configured to Inter
  if (/JetBrainsMono-[^/]*$/i.test(font)) return 'mono';
  if (/Inter-[^/]*$/i.test(font)) return 'sans';
  return null;
}
