// Shared visual vocabulary: spacing/type scale, the "card" (panel + title +
// content rect) that charts and controls sit on, and a pooled 2-D axis
// (gridlines + tick labels) for plots. All sizes in meters.

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { makeText, type Text } from './text.ts';
import { niceTicks } from './layout.ts';
import { formatTick } from './format.ts';

export const STYLE = {
  /** Inner padding of cards. */
  pad: 0.014,
  /** Type scale (em heights). */
  titleSize: 0.02,
  bodySize: 0.016,
  labelSize: 0.012,
  /** Z offsets above a card so content never z-fights with it. */
  zContent: 0.001,
  zOverlay: 0.002,
  zText: 0.003,
  /** Width reserved left of a plot for y tick labels. */
  yGutter: 0.05,
  /** Height reserved below a plot for x tick labels. */
  xGutter: 0.022,
} as const;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Card {
  group: THREE.Group;
  panel: THREE.Mesh;
  title: Text | null;
  /** Content area below the title, inside the padding (ctx.root coords). */
  inner: Rect;
  width: number;
  height: number;
}

/**
 * A themed card: rounded panel centered at the origin (facing +Z) with an
 * optional title at the top-left. Content goes into `inner`.
 */
export function buildCard(
  ctx: Pick<WidgetContext, 'THREE' | 'ui' | 'theme'>,
  opts: { width: number; height: number; title?: string; color?: string; opacity?: number },
): Card {
  const { width: w, height: h } = opts;
  const group = new ctx.THREE.Group();
  group.name = 'card';
  const panel = ctx.ui.panel(w, h, { color: opts.color, opacity: opts.opacity });
  group.add(panel);
  let title: Text | null = null;
  let top = h / 2 - STYLE.pad;
  if (opts.title) {
    title = makeText(ctx, opts.title, { size: STYLE.titleSize, color: ctx.theme.text, anchorX: 'left', anchorY: 'top', maxWidth: w - 2 * STYLE.pad, weight: 'semibold', whiteSpace: 'nowrap' });
    title.position.set(-w / 2 + STYLE.pad, top, STYLE.zText);
    title.name = 'title';
    group.add(title);
    top -= STYLE.titleSize * 1.5;
  }
  return { group, panel, title, inner: { x0: -w / 2 + STYLE.pad, x1: w / 2 - STYLE.pad, y0: -h / 2 + STYLE.pad, y1: top }, width: w, height: h };
}

/**
 * Pooled y-axis (and optional x-axis) for a plot rectangle: horizontal
 * gridlines with tick labels on the left, vertical extent labels below.
 * update() is cheap when the range is unchanged.
 */
export class PlotAxes {
  readonly group: THREE.Group;
  private grid: THREE.LineSegments;
  private positions: Float32Array;
  private ylabels: Text[] = [];
  private xlabels: Text[] = [];
  private lastKey = '';
  private readonly maxTicks: number;

  constructor(
    private ctx: Pick<WidgetContext, 'THREE' | 'ui' | 'theme'>,
    private rect: Rect,
    opts: { maxTicks?: number; xLabels?: boolean } = {},
  ) {
    const T = ctx.THREE;
    this.maxTicks = opts.maxTicks ?? 5;
    this.group = new T.Group();
    this.group.name = 'axes';
    // Gridlines: up to 12 horizontal lines + 2 frame lines (left, bottom).
    this.positions = new Float32Array((12 + 2) * 2 * 3);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(this.positions, 3));
    const mat = new T.LineBasicMaterial({ color: ctx.theme.border, transparent: true, opacity: 0.55, depthWrite: false });
    this.grid = new T.LineSegments(geo, mat);
    this.grid.raycast = () => {};
    this.grid.frustumCulled = false;
    this.grid.position.z = STYLE.zContent;
    this.group.add(this.grid);
    for (let i = 0; i < 12; i++) {
      const t = makeText(ctx, '', { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: 'right', anchorY: 'middle', font: 'mono' });
      t.visible = false;
      t.position.z = STYLE.zText;
      this.ylabels.push(t);
      this.group.add(t);
    }
    if (opts.xLabels) {
      for (const anchor of ['left', 'right'] as const) {
        const t = makeText(ctx, '', { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: anchor, anchorY: 'top', font: 'mono' });
        t.position.set(anchor === 'left' ? rect.x0 : rect.x1, rect.y0 - 0.004, STYLE.zText);
        this.xlabels.push(t);
        this.group.add(t);
      }
    }
  }

  /** Y range [min, max] mapped onto the rect; optional x extent labels. */
  update(ymin: number, ymax: number, xLeft?: string, xRight?: string): void {
    const key = `${ymin}|${ymax}|${xLeft ?? ''}|${xRight ?? ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = this.rect;
    const p = this.positions;
    let k = 0;
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      p[k++] = x0; p[k++] = y0; p[k++] = 0;
      p[k++] = x1; p[k++] = y1; p[k++] = 0;
    };
    seg(r.x0, r.y0, r.x0, r.y1);
    seg(r.x0, r.y0, r.x1, r.y0);
    const { ticks, step } = niceTicks(ymin, ymax, this.maxTicks);
    const span = ymax - ymin;
    let n = 0;
    for (const v of ticks) {
      if (n >= this.ylabels.length) break;
      const y = span > 0 ? r.y0 + ((v - ymin) / span) * (r.y1 - r.y0) : (r.y0 + r.y1) / 2;
      if (y < r.y0 - 1e-6 || y > r.y1 + 1e-6) continue;
      seg(r.x0, y, r.x1, y);
      const label = this.ylabels[n++];
      label.set(formatTick(v, step));
      label.position.set(r.x0 - 0.005, y, STYLE.zText);
      label.visible = true;
    }
    for (let i = n; i < this.ylabels.length; i++) this.ylabels[i].visible = false;
    this.grid.geometry.setDrawRange(0, k / 3);
    (this.grid.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.grid.geometry.computeBoundingBox();
    this.grid.geometry.computeBoundingSphere();
    if (this.xlabels.length) {
      this.xlabels[0].set(xLeft ?? '');
      this.xlabels[1].set(xRight ?? '');
    }
  }
}

/** Map v in [min, max] to a y coordinate in rect (clamped). */
export function yOf(rect: Rect, v: number, min: number, max: number): number {
  const d = max - min;
  const t = d > 0 ? (v - min) / d : 0.5;
  return rect.y0 + (t < 0 ? 0 : t > 1 ? 1 : t) * (rect.y1 - rect.y0);
}
