// Lucide icons as flat stroke meshes: each polyline of library/shared/lucide-icons.ts becomes quads
// along its segments plus round discs at every vertex (Lucide's round caps/joins, stroke 2/24),
// in the XY plane facing +Z, centered, 1 unit = the icon's 24×24 box. Geometry is built once per
// icon and shared; scale the mesh to the size you want. Unlit, opaque, no textures: crisp at any
// distance and cheap on Quest (an icon is a few hundred triangles).
//
//   const play = makeIcon(ctx, 'play', { size: 0.02, color: theme.text });   // a THREE.Mesh
//   setIcon(ctx.THREE, play, 'pause');                                        // swap the shape
// Add icons: node scripts/gen-lucide.mjs <name> … (names from lucide.dev).

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { LUCIDE_ICONS } from './lucide-icons.ts';
import { markShared, ownMaterial } from './resources.ts';

type Three = typeof THREE;

const HALF = 1 / 24; // half the stroke width (2) in unit-box coordinates
const JOIN_SEGMENTS = 10;
let cache: Map<string, THREE.BufferGeometry> | null = null;

export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LUCIDE_ICONS, name);
}

/** Positions of the stroked icon (non-indexed triangles), unit box centered at 0, y up. */
export function iconTriangles(name: string): Float32Array {
  const lines = LUCIDE_ICONS[name];
  if (!lines) throw new Error(`no icon "${name}" (add it: node scripts/gen-lucide.mjs ${name})`);
  const out: number[] = [];
  const P = (x: number, y: number): [number, number] => [(x - 12) / 24, (12 - y) / 24];
  const disc = (cx: number, cy: number) => {
    for (let k = 0; k < JOIN_SEGMENTS; k++) {
      const a0 = (k / JOIN_SEGMENTS) * Math.PI * 2, a1 = ((k + 1) / JOIN_SEGMENTS) * Math.PI * 2;
      out.push(cx, cy, 0, cx + HALF * Math.cos(a0), cy + HALF * Math.sin(a0), 0, cx + HALF * Math.cos(a1), cy + HALF * Math.sin(a1), 0);
    }
  };
  for (const pts of lines) {
    for (let i = 0; i < pts.length; i += 2) {
      const [ax, ay] = P(pts[i], pts[i + 1]);
      disc(ax, ay);
      if (i + 3 >= pts.length) continue;
      const [bx, by] = P(pts[i + 2], pts[i + 3]);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * HALF, ny = (dx / len) * HALF;
      // counter-clockwise seen from +Z
      out.push(ax - nx, ay - ny, 0, bx - nx, by - ny, 0, bx + nx, by + ny, 0);
      out.push(ax - nx, ay - ny, 0, bx + nx, by + ny, 0, ax + nx, ay + ny, 0);
    }
  }
  return new Float32Array(out);
}

/** Shared geometry for an icon (never mutate or dispose it). */
export function iconGeometry(T: Three, name: string): THREE.BufferGeometry {
  cache ??= new Map();
  let g = cache.get(name);
  if (!g) {
    g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(iconTriangles(name), 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    cache.set(name, markShared(g));
  }
  return g;
}

/** An icon mesh `size` m wide/tall (the 24-unit box), own material in `color`; never a hit target. */
export function makeIcon(ctx: Pick<WidgetContext, 'THREE'>, name: string, opts: { size: number; color: string }): THREE.Mesh {
  const T = ctx.THREE;
  const n = hasIcon(name) ? name : 'circle-question-mark';
  const m = new T.Mesh(iconGeometry(T, n), ownMaterial(T, opts.color, { doubleSide: true }));
  m.scale.setScalar(opts.size);
  m.name = `icon:${n}`;
  m.raycast = () => {};
  return m;
}

/** Swap an icon mesh's shape (e.g. play ↔ pause); no-op when unchanged. */
export function setIcon(T: Three, mesh: THREE.Mesh, name: string): void {
  const n = hasIcon(name) ? name : 'circle-question-mark';
  if (mesh.name === `icon:${n}`) return;
  mesh.geometry = iconGeometry(T, n);
  mesh.name = `icon:${n}`;
}
