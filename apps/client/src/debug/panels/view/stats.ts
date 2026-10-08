// Renderer stats for the View panel: frame interval history (fps, avg / max
// ms), renderer.info (draw calls, triangles, geometries, textures, programs),
// JS heap (Chromium), and an on-demand per-entity cost estimate (draw objects
// and triangles of each entity's own widget content).

import type * as THREE_NS from 'three';
import { signal } from '@preact/signals';
import type { DebugContext } from '../../types.ts';

export interface RenderStats {
  fps: number;
  avgMs: number;
  maxMs: number;
  calls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMB: number | null;
  heapLimitMB: number | null;
  /** Last ~120 frame intervals (ms), oldest first. */
  history: number[];
}

export const stats = signal<RenderStats | null>(null);

const HIST = 120;

/** Samples every frame; publishes to the `stats` signal ~4×/s while held. */
export class StatsSampler {
  private readonly hist = new Float32Array(HIST);
  private n = 0;
  private i = 0;
  private acc = 0;
  private readonly off: () => void;
  constructor(private readonly ctx: DebugContext) {
    this.off = ctx.client.onFrame((dt) => this.frame(dt));
  }

  /** Last finite per-frame render counts (a widget can report an infinite draw count for one frame, e.g. while text re-syncs). */
  private readonly lastRender = { calls: 0, triangles: 0, lines: 0, points: 0 };

  private frame(dt: number): void {
    const r = this.ctx.renderer.info.render; // the previous frame's numbers (read before this frame renders)
    if (Number.isFinite(r.triangles) && Number.isFinite(r.calls)) {
      this.lastRender.calls = r.calls; this.lastRender.triangles = r.triangles; this.lastRender.lines = r.lines; this.lastRender.points = r.points;
    }
    this.hist[this.i] = dt * 1000;
    this.i = (this.i + 1) % HIST;
    this.n = Math.min(HIST, this.n + 1);
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const hist: number[] = [];
    for (let k = 0; k < this.n; k++) hist.push(this.hist[(this.i - this.n + k + HIST) % HIST]);
    const recent = hist.slice(-60);
    const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const info = this.ctx.renderer.info;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    stats.value = {
      fps: avg > 0 ? 1000 / avg : 0,
      avgMs: avg,
      maxMs: recent.reduce((a, b) => Math.max(a, b), 0),
      calls: this.lastRender.calls,
      triangles: this.lastRender.triangles,
      lines: this.lastRender.lines,
      points: this.lastRender.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      heapLimitMB: mem ? mem.jsHeapSizeLimit / 1048576 : null,
      history: hist,
    };
  }

  dispose(): void { this.off(); }
}

export interface EntityCost { id: string; objects: number; triangles: number }

function trianglesOf(o: THREE_NS.Object3D): number {
  const m = o as THREE_NS.Mesh;
  const g = m.geometry as THREE_NS.BufferGeometry | undefined;
  if (!g || !(m as THREE_NS.Mesh).isMesh) return 0;
  const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  const inst = (o as THREE_NS.InstancedMesh).isInstancedMesh ? (o as THREE_NS.InstancedMesh).count : 1;
  return Math.floor(n / 3) * inst;
}

/** Visible draw objects + triangles of each entity's own content (child entities excluded). */
export function measureEntities(ctx: DebugContext): EntityCost[] {
  const out: EntityCost[] = [];
  for (const id in ctx.runtime.sceneState.entities) {
    const content = ctx.runtime.widgets.contentOf(id);
    if (!content) continue;
    let objects = 0, triangles = 0;
    content.traverseVisible((o) => {
      const r = o as THREE_NS.Mesh;
      if ((r.isMesh || (o as THREE_NS.Line).isLine || (o as THREE_NS.Points).isPoints) && r.material) {
        objects++;
        triangles += trianglesOf(o);
      }
    });
    out.push({ id, objects, triangles });
  }
  return out.sort((a, b) => b.triangles - a.triangles || b.objects - a.objects);
}
