// Color helpers for widgets.
//
// Color props accept, in this order of preference:
//   - theme tokens: 'accent', 'secondary' (= theme.accent2), 'positive',
//     'negative', 'text', 'dim' (= theme.textDim), 'surface', 'border',
//     'background'. Tokens keep widgets on-theme and are what the agent should
//     normally use. (Letters only, because the runtime's prop validator accepts
//     /^[a-z]+$/i names as colors.)
//   - hex: '#4cc3ff', '#4af', '#4cc3ffcc' (alpha ignored)
//   - CSS names / rgb()/hsl() strings understood by THREE.Color
//   - numbers: 0x4cc3ff
// Pure functions; no three.js runtime import.

import type { Theme } from '@evolspace/protocol';

export type ColorInput = string | number | null | undefined;

const TOKENS: Record<string, (t: Theme) => string> = {
  accent: (t) => t.accent,
  secondary: (t) => t.accent2,
  accent2: (t) => t.accent2,
  positive: (t) => t.positive,
  negative: (t) => t.negative,
  text: (t) => t.text,
  dim: (t) => t.textDim,
  textdim: (t) => t.textDim,
  surface: (t) => t.surface,
  border: (t) => t.border,
  background: (t) => t.background,
};

/** Names of the theme tokens accepted by color props (for docs/descriptions). */
export const COLOR_TOKENS = ['accent', 'secondary', 'positive', 'negative', 'text', 'dim', 'surface', 'border', 'background'] as const;

/**
 * Resolve a color prop to a CSS color string three.js understands.
 * Empty/invalid values resolve `fallback` (itself a token or color).
 */
export function resolveColor(theme: Theme, value: ColorInput, fallback: string = 'accent'): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return '#' + (Math.max(0, Math.min(0xffffff, Math.floor(value)))).toString(16).padStart(6, '0');
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (v) {
      const tok = TOKENS[v.toLowerCase()];
      if (tok) return tok(theme);
      if (v.startsWith('palette')) {
        // 'palette3' / 'palette:3' → categorical color 3 (only usable where the
        // runtime validator lets it through, e.g. inside json props).
        const n = Number(v.slice(7).replace(/^[:.]/, ''));
        if (Number.isInteger(n)) return paletteColor(theme, n);
      }
      return v;
    }
  }
  return fallback === value ? theme.accent : resolveColor(theme, fallback, theme.accent);
}

/** Categorical palette color i (wraps, negative-safe). */
export function paletteColor(theme: Theme, i: number): string {
  const p = theme.palette;
  if (!p.length) return theme.accent;
  const k = Math.floor(i);
  return p[((k % p.length) + p.length) % p.length];
}

/** Parse '#rgb' / '#rrggbb' / '#rrggbbaa' into sRGB bytes. Returns null for non-hex input. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split('').map((c) => c + c).join('');
  else if (s.length === 6 || s.length === 8) s = s.slice(0, 6);
  else return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** '#rrggbb' → 0xrrggbb (troika colorRanges etc.). Non-hex → fallback. */
export function hexToInt(hex: string, fallback = 0xffffff): number {
  const rgb = parseHex(hex);
  return rgb ? (rgb[0] << 16) | (rgb[1] << 8) | rgb[2] : fallback;
}

/** Mix two hex colors in sRGB (t=0 → a, t=1 → b). Returns '#rrggbb'; non-hex inputs return a. */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const k = Math.max(0, Math.min(1, t));
  const c = [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * k));
  return '#' + ((c[0] << 16) | (c[1] << 8) | c[2]).toString(16).padStart(6, '0');
}
