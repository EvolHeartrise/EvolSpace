// points: a 3-D scatter plot (embeddings, PCA projections, point clouds).
// One InstancedMesh of low-poly spheres (one draw call), per-point colors
// from a colormap or RGB tensor, per-point size multipliers. Data is fitted
// into a cube of `extent` meters (or used as-is in meters). Picking uses a
// custom ray-vs-points raycast (O(N), allocation-free) so a ray selects the
// point it passes closest to; press → `index`, hover → `hover`.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { resolveColor } from '../../shared/color.ts';
import { buildLut, categoryT, COLORMAPS, divergingT, isColormap, lutColor, rangeT, type ColormapName, type Lut } from '../../shared/colormap.ts';
import { PressTracker } from '../../shared/handle.ts';
import { disposeTree, ownMaterial, shadedGeometry, sharedEdges, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { formatNumber } from '../../shared/format.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { asPoints, asVector, extent, isTensor, toScalar } from '../../shared/tensor.ts';

interface PointsProps extends Record<string, unknown> {
  pointSize: number;
  color: string;
  colormap: ColormapName;
  fit: boolean;
  extent: number;
  maxPoints: number;
  showBounds: boolean;
  interactive: boolean;
  channel: string;
}

const definition: WidgetDefinition<PointsProps> = {
  description:
    '3-D scatter: input `points` = tensor [N, 3] (or [N, 2], or number[][]). Optional `colors` = tensor [N] scalars (→ colormap) or [N, 3] RGB 0..1, `sizes` = [N] multipliers. ' +
    'fit=true scales the data into an `extent`-meter cube. Press a point → `index`; hover → `hover`; input `select` highlights an index.',
  version: '1.0.0',
  props: {
    pointSize: { type: 'number', default: 0.008, min: 0.0005, max: 0.2, description: 'Sphere diameter in meters.' },
    color: { type: 'color', default: 'accent', description: 'Color when no `colors` input is given.' },
    colormap: { type: 'enum', options: [...COLORMAPS], default: 'sequential', description: 'Map for scalar colors (diverging centers on 0; palette = integer categories).' },
    fit: { type: 'boolean', default: true, description: 'Center and scale the data into the extent cube; false = coordinates are meters.' },
    extent: { type: 'number', default: 0.3, min: 0.01, max: 10, description: 'Edge of the fit cube (m).' },
    maxPoints: { type: 'integer', default: 20000, min: 1, max: 200000 },
    showBounds: { type: 'boolean', default: true, description: 'Draw the bounding cube outline.' },
    interactive: { type: 'boolean', default: true, description: 'Pick points with ray/pinch (then grab the cloud by its bounds).' },
    channel: { type: 'channel', default: '', description: 'Optional channel with the points tensor.' },
  },
  inputs: {
    points: { type: 'tensor', description: '[N, 3] positions.' },
    colors: { type: 'tensor', description: '[N] scalars or [N, 3] RGB in 0..1 (or number[]).' },
    sizes: { type: 'tensor', description: '[N] size multipliers.' },
    select: { type: 'number', description: 'Highlight this index (-1 / null clears).' },
  },
  outputs: {
    index: { type: 'number', description: 'Index of the pressed point.' },
    hover: { type: 'number', description: 'Index under the hand/ray (-1 when none).' },
  },
  size: [0.3, 0.3, 0.3],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let cloud: FittedInstances | null = null;
    let mesh: THREE.InstancedMesh | null = null;
    let bounds: THREE.LineSegments | null = null;
    let marker: THREE.Mesh | null = null;
    let label: Text | null = null;
    let lut: Lut = buildLut(ctx.theme, 'sequential');
    let xyz: Float32Array = new Float32Array(0);
    /** Points in the data (xyz) and points currently drawn (≤ maxPoints). */
    let count = 0;
    let drawn = 0;
    /** Rendered positions (ctx.root coords) for picking. */
    let rendered = new Float32Array(0);
    let colors: Float32Array | null = null;
    let colorDims = 1;
    let sizes: Float32Array | null = null;
    let selected = -1;
    let hovered = -1;
    let dirty = true;
    const press = new PressTracker(['press']);
    const m4 = new T.Matrix4();
    const col = new T.Color();
    const inv = new T.Matrix4();
    const ray = new T.Ray();
    const pt = new T.Vector3();
    const channel = new ChannelProp(ctx, (v) => setPoints(v));

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      lut = buildLut(ctx.theme, isColormap(p.colormap) ? p.colormap : 'sequential');
      group = new T.Group();
      group.name = 'points';
      bounds = null;
      if (p.showBounds && p.fit) {
        bounds = new T.LineSegments(sharedEdges(T, 'box'), new T.LineBasicMaterial({ color: ctx.theme.border, transparent: true, opacity: 0.7 }));
        bounds.scale.setScalar(p.extent);
        bounds.raycast = () => {};
        group.add(bounds);
      }
      marker = new T.Mesh(sharedGeometry(T, 'ico'), ownMaterial(T, ctx.theme.text, { wireframe: true }));
      marker.visible = false;
      marker.raycast = () => {};
      group.add(marker);
      label = makeText(ctx, '', { size: 0.012, color: ctx.theme.text, anchorX: 'left', anchorY: 'bottom', font: 'mono' });
      label.visible = false;
      group.add(label);
      mesh = null;
      cloud = null;
      ctx.root.add(group);
      dirty = true;
    }

    function ensureMesh(n: number): FittedInstances {
      const cap = Math.max(1, Math.min(ctx.props.maxPoints, n));
      if (cloud && cloud.mesh.instanceMatrix.count >= cap) return cloud;
      if (cloud) disposeTree(cloud.mesh);
      // Grow in powers of two so streaming clouds don't reallocate every update.
      let size = 64;
      while (size < cap) size *= 2;
      size = Math.min(size, Math.max(1, ctx.props.maxPoints));
      cloud = new FittedInstances(T, shadedGeometry(T, 'ico'), ownMaterial(T, '#ffffff', { shaded: true }), size);
      mesh = cloud.mesh;
      mesh.name = 'cloud';
      mesh.raycast = raycastPoints;
      group!.add(mesh);
      if (ctx.props.interactive) ctx.interactive(mesh);
      return cloud;
    }

    /**
     * Ray vs points: the instance closest along the ray within a pick radius.
     * Works in the parent (group) frame, where `rendered` lives. Allocation-free except the result.
     */
    function raycastPoints(this: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
      const n = this.count;
      const frame = this.parent;
      if (!n || !frame) return;
      frame.updateWorldMatrix(true, false);
      inv.copy(frame.matrixWorld).invert();
      ray.copy(raycaster.ray).applyMatrix4(inv);
      const r = Math.max(ctx.props.pointSize * 0.75, 0.006);
      const r2 = r * r;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        pt.set(rendered[i * 3], rendered[i * 3 + 1], rendered[i * 3 + 2]);
        const d2 = ray.distanceSqToPoint(pt);
        if (d2 > r2) continue;
        const along = pt.sub(ray.origin).dot(ray.direction);
        if (along < 0) continue;
        if (along < bestD) {
          bestD = along;
          best = i;
        }
      }
      if (best < 0) return;
      const point = new T.Vector3(rendered[best * 3], rendered[best * 3 + 1], rendered[best * 3 + 2]).applyMatrix4(frame.matrixWorld);
      intersects.push({ distance: raycaster.ray.origin.distanceTo(point), point, object: this, instanceId: best } as THREE.Intersection);
    }

    function setPoints(v: unknown): void {
      const pts = asPoints(v);
      if (!pts) {
        if (v !== undefined && v !== null) ctx.error(`points: expected tensor [N, 3] / [N, 2] or number[][] (got ${isTensor(v) ? `tensor ${v.dtype}[${v.shape}]` : typeof v})`);
        return;
      }
      xyz = pts.xyz;
      count = pts.count;
      dirty = true;
    }

    function setColors(v: unknown): void {
      if (v === null || v === undefined) {
        colors = null;
      } else {
        const vec = asVector(v);
        if (!vec) return;
        colors = vec;
        const shape = isTensor(v) ? v.shape : Array.isArray(v) && Array.isArray(v[0]) ? [v.length, (v[0] as unknown[]).length] : [vec.length];
        colorDims = shape.length >= 2 && shape[shape.length - 1] === 3 ? 3 : 1;
      }
      dirty = true;
    }

    function redraw(): void {
      dirty = false;
      if (!group) return;
      const p = ctx.props;
      // maxPoints may have shrunk since the data arrived: never draw past the instance capacity.
      const n = Math.min(count, Math.max(1, Math.floor(p.maxPoints)));
      drawn = n;
      const m = ensureMesh(n);
      if (rendered.length < n * 3) rendered = new Float32Array(Math.max(n * 3, 192));
      // Fit transform: center of the bounding box, uniform scale of the largest side.
      let cx = 0, cy = 0, cz = 0, s = 1;
      if (p.fit && n) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; cz = (z0 + z1) / 2;
        const side = Math.max(x1 - x0, y1 - y0, z1 - z0);
        s = side > 0 && Number.isFinite(side) ? p.extent / side : 1;
      }
      // Color scaling for scalar colors.
      let clo = 0, chi = 1, cabs = 1;
      if (colors && colorDims === 1) {
        [clo, chi] = extent(colors, Math.min(colors.length, n));
        cabs = Math.max(Math.abs(clo), Math.abs(chi)) || 1;
      }
      const base = resolveColor(ctx.theme, p.color, 'accent');
      if (!colors) col.set(base);
      const cm = lut.name;
      const sizeOf = (i: number) => p.pointSize * (sizes && i < sizes.length && Number.isFinite(sizes[i]) ? Math.max(0, sizes[i]) : 1);
      // Pass 1: rendered positions + their bounds (incl. point radius) so the mesh's own box is tight.
      let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = (xyz[i * 3] - cx) * s, y = (xyz[i * 3 + 1] - cy) * s, z = (xyz[i * 3 + 2] - cz) * s;
        rendered[i * 3] = x; rendered[i * 3 + 1] = y; rendered[i * 3 + 2] = z;
        const r = sizeOf(i) / 2;
        if (x - r < bx0) bx0 = x - r; if (x + r > bx1) bx1 = x + r;
        if (y - r < by0) by0 = y - r; if (y + r > by1) by1 = y + r;
        if (z - r < bz0) bz0 = z - r; if (z + r > bz1) bz1 = z + r;
      }
      const finiteBox = n > 0 && Number.isFinite(bx0 + bx1 + by0 + by1 + bz0 + bz1);
      if (finiteBox) m.fit(bx0, by0, bz0, bx1, by1, bz1);
      else m.fit(-0.01, -0.01, -0.01, 0.01, 0.01, 0.01);
      // Non-finite points (NaN/Inf from the producer) are drawn at zero scale inside the box:
      // a NaN instance matrix would turn the mesh bounds — used for picking and framing — into NaN.
      const hx = finiteBox ? (bx0 + bx1) / 2 : 0, hy = finiteBox ? (by0 + by1) / 2 : 0, hz = finiteBox ? (bz0 + bz1) / 2 : 0;
      // Pass 2: instance matrices and colors.
      for (let i = 0; i < n; i++) {
        const x = rendered[i * 3], y = rendered[i * 3 + 1], z = rendered[i * 3 + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          const d = sizeOf(i);
          m4.makeScale(d, d, d).setPosition(x, y, z);
        } else {
          m4.makeScale(0, 0, 0).setPosition(hx, hy, hz);
        }
        m.setMatrixAt(i, m4);
        if (colors) {
          if (colorDims === 3) col.setRGB(colors[i * 3] ?? 1, colors[i * 3 + 1] ?? 1, colors[i * 3 + 2] ?? 1, T.SRGBColorSpace);
          else {
            const c = colors[i] ?? NaN;
            const t = cm === 'diverging' ? divergingT(c, cabs) : cm === 'palette' ? categoryT(c, ctx.theme.palette.length) : rangeT(c, clo, chi);
            lutColor(T, lut, Number.isFinite(c) ? t : 0, col);
          }
        }
        m.setColorAt(i, col);
      }
      m.commit(n);
      showSelection();
    }

    function showSelection(): void {
      if (!marker || !label) return;
      const i = selected >= 0 && selected < drawn ? selected : -1;
      marker.visible = label.visible = i >= 0;
      if (i < 0) return;
      const d = ctx.props.pointSize * 2.2;
      marker.scale.setScalar(d);
      marker.position.set(rendered[i * 3], rendered[i * 3 + 1], rendered[i * 3 + 2]);
      label.position.set(rendered[i * 3] + d, rendered[i * 3 + 1] + d * 0.5, rendered[i * 3 + 2]);
      const c = colors && colorDims === 1 && i < colors.length ? `  ${formatNumber(colors[i], { precision: 3 })}` : '';
      label.set(`#${i}${c}`);
    }

    function nearest(lp: readonly number[]): number {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < drawn; i++) {
        const dx = rendered[i * 3] - lp[0], dy = rendered[i * 3 + 1] - lp[1], dz = rendered[i * 3 + 2] - lp[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      // Must be reasonably close (a point's radius plus touch slack).
      const lim = ctx.props.pointSize * 2 + 0.02;
      return bestD <= lim * lim ? best : -1;
    }

    build();
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'points') setPoints(v);
        else if (port === 'colors') setColors(v);
        else if (port === 'sizes') { sizes = v === null || v === undefined ? null : asVector(v); dirty = true; }
        else if (port === 'select') {
          const i = toScalar(v);
          selected = Number.isInteger(i) ? i : -1;
          showSelection();
        }
      },
      onInteraction(e: InteractionEvent) {
        if (!ctx.props.interactive) return;
        if (e.handler === 'hover') {
          const i = e.phase === 'end' || e.phase === 'cancel' ? -1 : nearest(e.localPoint);
          if (i !== hovered) {
            hovered = i;
            ctx.emit('hover', i);
          }
          return;
        }
        if (press.handle(e) === 'down') {
          const i = nearest(e.localPoint);
          if (i >= 0) {
            selected = i;
            showSelection();
            ctx.emit('index', i);
          }
        }
      },
      update() {
        if (dirty) redraw();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
