// Debug dashboard shortcuts. Never fire while typing (text inputs, textareas,
// selects, contenteditable) and don't collide with the desktop controls
// (WASD/QE/Shift move, V push-to-talk, P perf, H page panel):
//   ` or F1        toggle the whole dashboard
//   F              frame the selected entity        Shift+F  frame everything
//   Delete         remove the selected entity
//   Ctrl+Z         undo        Ctrl+Shift+Z / Ctrl+Y   redo
//   Esc            clear the selection
// While the dashboard is hidden only the toggle is active.

import { isTextEntry } from '../desktop/controls.ts';

export type ShortcutName = 'toggleUi' | 'frame' | 'frameAll' | 'remove' | 'undo' | 'redo' | 'clearSelection';

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  target: EventTarget | null;
}

/** Pure key → shortcut mapping. `uiVisible` false → only the toggle. */
export function matchShortcut(ev: KeyLike, uiVisible = true): ShortcutName | null {
  if (isTextEntry(ev.target)) return null;
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod && !ev.altKey && (ev.code === 'Backquote' || ev.key === 'F1')) return ev.repeat ? null : 'toggleUi';
  if (!uiVisible) return null;
  if (mod && !ev.altKey) {
    if (ev.code === 'KeyZ') return ev.shiftKey ? 'redo' : 'undo';
    if (ev.code === 'KeyY' && !ev.shiftKey) return 'redo';
    return null;
  }
  if (ev.altKey || ev.repeat) return null;
  if (ev.code === 'KeyF') return ev.shiftKey ? 'frameAll' : 'frame';
  if (ev.key === 'Delete') return 'remove';
  if (ev.key === 'Escape') return 'clearSelection';
  return null;
}

export type ShortcutHandlers = Record<ShortcutName, () => void>;

/** Install the window keydown listener. Returns an uninstall fn. */
export function installShortcuts(handlers: ShortcutHandlers, uiVisible: () => boolean, target: Window = window): () => void {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) return;
    const name = matchShortcut(ev, uiVisible());
    if (!name) return;
    ev.preventDefault();
    handlers[name]();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

/**
 * Desktop-controls key filter for debug mode: ignore keys while focus is in a
 * dashboard form control (checkbox, range, color, button-less inputs…), so
 * e.g. arrow/WASD on a focused slider never moves the camera.
 */
export function isDashboardControl(target: EventTarget | null, root: Element | null): boolean {
  const t = target as Element | null;
  if (!t || !root || typeof t.closest !== 'function' || !root.contains(t)) return false;
  return !!t.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"], [data-keys="capture"]');
}
