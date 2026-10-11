// Smooth scrolling for widgets with a scroll area (lists, chats, text previews).
//
//   SmoothScroll    the motion: content follows the hand 1:1 while dragging, keeps gliding after a
//                   flick and decelerates (iOS-style friction), eases to scrollTo() targets, and
//                   stays within [0, max]. Unit-agnostic: rows, lines or meters — the widget converts
//                   hand travel into its unit.
//   TextSync        rows without flicker: troika lays text out asynchronously, so after .set() a text keeps
//                   drawing its OLD string for a frame or two. Pooled rows therefore keep their item while it
//                   stays in view (ring slots: item i always uses slot i % slots) and a slot that takes a new
//                   item stays hidden until its texts are laid out (TextSync.ready()).
//   ScrollViewport  the clipping: rows that are only partly inside the scroll area are cut exactly at
//                   its edges — meshes through two clipping planes (shared materials are cloned once),
//                   troika texts through clipRect — and invisible hit targets are trimmed to the
//                   part inside the area (so a half-visible row can't steal taps from what is
//                   above or below the area). Needs renderer.localClippingEnabled (the client and mirror enable it).
//
// Typical row list (first visible row index + fractional offset instead of Math.round):
//
//   const scroll = new SmoothScroll();
//   const view = new ScrollViewport(ctx.THREE, group, rowsBottom, rowsTop);   // after build
//   view.add(rowGroup)                                                       // for each pooled row
//   // drag: scroll.dragStart(); scroll.dragMove(-(y - y0) / rowH) … scroll.dragEnd()
//   // update(dt): if (scroll.step(dt)) dirty = true; … render: first = Math.floor(scroll.pos),
//   //   frac = scroll.pos - first, row r at rowsTop - (r + 0.5 - frac) * rowH (pool n + 1 rows);
//   //   then view.update().

import type * as THREE from 'three';

type Three = typeof THREE;

/** Friction time constant of a fling (s): speed decays by 1/e every FRICTION_S. */
const FRICTION_S = 0.32;
/** Release speeds below this many rows/s don't fling (a held, still hand). */
const MIN_FLING = 1.5;
/** A glide slower than this many rows/s comes to rest. */
const REST_SPEED = 0.05;
/** Velocity is measured over the last VELOCITY_WINDOW_MS of dragging. */
const VELOCITY_WINDOW_MS = 90;
/** scrollTo easing rate (1/s). */
const EASE_RATE = 14;

export class SmoothScroll {
  /** Current position (unit of the widget's choice), always within [0, max]. */
  pos = 0;
  private _max = 0;
  private vel = 0;
  private target: number | null = null;
  private dragging = false;
  private dragPos0 = 0;
  private dragDelta = 0;
  private samples: Array<{ t: number; pos: number }> = [];
  private changed = false;

  private readonly now: () => number;
  private readonly unit: number;

  /**
   * `unit`: the size of one row in the widget's scroll unit (1 when scrolling in rows; e.g. the row
   * height in meters when scrolling in meters), so the fling/rest speed thresholds mean the same
   * thing in any unit. `now` (ms) is for tests.
   */
  constructor(opts: { unit?: number; now?: () => number } | (() => number) = {}) {
    const o = typeof opts === 'function' ? { now: opts } : opts;
    this.now = o.now ?? (() => performance.now());
    this.unit = o.unit && o.unit > 0 ? o.unit : 1;
  }

  get max(): number { return this._max; }
  /** Content became longer/shorter: clamp (no animation). */
  setMax(max: number): void {
    this._max = Math.max(0, Number.isFinite(max) ? max : 0);
    if (this.target !== null) this.target = clamp(this.target, 0, this._max);
    const p = clamp(this.pos, 0, this._max);
    if (p !== this.pos) { this.pos = p; this.changed = true; }
  }

  /** Dragging or gliding (the widget keeps redrawing while true). */
  get active(): boolean { return this.dragging || this.vel !== 0 || this.target !== null; }
  get isDragging(): boolean { return this.dragging; }

  dragStart(): void {
    this.dragging = true;
    this.vel = 0;
    this.target = null;
    this.dragPos0 = this.pos;
    this.dragDelta = 0;
    this.samples.length = 0;
    this.sample();
  }

