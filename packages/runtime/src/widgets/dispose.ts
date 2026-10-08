// GPU resource cleanup for a widget's content subtree after the widget's own
// dispose(). Widgets are often sloppy about this, and hot reload re-creates
// them many times a session, so the host sweeps up: troika texts, geometries,
// materials and their textures — except resources the UiKit marked shared.

import type * as THREE from 'three';
import { isShared } from '../ui/geometry.ts';

const TEXTURE_KEYS = ['map', 'alphaMap', 'aoMap', 'emissiveMap', 'lightMap', 'bumpMap', 'normalMap', 'specularMap', 'envMap'] as const;

export function disposeSubtree(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((obj) => {
    const o = obj as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[]; dispose?: () => void; isMesh?: boolean };
    // troika Text (and similar) own their resources and expose dispose().
    if (typeof o.dispose === 'function' && (o as { isMesh?: boolean }).isMesh && 'text' in o) {
      try { o.dispose(); } catch { /* ignore */ }
      return;
    }
    if (o.geometry && !isShared(o.geometry) && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      try { o.geometry.dispose(); } catch { /* ignore */ }
    }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (isShared(m) || seen.has(m)) continue;
      seen.add(m);
      for (const k of TEXTURE_KEYS) {
        const tex = (m as unknown as Record<string, THREE.Texture | null | undefined>)[k];
        if (tex && !seen.has(tex) && !isShared(tex)) {
          seen.add(tex);
          try { tex.dispose(); } catch { /* ignore */ }
        }
      }
      try { m.dispose(); } catch { /* ignore */ }
    }
  });
}
