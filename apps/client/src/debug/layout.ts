// Dock layout of the debug dashboard: sizes, collapsed docks, tab order and
// active tab per dock, hidden panels, enabled overlays and whether the UI is
// shown at all. Persisted in localStorage (every access guarded: private
// windows / blocked storage just fall back to defaults).

import { effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { DockId, PanelDef } from './types.ts';
import { DOCK_IDS } from './types.ts';

export interface DockState {
  /** Width (left/right) or height (bottom) in CSS px when expanded. */
  size: number;
  collapsed: boolean;
  /** Panel ids in tab order. */
  tabs: string[];
  active: string | null;
}

export interface LayoutState {
  version: 1;
  /** Whole dashboard shown (` / F1 toggles). */
  visible: boolean;
  docks: Record<DockId, DockState>;
  /** Panels closed by the user (reopen from the toolbar's Panels menu). */
  hidden: string[];
  /** Enabled overlay ids (null = never configured → each overlay's defaultEnabled). */
  overlays: string[] | null;
}

export const LAYOUT_KEY = 'evolspace.debug.layout';
export const DEFAULT_SIZES: Record<DockId, number> = { left: 300, right: 380, bottom: 290 };
export const SIZE_LIMITS: Record<DockId, [number, number]> = { left: [180, 900], right: [220, 900], bottom: [90, 900] };

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

/** localStorage, or a no-op store when it is unavailable or throws. */
export function safeLocalStorage(): StorageLike {
  try {
    const s = globalThis.localStorage;
    if (s) {
      const probe = '__evol_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return {
        getItem: (k) => { try { return s.getItem(k); } catch { return null; } },
        setItem: (k, v) => { try { s.setItem(k, v); } catch { /* quota / blocked */ } },
        removeItem: (k) => { try { s.removeItem(k); } catch { /* blocked */ } },
      };
    }
  } catch { /* blocked */ }
  const mem = new Map<string, string>();
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } };
}

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

export function defaultLayout(panels: readonly PanelDef[]): LayoutState {
  return reconcileLayout(null, panels);
}

/**
 * Merge a saved (possibly stale or corrupt) layout with the registered panels:
 * unknown panel ids are dropped, new panels are appended to their default dock
 * (in `order`), sizes are clamped and every active tab is valid.
 */
export function reconcileLayout(saved: unknown, panels: readonly PanelDef[]): LayoutState {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<LayoutState>;
  const ids = new Set(panels.map((p) => p.id));
  const placed = new Set<string>();
  const docks = {} as Record<DockId, DockState>;
  for (const d of DOCK_IDS) {
    const sd = (s.docks && typeof s.docks === 'object' ? (s.docks as Partial<Record<DockId, Partial<DockState>>>)[d] : undefined) ?? {};
    const tabs: string[] = [];
    for (const t of Array.isArray(sd.tabs) ? sd.tabs : []) {
      if (typeof t !== 'string' || !ids.has(t) || placed.has(t)) continue;
      placed.add(t);
      tabs.push(t);
    }
    docks[d] = {
      size: clamp(typeof sd.size === 'number' && Number.isFinite(sd.size) ? sd.size : DEFAULT_SIZES[d], SIZE_LIMITS[d]),
      collapsed: sd.collapsed === true,
      tabs,
      active: typeof sd.active === 'string' ? sd.active : null,
    };
  }
  const fresh = panels.filter((p) => !placed.has(p.id)).sort((a, b) => a.order - b.order);
  for (const p of fresh) docks[p.dock].tabs.push(p.id);
  const hidden = (Array.isArray(s.hidden) ? s.hidden : []).filter((h): h is string => typeof h === 'string' && ids.has(h));
  for (const d of DOCK_IDS) {
    const dock = docks[d];
    const visibleTabs = dock.tabs.filter((t) => !hidden.includes(t));
    if (!dock.active || !visibleTabs.includes(dock.active)) {
      // Default: the lowest-order visible panel of this dock.
      const byOrder = visibleTabs.map((t) => panels.find((p) => p.id === t)!).sort((a, b) => a.order - b.order);
      dock.active = byOrder[0]?.id ?? null;
    }
  }
  const overlays = Array.isArray(s.overlays) ? s.overlays.filter((o): o is string => typeof o === 'string') : null;
  return { version: 1, visible: s.visible !== false, docks, hidden, overlays };
}

export function loadLayout(storage: StorageLike, panels: readonly PanelDef[]): LayoutState {
  let saved: unknown = null;
  try { saved = JSON.parse(storage.getItem(LAYOUT_KEY) ?? 'null'); } catch { /* corrupt → defaults */ }
  return reconcileLayout(saved, panels);
}

