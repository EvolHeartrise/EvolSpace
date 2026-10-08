// Wireframe mode: sets `wireframe = true` on every mesh material under the
// space root (widgets, fallbacks), re-scanning twice a second for materials
// created later, and restores each material's exact original value on disable.
// Text (troika) and non-mesh materials are left alone; debug overlays too.

import type * as THREE_NS from 'three';
import type { DebugContext, OverlayDef, OverlayInstance } from '../types.ts';

type WireMat = THREE_NS.Material & { wireframe: boolean };

const isWireable = (m: THREE_NS.Material | undefined): m is WireMat => !!m && typeof (m as Partial<WireMat>).wireframe === 'boolean';

/** Applies wireframe under `root`; restore() puts back exactly what was changed. */
export class WireframeMode {
  private readonly saved = new Map<WireMat, boolean>();
  constructor(private readonly root: THREE_NS.Object3D) {}

  /** Apply to every material currently under the root (idempotent; returns how many were newly changed). */
  scan(): number {
    let n = 0;
    this.root.traverse((o) => {
      if (o.userData?.debugOverlay) return;
      const mesh = o as THREE_NS.Mesh & { isTroikaText?: boolean };
      if (!mesh.isMesh || mesh.isTroikaText) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!isWireable(m) || this.saved.has(m)) continue;
        this.saved.set(m, m.wireframe);
        if (!m.wireframe) { m.wireframe = true; m.needsUpdate = true; }
        n++;
      }
    });
    return n;
  }

  restore(): void {
    for (const [m, was] of this.saved) {
      if (m.wireframe !== was) { m.wireframe = was; m.needsUpdate = true; }
    }
    this.saved.clear();
  }

  get size(): number { return this.saved.size; }
}

export const wireframeOverlay: OverlayDef = {
  id: 'wireframe',
  title: 'Wireframe',
  description: 'Every widget mesh as wireframe (materials restored exactly when off)',
  create(ctx: DebugContext): OverlayInstance {
    const mode = new WireframeMode(ctx.runtime.root);
    mode.scan();
    let acc = 0;
    return {
      update(dt) {
        acc += dt;
        if (acc >= 0.5) { acc = 0; mode.scan(); }
      },
      dispose() { mode.restore(); },
    };
  },
};
