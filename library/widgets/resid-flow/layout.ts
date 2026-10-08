// Pure geometry for resid-flow (no three.js): node placement, smoothed
// trajectory ribbons, attention arcs, delta ticks, and point/ray picking.
// Everything writes into reusable typed arrays so rebuilding on a new sample
// does not churn the GC; buffers only grow.
//
// Frame (widget-local, meters): layers stacked along +Y and centered on the
// origin; each layer is a width × width square in XZ. Projection component 0
// → x, component 1 → z, optional component 2 → small y offset (depthJitter).

import type { InterpData } from './data.ts';

export interface LayoutOptions {
  /** Edge length of each layer plane (m). */
  width: number;
  /** Distance between consecutive layer planes (m). */
  spacing: number;
  /** 'global': one scale for all layers (shows growth); 'layer': each layer fills its plane. */
  normalize: 'global' | 'layer';
  /** Use projection component 2 as a y offset of up to ±depthJitter × spacing (0 = flat planes). */
  depthJitter: number;
  /** Token filter; omitted = all tokens visible. */
  tokenVisible?: (t: number) => boolean;
}

export interface Layout {
  L1: number;
  T: number;
  width: number;
  spacing: number;
  /** y of layer 0; layer l sits at y0 + l × spacing. */
  y0: number;
  /** Node position per (l, t), [L1 × T × 3]; NaN where the node is absent (masked or filtered). */
  pos: Float32Array;
  /** Node index per (l, t) or -1. */
  nodeOf: Int32Array;
  nodeCount: number;
  nodeLayer: Int32Array;
  nodeToken: Int32Array;
  /** Normalized residual norm per (l, t) in [0, 1] (0.6 when no norm channel). */
  normN: Float32Array;
  /** 1 if token t passes the filter. */
  visible: Uint8Array;
  /** Max |y offset| of nodes from their plane (depth jitter). */
  maxYOffset: number;
}

export const layerY = (L: Layout, l: number): number => L.y0 + l * L.spacing;

/** Grow-only typed array helper: returns `a` if large enough, else a bigger one (×1.5 headroom). */
export function ensureF32(a: Float32Array | undefined, n: number): Float32Array {
  return a && a.length >= n ? a : new Float32Array(Math.max(16, Math.ceil(n * 1.5)));
}
export function ensureU32(a: Uint32Array | undefined, n: number): Uint32Array {
  return a && a.length >= n ? a : new Uint32Array(Math.max(16, Math.ceil(n * 1.5)));
}
function ensureI32(a: Int32Array | undefined, n: number): Int32Array {
  return a && a.length >= n ? a : new Int32Array(Math.max(16, Math.ceil(n * 1.5)));
}

/** q-quantile of the first n entries of `vals` (sorts a copy; fine at rebuild time). */
export function quantile(vals: Float32Array, n: number, q: number): number {
  if (n <= 0) return 0;
  const s = vals.slice(0, n).sort();
  const i = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
  return s[i];
}

/**
 * Place every existing residual (l, t) in the stack. Reuses `prev`'s arrays
 * when they are large enough.
 */
