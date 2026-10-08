// line: a polyline through 3-D points (paths, trajectories, connectors,
// outlines). Hairline (radius 0: one GL line, cheapest) or solid tubes
// (radius > 0: one InstancedMesh of cylinders + joint spheres).

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { resolveColor } from '../../shared/color.ts';
import { disposeTree, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { SegmentMath } from '../../shared/segments.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { asPoints, isTensor } from '../../shared/tensor.ts';

interface LineProps extends Record<string, unknown> {
  points: number[][];
  color: string;
  radius: number;
  closed: boolean;
  opacity: number;
  channel: string;
}

const definition: WidgetDefinition<LineProps> = {
  description:
    'Polyline through 3-D points (meters, local coordinates). `points` prop = [[x,y,z], …] or input `points` = tensor [N, 3] / [N, 2]. ' +
    'radius 0 = hairline (cheapest); radius > 0 = solid tube. closed joins the last point to the first.',
  version: '1.0.0',
  props: {
    points: { type: 'json', default: [[0, 0, 0], [0.1, 0.05, 0], [0.2, 0, 0]], description: '[[x, y, z], …] in meters.' },
    color: { type: 'color', default: 'accent' },
    radius: { type: 'number', default: 0, min: 0, max: 0.5, description: 'Tube radius in meters; 0 = 1-pixel line.' },
    closed: { type: 'boolean', default: false },
    opacity: { type: 'number', default: 1, min: 0, max: 1 },
    channel: { type: 'channel', default: '', description: 'Optional channel with a points tensor.' },
  },
  inputs: {
    points: { type: 'any', description: 'tensor [N, 3] / [N, 2] or number[][]; overrides the prop.' },
  },
  size: [0.2, 0.05, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let override: { count: number; xyz: Float32Array } | null = null;
    const seg = new SegmentMath(T);
    const m4 = new T.Matrix4();
    let hair: { line: THREE.Line; buf: Float32Array; closed: boolean } | null = null;

    function current(): { count: number; xyz: Float32Array } {
      return override ?? asPoints(ctx.props.points) ?? { count: 0, xyz: new Float32Array(0) };
    }

    function build(): void {
      if (group) disposeTree(group);
      hair = null;
      const p = ctx.props;
      const { count: n0, xyz } = current();
      group = new T.Group();
      group.name = 'line';
      const color = resolveColor(ctx.theme, p.color, 'accent');
      const closed = p.closed && n0 > 2;
      if (n0 >= 2) {
        if (p.radius > 0) {
          const segs = n0 - 1 + (closed ? 1 : 0);
          const mat = ownMaterial(T, color, { opacity: p.opacity, shaded: true });
          // Bounds of the tube (points ± radius) so the instanced meshes report tight boxes.
          const r = p.radius;
          let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
          for (let i = 0; i < n0; i++) {
            const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
            x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
            y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
            z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
          }
          const rods = new FittedInstances(T, shadedGeometry(T, 'cylinder'), mat, segs);
          rods.fit(x0, y0, z0, x1, y1, z1);
          for (let i = 0; i < segs; i++) {
            const a = i * 3;
            const b = ((i + 1) % n0) * 3;
            seg.rod(m4, xyz[a], xyz[a + 1], xyz[a + 2], xyz[b], xyz[b + 1], xyz[b + 2], r);
            rods.setMatrixAt(i, m4);
          }
          rods.commit(segs);
          rods.mesh.name = 'tube';
          group.add(rods.mesh);
          // Joint spheres hide the gaps between cylinders.
          const joints = new FittedInstances(T, shadedGeometry(T, 'ico'), mat, n0);
          joints.fit(x0, y0, z0, x1, y1, z1);
          for (let i = 0; i < n0; i++) {
            m4.makeScale(2 * r, 2 * r, 2 * r).setPosition(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
            joints.setMatrixAt(i, m4);
          }
          joints.commit(n0);
          joints.mesh.name = 'joints';
          group.add(joints.mesh);
        } else {
          // Capacity rounded up so streamed updates can be written in place (see setPoints).
          let cap = 16;
          while (cap < n0) cap *= 2;
          const buf = new Float32Array(cap * 3);
          buf.set(xyz.subarray(0, n0 * 3));
          for (let i = n0 * 3; i < buf.length; i += 3) buf.copyWithin(i, (n0 - 1) * 3, n0 * 3);
          const geo = new T.BufferGeometry();
          geo.setAttribute('position', new T.BufferAttribute(buf, 3));
          geo.setDrawRange(0, n0);
          const mat = new T.LineBasicMaterial({ color, transparent: p.opacity < 1, opacity: p.opacity });
          const line = closed ? new T.LineLoop(geo, mat) : new T.Line(geo, mat);
          line.name = 'polyline';
          line.frustumCulled = false;
          group.add(line);
          hair = { line, buf, closed };
        }
      }
      ctx.root.add(group);
    }

    /** Fast path: write new points into the existing hairline buffer. */
    function updateInPlace(pts: { count: number; xyz: Float32Array }): boolean {
      if (!hair || !hair.line.parent || ctx.props.radius > 0) return false;
      const n = pts.count;
      if (n < 2 || n * 3 > hair.buf.length || hair.closed !== (ctx.props.closed && n > 2)) return false;
      hair.buf.set(pts.xyz.subarray(0, n * 3));
      // Repeat the last point over the unused tail so bounds (which ignore drawRange) stay tight.
      for (let i = n * 3; i < hair.buf.length; i += 3) hair.buf.copyWithin(i, (n - 1) * 3, n * 3);
      const geo = hair.line.geometry;
      geo.setDrawRange(0, n);
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      return true;
    }

    function setPoints(v: unknown): void {
      if (v === null || v === undefined) {
        override = null;
      } else {
        const pts = asPoints(v);
        if (!pts) {
          ctx.error(`line: expected points tensor [N, 3] or number[][] (got ${isTensor(v) ? `tensor ${v.dtype}[${v.shape}]` : typeof v})`);
          return;
        }
        override = pts;
        if (updateInPlace(pts)) return;
      }
      build();
    }

    build();
    // Created after the first build: subscribing fires synchronously when the channel already has a value.
    const channel = new ChannelProp(ctx, (v) => setPoints(v));
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'points') setPoints(v);
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
