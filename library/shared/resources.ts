// Shared GPU resources and cleanup.
//
// - sharedGeometry(): unit-sized geometries cached per bundle and tagged
//   `userData.evolShared = true`, the flag the runtime's widget host checks so
//   it never disposes them on teardown. Scale meshes instead of building new
//   geometry per instance; that keeps memory and GC flat on the Quest.
// - disposeTree(): what the host does after dispose(), for widgets that rebuild
//   parts of themselves on prop changes (skips shared resources, disposes
//   troika texts, geometries, materials and their textures).
//
// The caches are created lazily inside create() calls (never at module top level).

import type * as THREE from 'three';

type Three = typeof THREE;

export function markShared<T extends { userData: Record<string, unknown> }>(x: T): T {
  x.userData.evolShared = true;
  return x;
}

export function isShared(x: { userData?: Record<string, unknown> } | null | undefined): boolean {
  return !!x?.userData?.evolShared;
}

export const UNIT_GEOMETRIES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'ring', 'tetra', 'octa', 'disc', 'ico'] as const;
export type UnitGeometry = (typeof UNIT_GEOMETRIES)[number];

let cache: Map<string, THREE.BufferGeometry> | null = null;

/**
 * Unit geometry (fits a 1 m cube, centered at the origin; flat ones lie in XY
 * facing +Z). Shared: never mutate or dispose it.
 *   box, sphere (d=1), cylinder/cone/capsule (d=1, h=1, Y-up), torus (outer d=1),
 *   plane (1×1), ring (outer d=1, inner 0.6), disc (d=1), tetra, octa, ico
 *   (low-poly sphere for instancing).
 */
export function sharedGeometry(T: Three, kind: UnitGeometry): THREE.BufferGeometry {
  cache ??= new Map();
  let g = cache.get(kind);
  if (!g) {
    g = makeUnit(T, kind);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    cache.set(kind, markShared(g));
  }
  return g;
}

function makeUnit(T: Three, kind: UnitGeometry): THREE.BufferGeometry {
  switch (kind) {
    case 'box': return new T.BoxGeometry(1, 1, 1);
    case 'sphere': return new T.SphereGeometry(0.5, 24, 16);
    case 'cylinder': return new T.CylinderGeometry(0.5, 0.5, 1, 24, 1);
    case 'cone': return new T.ConeGeometry(0.5, 1, 24, 1);
    case 'torus': return new T.TorusGeometry(0.375, 0.125, 12, 32);
    case 'capsule': return new T.CapsuleGeometry(0.25, 0.5, 6, 16);
    case 'plane': return new T.PlaneGeometry(1, 1);
    case 'ring': return new T.RingGeometry(0.3, 0.5, 32);
    case 'disc': return new T.CircleGeometry(0.5, 32);
    case 'tetra': return new T.TetrahedronGeometry(0.5);
    case 'octa': return new T.OctahedronGeometry(0.5);
    case 'ico': return new T.IcosahedronGeometry(0.5, 1);
  }
}

/**
 * Shared unit geometry with a baked "light" in its vertex colors: a soft
 * half-Lambert shade from a fixed upper-left-front direction (0.4..1.0 ×
 * the material color, linear). Gives solids depth cues while staying unlit and free
 * at runtime. Use with ownMaterial(..., { shaded: true }) (vertexColors).
 */
export function shadedGeometry(T: Three, kind: UnitGeometry): THREE.BufferGeometry {
  cache ??= new Map();
  const key = `shaded:${kind}`;
  let g = cache.get(key);
  if (!g) {
    g = sharedGeometry(T, kind).clone();
    const n = g.getAttribute('normal');
    const colors = new Float32Array(n.count * 3);
    // Fixed key light, normalized (-0.35, 0.8, 0.5).
    const lx = -0.35, ly = 0.8, lz = 0.5;
    const len = Math.hypot(lx, ly, lz);
    for (let i = 0; i < n.count; i++) {
      const d = (n.getX(i) * lx + n.getY(i) * ly + n.getZ(i) * lz) / len;
      const s = 0.4 + 0.6 * (0.5 + 0.5 * d);
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = s;
    }
    g.setAttribute('color', new T.BufferAttribute(colors, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    cache.set(key, markShared(g));
  }
  return g;
}

/** Edges of a shared unit geometry (for wireframe-ish outlines), also shared. */
export function sharedEdges(T: Three, kind: UnitGeometry): THREE.BufferGeometry {
  cache ??= new Map();
  const key = `edges:${kind}`;
  let g = cache.get(key);
  if (!g) {
    g = new T.EdgesGeometry(sharedGeometry(T, kind), 20);
    cache.set(key, markShared(g));
  }
  return g;
}

const TEXTURE_KEYS = ['map', 'alphaMap', 'aoMap', 'lightMap'] as const;

/**
 * Dispose a subtree's non-shared GPU resources, hide it and detach it from its
 * parent. Safe to call on anything a widget built itself.
 */
export function disposeTree(root: THREE.Object3D): void {
  // Hide first: objects registered with ctx.interactive() stay in the host's
  // set after a rebuild; an invisible ancestor keeps them from being hit.
  root.visible = false;
  root.removeFromParent();
  const seen = new Set<unknown>();
  root.traverse((obj) => {
    const o = obj as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
      dispose?: () => void;
      isMesh?: boolean;
    };
    if (typeof o.dispose === 'function' && o.isMesh && 'text' in o) {
      // troika Text owns its geometry/material.
      try { o.dispose(); } catch { /* ignore */ }
      return;
    }
    if (typeof o.dispose === 'function' && (o as { isInstancedMesh?: boolean }).isInstancedMesh) {
      try { o.dispose(); } catch { /* ignore */ }
    }
    if (o.geometry && !isShared(o.geometry) && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      o.geometry.dispose();
    }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (isShared(m) || seen.has(m)) continue;
      seen.add(m);
      for (const k of TEXTURE_KEYS) {
        const tex = (m as unknown as Record<string, THREE.Texture | null | undefined>)[k];
        if (tex && !isShared(tex) && !seen.has(tex)) {
          seen.add(tex);
          tex.dispose();
        }
      }
      m.dispose();
    }
  });
}

/** Material the widget owns (not cached by the UiKit), safe to mutate. Unlit. */
export function ownMaterial(
  T: Three,
  color: string,
  opts: { opacity?: number; wireframe?: boolean; doubleSide?: boolean; depthTest?: boolean; shaded?: boolean } = {},
): THREE.MeshBasicMaterial {
  const opacity = opts.opacity ?? 1;
  return new T.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    wireframe: !!opts.wireframe,
    side: opts.doubleSide ? T.DoubleSide : T.FrontSide,
    depthTest: opts.depthTest ?? true,
    // Only with shadedGeometry(): a geometry without a color attribute would render black.
    vertexColors: !!opts.shaded,
  });
}

/** An invisible (never drawn) material: meshes using it still raycast — ideal for enlarged hit areas. */
export function hitMaterial(T: Three): THREE.MeshBasicMaterial {
  if (!hitMat) {
    hitMat = markShared(new T.MeshBasicMaterial({ color: 0xffffff }));
    hitMat.visible = false;
  }
  return hitMat;
}

let hitMat: THREE.MeshBasicMaterial | null = null;