export function buildLayout(data: InterpData, o: LayoutOptions, prev?: Layout): Layout | null {
  const p = data.proj;
  if (!p) return null;
  const [L1, T, C] = p.shape;
  const n = L1 * T;
  const pos = ensureF32(prev?.pos, n * 3);
  const nodeOf = ensureI32(prev?.nodeOf, n);
  const nodeLayer = ensureI32(prev?.nodeLayer, n);
  const nodeToken = ensureI32(prev?.nodeToken, n);
  const normN = ensureF32(prev?.normN, n);
  const visible = prev && prev.visible.length >= T ? prev.visible : new Uint8Array(Math.max(16, T));
  for (let t = 0; t < T; t++) visible[t] = !o.tokenVisible || o.tokenVisible(t) ? 1 : 0;

  const spacing = o.spacing;
  const y0 = -((L1 - 1) * spacing) / 2;
  const half = o.width / 2;
  const fitR = half * 0.9;

  // Centering + robust scale over all existing residuals (filtered ones too,
  // so toggling the filter does not rescale the scene).
  const scratch = new Float32Array(Math.max(1, n));
  const cx = new Float32Array(L1);
  const cz = new Float32Array(L1);
  const scale = new Float32Array(L1);
  const exists = (l: number, t: number) => data.exists(l, t);
  if (o.normalize === 'layer') {
    for (let l = 0; l < L1; l++) {
      let sx = 0, sz = 0, c = 0;
      for (let t = 0; t < T; t++) {
        if (!exists(l, t)) continue;
        const k = (l * T + t) * C;
        sx += p.data[k]; sz += p.data[k + 1]; c++;
      }
      cx[l] = c ? sx / c : 0;
      cz[l] = c ? sz / c : 0;
      let m = 0;
      for (let t = 0; t < T; t++) {
        if (!exists(l, t)) continue;
        const k = (l * T + t) * C;
        scratch[m++] = Math.max(Math.abs(p.data[k] - cx[l]), Math.abs(p.data[k + 1] - cz[l]));
      }
      scale[l] = quantile(scratch, m, 0.98) || 1;
    }
  } else {
    let sx = 0, sz = 0, c = 0;
    for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) {
      if (!exists(l, t)) continue;
      const k = (l * T + t) * C;
      sx += p.data[k]; sz += p.data[k + 1]; c++;
    }
    const mx = c ? sx / c : 0, mz = c ? sz / c : 0;
    let m = 0;
    for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) {
      if (!exists(l, t)) continue;
      const k = (l * T + t) * C;
      scratch[m++] = Math.max(Math.abs(p.data[k] - mx), Math.abs(p.data[k + 1] - mz));
    }
    const s = quantile(scratch, m, 0.98) || 1;
    cx.fill(mx); cz.fill(mz); scale.fill(s);
  }

  // Depth jitter scale from component 2.
  let s2 = 1;
  if (C >= 3 && o.depthJitter > 0) {
    let m = 0;
    for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) if (exists(l, t)) scratch[m++] = Math.abs(p.data[(l * T + t) * C + 2]);
    s2 = quantile(scratch, m, 0.98) || 1;
  }

  // Norms → [0, 1] via the 95th percentile (robust to outliers like BOS sinks), sqrt for perception.
  const norm = data.norm;
  let nScale = 1;
  if (norm) {
    let m = 0;
    for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) if (exists(l, t) && Number.isFinite(norm.data[l * T + t])) scratch[m++] = Math.abs(norm.data[l * T + t]);
    nScale = quantile(scratch, m, 0.95) || 1;
  }

  let count = 0;
  let maxYOffset = 0;
  const yAmp = o.depthJitter * spacing;
  for (let l = 0; l < L1; l++) {
    const yl = y0 + l * spacing;
    for (let t = 0; t < T; t++) {
      const i = l * T + t;
      const nv = norm ? norm.data[i] : NaN;
      normN[i] = norm && Number.isFinite(nv) ? Math.sqrt(Math.min(1, Math.abs(nv) / nScale)) : 0.6;
      if (!visible[t] || !exists(l, t)) {
        pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = NaN;
        nodeOf[i] = -1;
        continue;
      }
      const k = i * C;
      const f = fitR / scale[l];
      const x = clampAbs((p.data[k] - cx[l]) * f, half * 1.15);
      const z = clampAbs((p.data[k + 1] - cz[l]) * f, half * 1.15);
      let dy = 0;
      if (yAmp > 0 && C >= 3) {
        dy = clampAbs((p.data[k + 2] / s2) * yAmp, yAmp);
        maxYOffset = Math.max(maxYOffset, Math.abs(dy));
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = yl + dy;
      pos[i * 3 + 2] = z;
      nodeOf[i] = count;
      nodeLayer[count] = l;
      nodeToken[count] = t;
      count++;
    }
  }

  return { L1, T, width: o.width, spacing, y0, pos, nodeOf, nodeCount: count, nodeLayer, nodeToken, normN, visible, maxYOffset };
}

