// troika-three-text wiring: font defaults + warm-up. Kept separate so headless
// code paths (tests) never need to touch troika's worker/WebGL machinery.

import { Text, configureTextBuilder, preloadFont } from 'troika-three-text';
import type { TextFactory, TextLike } from './UiKit.ts';
import { FONTS, PRELOAD_CHARS, fontUrl, type FontKey } from './fonts.ts';

let configured = false;

export function configureTroika(fontBase?: string): void {
  if (configured) return;
  configured = true;
  configureTextBuilder({ defaultFontURL: fontUrl('sans', fontBase), useWorker: true });
}

export const troikaTextFactory: TextFactory = () => new Text() as unknown as TextLike;

/** Pre-generate glyph SDFs for the common character set of each font (async, fire-and-forget). */
export function preloadFonts(fontBase?: string, onDone?: () => void): void {
  const keys = Object.keys(FONTS) as FontKey[];
  let left = keys.length;
  for (const k of keys) {
    try {
      preloadFont({ font: fontUrl(k, fontBase), characters: PRELOAD_CHARS }, () => {
        if (--left === 0) onDone?.();
      });
    } catch (err) {
      console.warn('font preload failed', k, err);
      if (--left === 0) onDone?.();
    }
  }
}
