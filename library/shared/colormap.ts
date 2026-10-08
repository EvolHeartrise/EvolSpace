// Colormaps as precomputed sRGB lookup tables.
//
// One source of truth: a LUT of `size` RGBA bytes (sRGB). Textures use it
// directly (set texture.colorSpace = SRGBColorSpace); per-instance / vertex
// colors read it with lutColor(), which converts to three's working space.
//
// Names:
//   'sequential' | 'diverging' | 'palette'  → the theme's ramps (default choice)
//   'viridis' | 'magma' | 'gray'            → classic scientific maps
// Every map takes t in [0, 1]. For signed data use 'diverging' and map
// value v to t = 0.5 + 0.5 * v / maxAbs (see divergingT) so zero is the midpoint.

import type * as THREE from 'three';
import type { Theme } from '@evolspace/protocol';
import { parseHex } from './color.ts';

export const COLORMAPS = ['sequential', 'diverging', 'viridis', 'magma', 'gray', 'palette'] as const;
export type ColormapName = (typeof COLORMAPS)[number];

const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];
const MAGMA = ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'];
const GRAY = ['#101010', '#f0f0f0'];

export function isColormap(name: unknown): name is ColormapName {
  return typeof name === 'string' && (COLORMAPS as readonly string[]).includes(name);
}

/** Hex stops of a colormap (theme-dependent for the theme ramps). */
export function colormapStops(theme: Theme, name: ColormapName): string[] {
  switch (name) {
    case 'sequential': return theme.sequential;
    case 'diverging': return [...theme.diverging];
    case 'viridis': return VIRIDIS;
    case 'magma': return MAGMA;
    case 'gray': return GRAY;
    case 'palette': return theme.palette;
  }
}

export interface Lut {
  name: ColormapName;
  size: number;
  /** size × RGBA, sRGB bytes. */
  bytes: Uint8Array;
}

/**
 * Build a LUT. 'palette' is categorical: the LUT holds `size` entries that
 * step through the palette (no blending), so t = i / palette.length picks color i.
 */
export function buildLut(theme: Theme, name: ColormapName, size = 256): Lut {
  const stops = colormapStops(theme, name).map((h) => parseHex(h) ?? [255, 255, 255]);
  const bytes = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1);
    let r: number, g: number, b: number;
    if (name === 'palette') {
      const k = Math.min(stops.length - 1, Math.floor((i / size) * stops.length));
      [r, g, b] = stops[k];
    } else if (stops.length === 1) {
      [r, g, b] = stops[0];
    } else {
      const x = t * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(x));
      const f = x - k;
      const a = stops[k];
      const c = stops[k + 1];
      r = a[0] + (c[0] - a[0]) * f;
      g = a[1] + (c[1] - a[1]) * f;
      b = a[2] + (c[2] - a[2]) * f;
    }
    bytes[i * 4] = Math.round(r);
    bytes[i * 4 + 1] = Math.round(g);
    bytes[i * 4 + 2] = Math.round(b);
    bytes[i * 4 + 3] = 255;
  }
  return { name, size, bytes };
}

/** LUT index for t in [0, 1] (clamped; NaN → 0). */
export function lutIndex(lut: Lut, t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return lut.size - 1;
  return Math.floor(t * (lut.size - 1) + 0.5);
}

/** Write the LUT color for t into `out` (three working color space). Allocation-free. */
export function lutColor(THREE_: typeof THREE, lut: Lut, t: number, out: THREE.Color): THREE.Color {
  const i = lutIndex(lut, t) * 4;
  return out.setRGB(lut.bytes[i] / 255, lut.bytes[i + 1] / 255, lut.bytes[i + 2] / 255, THREE_.SRGBColorSpace);
}

/** Map a signed value to t in [0, 1] around zero for diverging maps. */
export function divergingT(v: number, maxAbs: number): number {
  if (!(maxAbs > 0)) return 0.5;
  return 0.5 + 0.5 * Math.max(-1, Math.min(1, v / maxAbs));
}

/** t for integer category k on a 'palette' LUT with `n` colors (wraps). */
export function categoryT(k: number, n: number): number {
  const m = Math.max(1, n);
  const i = ((Math.round(k) % m) + m) % m;
  return (i + 0.5) / m;
}

/** Map v from [min, max] to [0, 1] (clamped; degenerate ranges → 0.5). */
export function rangeT(v: number, min: number, max: number): number {
  const d = max - min;
  if (!(d > 0) || !Number.isFinite(d)) return 0.5;
  const t = (v - min) / d;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