function clampAbs(v: number, m: number): number {
  return v > m ? m : v < -m ? -m : v;
}

// ---------------------------------------------------------------- ribbons

/**
 * Ribbon vertex buffers shared by trajectories and attention arcs. Each center
 * line sample emits two vertices (side −1 / +1); the vertex shader expands
 * them perpendicular to both the tangent and the view direction, so a flat
 * strip reads as a tube from every angle.
 *   position (3)  center-line point
 *   tangent  (3)  center-line direction (unnormalized ok)
 *   data     (4)  side, u (flow coordinate), weight [0,1] (width/brightness), token id
 *   color    (3)  linear RGB
 */
export interface RibbonBuffers {
  position: Float32Array;
  tangent: Float32Array;
  data: Float32Array;
  color: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  indexCount: number;
  /** Number of separate strips (trajectory segments / arcs). */
  strips: number;
}

export function emptyRibbons(): RibbonBuffers {
  return {
    position: new Float32Array(16), tangent: new Float32Array(16), data: new Float32Array(16), color: new Float32Array(16),
    index: new Uint32Array(16), vertexCount: 0, indexCount: 0, strips: 0,
  };
}

function reserveRibbons(b: RibbonBuffers, verts: number, indices: number): void {
  b.position = ensureF32(b.position, verts * 3);
  b.tangent = ensureF32(b.tangent, verts * 3);
  b.data = ensureF32(b.data, verts * 4);
  b.color = ensureF32(b.color, verts * 3);
  b.index = ensureU32(b.index, indices);
  b.vertexCount = 0;
  b.indexCount = 0;
  b.strips = 0;
}

/** Append one center-line sample (2 vertices); links to the previous sample unless `first`. */
function pushSample(
  b: RibbonBuffers, first: boolean,
  px: number, py: number, pz: number, tx: number, ty: number, tz: number,
  u: number, w: number, token: number, r: number, g: number, bl: number,
): void {
  const v = b.vertexCount;
  for (let s = 0; s < 2; s++) {
    const i = v + s;
    b.position[i * 3] = px; b.position[i * 3 + 1] = py; b.position[i * 3 + 2] = pz;
    b.tangent[i * 3] = tx; b.tangent[i * 3 + 1] = ty; b.tangent[i * 3 + 2] = tz;
    b.data[i * 4] = s === 0 ? -1 : 1; b.data[i * 4 + 1] = u; b.data[i * 4 + 2] = w; b.data[i * 4 + 3] = token;
    b.color[i * 3] = r; b.color[i * 3 + 1] = g; b.color[i * 3 + 2] = bl;
  }
  if (!first) {
    const a = v - 2;
    const ix = b.index;
    let k = b.indexCount;
    ix[k++] = a; ix[k++] = a + 1; ix[k++] = v;
    ix[k++] = a + 1; ix[k++] = v + 1; ix[k++] = v;
    b.indexCount = k;
  }
  b.vertexCount = v + 2;
}

/** Contiguous layer runs [start, end] (inclusive) where token t has a node. */
function forEachRun(L: Layout, t: number, cb: (l0: number, l1: number) => void): void {
  let start = -1;
  for (let l = 0; l <= L.L1; l++) {
    const has = l < L.L1 && L.nodeOf[l * L.T + t] >= 0;
    if (has && start < 0) start = l;
    if (!has && start >= 0) {
      cb(start, l - 1);
      start = -1;
    }
  }
}

/**
 * Smooth trajectories (uniform Catmull-Rom through each token's nodes, with
 * reflected end points so the curve ends exactly at the first/last node).
 * Masked positions split a trajectory into separate strips.
 * `nodeColor` is [L1 × T × 3] linear RGB.
 */
