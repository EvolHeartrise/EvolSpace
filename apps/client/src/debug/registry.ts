// Global registries of the debug dashboard: panels, 3D overlays and toolbar
// actions. Signals, so registering late (panel init, HMR) updates the UI.

import { signal, type ReadonlySignal } from '@preact/signals';
import type { OverlayDef, PanelDef, ToolbarAction } from './types.ts';

const panels = signal<PanelDef[]>([]);
const overlays = signal<OverlayDef[]>([]);
const actions = signal<ToolbarAction[]>([]);

export const panelDefs: ReadonlySignal<PanelDef[]> = panels;
export const overlayDefs: ReadonlySignal<OverlayDef[]> = overlays;
export const toolbarActions: ReadonlySignal<ToolbarAction[]> = actions;

function upsert<T extends { id: string }>(list: T[], item: T, keep?: (old: T) => boolean): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  if (keep?.(list[i])) return list;
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Identity helper for typed panel definitions. */
export function definePanel(def: PanelDef): PanelDef {
  return def;
}

/** Register (or replace, by id) a panel. Returns an unregister fn. */
export function registerPanel(def: PanelDef): () => void {
  panels.value = upsert(panels.value, def);
  return () => { panels.value = panels.value.filter((p) => p !== def); };
}

/** Register (or replace, by id) a 3D overlay. Returns an unregister fn. */
export function registerOverlay(def: OverlayDef): () => void {
  overlays.value = upsert(overlays.value, def);
  return () => { overlays.value = overlays.value.filter((o) => o !== def); };
}

/** Register (or replace, by id) a toolbar action. A `placeholder` never replaces a real one. */
export function registerToolbarAction(def: ToolbarAction): () => void {
  actions.value = upsert(actions.value, def, (old) => !!def.placeholder && !old.placeholder);
  return () => { actions.value = actions.value.filter((a) => a !== def); };
}

export function panelById(id: string): PanelDef | undefined {
  return panels.value.find((p) => p.id === id);
}

/** Tests only. */
export function resetRegistries(): void {
  panels.value = [];
  overlays.value = [];
  actions.value = [];
}
