// arrow: a 3-D arrow from `from` to `to` (local meters) — vectors, flows,
// annotations pointing at things. Shaft = cylinder, head = cone (shared unit
// geometry). Endpoints can be driven by vec3 inputs.

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { resolveColor } from '../../shared/color.ts';
import { disposeTree, ownMaterial, shadedGeometry } from '../../shared/resources.ts';
import { readVec3, SegmentMath } from '../../shared/segments.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface ArrowProps extends Record<string, unknown> {
  from: [number, number, number];
  to: [number, number, number];
  color: string;
  radius: number;
  headLength: number;
  headRadius: number;
  label: string;
  opacity: number;
}

const definition: WidgetDefinition<ArrowProps> = {
  description:
    'A 3-D arrow from `from` to `to` (meters, local coordinates) with a cone head; optional label at the tip. Inputs `from`/`to` (vec3) move the endpoints live.',
  version: '1.0.0',
  props: {
    from: { type: 'vec3', default: [0, 0, 0] },
    to: { type: 'vec3', default: [0.2, 0, 0] },
    color: { type: 'color', default: 'accent' },
    radius: { type: 'number', default: 0.003, min: 0.0002, max: 0.2, description: 'Shaft radius (m).' },
    headLength: { type: 'number', default: 0.024, min: 0, max: 1, description: 'Cone length (m); capped at half the arrow length.' },
    headRadius: { type: 'number', default: 0.009, min: 0, max: 0.5 },
    label: { type: 'string', default: '', description: 'Text shown just past the tip.' },
    opacity: { type: 'number', default: 1, min: 0, max: 1 },
  },
  inputs: {
    from: { type: 'vec3', description: 'Tail position [x, y, z].' },
    to: { type: 'vec3', description: 'Tip position [x, y, z].' },
  },
  size: [0.2, 0.02, 0.02],
  create(ctx) {
    const T = ctx.THREE;
    const seg = new SegmentMath(T);
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    let fromIn: [number, number, number] | null = null;
    let toIn: [number, number, number] | null = null;
    let group: THREE.Group | null = null;
    let shaft: THREE.Mesh | null = null;
    let head: THREE.Mesh | null = null;
    let label: Text | null = null;

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      group = new T.Group();
      group.name = 'arrow';
      const mat = ownMaterial(T, resolveColor(ctx.theme, p.color, 'accent'), { opacity: p.opacity, shaded: true });
      shaft = new T.Mesh(shadedGeometry(T, 'cylinder'), mat);
      shaft.name = 'shaft';
      head = new T.Mesh(shadedGeometry(T, 'cone'), mat);
      head.name = 'head';
      group.add(shaft, head);
      label = null;
      if (p.label) {
        label = makeText(ctx, p.label, { size: STYLE.bodySize, color: ctx.theme.text, anchorX: 'left', anchorY: 'middle' });
        group.add(label);
      }
      ctx.root.add(group);
      place();
    }

    function place(): void {
      if (!shaft || !head) return;
      const p = ctx.props;
      if (!readVec3(fromIn ?? p.from, a)) a[0] = a[1] = a[2] = 0;
      if (!readVec3(toIn ?? p.to, b)) { b[0] = 0.2; b[1] = b[2] = 0; }
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      const hl = Math.min(p.headLength, len * 0.5);
      const k = len > 0 ? (len - hl) / len : 0;
      // Shaft ends where the head starts.
      const sx = a[0] + dx * k, sy = a[1] + dy * k, sz = a[2] + dz * k;
      seg.place(shaft, a[0], a[1], a[2], sx, sy, sz, p.radius);
      seg.place(head, sx, sy, sz, b[0], b[1], b[2], p.headRadius);
      shaft.visible = len - hl > 1e-6;
      head.visible = hl > 1e-6;
      if (label) {
        const u = len > 0 ? 1 / len : 0;
        label.position.set(b[0] + dx * u * 0.01, b[1] + dy * u * 0.01 + 0.004, b[2] + dz * u * 0.01);
      }
    }

    build();
    return {
      onProps: build,
      onInput(port, v) {
        const out: [number, number, number] = [0, 0, 0];
        const ok = readVec3(v, out);
        if (port === 'from') fromIn = ok ? out : null;
        else if (port === 'to') toIn = ok ? out : null;
        else return;
        place();
      },
      dispose() {
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
