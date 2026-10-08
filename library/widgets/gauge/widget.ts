// gauge: a dial showing a value within [min, max] as a 270° arc with a
// numeric read-out — compact status for metrics (loss, accuracy, GPU load).
// Also the worked example in library/widgets/README.md.

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { resolveColor } from '../../shared/color.ts';
import { formatNumber } from '../../shared/format.ts';
import { disposeTree, ownMaterial } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';
import { toScalar } from '../../shared/tensor.ts';

interface GaugeProps extends Record<string, unknown> {
  value: number;
  min: number;
  max: number;
  label: string;
  unit: string;
  color: string;
}

const SEGMENTS = 64;
const SWEEP = Math.PI * 1.5; // 270°

const definition: WidgetDefinition<GaugeProps> = {
  description: 'Dial gauge: input `value` (or the `value` prop) shown as a 270° arc between min and max, with a numeric read-out, unit and label.',
  version: '1.0.0',
  props: {
    value: { type: 'number', default: 0, description: 'Shown until an input arrives.' },
    min: { type: 'number', default: 0 },
    max: { type: 'number', default: 1 },
    label: { type: 'string', default: '' },
    unit: { type: 'string', default: '' },
    color: { type: 'color', default: 'accent' },
  },
  inputs: { value: { type: 'number', description: 'Value to show (numbers, numeric strings, size-1 tensors).' } },
  size: [0.14, 0.14, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let fill: THREE.Mesh | null = null;
    let readout: Text | null = null;
    let value = ctx.props.value;

    function build(): void {
      if (group) disposeTree(group);
      group = new T.Group();
      group.name = 'gauge';
      group.add(ctx.ui.panel(0.14, 0.14));
      // Ring segments are indexed in angle order, so a draw range shows a partial arc:
      // one geometry, no reallocation when the value changes. scale.x = -1 makes it fill clockwise.
      const ring = (color: string, z: number) => {
        const m = new T.Mesh(new T.RingGeometry(0.044, 0.054, SEGMENTS, 1, -Math.PI / 4, SWEEP), ownMaterial(T, color, { doubleSide: true }));
        m.scale.x = -1;
        m.position.set(0, 0.006, z);
        m.raycast = () => {};
        group!.add(m);
        return m;
      };
      ring(ctx.theme.surface, STYLE.zContent);
      fill = ring(resolveColor(ctx.theme, ctx.props.color), STYLE.zOverlay);
      readout = makeText(ctx, '', { size: 0.02, font: 'mono' });
      readout.position.set(0, 0.006, STYLE.zText);
      const label = makeText(ctx, ctx.props.label, { size: STYLE.labelSize, color: ctx.theme.textDim, maxWidth: 0.12 });
      label.position.set(0, -0.052, STYLE.zText);
      group.add(readout, label);
      ctx.root.add(group);
      render();
    }

    function render(): void {
      const { min, max } = ctx.props;
      const t = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
      fill!.geometry.setDrawRange(0, Math.round(t * SEGMENTS) * 6); // 6 indices per segment
      readout!.set(formatNumber(value, { precision: 3, unit: ctx.props.unit }));
    }

    build();
    return {
      onProps(p, prev) {
        if (p.value !== prev.value) value = p.value as number;
        build();
      },
      onInput(port, v) {
        if (port !== 'value') return;
        const n = toScalar(v);
        if (Number.isFinite(n) && n !== value) {
          value = n;
          render();
        }
      },
      dispose() {
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
