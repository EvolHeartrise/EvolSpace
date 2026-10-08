// Font URLs. The client serves apps/client/public/fonts at /fonts/ — fonts are
// never loaded from a CDN (the headset may be offline / on a LAN).

export const FONT_BASE = '/fonts/';

export const FONTS = {
  sans: 'Inter-Regular.ttf',
  sansSemiBold: 'Inter-SemiBold.ttf',
  mono: 'JetBrainsMono-Regular.ttf',
} as const;

export type FontKey = keyof typeof FONTS;

export function fontUrl(key: FontKey, base: string = FONT_BASE): string {
  return base.replace(/\/?$/, '/') + FONTS[key];
}

/** Characters pre-rendered at startup so the first frames don't stall on glyph SDF generation. */
export const PRELOAD_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·…–—•°×→←↑↓';
