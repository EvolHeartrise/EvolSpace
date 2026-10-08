// Cached, cheap geometry builders. Geometries returned here are SHARED: they
// are tagged `userData.evolShared = true` so the widget host never disposes
// them when tearing a widget down. (Disposing them anyway is harmless — three
// re-uploads on next use — just wasteful.)

import * as THREE from 'three';

export function markShared<T extends { userData: Record<string, unknown> }>(x: T): T {
  x.userData.evolShared = true;
  return x;
}

export function isShared(x: { userData?: Record<string, unknown> } | null | undefined): boolean {
  return !!x?.userData?.evolShared;
}

const roundedCache = new Map<string, THREE.BufferGeometry>();
const outlineCache = new Map<string, THREE.BufferGeometry>();

function roundedShape(w: number, h: number, r: number): THREE.Shape {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  if (rr) s.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - rr);
  if (rr) s.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(x + rr, y + h);
  if (rr) s.absarc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + rr);
  if (rr) s.absarc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}

function key(w: number, h: number, r: number): string {
  // Quantize to 0.1 mm so near-identical sizes share a geometry.
  return `${Math.round(w * 1e4)}|${Math.round(h * 1e4)}|${Math.round(r * 1e4)}`;
}

/** Flat rounded rectangle in the XY plane, centered, facing +Z. ~40 triangles. */
export function roundedRectGeometry(w: number, h: number, r: number): THREE.BufferGeometry {
  const k = key(w, h, r);
  let g = roundedCache.get(k);
  if (!g) {
    g = markShared(new THREE.ShapeGeometry(roundedShape(w, h, r), 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    roundedCache.set(k, g);
  }
  return g;
}

/** Closed outline of the same rounded rectangle (for LineLoop borders). */
export function roundedRectOutline(w: number, h: number, r: number): THREE.BufferGeometry {
  const k = key(w, h, r);
  let g = outlineCache.get(k);
  if (!g) {
    const pts = roundedShape(w, h, r).getPoints(4);
    g = markShared(new THREE.BufferGeometry().setFromPoints(pts));
    outlineCache.set(k, g);
  }
  return g;
}

let unitBoxEdges: THREE.BufferGeometry | null = null;
/** Edges of a unit cube centered at the origin (wireframe fallback boxes). */
export function unitBoxEdgesGeometry(): THREE.BufferGeometry {
  if (!unitBoxEdges) unitBoxEdges = markShared(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)));
  return unitBoxEdges;
}

let bracketGeom: THREE.BufferGeometry | null = null;
/**
 * Corner brackets of a unit cube centered at the origin: at each of the 8
 * corners, three short segments along the edges (length = `frac` of the edge).
 * Reads as a diagrammatic "selection" frame and is far cheaper than an outline pass.
 */
export function unitBracketGeometry(frac = 0.2): THREE.BufferGeometry {
  if (bracketGeom) return bracketGeom;
  const pos: number[] = [];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    const dx = -Math.sign(sx) * frac;
    const dy = -Math.sign(sy) * frac;
    const dz = -Math.sign(sz) * frac;
    pos.push(sx, sy, sz, sx + dx, sy, sz);
    pos.push(sx, sy, sz, sx, sy + dy, sz);
    pos.push(sx, sy, sz, sx, sy, sz + dz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bracketGeom = markShared(g);
  return bracketGeom;
}

const sphereCache = new Map<number, THREE.BufferGeometry>();
/** Low-poly unit-radius sphere (icosahedron), shared. */
export function unitSphereGeometry(detail = 2): THREE.BufferGeometry {
  let g = sphereCache.get(detail);
  if (!g) sphereCache.set(detail, (g = markShared(new THREE.IcosahedronGeometry(1, detail))));
  return g;
}
