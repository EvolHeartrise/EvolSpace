// Small stroke icons (24×24 grid, currentColor) for the debug dashboard.

import type { CSSProperties } from 'preact';

const P = {
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2 M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 7.5-2',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-5-5',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  grid: 'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3z M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  x: 'M6 6l12 12 M18 6L6 18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  target: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  duplicate: 'M8 8h12v12H8z M4 16V4h12 M14 11v6 M11 14h6',
  plus: 'M12 5v14 M5 12h14',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17h.01',
  panelLeft: 'M3 4h18v16H3z M9 4v16',
  panelRight: 'M3 4h18v16H3z M15 4v16',
  panelBottom: 'M3 4h18v16H3z M3 14h18',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M16 4v4 M10 10v4 M18 16v4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  radio: 'M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z M8 8a5.5 5.5 0 0 0 0 8 M16 8a5.5 5.5 0 0 1 0 8 M5 5a10 10 0 0 0 0 14 M19 5a10 10 0 0 1 0 14',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  bot: 'M5 9h14v10H5z M12 5v4 M9 13h.01 M15 13h.01 M9 16h6 M12 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  cpu: 'M7 7h10v10H7z M10 10h4v4h-4z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12 M11 11V4.5a1.5 1.5 0 0 1 3 0V12 M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15a1.6 1.6 0 0 1 2.6-1.8L8 15.5',
  view: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  image: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M15.5 8.5h.01',
  save: 'M5 3h11l3 3v15H5z M8 3v5h7V3 M8 21v-7h8v7',
  folder: 'M3 6h6l2 2h10v11H3z',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4 M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4',
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  headset: 'M3 9h18v7h-5l-2-2.5h-4L8 16H3z M7 12.5h.01 M17 12.5h.01',
  check: 'M5 12l5 5 9-10',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  crosshair: 'M12 2v5 M12 17v5 M2 12h5 M17 12h5 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  hide: 'M4 20L20 4 M4 4h16v16H4z',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  bug: 'M8 9h8v8a4 4 0 0 1-8 0z M9 9V7a3 3 0 0 1 6 0v2 M4 13h4 M16 13h4 M5 8l3 2 M19 8l-3 2 M5 19l3-2 M19 19l-3-2',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  dot: 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 15, class: cls, title, style }: { name: IconName; size?: number; class?: string; title?: string; style?: CSSProperties }) {
  return (
    <svg class={`dbg-icon${cls ? ` ${cls}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width={1.8} stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'} style={style}>
      {title ? <title>{title}</title> : null}
      <path d={P[name]} />
    </svg>
  );
}

export const ICON_NAMES = Object.keys(P) as IconName[];
