// Orientation aid: a faint floor grid at the space origin (1 m cells over
// 10 × 10 m by default, fading out with distance from the origin) plus a small
// origin marker (short X/Z axis ticks). One LineSegments = one draw call:
// unlit, vertex colors with per-vertex alpha, no depth writes, never
// hit-tested. Shown in VR and in mirror screenshots; the client hides it in AR
// (passthrough) via SpaceRuntime.setEnvironment({ grid }).

import * as THREE from 'three';
import type { Theme } from '@evolspace/protocol';

export interface FloorGridOptions {
  /** Edge length of the square grid, meters (default 10). */
  size?: number;
  /** Cell size, meters (default 1). */
  cell?: number;
  /** Peak line opacity near the origin (default 0.22). */
  opacity?: number;
}

/** Segments per cell: alpha is interpolated along a line, so the fade needs a few vertices. */
const SUBDIV = 2;
const MARKER = 0.25;

export function createFloorGrid(theme: Theme, opts: FloorGridOptions = {}): THREE.LineSegments {
  const size = opts.size ?? 10;
  const cell = opts.cell ?? 1;
  const peak = opts.opacity ?? 0.22;
  const half = size / 2;
  const n = Math.max(1, Math.round(size / cell));
  const step = size / n;
  const seg = step / SUBDIV;
  const segsPerLine = n * SUBDIV;

  const line = new THREE.Color(theme.textDim);
  const xAxis = new THREE.Color(theme.negative);
  const zAxis = new THREE.Color(theme.accent);
  const center = new THREE.Color(theme.text);

  // (n + 1) lines per direction, segsPerLine segments each, 2 vertices per
  // segment; plus the origin marker (3 segments).
  const lineVerts = 2 * (n + 1) * segsPerLine * 2;
  const markerVerts = 3 * 2;
  const pos = new Float32Array((lineVerts + markerVerts) * 3);
  const col = new Float32Array((lineVerts + markerVerts) * 4);
  let v = 0;
  const fade = (x: number, z: number) => {
    // Smooth radial falloff: full near the origin, zero at the grid's edge.
    const r = Math.min(1, Math.hypot(x, z) / half);
    const t = 1 - r * r;
    return peak * t * t;
  };
  const push = (x: number, z: number, c: THREE.Color, a: number) => {
    pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = z;
    col[v * 4] = c.r; col[v * 4 + 1] = c.g; col[v * 4 + 2] = c.b; col[v * 4 + 3] = a;
    v++;
  };
  for (let i = 0; i <= n; i++) {
    const k = -half + i * step;
    for (let j = 0; j < segsPerLine; j++) {
      const a = -half + j * seg;
      const b = a + seg;
      push(k, a, line, fade(k, a)); push(k, b, line, fade(k, b)); // along Z
      push(a, k, line, fade(a, k)); push(b, k, line, fade(b, k)); // along X
    }
  }
  // Origin marker: +X tick (red-ish), +Z tick (blue-ish), a short -X stub so the cross reads as a center.
  const ma = Math.min(1, peak * 3.5);
  push(0, 0, xAxis, ma); push(MARKER, 0, xAxis, ma);
  push(0, 0, zAxis, ma); push(0, MARKER, zAxis, ma);
  push(-MARKER * 0.4, 0, center, ma * 0.7); push(0, 0, center, ma * 0.7);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geom.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const grid = new THREE.LineSegments(geom, mat);
  grid.name = 'floor-grid';
  grid.renderOrder = -1; // under other transparent content
  grid.raycast = () => {}; // an orientation aid, never a target
  grid.matrixAutoUpdate = false;
  grid.updateMatrix();
  return grid;
}
