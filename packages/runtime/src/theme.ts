// EvolSpace visual theme: clean, diagrammatic, dark-glass panels that stay
// legible both over MR passthrough (bright, busy backgrounds) and in VR (dark
// backgrounds). Colors are sRGB hex strings (three converts to linear).
//
// Palette design notes:
// - Categorical palette: 10 hues with similar lightness (L*≈68–80) and
//   moderate chroma so no series dominates; ordered so neighbours contrast.
// - Sequential: monotonic lightness from a deep blue (still visible on the dark
//   glass) to a warm near-white, so magnitude reads even in grayscale.
// - Diverging: blue ↔ neutral ↔ red with a light-gray midpoint (zero is
//   visible but quiet on dark panels).

import type { Theme } from '@evolspace/protocol';

export const DEFAULT_THEME: Readonly<Theme> = Object.freeze({
  background: '#0e131b',
  surface: '#1a2230',
  border: '#3b475a',
  text: '#e9eef5',
  textDim: '#8d99ab',
  accent: '#4cc3ff',
  accent2: '#ffb547',
  positive: '#45d49b',
  negative: '#ff5d6c',
  palette: Object.freeze([
    '#4cc3ff', // sky
    '#ffb547', // amber
    '#45d49b', // mint
    '#ff6f91', // rose
    '#a98bff', // violet
    '#f2dc5d', // lemon
    '#4fd9d4', // teal
    '#ff8a5b', // coral
    '#9ad85a', // lime
    '#e48ad6', // orchid
  ]) as unknown as string[],
  diverging: Object.freeze(['#3f8cff', '#d5d9e0', '#ff4d5e']) as unknown as [string, string, string],
  sequential: Object.freeze([
    '#1d2f5c', '#22488a', '#2366b0', '#2a88c9', '#3caed6', '#66cdd5', '#9fe2c9', '#d5f1bf', '#fff8d6',
  ]) as unknown as string[],
});

/** Runtime-only extras (not part of the widget contract). */
export const SYSTEM_STYLE = Object.freeze({
  /** Default opacity of glass panels. */
  panelOpacity: 0.86,
  /** Corner radius for panels, meters. */
  panelRadius: 0.012,
  /** Agent states → orb colors. */
  agent: Object.freeze({
    idle: '#8d99ab',
    listening: '#4cc3ff',
    transcribing: '#4fd9d4',
    thinking: '#a98bff',
    working: '#ffb547',
    error: '#ff5d6c',
    offline: '#5a6577',
  }),
  /** Hover highlight / selection outline. */
  hover: '#e9eef5',
  selection: '#4cc3ff',
  error: '#ff5d6c',
});

/** Create a theme with overrides (deep-copies arrays so callers can't mutate the default). */
export function createTheme(overrides: Partial<Theme> = {}): Theme {
  const t: Theme = {
    ...DEFAULT_THEME,
    palette: [...DEFAULT_THEME.palette],
    diverging: [...DEFAULT_THEME.diverging] as [string, string, string],
    sequential: [...DEFAULT_THEME.sequential],
    ...overrides,
  };
  return t;
}
