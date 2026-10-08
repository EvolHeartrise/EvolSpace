// ScreenshotRequest.background parsing: 'scene' | 'transparent' | any CSS color.
import * as THREE from 'three';

export type BackgroundSpec =
  | { mode: 'scene' }
  | { mode: 'transparent' }
  | { mode: 'color'; color: THREE.Color; alpha: number };

/** Throws a descriptive error for strings that are not a valid CSS color. */
export function parseBackground(bg: string | undefined): BackgroundSpec {
  if (bg === undefined || bg === '' || bg === 'scene') return { mode: 'scene' };
  if (bg === 'transparent') return { mode: 'transparent' };
  const rgba = cssColorToRgba(bg);
  if (!rgba) throw new Error(`mirror: invalid background ${JSON.stringify(bg)} (use 'scene', 'transparent' or a CSS color)`);
  const [r, g, b, a] = rgba;
  if (a === 0) return { mode: 'transparent' };
  const color = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return { mode: 'color', color, alpha: a };
}

/** Uses the browser's CSS parser (via a 2D context) so every CSS color syntax works. */
export function cssColorToRgba(css: string): [number, number, number, number] | null {
  if (typeof CSS !== 'undefined' && !CSS.supports('color', css)) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = css;
  const s = String(ctx.fillStyle);
  if (s.startsWith('#') && s.length === 7) {
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  return null;
}
