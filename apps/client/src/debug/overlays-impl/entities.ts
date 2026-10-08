// Entity overlays: oriented content bounds (selected = accent, others dim;
// instanced-mesh aware via the runtime Picker's node-local bounds, subtree
// world bounds as a fallback), screen-space name labels and origin axes.

import type * as THREE_NS from 'three';
import type { DebugContext, OverlayDef, OverlayInstance } from '../types.ts';
import { entityLabel } from '../entity.ts';
import { LabelLayer, LineBatch, OverlayRoot, boxCorners, esc, overlayColors } from './common.ts';

/** Per-entity oriented box: content bounds in node space + the node's world matrix. Null if nothing to show. */
export interface EntityBox {
  box: THREE_NS.Box3;
  /** null = `box` is already in world space. */
  matrix: THREE_NS.Matrix4 | null;
}

export function entityBox(ctx: DebugContext, id: string, scratch: THREE_NS.Box3, subtreeFallback = false): EntityBox | null {
  const node = ctx.runtime.entityObject(id);
  if (!node || !effectivelyVisible(node)) return null;
  const lb = ctx.runtime.picker.localBounds(id);
  if (lb && !lb.isEmpty()) return { box: lb, matrix: node.matrixWorld };
  if (!subtreeFallback) return null; // (frameEntity refreshes every matrix: only for the selection)
  const wb = ctx.runtime.frameEntity(id);
  if (wb && !wb.isEmpty()) return { box: scratch.copy(wb), matrix: null };
  return null;
}

function effectivelyVisible(o: THREE_NS.Object3D): boolean {
  for (let c: THREE_NS.Object3D | null = o; c; c = c.parent) if (!c.visible) return false;
  return true;
}

export const boundsOverlay: OverlayDef = {
  id: 'bounds',
  title: 'Entity bounds',
  description: 'Oriented content box of every entity; the selection in accent, drawn through geometry',
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const root = new OverlayRoot(ctx, 'bounds');
    const dim = new LineBatch(T, { opacity: 0.55, name: 'bounds-dim' });
    const sel = new LineBatch(T, { opacity: 0.95, depthTest: false, renderOrder: 950, capacity: 32, name: 'bounds-sel' });
    root.world.add(dim.lines, sel.lines);
    const col = overlayColors(ctx);
    const corners = Array.from({ length: 8 }, () => new T.Vector3());
    const scratch = new T.Box3();
    return {
      update() {
        dim.begin(); sel.begin();
        const ents = ctx.runtime.sceneState.entities;
        const selected = ctx.store.selection.peek();
        for (const id in ents) {
          const eb = entityBox(ctx, id, scratch, id === selected);
          if (!eb) continue;
          boxCorners(eb.box, eb.matrix, corners);
          if (id === selected) sel.box(corners, col.accent); else dim.box(corners, col.dim);
        }
        dim.end(); sel.end();
      },
      dispose() { dim.dispose(); sel.dispose(); root.dispose(); },
    };
  },
};

export const labelsOverlay: OverlayDef = {
  id: 'labels',
  title: 'Entity labels',
  description: 'name · widget · id above each entity (screen-space)',
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const layer = new LabelLayer(ctx);
    const corners = Array.from({ length: 8 }, () => new T.Vector3());
    const scratch = new T.Box3();
    const top = new T.Vector3();
    const html = new Map<string, { key: string; html: string }>();
    return {
      update() {
        layer.begin();
        const ents = ctx.runtime.sceneState.entities;
        const selected = ctx.store.selection.peek();
        for (const id in ents) {
          const e = ents[id];
          const eb = entityBox(ctx, id, scratch, id === selected);
          if (eb) {
            boxCorners(eb.box, eb.matrix, corners);
            // Top center of the (oriented) box.
            let maxY = -Infinity;
            top.set(0, 0, 0);
            for (const c of corners) { top.add(c); if (c.y > maxY) maxY = c.y; }
            top.multiplyScalar(1 / 8);
            top.y = maxY;
          } else {
            // No own content (e.g. a group): its origin.
            const node = ctx.runtime.entityObject(id);
            if (!node || !effectivelyVisible(node)) continue;
            node.getWorldPosition(top);
          }
          const key = `${e.name ?? ''}|${e.widget}`;
          let h = html.get(id);
          if (!h || h.key !== key) {
            h = { key, html: `${esc(entityLabel(e))}${e.name ? ` <span class="w">· ${esc(e.widget)}</span>` : ''} <span class="i">${esc(id)}</span>` };
            html.set(id, h);
          }
          layer.put(id, top, h.html, id === selected ? 'sel' : '', -4);
        }
        layer.end();
      },
      dispose() { layer.dispose(); html.clear(); },
    };
  },
};

