// axes: a 3-D axis triad with tick marks and numeric labels — a reference
// frame for 3-D plots (e.g. place `points` with fit=false inside it). Axis
// colors follow the x/y/z = red/green/blue convention via theme colors.

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { formatTick } from '../../shared/format.ts';
import { niceTicks } from '../../shared/layout.ts';
import { disposeTree } from '../../shared/resources.ts';
import { makeText } from '../../shared/text.ts';

interface AxesProps extends Record<string, unknown> {
  length: number;
  min: number;
  max: number;
  ticks: number;
  labels: string;
  negative: boolean;
  showTickLabels: boolean;
}

const MAX_TICK_LABELS = 11;

const definition: WidgetDefinition<AxesProps> = {
  description:
    '3-D axes (x red, y green, z blue) of `length` meters with tick marks; the data range [min, max] is mapped onto each axis for tick labels. ' +
    '`labels` = "x,y,z" axis names; negative=true draws axes through the origin in both directions.',
  version: '1.0.0',
  props: {
    length: { type: 'number', default: 0.3, min: 0.01, max: 20, description: 'Axis length in meters (each direction when negative).' },
    min: { type: 'number', default: 0, description: 'Data value at the origin end (or at -length with negative).' },
    max: { type: 'number', default: 1, description: 'Data value at the +length end.' },
    ticks: { type: 'integer', default: 5, min: 0, max: 20, description: 'Approximate tick count per axis; 0 = none.' },
    labels: { type: 'string', default: 'x,y,z', description: 'Comma-separated axis names.' },
    negative: { type: 'boolean', default: false },
    showTickLabels: { type: 'boolean', default: true },
  },
  size: [0.3, 0.3, 0.3],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      group = new T.Group();
      group.name = 'axes';
      const colors = [ctx.theme.negative, ctx.theme.positive, ctx.theme.accent];
      const names = String(p.labels ?? '').split(',').map((s) => s.trim());
      const L = p.length;
      const lo = p.negative ? -L : 0;
      const tickLen = Math.max(0.003, L * 0.025);
      const { ticks, step } = p.ticks > 0 ? niceTicks(p.min, p.max, p.ticks) : { ticks: [] as number[], step: 1 };
      const span = p.max - p.min || 1;
      const dims = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      // Tick marks are drawn perpendicular to the axis, in this "side" direction.
      const side = [[0, -1, 0], [-1, 0, 0], [-1, 0, 0]];
      for (let ax = 0; ax < 3; ax++) {
        const d = dims[ax];
        const sd = side[ax];
        const verts: number[] = [lo * d[0], lo * d[1], lo * d[2], L * d[0], L * d[1], L * d[2]];
        const labelled: Array<{ v: number; pos: number }> = [];
        for (const v of ticks) {
          const pos = lo + ((v - p.min) / span) * (L - lo);
          if (pos < lo - 1e-9 || pos > L + 1e-9) continue;
          verts.push(pos * d[0], pos * d[1], pos * d[2], pos * d[0] + sd[0] * tickLen, pos * d[1] + sd[1] * tickLen, pos * d[2] + sd[2] * tickLen);
          labelled.push({ v, pos });
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
        const lines = new T.LineSegments(geo, new T.LineBasicMaterial({ color: colors[ax] }));
        lines.name = `axis-${'xyz'[ax]}`;
        group.add(lines);
        // Readable at arm's length (≥ 9 mm ticks, ≥ 12 mm names) while scaling with the axes.
        const size = Math.max(0.012, L * 0.05);
        if (p.showTickLabels && labelled.length <= MAX_TICK_LABELS) {
          for (const { v, pos } of labelled) {
            const t = makeText(ctx, formatTick(v, step), { size: Math.max(0.009, size * 0.7), color: ctx.theme.textDim, anchorX: ax === 0 ? 'center' : 'right', anchorY: ax === 0 ? 'top' : 'middle', font: 'mono' });
            const off = tickLen * 1.6;
            t.position.set(pos * d[0] + sd[0] * off, pos * d[1] + sd[1] * off, pos * d[2] + sd[2] * off);
            group.add(t);
          }
        }
        const name = names[ax] ?? '';
        if (name) {
          const t = makeText(ctx, name, { size, color: colors[ax], anchorX: 'left', anchorY: 'bottom', weight: 'semibold' });
          t.position.set(d[0] * (L + size * 0.4), d[1] * (L + size * 0.4), d[2] * (L + size * 0.4));
          group.add(t);
        }
      }
      ctx.root.add(group);
    }

    build();
    return {
      onProps: build,
      dispose() {
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
