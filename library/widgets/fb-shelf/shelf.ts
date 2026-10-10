// fb-shelf — one bookcase (= one folder). Frame boards, books/boxes and their decorations are three
// instanced meshes; a single invisible hit box covers the shelves (the item under the hand is found
// from the hit point, so even thin books are easy to target and hover shows which one it is).
// The case animates toward a target transform (main slot, or a dimmer, smaller ancestor slot to the
// left), items glide to new places on re-sort / re-layout, and a page change revolves the case.

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { FittedInstances } from '../../shared/instanced.ts';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { mixHex, parseHex } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import {
  BACK, BOARD, type CaseDims, type CaseLayout, type Entry, layoutCase, nearestSlots, pageSlots, PLINTH, shelfGeometry, SIDE,
  type Slot, slotAt, sortEntries, type SortMode, spineChars, TOP,
} from './layout.ts';

export interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Entry[]; truncated: boolean; error?: string }

export interface LabelPool { books: Text[]; boxes: Text[]; bookSize: number; boxSize: number }

export const PULL = 0.05;       // hover slide-out (m)
const CREST_H = 0.13;
const CARD = '#ece3cf';
const HOLE = '#2b2118';
const BOOKEND = '#59626d';

const lum = (hex: string) => { const c = parseHex(hex); return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0.5; };

export class CaseView {
  readonly group: THREE.Group;
  readonly hit: THREE.Mesh;
  /** Absolute path once a listing arrived (before: the requested path). */
  path: string;
  adopted = false;
  listing: Listing | null = null;
  layout: CaseLayout | null = null;
  page = 0;
  slots: Slot[] = [];
  /** Name of the child folder open to the right (highlighted while this case is an ancestor). */
  mark: string | null = null;
  leaving = false;
  /** Slot index whose book is out (hidden on the shelf). */
  hidden = -1;
  /** Slot index pressed (follows the hand in z by dragZ). */
  pressed = -1;
  dragZ = 0;
  readonly hovered = new Set<number>();
  /** Target transform + dim (0 = full brightness). */
  readonly tgt = { x: 0, y: 0, z: 0, ry: 0, s: 1, dim: 0 };
  readonly cur = { x: 0, y: 0, z: 0, ry: 0, s: 1, dim: 0 };
  labels: LabelPool | null = null;
  titles: 'up' | 'down' = 'up';

  private readonly T: typeof THREE;
  private readonly content: THREE.Group;
  private readonly frame: FittedInstances;
  private items: FittedInstances;
  private bands: FittedInstances;
  private readonly frameMat: THREE.MeshBasicMaterial;
  private readonly itemMat: THREE.MeshBasicMaterial;
  private readonly bandMat: THREE.MeshBasicMaterial;
  private readonly crest: Text;
  private cap = 0;
  private curX = new Float32Array(0);
  private curY = new Float32Array(0);
  private pull = new Float32Array(0);
  private appear = new Float32Array(0);
  private labelOf = new Int16Array(0);
  private sorted: Entry[] = [];
  private animItems = true;
  private turnT = -1;
  private turnDir = 1;
  private turnTo = 0;
  private colorsDirty = true;
  private readonly lastEnd = new Float32Array(9);
  // scratch (no per-frame allocation)
  private readonly m: THREE.Matrix4;
  private readonly p: THREE.Vector3;
  private readonly q: THREE.Quaternion;
  private readonly sc: THREE.Vector3;
  private readonly col: THREE.Color;
  private readonly inv: THREE.Matrix4;