  /** Total hand travel since dragStart, converted to scroll units (positive = towards max). */
  dragMove(delta: number): void {
    if (!this.dragging) return;
    this.dragDelta = delta;
    const p = clamp(this.dragPos0 + delta, 0, this._max);
    if (p !== this.pos) { this.pos = p; this.changed = true; }
    this.sample();
  }

  /** Release: fling with the recent drag speed (pass false to stop dead, e.g. a cancelled pinch). */
  dragEnd(fling = true): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.sample();
    const s = this.samples;
    const last = s[s.length - 1];
    let first = s[0];
    for (const x of s) if (last.t - x.t <= VELOCITY_WINDOW_MS) { first = x; break; }
    const dt = (last.t - first.t) / 1000;
    const v = dt > 0.008 ? (last.pos - first.pos) / dt : 0;
    this.vel = fling && Math.abs(v) >= MIN_FLING * this.unit ? v : 0;
  }

  /** Animate to `pos` (or jump with animate false). */
  scrollTo(pos: number, animate = true): void {
    const p = clamp(pos, 0, this._max);
    this.vel = 0;
    if (this.dragging) return;
    if (!animate) { this.target = null; if (p !== this.pos) { this.pos = p; this.changed = true; } return; }
    this.target = Math.abs(p - this.pos) < 1e-4 ? null : p;
  }

  /** Shift without animation (keep content anchored when items are inserted above/below). */
  shift(delta: number): void {
    if (this.dragging) this.dragPos0 += delta;
    if (this.target !== null) this.target += delta;
    const p = clamp(this.pos + delta, 0, this._max);
    if (p !== this.pos) { this.pos = p; this.changed = true; }
  }

  /** Stop any glide (e.g. the list was replaced). */
  stop(): void { this.vel = 0; this.target = null; }

  /** Advance the glide; true when pos changed since the last call (redraw). */
  step(dt: number): boolean {
    if (!this.dragging && dt > 0) {
      if (this.vel !== 0) {
        const decay = Math.exp(-dt / FRICTION_S);
        // Exact integral of v·e^(-t/τ) over the step.
        const p = this.pos + this.vel * FRICTION_S * (1 - decay);
        this.vel *= decay;
        const c = clamp(p, 0, this._max);
        if (c !== p || Math.abs(this.vel) < REST_SPEED * this.unit) this.vel = 0; // hit an end, or slow enough to rest
        if (c !== this.pos) { this.pos = c; this.changed = true; }
      } else if (this.target !== null) {
        const k = 1 - Math.exp(-dt * EASE_RATE);
        let p = this.pos + (this.target - this.pos) * k;
        if (Math.abs(this.target - p) < 1e-3 * this.unit) { p = this.target; this.target = null; }
        if (p !== this.pos) { this.pos = p; this.changed = true; }
      }
    }
    const c = this.changed;
    this.changed = false;
    return c;
  }

  private sample(): void {
    const t = this.now();
    this.samples.push({ t, pos: this.dragPos0 + this.dragDelta });
    if (this.samples.length > 24) this.samples.splice(0, this.samples.length - 24);
  }
}

interface ClipText { mesh: THREE.Object3D & { clipRect: number[] | null }; rect: number[] }
/** A hit box (unit box geometry scaled to size) and its laid-out centre/height, before trimming. */
interface ClipHit { mesh: THREE.Object3D; y: number; h: number }

/**
 * Clips everything added to it to the horizontal band [y0, y1] of `frame` (local coordinates of
 * `frame`, which must not be rotated relative to the added content). Keep one per scroll area;
 * call update() after laying out (and each frame while the entity may move — it is cheap).
 */
export class ScrollViewport {
  /** World-space planes shared by every clipped material (updated in place). */
  readonly planes: [THREE.Plane, THREE.Plane];
  private texts: ClipText[] = [];
  private hits: ClipHit[] = [];
  private readonly v: THREE.Vector3;
  private readonly n: THREE.Vector3;

  constructor(T: Three, private readonly frame: THREE.Object3D, public y0: number, public y1: number) {
    this.planes = [new T.Plane(), new T.Plane()];
    this.v = new T.Vector3();
    this.n = new T.Vector3();
  }

  setRect(y0: number, y1: number): void { this.y0 = y0; this.y1 = y1; }