export const axesOverlay: OverlayDef = {
  id: 'axes',
  title: 'Origin axes',
  description: 'X/Y/Z gizmo (red/green/blue, 8 cm) at every entity origin',
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const root = new OverlayRoot(ctx, 'axes');
    const batch = new LineBatch(T, { opacity: 0.95, depthTest: false, renderOrder: 940, name: 'axes' });
    root.world.add(batch.lines);
    const col = overlayColors(ctx);
    const o = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(), a = new T.Vector3();
    const L = 0.08;
    return {
      update() {
        batch.begin();
        const ents = ctx.runtime.sceneState.entities;
        for (const id in ents) {
          const node = ctx.runtime.entityObject(id);
          if (!node || !effectivelyVisible(node)) continue;
          node.updateWorldMatrix(true, false);
          node.matrixWorld.decompose(o, q, s);
          a.set(L, 0, 0).applyQuaternion(q).add(o); batch.segV(o, a, col.x);
          a.set(0, L, 0).applyQuaternion(q).add(o); batch.segV(o, a, col.y);
          a.set(0, 0, L).applyQuaternion(q).add(o); batch.segV(o, a, col.z);
        }
        batch.end();
      },
      dispose() { batch.dispose(); root.dispose(); },
    };
  },
};

export const interactiveOverlay: OverlayDef = {
  id: 'interactive',
  title: 'Interactive parts',
  description: 'Objects registered via ctx.interactive() (pinch → widget handler); hovered by a hand ray = green',
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const root = new OverlayRoot(ctx, 'interactive');
    const batch = new LineBatch(T, { opacity: 0.9, depthTest: false, renderOrder: 945, name: 'interactive' });
    root.world.add(batch.lines);
    const col = overlayColors(ctx);
    const corners = Array.from({ length: 8 }, () => new T.Vector3());
    const box = new T.Box3();
    const hovered = new Set<string>();
    return {
      update() {
        hovered.clear();
        try {
          const rays = ctx.engine.rays();
          for (const h of ['left', 'right'] as const) {
            const hit = rays[h]?.hit;
            if (hit?.interactive && hit.object) hovered.add(`${hit.entity}\u0000${hit.object}`);
          }
        } catch { /* engine not ready */ }
        batch.begin();
        const ents = ctx.runtime.sceneState.entities;
        for (const id in ents) {
          const set = ctx.runtime.widgets.interactivesOf(id);
          if (!set || !set.size) continue;
          for (const o of set) {
            if (!o.parent || !effectivelyVisible(o)) continue;
            const mesh = o as THREE_NS.Mesh;
            o.updateWorldMatrix(true, false);
            if (mesh.geometry && !(o as THREE_NS.InstancedMesh).isInstancedMesh) {
              if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
              boxCorners(mesh.geometry.boundingBox!, o.matrixWorld, corners);
            } else {
              box.setFromObject(o);
              if (box.isEmpty()) continue;
              boxCorners(box, null, corners);
            }
            const hot = hovered.has(`${id}\u0000${o.name || o.uuid}`);
            batch.box(corners, hot ? col.pos : col.accent2);
          }
        }
        batch.end();
      },
      dispose() { batch.dispose(); root.dispose(); },
    };
  },
};