  constructor(private ctx: WidgetContext, readonly id: number, readonly dims: CaseDims, path: string) {
    const T = (this.T = ctx.THREE);
    this.path = path;
    this.m = new T.Matrix4(); this.p = new T.Vector3(); this.q = new T.Quaternion(); this.sc = new T.Vector3(); this.col = new T.Color(); this.inv = new T.Matrix4();
    this.group = new T.Group();
    this.group.name = `case-view:${id}`;
    this.content = new T.Group();
    this.group.add(this.content);
    this.frameMat = ownMaterial(T, '#ffffff', { shaded: true });
    this.itemMat = ownMaterial(T, '#ffffff', { shaded: true });
    this.bandMat = ownMaterial(T, '#ffffff', { shaded: true });
    this.frame = new FittedInstances(T, shadedGeometry(T, 'box'), this.frameMat, 16);
    this.frame.mesh.name = 'frame';
    this.items = new FittedInstances(T, shadedGeometry(T, 'box'), this.itemMat, 1);
    this.bands = new FittedInstances(T, shadedGeometry(T, 'box'), this.bandMat, 1);
    this.content.add(this.frame.mesh, this.items.mesh, this.bands.mesh);
    this.buildFrame();
    const g = shelfGeometry(dims);
    this.hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
    this.hit.scale.set(g.x1 - g.x0 + 0.016, dims.height - TOP - PLINTH, dims.depth);
    this.hit.position.set(0, PLINTH + (dims.height - TOP - PLINTH) / 2, 0.004);
    this.hit.name = `case:${id}`;
    ctx.interactive(this.hit);
    this.content.add(this.hit);
    this.crest = makeText(ctx, '', { size: 0.046, anchorX: 'center', anchorY: 'middle', color: ctx.theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    this.crest.position.set(0, dims.height + CREST_H * 0.62, dims.depth / 2 - 0.004 + 0.0015);
    this.content.add(this.crest);
  }

  /** Wood frame, back panel, shelf boards and the name crest on top. */
  private buildFrame(): void {
    const T = this.T, d = this.dims, theme = this.ctx.theme;
    const W = d.width, H = d.height, D = d.depth;
    const wood = mixHex('#6d5139', theme.surface, 0.2);
    const woodDark = mixHex('#3a2b20', theme.background, 0.35);
    const edge = mixHex('#86664a', theme.surface, 0.15);
    const g = shelfGeometry(d);
    const f = this.frame;
    f.fit(-W / 2 - 0.01, 0, -D / 2 - 0.01, W / 2 + 0.01, H + CREST_H + 0.01, D / 2 + 0.01);
    let n = 0;
    const board = (x: number, y: number, z: number, w: number, h: number, dd: number, color: string) => {
      this.p.set(x, y, z); this.q.identity(); this.sc.set(w, h, dd);
      this.m.compose(this.p, this.q, this.sc);
      f.setMatrixAt(n, this.m);
      f.setColorAt(n, this.col.set(color));
      n++;
    };
    board(-W / 2 + SIDE / 2, (H - TOP) / 2, 0, SIDE, H - TOP, D, wood);
    board(W / 2 - SIDE / 2, (H - TOP) / 2, 0, SIDE, H - TOP, D, wood);
    board(0, H - TOP / 2, 0.004, W + 0.02, TOP, D + 0.012, edge);
    board(0, (PLINTH - 0.012) / 2, -0.006, W - 2 * SIDE, PLINTH - 0.012, D - 0.012, woodDark);
    board(0, PLINTH + (H - TOP - PLINTH) / 2, -D / 2 + BACK / 2, W - 2 * SIDE, H - TOP - PLINTH, BACK, woodDark);
    for (let k = 0; k < d.shelves - 1; k++) board(0, g.base(k) - BOARD / 2, 0, W - 2 * SIDE, BOARD, D - 0.004, edge);
    board(0, PLINTH - 0.006, 0, W - 2 * SIDE, 0.012, D - 0.004, edge); // bottom shelf surface
    board(0, H + CREST_H / 2, D / 2 - 0.016, W * 0.86, CREST_H, 0.024, wood);
    this.frame.commit(n);
  }

  // ---- data -----------------------------------------------------------------------------------

  setListing(l: Listing, sort: SortMode, folderSizes?: Map<string, number>): void {
    this.listing = l;
    this.path = l.path;
    this.adopted = true;
    this.relayout(sort, folderSizes, false);
  }

  /** Recompute the layout (sort toggle, folder sizes arrived); `glide` animates items to their new places. */
  relayout(sort: SortMode, folderSizes: Map<string, number> | undefined, glide: boolean): void {
    if (!this.listing) return;
    this.sorted = sortEntries(this.listing.entries ?? [], sort);
    this.layout = layoutCase(this.sorted, this.dims, folderSizes);
    let page = Math.min(this.page, this.layout.pages - 1);
    if (this.mark) {
      const s = this.layout.slots.find((x) => x.name === this.mark && x.folder);
      if (s) page = s.page;
    }
    this.showPage(page, glide);
    this.crest.set(truncate(this.title(), Math.floor((this.dims.width * 0.82) / (0.046 * 0.56))));
  }

  title(): string {
    const l = this.listing;
    if (!l) return '';
    const p = l.display || l.path;
    if (p === '~') return '~';
    if (p === '/') return '/';
    return p.replace(/\/+$/, '').split('/').pop() || p;
  }

  entryOf(s: Slot): Entry | null { return this.sorted[s.i] ?? null; }
  get pages(): number { return this.layout?.pages ?? 1; }

  /** Show page `page`; with `glide`, items present before keep their current positions and glide. */
  showPage(page: number, glide: boolean): void {
    if (!this.layout) return;
    const prev = new Map<string, number>();
    if (glide) for (let i = 0; i < this.slots.length; i++) prev.set(this.slots[i].name, i);
    const oldX = this.curX, oldY = this.curY;
    this.page = Math.max(0, Math.min(page, this.layout.pages - 1));
    this.slots = pageSlots(this.layout, this.page);
    const n = this.slots.length;
    this.ensure(n);
    const g = shelfGeometry(this.dims);
    const nx = new Float32Array(this.cap), ny = new Float32Array(this.cap);
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      const j = glide ? prev.get(s.name) : undefined;
      nx[i] = j !== undefined ? oldX[j] : s.x;
      ny[i] = j !== undefined ? oldY[j] : g.base(s.shelf);
      this.appear[i] = glide && j === undefined ? 0 : 1;
      this.pull[i] = 0;
    }
    this.curX = nx; this.curY = ny;
    this.hidden = -1;
    this.pressed = -1;
    this.hovered.clear();
    this.colorsDirty = true;
    this.animItems = true;
    if (this.labels) this.assignLabels(0, this.dims.height * 0.72);
  }

  private ensure(n: number): void {
    if (n <= this.cap && this.cap) return;
    let cap = 16;
    while (cap < n) cap *= 2;
    this.cap = cap;
    this.curX = new Float32Array(cap); this.curY = new Float32Array(cap);
    this.pull = new Float32Array(cap); this.appear = new Float32Array(cap);
    this.labelOf = new Int16Array(cap).fill(-1);
    const T = this.T;
    for (const old of [this.items, this.bands]) { old.mesh.removeFromParent(); old.mesh.dispose(); }
    this.items = new FittedInstances(T, shadedGeometry(T, 'box'), this.itemMat, cap);
    this.bands = new FittedInstances(T, shadedGeometry(T, 'box'), this.bandMat, cap * 2 + 16);
    this.items.mesh.name = 'items';
    this.bands.mesh.name = 'bands';
    for (const f of [this.items, this.bands]) { f.mesh.raycast = () => {}; this.content.add(f.mesh); }
    const W = this.dims.width, H = this.dims.height, D = this.dims.depth;
    this.items.fit(-W / 2, 0, -D / 2, W / 2, H, D / 2 + 0.3);
    this.bands.fit(-W / 2, 0, -D / 2, W / 2, H, D / 2 + 0.3);
  }

  // ---- labels (main case only) ----------------------------------------------------------------

  attachLabels(pool: LabelPool, fx: number, fy: number): void {
    this.labels = pool;
    for (const t of [...pool.books, ...pool.boxes]) { t.visible = false; this.content.add(t); }
    this.assignLabels(fx, fy);
  }

  detachLabels(): void {
    if (!this.labels) return;
    for (const t of [...this.labels.books, ...this.labels.boxes]) { t.visible = false; t.removeFromParent(); }
    this.labels = null;
    this.labelOf.fill(-1);
  }

  hasLabel(i: number): boolean { return i >= 0 && i < this.slots.length && this.labelOf[i] >= 0; }

  /** Give the pooled spine labels to the items nearest to a focus point (case coords). */
  assignLabels(fx: number, fy: number): void {
    const pool = this.labels;
    if (!pool) return;
    this.labelOf.fill(-1);
    const put = (texts: Text[], idx: number[], size: number, big: boolean) => {
      for (let j = 0; j < texts.length; j++) {
        const t = texts[j];
        const i = idx[j];
        if (i === undefined) { t.visible = false; continue; }
        const s = this.slots[i];
        this.labelOf[i] = big ? 1000 + j : j;
        const len = s.folder ? s.h * 0.56 : s.h * 0.6;
        t.set(truncate(s.name, spineChars(len, size)));
        (t as unknown as { color: unknown }).color = s.folder ? '#2a2118' : lum(s.color) > 0.42 ? '#121820' : '#f3f5f8';
        t.rotation.set(0, 0, this.titles === 'down' ? -Math.PI / 2 : Math.PI / 2);
        t.visible = i !== this.hidden;
      }
    };
    // nearest boxes get the big labels; the small ones go to the nearest of everything else
    const big = nearestSlots(this.slots, this.dims, true, fx, fy, pool.boxes.length);
    const rest = nearestSlots(this.slots, this.dims, null, fx, fy, pool.books.length + big.length).filter((i) => !big.includes(i)).slice(0, pool.books.length);
    put(pool.boxes, big, pool.boxSize, true);
    put(pool.books, rest, pool.bookSize, false);
    this.animItems = true;
  }

  private labelText(i: number): Text | null {
    const pool = this.labels, k = this.labelOf[i];
    if (!pool || k < 0) return null;
    return k >= 1000 ? pool.boxes[k - 1000] : pool.books[k];
  }

  // ---- interaction helpers --------------------------------------------------------------------

  /** Root-space point → case-local point (in place). */
  toLocal(v: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrix();
    this.inv.copy(this.group.matrix).invert();
    return v.applyMatrix4(this.inv);
  }

  /** Case-local point → root space (in place). */
  toRoot(v: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrix();
    return v.applyMatrix4(this.group.matrix);
  }

  /** Index (into slots) of the item under a case-local point, or -1. */
  slotIndexAt(x: number, y: number): number {
    const s = slotAt(this.slots, this.dims, x, y);
    return s ? this.slots.indexOf(s) : -1;
  }

  /** Spine-face center of slot i in case coordinates (current animated position). */
  spineCenter(i: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.slots[i];
    const g = shelfGeometry(this.dims);
    return out.set(this.curX[i], this.curY[i] + s.h / 2, g.front + this.pull[i] * PULL + (i === this.pressed ? this.dragZ : 0));
  }

  setPull(i: number, on: boolean): void {
    if (i < 0 || i >= this.slots.length) return;
    if (on) this.hovered.add(i); else this.hovered.delete(i);
    this.animItems = true;
  }

  setHidden(i: number): void {
    if (this.hidden === i) return;
    const before = this.hidden;
    this.hidden = i;
    for (const k of [before, i]) { const t = k >= 0 ? this.labelText(k) : null; if (t) t.visible = k !== i; }
    this.animItems = true;
  }

  markChanged(): void { this.colorsDirty = true; this.animItems = true; }

  // ---- paging ---------------------------------------------------------------------------------

  /** Revolve the case to another page. */
  flip(dir: number): boolean {
    if (!this.layout || this.turnT >= 0) return false;
    const to = this.page + dir;
    if (to < 0 || to >= this.layout.pages) return false;
    this.turnDir = dir;
    this.turnTo = to;
    this.turnT = 0;
    return true;
  }

  /** Jump to a page without animation (e.g. restore). */
  get turning(): boolean { return this.turnT >= 0; }

  // ---- per frame ------------------------------------------------------------------------------

  /** Returns true while anything animates. */
  update(dt: number): boolean {
    let busy = false;
    const k = 1 - Math.exp(-dt * 9);
    const c = this.cur, t = this.tgt;
    const keys = ['x', 'y', 'z', 'ry', 's', 'dim'] as const;
    for (const key of keys) {
      const d = t[key] - c[key];
      if (Math.abs(d) > 1e-4) { c[key] += d * k; busy = true; } else c[key] = t[key];
    }
    let turn = 0;
    if (this.turnT >= 0) {
      const before = this.turnT;
      this.turnT = Math.min(1, this.turnT + dt / 0.42);
      if (before < 0.5 && this.turnT >= 0.5) {
        this.showPage(this.turnTo, false);
      }
      const u = this.turnT;
      turn = u < 0.5 ? (u / 0.5) * (Math.PI / 2) * this.turnDir : -(1 - (u - 0.5) / 0.5) * (Math.PI / 2) * this.turnDir;
      if (this.turnT >= 1) { this.turnT = -1; turn = 0; }
      busy = true;
    }
    const gr = this.group;
    gr.position.set(c.x, c.y, c.z);
    gr.rotation.set(0, c.ry + turn, 0);
    gr.scale.setScalar(Math.max(1e-3, c.s));
    const shade = 1 - c.dim * 0.62;
    this.frameMat.color.setRGB(shade, shade, shade);
    this.itemMat.color.setRGB(shade, shade, shade);
    this.bandMat.color.setRGB(shade, shade, shade);
    this.crest.visible = c.s > 0.15;
    if (this.animItems) busy = this.animate(dt) || busy;
    return busy;
  }

  /** Glide items, slide hovered ones out; write instances. */
  private animate(dt: number): boolean {
    const g = shelfGeometry(this.dims);
    const k = 1 - Math.exp(-dt * 14);
    const n = this.slots.length;
    let moving = false;
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      const tx = s.x, ty = g.base(s.shelf);
      const want = i === this.pressed || this.hovered.has(i) || (this.mark !== null && s.folder && s.name === this.mark) ? 1 : 0;
      const dx = tx - this.curX[i], dy = ty - this.curY[i], dp = want - this.pull[i], da = 1 - this.appear[i];
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dp) > 1e-3 || da > 1e-3) {
        this.curX[i] += dx * k; this.curY[i] += dy * k; this.pull[i] += dp * k; this.appear[i] += da * k;
        moving = true;
      } else { this.curX[i] = tx; this.curY[i] = ty; this.pull[i] = want; this.appear[i] = 1; }
    }
    this.write();
    if (!moving) this.animItems = false;
    return moving;
  }

  private write(): void {
    const g = shelfGeometry(this.dims);
    const n = this.slots.length;
    const accent = this.ctx.theme.accent;
    let b = 0;
    const band = (x: number, y: number, z: number, w: number, h: number, d: number, color: string | null) => {
      this.p.set(x, y, z); this.q.identity(); this.sc.set(w, h, d);
      this.bands.setMatrixAt(b, this.m.compose(this.p, this.q, this.sc));
      if (color && this.colorsDirty) this.bands.setColorAt(b, this.col.set(color));
      b++;
    };
    const lastEnd = this.lastEnd;
    lastEnd.fill(-1);
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      const a = i === this.hidden ? 0 : this.appear[i];
      const z = g.front + this.pull[i] * PULL + (i === this.pressed ? this.dragZ : 0);
      const x = this.curX[i], y0 = this.curY[i];
      const w = Math.max(1e-4, s.w * a), h = Math.max(1e-4, s.h * a);
      this.p.set(x, y0 + h / 2, z - s.d / 2); this.q.identity(); this.sc.set(w, h, s.d);
      this.items.setMatrixAt(i, this.m.compose(this.p, this.q, this.sc));
      const marked = this.mark !== null && s.folder && s.name === this.mark;
      if (this.colorsDirty) this.items.setColorAt(i, this.col.set(marked ? mixHex(s.color, accent, 0.6) : s.color));
      if (s.folder) {
        band(x, y0 + h * 0.47, z + 0.0012, Math.max(1e-4, w - 0.018), h * 0.6, 0.002, CARD);
        band(x, y0 + h - 0.032 * a, z + 0.0012, Math.max(1e-4, Math.min(0.036, w * 0.42)), Math.max(1e-4, 0.014 * a), 0.002, HOLE);
      } else {
        const bc = this.colorsDirty ? mixHex(s.color, '#fff6dc', 0.55) : null;
        band(x, y0 + h * 0.86, z + 0.0012, w * 0.999, Math.max(1e-4, 0.009 * a), 0.002, bc);
        band(x, y0 + h * 0.1, z + 0.0012, w * 0.999, Math.max(1e-4, 0.009 * a), 0.002, bc);
      }
      const t = this.labelText(i);
      if (t) {
        t.position.set(x, y0 + h * (s.folder ? 0.47 : 0.48), z + 0.0026);
        t.scale.setScalar(Math.max(1e-3, a));
        if (i !== this.hidden && !t.visible && a > 0.01) t.visible = true;
      }
      const end = s.x + s.w / 2;
      if (!s.folder && end > lastEnd[s.shelf]) lastEnd[s.shelf] = end;
    }
    // bookends after the last book of each partly filled shelf
    for (let k = 0; k < this.dims.shelves; k++) {
      if (lastEnd[k] < 0 || lastEnd[k] > g.x1 - 0.02) continue;
      band(lastEnd[k] + 0.005, g.base(k) + 0.07, g.front - 0.065, 0.005, 0.14, 0.13, BOOKEND);
    }
    this.items.commit(n);
    this.bands.commit(b);
    this.colorsDirty = false;
  }

  dispose(): void {
    this.detachLabels();
    disposeTree(this.group);
  }
}
