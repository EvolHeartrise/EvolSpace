// Implementation shared by the 'shape' widget and its 'box' alias.

import type { InteractionEvent, PortSpec, PropSpec, WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { resolveColor } from './color.ts';
import { PressTracker } from './handle.ts';
import { disposeTree, ownMaterial, shadedGeometry, sharedEdges, sharedGeometry, type UnitGeometry } from './resources.ts';
import { makeText } from './text.ts';
import { STYLE } from './style.ts';
import { toScalar } from './tensor.ts';

export const SHAPE_KINDS = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'ring', 'tetra', 'octa'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export interface ShapeProps extends Record<string, unknown> {
  kind: ShapeKind;
  color: string;
  size: number;
  dims: [number, number, number];
  wireframe: boolean;
  opacity: number;
  outline: boolean;
  label: string;
  pressable: boolean;
}

export function shapeProps(defaultKind: ShapeKind, includeKind = true): Record<string, PropSpec> {
  const p: Record<string, PropSpec> = {
    kind: { type: 'enum', options: [...SHAPE_KINDS], default: defaultKind, description: 'Primitive type.' },
    color: { type: 'color', default: 'accent', description: 'Theme token (accent, secondary, positive, negative, text, dim, surface) or CSS color.' },
    size: { type: 'number', default: 0.1, min: 0.001, max: 20, description: 'Extent in meters (diameter / edge length).' },
    dims: { type: 'vec3', default: [1, 1, 1], description: 'Per-axis multipliers of size, e.g. [2, 0.5, 1] for a flat bar.' },
    wireframe: { type: 'boolean', default: false, description: 'Render as wireframe.' },
    opacity: { type: 'number', default: 1, min: 0, max: 1, description: 'Opacity 0..1 (translucent shapes do not write depth).' },
    outline: { type: 'boolean', default: false, description: 'Draw crisp edges in the text color (diagram look).' },
    label: { type: 'string', default: '', description: 'Optional caption shown above the shape.' },
    pressable: { type: 'boolean', default: false, description: 'Make the shape a button: pinch/poke emits `press` (it can then only be grabbed by its label).' },
  };
  if (!includeKind) delete p.kind;
  return p;
}

export const SHAPE_INPUTS: Record<string, PortSpec> = {
  color: { type: 'color', description: 'Overrides the color prop (e.g. driven by a threshold transform).' },
  scale: { type: 'number', description: 'Uniform scale multiplier (1 = size).' },
  visible: { type: 'boolean', description: 'Show/hide the shape.' },
};

export const SHAPE_OUTPUTS: Record<string, PortSpec> = {
  press: { type: 'event', description: 'Pressed (pinch or poke) — only when pressable.' },
};

/** Geometry key for a kind (plane/ring render double-sided). */
const GEOM: Record<ShapeKind, UnitGeometry> = {
  box: 'box', sphere: 'sphere', cylinder: 'cylinder', cone: 'cone', torus: 'torus', capsule: 'capsule', plane: 'plane', ring: 'ring', tetra: 'tetra', octa: 'octa',
};

export function buildShape(ctx: WidgetContext, fixedKind?: ShapeKind) {
  const T = ctx.THREE;
  let group: THREE.Group | null = null;
  let mesh: THREE.Mesh | null = null;
  let material: THREE.MeshBasicMaterial | null = null;
  let inputColor: string | null = null;
  let inputScale = 1;
  const press = new PressTracker(['press']);

  const kind = (): ShapeKind => {
    const k = (fixedKind ?? ctx.props.kind) as ShapeKind;
    return SHAPE_KINDS.includes(k) ? k : 'box';
  };

  function rebuild(): void {
    if (group) disposeTree(group);
    const p = ctx.props;
    const k = kind();
    group = new T.Group();
    group.name = 'shape';
    const color = resolveColor(ctx.theme, inputColor ?? (p.color as string), 'accent');
    const opacity = clamp01(num(p.opacity, 1));
    // Solids get baked shading for depth cues; flat kinds stay flat.
    const flat = k === 'plane' || k === 'ring';
    material = ownMaterial(T, color, { opacity, wireframe: !!p.wireframe, doubleSide: flat, shaded: !flat });
    mesh = new T.Mesh(flat ? sharedGeometry(T, GEOM[k]) : shadedGeometry(T, GEOM[k]), material);
    mesh.name = 'body';
    applyScale();
    group.add(mesh);
    if (p.outline && !p.wireframe) {
      const edges = new T.LineSegments(sharedEdges(T, GEOM[k]), new T.LineBasicMaterial({ color: ctx.theme.text, transparent: true, opacity: 0.6 }));
      edges.raycast = () => {};
      edges.name = 'outline';
      mesh.add(edges);
    }
    const label = typeof p.label === 'string' ? p.label : '';
    if (label) {
      const t = makeText(ctx, label, { size: STYLE.bodySize, color: ctx.theme.text, anchorX: 'center', anchorY: 'bottom' });
      const dims = vec3(p.dims);
      t.position.set(0, (num(p.size, 0.1) * dims[1]) / 2 + 0.01, 0);
      t.name = 'label';
      group.add(t);
    }
    if (p.pressable) ctx.interactive(mesh);
    group.visible = inputVisible;
    ctx.root.add(group);
  }

  let inputVisible = true;

  function applyScale(): void {
    if (!mesh) return;
    const s = num(ctx.props.size, 0.1) * (Number.isFinite(inputScale) ? inputScale : 1);
    const d = vec3(ctx.props.dims);
    mesh.scale.set(s * d[0], s * d[1], s * d[2]);
  }

  function input(port: string, v: unknown): void {
    if (port === 'color') {
      inputColor = typeof v === 'string' || typeof v === 'number' ? resolveColor(ctx.theme, v as string, 'accent') : null;
      material?.color.set(inputColor ?? resolveColor(ctx.theme, ctx.props.color as string, 'accent'));
    } else if (port === 'scale') {
      const s = toScalar(v);
      inputScale = Number.isFinite(s) ? s : 1;
      applyScale();
    } else if (port === 'visible') {
      inputVisible = v !== false && v !== 0 && v !== 'false';
      if (group) group.visible = inputVisible;
    }
  }

  function interact(e: InteractionEvent): void {
    if (!ctx.props.pressable || !mesh || !material) return;
    const r = press.handle(e);
    if (r === 'down') mesh.scale.multiplyScalar(0.92);
    else if (r === 'up' || r === 'cancel') {
      applyScale();
      if (r === 'up') ctx.emit('press', { entity: ctx.entityId });
    }
  }

  rebuild();
  return {
    rebuild,
    input,
    interact,
    dispose(): void {
      if (group) disposeTree(group);
      group = null;
      mesh = null;
    },
  };
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function vec3(v: unknown): [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as [number, number, number]) : [1, 1, 1];
}