export function saveLayout(storage: StorageLike, state: LayoutState): void {
  try { storage.setItem(LAYOUT_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

/** Reactive layout with persistence. */
export class LayoutStore {
  private readonly _state: Signal<LayoutState>;
  readonly state: ReadonlySignal<LayoutState>;
  private readonly stopSave: () => void;
  private readonly stopPanels: () => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly panels: ReadonlySignal<PanelDef[]>, private readonly storage: StorageLike = safeLocalStorage(), saveDelayMs = 150) {
    this._state = signal(loadLayout(storage, panels.value));
    this.state = this._state;
    let first = true;
    this.stopSave = effect(() => {
      const st = this._state.value;
      if (first) { first = false; return; }
      if (this.saveTimer) clearTimeout(this.saveTimer);
      if (saveDelayMs <= 0) { saveLayout(this.storage, st); return; }
      this.saveTimer = setTimeout(() => { this.saveTimer = null; saveLayout(this.storage, st); }, saveDelayMs);
    });
    // Panels registered later (lazy, HMR) are merged in.
    this.stopPanels = effect(() => {
      const list = this.panels.value;
      const cur = this._state.peek();
      const next = reconcileLayout(cur, list);
      if (JSON.stringify(next) !== JSON.stringify(cur)) this._state.value = next;
    });
  }

  get value(): LayoutState { return this._state.value; }

  private update(fn: (s: LayoutState) => void): void {
    const next = structuredClone(this._state.peek());
    fn(next);
    this._state.value = reconcileLayout(next, this.panels.peek());
  }

  dockOf(panelId: string): DockId | null {
    for (const d of DOCK_IDS) if (this._state.value.docks[d].tabs.includes(panelId)) return d;
    return null;
  }

  setSize(dock: DockId, px: number): void {
    this.update((s) => { s.docks[dock].size = clamp(Math.round(px), SIZE_LIMITS[dock]); s.docks[dock].collapsed = false; });
  }

  setCollapsed(dock: DockId, collapsed: boolean): void {
    this.update((s) => { s.docks[dock].collapsed = collapsed; });
  }

  toggleCollapsed(dock: DockId): void {
    this.setCollapsed(dock, !this._state.peek().docks[dock].collapsed);
  }

  setActive(dock: DockId, panelId: string): void {
    this.update((s) => { s.docks[dock].active = panelId; s.docks[dock].collapsed = false; });
  }

  /** Show a panel: un-hide it, activate its tab, expand its dock. */
  show(panelId: string): void {
    const dock = this.dockOf(panelId);
    if (!dock) return;
    this.update((s) => {
      s.hidden = s.hidden.filter((h) => h !== panelId);
      s.docks[dock].active = panelId;
      s.docks[dock].collapsed = false;
    });
  }

  hide(panelId: string): void {
    this.update((s) => { if (!s.hidden.includes(panelId)) s.hidden.push(panelId); });
  }

  isHidden(panelId: string): boolean {
    return this._state.value.hidden.includes(panelId);
  }

  /** Move a panel to another dock (appended, activated). */
  move(panelId: string, dock: DockId): void {
    this.update((s) => {
      for (const d of DOCK_IDS) s.docks[d].tabs = s.docks[d].tabs.filter((t) => t !== panelId);
      s.docks[dock].tabs.push(panelId);
      s.docks[dock].active = panelId;
      s.docks[dock].collapsed = false;
      s.hidden = s.hidden.filter((h) => h !== panelId);
    });
  }

  /** Reorder a tab within its dock to `index`. */
  reorder(panelId: string, index: number): void {
    const dock = this.dockOf(panelId);
    if (!dock) return;
    this.update((s) => {
      const tabs = s.docks[dock].tabs.filter((t) => t !== panelId);
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, panelId);
      s.docks[dock].tabs = tabs;
    });
  }

  setVisible(v: boolean): void {
    this.update((s) => { s.visible = v; });
  }

  toggleVisible(): void {
    this.setVisible(!this._state.peek().visible);
  }

  setOverlays(ids: string[]): void {
    this.update((s) => { s.overlays = [...new Set(ids)]; });
  }

  reset(): void {
    const keepOverlays = this._state.peek().overlays;
    this._state.value = { ...defaultLayout(this.panels.peek()), overlays: keepOverlays };
  }

  /** Flush a pending save (tests, page hide). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    saveLayout(this.storage, this._state.peek());
  }

  dispose(): void {
    this.flush();
    this.stopSave();
    this.stopPanels();
  }
}