export function buildTrajectories(L: Layout, nodeColor: Float32Array, samplesPerGap: number, out: RibbonBuffers = emptyRibbons()): RibbonBuffers {
  const S = Math.max(1, Math.floor(samplesPerGap));
  // Pre-count.
  let verts = 0, idx = 0;
  for (let t = 0; t < L.T; t++) {
    if (!L.visible[t]) continue;
    forEachRun(L, t, (a, b) => {
      if (b <= a) return;
      const samples = (b - a) * S + 1;
      verts += samples * 2;
      idx += (samples - 1) * 6;
    });
  }
  reserveRibbons(out, verts, idx);
  const P = L.pos, T = L.T;
  const px = (l: number, t: number, c: number) => P[(l * T + t) * 3 + c];

  for (let t = 0; t < T; t++) {
    if (!L.visible[t]) continue;
    forEachRun(L, t, (a, b) => {
      if (b <= a) return;
      out.strips++;
      let first = true;
      for (let l = a; l < b; l++) {
        const last = l === b - 1;
        for (let s = 0; s <= (last ? S : S - 1); s++) {
          const u = s / S;
          // Control points p0..p3 around the gap [l, l+1], reflected at run ends.
          let x = 0, y = 0, z = 0, dx = 0, dy = 0, dz = 0;
          for (let c = 0; c < 3; c++) {
            const p1 = px(l, t, c), p2 = px(l + 1, t, c);
            const p0 = l - 1 >= a ? px(l - 1, t, c) : 2 * p1 - p2;
            const p3 = l + 2 <= b ? px(l + 2, t, c) : 2 * p2 - p1;
            const u2 = u * u, u3 = u2 * u;
            const a1 = -p0 + p2, a2 = 2 * p0 - 5 * p1 + 4 * p2 - p3, a3 = -p0 + 3 * p1 - 3 * p2 + p3;
            const v = 0.5 * (2 * p1 + a1 * u + a2 * u2 + a3 * u3);
            const d = 0.5 * (a1 + 2 * a2 * u + 3 * a3 * u2);
            if (c === 0) { x = v; dx = d; } else if (c === 1) { y = v; dy = d; } else { z = v; dz = d; }
          }
          const i0 = l * T + t, i1 = (l + 1) * T + t;
          const w = L.normN[i0] + (L.normN[i1] - L.normN[i0]) * u;
          const r = nodeColor[i0 * 3] + (nodeColor[i1 * 3] - nodeColor[i0 * 3]) * u;
          const g = nodeColor[i0 * 3 + 1] + (nodeColor[i1 * 3 + 1] - nodeColor[i0 * 3 + 1]) * u;
          const bl = nodeColor[i0 * 3 + 2] + (nodeColor[i1 * 3 + 2] - nodeColor[i0 * 3 + 2]) * u;
          pushSample(out, first, x, y, z, dx, dy, dz, l + u, w, t, r, g, bl);
          first = false;
        }
      }
    });
  }
  return out;
}

export interface ArcOptions {
  topK: number;
  minWeight: number;
  samples: number;
  /** Linear RGB of the arcs. */
  color: [number, number, number];
}

/**
 * Attention arcs inside the plane of `layer` from each attended key to the
 * query token: quadratic Béziers that arch slightly above the plane (kept
 * below the next plane). `weights` is the query's attention row (length T).
 * The flow coordinate u runs 0 → 1 from key to query (information flow).
 * Returns the indices of the drawn keys in `keysOut` (descending weight).
 */