  /** Clip `obj` and everything under it (call once after building it). */
  add(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh & { clipRect?: number[] | null; text?: unknown };
      if ('text' in mesh && 'clipRect' in mesh) {
        this.texts.push({ mesh: mesh as ClipText['mesh'], rect: [-1e3, -1e3, 1e3, 1e3] });
        return;
      }
      if (!mesh.isMesh || !mesh.material || Array.isArray(mesh.material)) return;
      const mat = mesh.material as THREE.Material;
      if (mat.visible === false) { this.hits.push({ mesh, y: mesh.position.y, h: mesh.scale.y }); return; } // invisible hit target
      if (mat.clippingPlanes === this.planes) return;
      let own = mat;
      if (mat.userData?.evolShared) {
        own = mat.clone();
        delete own.userData.evolShared; // ours now: disposeTree frees it
      }
      own.clippingPlanes = this.planes;
      mesh.material = own;
    });
  }

  /** Recompute the planes (world space), text clip rects and hit-target visibility. */
  update(): void {
    const f = this.frame;
    f.updateWorldMatrix(true, false);
    // bottom plane keeps y > y0, top plane keeps y < y1 (three keeps the side the normal points to).
    this.setPlane(this.planes[0], this.y0, 1);
    this.setPlane(this.planes[1], this.y1, -1);
    for (const t of this.texts) {
      const ty = this.offsetY(t.mesh);
      if (ty === null) continue;
      t.rect[1] = this.y0 - ty;
      t.rect[3] = this.y1 - ty;
      if (t.mesh.clipRect !== t.rect) t.mesh.clipRect = t.rect;
    }
    for (const h of this.hits) {
      const parentY = h.mesh.parent ? this.offsetY(h.mesh.parent) : null;
      if (parentY === null) continue;
      const c = parentY + h.y;
      const lo = Math.max(this.y0, c - h.h / 2), hi = Math.min(this.y1, c + h.h / 2);
      h.mesh.visible = hi - lo > 1e-4;
      if (!h.mesh.visible) continue;
      h.mesh.position.y = h.y + ((lo + hi) / 2 - c);
      h.mesh.scale.y = hi - lo;
    }
  }

  private setPlane(p: THREE.Plane, y: number, dir: 1 | -1): void {
    // The frame's y axis in world space (rotation and any axis scale: the plane spans the frame's x/z axes).
    this.n.set(0, dir, 0).transformDirection(this.frame.matrixWorld);
    this.v.set(0, y, 0).applyMatrix4(this.frame.matrixWorld);
    p.setFromNormalAndCoplanarPoint(this.n, this.v);
  }

  /** y of `o`'s origin in the frame (sum of translations up to it: rows are translated, never rotated/scaled). */
  private offsetY(o: THREE.Object3D): number | null {
    if (o === this.frame) return 0;
    let y = 0;
    let cur: THREE.Object3D | null = o;
    while (cur && cur !== this.frame) {
      y += cur.position.y;
      cur = cur.parent;
    }
    return cur ? y : null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface SyncText { set(s: string): void }
const textOf = (t: SyncText): string => (t as unknown as { text?: string }).text ?? '';
const infoOf = (t: SyncText): unknown => (t as unknown as { textRenderInfo?: unknown }).textRenderInfo;

/**
 * Tracks whether texts given new strings have been laid out by troika yet. One per pooled row (slot):
 * set() its texts through it when the slot takes a new item, show the slot once ready().
 */
export class TextSync {
  private pending: Array<{ t: SyncText; info: unknown }> = [];
  private frames = 0;
  constructor(private readonly maxFrames = 6) {}

  /** Set `t` to `s`; if that changes what it shows, wait for its layout. Returns whether it changed. */
  set(t: SyncText, s: string): boolean {
    const before = textOf(t);
    const info = infoOf(t);
    t.set(s);
    if (textOf(t) === before) return false; // same (sanitized) string: nothing to lay out
    if (!this.pending.some((p) => p.t === t)) this.pending.push({ t, info });
    this.frames = 0;
    return true;
  }

  /** All texts set since the last ready() === true have been laid out (or gave up after maxFrames frames). Call once per frame. */
  ready(): boolean {
    if (!this.pending.length) return true;
    this.frames++;
    if (this.frames > this.maxFrames || this.pending.every((p) => infoOf(p.t) !== p.info)) { this.pending.length = 0; return true; }
    return false;
  }

  get waiting(): boolean { return this.pending.length > 0; }
}
