// Shared plumbing for the debug overlays: a world-level group (never under
// runtime.root's entity nodes, so it is never hit-tested and never counts
// toward entity bounds), a space-frame child that follows runtime.root,
// growable line batches (one draw call each, vertex colors, no raycast) and a
// DOM label layer projected over the canvas. Everything here is fully
// disposed by its owner; nothing allocates per frame in steady state.

import type * as THREE_NS from 'three';
import type { DebugContext } from '../types.ts';

type THREE = DebugContext['THREE'];

const noRaycast = () => {};

/** Mark an overlay object (and descendants) as never hit-testable / never frustum-culled. */
export function inert(o: THREE_NS.Object3D): void {
  o.traverse((c) => {
    c.raycast = noRaycast;
    c.frustumCulled = false;
    c.userData.debugOverlay = true;
  });
}

/** A group in the world scene; `space` follows runtime.root (space coordinates). */
export class OverlayRoot {
  readonly world: THREE_NS.Group;
  readonly space: THREE_NS.Group;
  constructor(private readonly ctx: Pick<DebugContext, 'THREE' | 'scene' | 'runtime'>, name: string) {
    const T = ctx.THREE;
    this.world = new T.Group();
    this.world.name = `debug-overlay:${name}`;
    this.space = new T.Group();
    this.space.name = `debug-overlay:${name}:space`;
    this.space.matrixAutoUpdate = false;
    this.world.add(this.space);
    this.world.userData.debugOverlay = true;
    this.world.raycast = noRaycast;
    this.space.raycast = noRaycast;
    ctx.scene.add(this.world);
    this.sync();
  }

  /** Copy the space root's world matrix (call per frame before using `space`). */
  sync(): void {
    const root = this.ctx.runtime.root;
    root.updateWorldMatrix(true, false);
    this.space.matrix.copy(root.matrixWorld);
    this.space.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.world.removeFromParent();
    disposeTree(this.world);
  }
}

/** Dispose geometries/materials of a subtree (overlay-owned only). */
export function disposeTree(o: THREE_NS.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE_NS.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE_NS.Material | THREE_NS.Material[] | undefined;
    if (Array.isArray(mat)) for (const x of mat) x.dispose(); else mat?.dispose();
  });
}

/**
 * Growable batch of colored line segments (2 vertices per segment). Write with
 * begin() → seg()… → end(). One draw call.
 */
export class LineBatch {
  readonly lines: THREE_NS.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private n = 0;
  private cap: number;
  constructor(private readonly T: THREE, opts: { capacity?: number; opacity?: number; depthTest?: boolean; renderOrder?: number; name?: string } = {}) {
    this.cap = opts.capacity ?? 256;
    this.pos = new Float32Array(this.cap * 6);
    this.col = new Float32Array(this.cap * 6);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const mat = new T.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: opts.opacity ?? 0.9,
      depthTest: opts.depthTest ?? true, depthWrite: false, toneMapped: false,
    });
    this.lines = new T.LineSegments(g, mat);
    this.lines.name = opts.name ?? 'debug-lines';
    this.lines.renderOrder = opts.renderOrder ?? 900;
    inert(this.lines);
  }

  begin(): void { this.n = 0; }

  private grow(): void {
    this.cap *= 2;
    const p = new Float32Array(this.cap * 6); p.set(this.pos); this.pos = p;
    const c = new Float32Array(this.cap * 6); c.set(this.col); this.col = c;
    const g = this.lines.geometry;
    g.setAttribute('position', new this.T.BufferAttribute(this.pos, 3).setUsage(this.T.DynamicDrawUsage));
    g.setAttribute('color', new this.T.BufferAttribute(this.col, 3).setUsage(this.T.DynamicDrawUsage));
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE_NS.Color, c2: THREE_NS.Color = c): void {
    if (this.n >= this.cap) this.grow();
    const o = this.n * 6;
    const p = this.pos, k = this.col;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az; p[o + 3] = bx; p[o + 4] = by; p[o + 5] = bz;
    k[o] = c.r; k[o + 1] = c.g; k[o + 2] = c.b; k[o + 3] = c2.r; k[o + 4] = c2.g; k[o + 5] = c2.b;
    this.n++;
  }

  segV(a: THREE_NS.Vector3, b: THREE_NS.Vector3, c: THREE_NS.Color, c2?: THREE_NS.Color): void {
    this.seg(a.x, a.y, a.z, b.x, b.y, b.z, c, c2);
  }

  /** 12 edges of a box given its 8 corners (Box3 corner order: see boxCorners). */
  box(corners: THREE_NS.Vector3[], c: THREE_NS.Color): void {
    for (const [i, j] of BOX_EDGES) this.segV(corners[i], corners[j], c);
  }

  end(): void {
    const g = this.lines.geometry;
    (g.getAttribute('position') as THREE_NS.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE_NS.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, this.n * 2);
    this.lines.visible = this.n > 0;
  }

  get count(): number { return this.n; }

  dispose(): void {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE_NS.Material).dispose();
  }
}