export function buildArcs(
  L: Layout, layer: number, query: number, weights: ArrayLike<number>, o: ArcOptions,
  out: RibbonBuffers = emptyRibbons(), keysOut: number[] = [],
): RibbonBuffers {
  keysOut.length = 0;
  reserveRibbons(out, 0, 0);
  if (layer < 0 || layer >= L.L1 || query < 0 || query >= L.T) return out;
  const qi = layer * L.T + query;
  if (L.nodeOf[qi] < 0) return out;
  // Candidate keys.
  for (let k = 0; k < L.T; k++) {
    if (k === query) continue;
    const w = weights[k];
    if (!(w >= o.minWeight) || L.nodeOf[layer * L.T + k] < 0) continue;
    keysOut.push(k);
  }
  keysOut.sort((a, b) => weights[b] - weights[a]);
  if (keysOut.length > o.topK) keysOut.length = Math.max(0, o.topK);
  if (!keysOut.length) return out;
  const wMax = weights[keysOut[0]] || 1;
  const S = Math.max(2, Math.floor(o.samples));
  reserveRibbons(out, keysOut.length * (S + 1) * 2, keysOut.length * S * 6);
  const P = L.pos;
  const bx = P[qi * 3], by = P[qi * 3 + 1], bz = P[qi * 3 + 2];
  for (const k of keysOut) {
    const ki = layer * L.T + k;
    const ax = P[ki * 3], ay = P[ki * 3 + 1], az = P[ki * 3 + 2];
    const dist = Math.hypot(bx - ax, bz - az);
    const lift = Math.min(L.spacing * 0.8, L.spacing * 0.3 + dist * 0.35);
    const cx = (ax + bx) / 2, cy = Math.max(ay, by) + lift, cz = (az + bz) / 2;
    const w = Math.sqrt(weights[k] / wMax);
    out.strips++;
    for (let s = 0; s <= S; s++) {
      const u = s / S, m = 1 - u;
      const x = m * m * ax + 2 * m * u * cx + u * u * bx;
      const y = m * m * ay + 2 * m * u * cy + u * u * by;
      const z = m * m * az + 2 * m * u * cz + u * u * bz;
      const dx = 2 * m * (cx - ax) + 2 * u * (bx - cx);
      const dy = 2 * m * (cy - ay) + 2 * u * (by - cy);
      const dz = 2 * m * (cz - az) + 2 * u * (bz - cz);
      // token id -2: never matches the selection/hover uniforms.
      pushSample(out, s === 0, x, y, z, dx, dy, dz, u, w, -2, o.color[0], o.color[1], o.color[2]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- ticks

export interface TickBuffers {
  /** Node position per tick (3). */
  center: Float32Array;
  /** value [0, ~1.25], kind (0 attn, 1 mlp), token, layer. */
  info: Float32Array;
  count: number;
}

/**
 * Paired attn/MLP write-magnitude ticks. Block b's writes are drawn at the
 * node it produced: residual layer b + 1. Values are scaled by the 98th
 * percentile over both kinds so attn and MLP stay comparable.
 */
export function buildTicks(L: Layout, delta: { shape: number[]; data: Float32Array }, out?: TickBuffers): TickBuffers {
  const T = L.T;
  const blocks = Math.min(delta.shape[0], L.L1 - 1);
  let n = 0;
  for (let b = 0; b < blocks; b++) for (let t = 0; t < T; t++) if (L.nodeOf[(b + 1) * T + t] >= 0) n += 2;
  const center = ensureF32(out?.center, n * 3);
  const info = ensureF32(out?.info, n * 4);
  const scratch = new Float32Array(Math.max(1, n));
  let m = 0;
  for (let b = 0; b < blocks; b++) for (let k = 0; k < 2; k++) for (let t = 0; t < T; t++) {
    if (L.nodeOf[(b + 1) * T + t] < 0) continue;
    const v = Math.abs(delta.data[(b * 2 + k) * T + t]);
    if (Number.isFinite(v)) scratch[m++] = v;
  }
  const s = quantile(scratch, m, 0.98) || 1;
  let c = 0;
  for (let b = 0; b < blocks; b++) for (let t = 0; t < T; t++) {
    const i = (b + 1) * T + t;
    if (L.nodeOf[i] < 0) continue;
    for (let k = 0; k < 2; k++) {
      const raw = Math.abs(delta.data[(b * 2 + k) * T + t]);
      center[c * 3] = L.pos[i * 3]; center[c * 3 + 1] = L.pos[i * 3 + 1]; center[c * 3 + 2] = L.pos[i * 3 + 2];
      info[c * 4] = Number.isFinite(raw) ? Math.min(1.25, raw / s) : 0;
      info[c * 4 + 1] = k; info[c * 4 + 2] = t; info[c * 4 + 3] = b + 1;
      c++;
    }
  }
  return { center, info, count: c };
}

// ---------------------------------------------------------------- picking

export type PickResult =
  | { kind: 'token'; token: number; layer: number }
  | { kind: 'layer'; layer: number };

/** Nearest layer index to a local y. */
export function layerAt(L: Layout, y: number): number {
  const l = Math.round((y - L.y0) / L.spacing);
  return l < 0 ? 0 : l >= L.L1 ? L.L1 - 1 : l;
}

/** Nearest visible node of `layer` within `radius` of (x, y, z), or -1. */
export function nearestNodeInLayer(L: Layout, layer: number, x: number, y: number, z: number, radius: number): number {
  let best = -1, bd = radius * radius;
  const T = L.T;
  for (let t = 0; t < T; t++) {
    const i = layer * T + t;
    if (L.nodeOf[i] < 0) continue;
    const dx = L.pos[i * 3] - x, dy = L.pos[i * 3 + 1] - y, dz = L.pos[i * 3 + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d <= bd) { bd = d; best = t; }
  }
  return best;
}

/** Allocation-free pick result: kind 0 = nothing, 1 = layer plane, 2 = token node. */
export interface PickSlot {
  kind: 0 | 1 | 2;
  token: number;
  layer: number;
}

/**
 * Resolve a widget-local point (from an interaction event) to a token node
 * or a layer plane, writing into `out` (no allocation; used per hover frame).
 * Points outside the planes' footprint (plus margin) or farther than half a
 * spacing from any plane resolve to kind 0.
 */
export function resolveInto(L: Layout, x: number, y: number, z: number, nodeRadius: number, out: PickSlot, margin = 0.03): PickSlot {
  out.kind = 0; out.token = -1; out.layer = -1;
  const half = L.width / 2 + margin;
  if (Math.abs(x) > half || Math.abs(z) > half) return out;
  const l = layerAt(L, y);
  if (Math.abs(y - (L.y0 + l * L.spacing)) > Math.max(L.spacing / 2, L.maxYOffset + nodeRadius)) return out;
  out.layer = l;
  out.token = nearestNodeInLayer(L, l, x, y, z, nodeRadius);
  out.kind = out.token >= 0 ? 2 : 1;
  return out;
}

/** Convenience wrapper of resolveInto() returning a tagged result (or null). */
export function resolvePoint(L: Layout, p: readonly number[], nodeRadius: number, margin = 0.03): PickResult | null {
  const r = resolveInto(L, p[0], p[1], p[2], nodeRadius, { kind: 0, token: -1, layer: -1 }, margin);
  return r.kind === 2 ? { kind: 'token', token: r.token, layer: r.layer } : r.kind === 1 ? { kind: 'layer', layer: r.layer } : null;
}

export interface RayHit {
  /** Distance along the (unit) ray. */
  distance: number;
  x: number;
  y: number;
  z: number;
  /** Token id if a node was hit, else -1 (plane hit). */
  token: number;
  /** Layer of the hit (set by rayStack; rayLayer leaves it as passed). */
  layer?: number;
}

/**
 * Ray (local frame, unit direction) against the whole stack — what the user
 * actually points at:
 *  1. nodes the ray passes through visually (within `directRadius`): the
 *     nearest one along the ray (front nodes occlude back ones);
 *  2. else the node closest to the ray within `nodeRadius` (forgiving aim);
 *  3. else the first layer plane whose footprint the ray crosses.
 * Per-layer picking (rayLayer per slab) would let the footprint of a nearer
 * plane win over an interior node for any angled ray, so slabs share this
 * result and only the winning layer's slab reports an intersection.
 * O((L+1)·T), no allocation.
 */
export function rayStack(
  L: Layout,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  directRadius: number, nodeRadius: number, margin: number, out: RayHit,
): RayHit | null {
  const T = L.T, P = L.pos;
  const d2 = directRadius * directRadius, r2 = nodeRadius * nodeRadius;
  let direct = -1, directS = Infinity;
  let near = -1, nearE = Infinity, nearS = Infinity;
  for (let k = 0; k < L.nodeCount; k++) {
    const i = L.nodeLayer[k] * T + L.nodeToken[k];
    const qx = P[i * 3] - ox, qy = P[i * 3 + 1] - oy, qz = P[i * 3 + 2] - oz;
    const s = qx * dx + qy * dy + qz * dz;
    if (s <= 0) continue;
    const ex = qx - dx * s, ey = qy - dy * s, ez = qz - dz * s;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > r2) continue;
    if (e2 <= d2 && s < directS) { directS = s; direct = i; }
    if (e2 < nearE - 1e-12 || (Math.abs(e2 - nearE) <= 1e-12 && s < nearS)) { nearE = e2; nearS = s; near = i; }
  }
  const best = direct >= 0 ? direct : near;
  if (best >= 0) {
    out.distance = best === direct ? directS : nearS;
    out.x = P[best * 3]; out.y = P[best * 3 + 1]; out.z = P[best * 3 + 2];
    out.token = best % T;
    out.layer = (best - out.token) / T;
    return out;
  }
  if (Math.abs(dy) < 1e-6) return null;
  const half = L.width / 2 + margin;
  let bestS = Infinity, bestL = -1, hx = 0, hz = 0;
  for (let l = 0; l < L.L1; l++) {
    const s = (L.y0 + l * L.spacing - oy) / dy;
    if (s <= 0 || s >= bestS) continue;
    const x = ox + dx * s, z = oz + dz * s;
    if (Math.abs(x) > half || Math.abs(z) > half) continue;
    bestS = s; bestL = l; hx = x; hz = z;
  }
  if (bestL < 0) return null;
  out.distance = bestS; out.x = hx; out.y = L.y0 + bestL * L.spacing; out.z = hz; out.token = -1; out.layer = bestL;
  return out;
}

/**
 * Ray (local frame, unit direction) against one layer: nodes within
 * `nodeRadius` of the ray win over the plane footprint. The hit point of a
 * node hit is the node itself so resolvePoint() maps it back exactly.
 */
export function rayLayer(
  L: Layout, layer: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  nodeRadius: number, margin = 0.02, out?: RayHit,
): RayHit | null {
  const T = L.T;
  // Among nodes within the radius, the one closest to the ray wins (nodes of a
  // plane often line up behind each other at grazing angles); ties → nearer.
  let best = -1, bestS = Infinity, bestE = Infinity;
  const r2 = nodeRadius * nodeRadius;
  for (let t = 0; t < T; t++) {
    const i = layer * T + t;
    if (L.nodeOf[i] < 0) continue;
    const qx = L.pos[i * 3] - ox, qy = L.pos[i * 3 + 1] - oy, qz = L.pos[i * 3 + 2] - oz;
    const s = qx * dx + qy * dy + qz * dz;
    if (s <= 0) continue;
    const ex = qx - dx * s, ey = qy - dy * s, ez = qz - dz * s;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 <= r2 && (e2 < bestE - 1e-12 || (Math.abs(e2 - bestE) <= 1e-12 && s < bestS))) { bestE = e2; bestS = s; best = t; }
  }
  const o = out ?? { distance: 0, x: 0, y: 0, z: 0, token: -1 };
  if (best >= 0) {
    const i = layer * T + best;
    o.distance = bestS; o.x = L.pos[i * 3]; o.y = L.pos[i * 3 + 1]; o.z = L.pos[i * 3 + 2]; o.token = best;
    return o;
  }
  if (Math.abs(dy) < 1e-6) return null;
  const yl = L.y0 + layer * L.spacing;
  const s = (yl - oy) / dy;
  if (s <= 0) return null;
  const hx = ox + dx * s, hz = oz + dz * s;
  const half = L.width / 2 + margin;
  if (Math.abs(hx) > half || Math.abs(hz) > half) return null;
  o.distance = s; o.x = hx; o.y = yl; o.z = hz; o.token = -1;
  return o;
}
