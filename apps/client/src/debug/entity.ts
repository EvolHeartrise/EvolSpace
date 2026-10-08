// Entity helpers shared by debug panels: display name/color, world-preserving
// reparenting, and the standard entity context menu.

import * as THREE from 'three';
import type { Entity, EntityPatch } from '@evolspace/protocol';
import { DEFAULT_THEME } from '@evolspace/runtime';
import type { DebugContext } from './types.ts';
import type { MenuEntry } from './ui/menu.tsx';
import { copyText } from './ui/hooks.ts';
import { hashIndex } from './ui/format.ts';

export function entityLabel(e: Pick<Entity, 'name' | 'widget'>): string {
  return e.name?.trim() || e.widget;
}

/** Stable color per widget id (theme palette). */
export function widgetColor(widget: string): string {
  const pal = DEFAULT_THEME.palette;
  return pal[hashIndex(widget, pal.length)];
}

export function widgetGlyph(widget: string): string {
  const parts = widget.split(/[-_ ]/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * Patch that moves `id` under `newParent` (null = root) keeping its current
 * placement in space (local transform recomputed from the three.js nodes).
 */
export function reparentPatch(ctx: DebugContext, id: string, newParent: string | null): EntityPatch {
  const obj = ctx.runtime.entityObject(id);
  const parentObj = newParent ? ctx.runtime.entityObject(newParent) : ctx.runtime.root;
  if (!obj || !parentObj) return { parent: newParent };
  obj.updateWorldMatrix(true, false);
  parentObj.updateWorldMatrix(true, false);
  const m = new THREE.Matrix4().copy(parentObj.matrixWorld).invert().multiply(obj.matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const r = (v: number, k = 1e5) => Math.round(v * k) / k;
  return {
    parent: newParent,
    transform: { position: [r(p.x), r(p.y), r(p.z)], rotation: [q.x, q.y, q.z, q.w], scale: [r(s.x), r(s.y), r(s.z)] },
  };
}

/** The standard right-click menu for an entity. */
export function entityMenu(ctx: DebugContext, e: Entity): MenuEntry[] {
  const a = ctx.actions;
  return [
    { header: `${entityLabel(e)} · ${e.id}` },
    { label: 'Frame', icon: 'target', hint: 'F / dbl-click', run: () => { a.select(e.id); a.frame(e.id); } },
    ...(e.parent ? [{ label: 'Select parent', icon: 'chevronDown' as const, run: () => a.select(e.parent) }] : []),
    'separator',
    { label: 'Duplicate', icon: 'duplicate', run: () => void a.duplicate(e.id) },
    { label: e.visible ? 'Hide' : 'Show', icon: e.visible ? 'eyeOff' : 'eye', run: () => void a.update(e.id, { visible: !e.visible }) },
    { label: e.locked ? 'Unlock' : 'Lock (no grab/scale)', icon: e.locked ? 'unlock' : 'lock', run: () => void a.update(e.id, { locked: e.locked ? null as unknown as boolean : true }) },
    ...(e.parent ? [{ label: 'Move to root (keep placement)', icon: 'layers' as const, run: () => void a.update(e.id, reparentPatch(ctx, e.id, null)) }] : []),
    'separator',
    { label: 'Copy id', icon: 'copy', run: () => void copyText(e.id).then((ok) => ctx.toast(ok ? `Copied ${e.id}` : 'Clipboard unavailable', ok ? 'info' : 'warn')) },
    { label: 'Copy as JSON', icon: 'code', run: () => void copyText(JSON.stringify(e, null, 2)).then((ok) => ctx.toast(ok ? 'Entity JSON copied' : 'Clipboard unavailable', ok ? 'info' : 'warn')) },
    'separator',
    { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, run: () => void a.remove(e.id) },
  ];
}