/** Corner i has bit0 → x max, bit1 → y max, bit2 → z max. */
export const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
];

/** Write the 8 corners of `box` transformed by `m` into `out` (no allocation). */
export function boxCorners(box: THREE_NS.Box3, m: THREE_NS.Matrix4 | null, out: THREE_NS.Vector3[]): void {
  for (let i = 0; i < 8; i++) {
    out[i].set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    if (m) out[i].applyMatrix4(m);
  }
}

// ------------------------------------------------------------------ DOM labels

/**
 * Screen-space labels over the canvas: reuse a <div> per key, position with a
 * transform each frame, hide when off-screen / behind the camera.
 */
export class LabelLayer {
  readonly el: HTMLDivElement | null;
  private readonly items = new Map<string, { el: HTMLDivElement; html: string; cls: string; used: boolean }>();
  private readonly v: THREE_NS.Vector3;
  private w = 0;
  private h = 0;
  constructor(private readonly ctx: Pick<DebugContext, 'THREE' | 'renderer' | 'camera'>) {
    this.v = new ctx.THREE.Vector3();
    if (typeof document === 'undefined') { this.el = null; return; }
    this.el = document.createElement('div');
    this.el.className = 'vw-labels';
    this.attach();
  }

  /** Keep the layer next to the canvas (the dashboard moves the canvas into its viewport after start-up). */
  private attach(): void {
    const host = this.ctx.renderer.domElement.parentElement;
    if (this.el && host && this.el.parentElement !== host) host.appendChild(this.el);
  }

  begin(): void {
    for (const it of this.items.values()) it.used = false;
    // Read layout once per frame (before any style writes).
    if (this.el) { this.attach(); this.w = this.el.clientWidth; this.h = this.el.clientHeight; }
  }

  /** Show a label at a world point. `html` must be trusted/escaped by the caller. */
  put(key: string, world: THREE_NS.Vector3, html: string, cls = '', dy = 0): void {
    if (!this.el) return;
    let it = this.items.get(key);
    if (!it) {
      const el = document.createElement('div');
      el.className = `vw-label${cls ? ` ${cls}` : ''}`;
      el.innerHTML = html;
      this.el.appendChild(el);
      it = { el, html, cls, used: true };
      this.items.set(key, it);
    }
    it.used = true;
    if (it.html !== html) { it.el.innerHTML = html; it.html = html; }
    if (it.cls !== cls) { it.el.className = `vw-label${cls ? ` ${cls}` : ''}`; it.cls = cls; }
    const cam = this.ctx.camera;
    const v = this.v.copy(world).applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -cam.near) { it.el.style.display = 'none'; return; }
    v.applyMatrix4(cam.projectionMatrix);
    const w = this.w, h = this.h;
    const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h + dy;
    if (x < -200 || x > w + 200 || y < -50 || y > h + 50) { it.el.style.display = 'none'; return; }
    it.el.style.display = 'block';
    it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  end(): void {
    for (const [k, it] of this.items) {
      if (!it.used) { it.el.remove(); this.items.delete(k); }
    }
  }

  dispose(): void {
    for (const it of this.items.values()) it.el.remove();
    this.items.clear();
    this.el?.remove();
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Theme-derived overlay colors. */
export function overlayColors(ctx: Pick<DebugContext, 'THREE' | 'runtime'>) {
  const T = ctx.THREE;
  const th = ctx.runtime.theme;
  return {
    accent: new T.Color(th.accent),
    accent2: new T.Color(th.accent2),
    pos: new T.Color(th.positive),
    neg: new T.Color(th.negative),
    dim: new T.Color(th.textDim).multiplyScalar(0.75),
    text: new T.Color(th.text),
    x: new T.Color('#ff6b7a'), y: new T.Color('#6fdc8c'), z: new T.Color('#5aa9ff'),
    left: new T.Color('#c38bff'), right: new T.Color(th.accent),
  };
}
