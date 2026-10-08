// Screenshot request building for the Screenshots panel (tested in
// apps/client/test/debug-panels-b-screenshots.test.ts). Mirror camera views are
// in SPACE coordinates (packages/protocol ScreenshotView 'camera'); the desktop
// camera lives in WORLD coordinates and runtime.root is the space origin, so
// the camera pose is expressed relative to the root.

import * as THREE from 'three';
import type { Quat, ScreenshotRequest, ScreenshotView, Vec3 } from '@evolspace/protocol';

export type ShotKind = 'user' | 'camera' | 'entity' | 'widget';

/** Entity/widget view directions (subject → camera, space coords). 'auto' = mirror default; 'camera' = from the desktop camera. */
export const DIRECTIONS: Record<string, { label: string; dir?: Vec3 }> = {
  auto: { label: 'auto (front, entity-relative)' },
  camera: { label: 'from my camera' },
  front: { label: 'front', dir: [0, 0.3, 1] },
  back: { label: 'back', dir: [0, 0.3, -1] },
  left: { label: 'left', dir: [-1, 0.3, 0] },
  right: { label: 'right', dir: [1, 0.3, 0] },
  top: { label: 'top', dir: [0, 1, 0.02] },
  iso: { label: 'isometric', dir: [1, 0.8, 1] },
};

export const SIZES: Record<string, { label: string; w?: number; h?: number }> = {
  viewport: { label: 'viewport aspect' },
  '1024x768': { label: '1024 × 768', w: 1024, h: 768 },
  '1280x720': { label: '1280 × 720', w: 1280, h: 720 },
  '1920x1080': { label: '1920 × 1080', w: 1920, h: 1080 },
  '800x800': { label: '800 × 800', w: 800, h: 800 },
  '512x512': { label: '512 × 512', w: 512, h: 512 },
  custom: { label: 'custom' },
};

export interface ShotForm {
  kind: ShotKind;
  size: string;
  width: number;
  height: number;
  hands: boolean;
  labels: boolean;
  /** 'scene' | 'transparent' | 'color' (→ `color`). */
  background: 'scene' | 'transparent' | 'color';
  color: string;
  /** Entity view subject; null = the current selection. */
  entity: string | null;
  direction: string;
  padding: number;
  widget: string;
  widgetProps: Record<string, unknown> | null;
}

export const DEFAULT_FORM: ShotForm = {
  kind: 'camera', size: 'viewport', width: 1280, height: 720, hands: false, labels: false, background: 'scene', color: '#101722',
  entity: null, direction: 'auto', padding: 0.15, widget: '', widgetProps: null,
};

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** World camera pose → explicit camera view in space coordinates (relative to `root`). */
export function cameraViewFromWorld(position: THREE.Vector3, quaternion: THREE.Quaternion, fov: number, root: THREE.Object3D): Extract<ScreenshotView, { kind: 'camera' }> {
  root.updateWorldMatrix(true, false);
  const inv = root.matrixWorld.clone().invert();
  const p = position.clone().applyMatrix4(inv);
  const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
  const q = rootQ.invert().multiply(quaternion).normalize();
  return { kind: 'camera', position: [r4(p.x), r4(p.y), r4(p.z)], rotation: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] as Quat, fov: Math.round(fov * 100) / 100 };
}

/** The desktop camera's current view (pose + vertical FOV) as a mirror camera view. */
export function cameraViewOf(camera: THREE.PerspectiveCamera, root: THREE.Object3D): Extract<ScreenshotView, { kind: 'camera' }> {
  camera.updateMatrixWorld();
  return cameraViewFromWorld(camera.getWorldPosition(new THREE.Vector3()), camera.getWorldQuaternion(new THREE.Quaternion()), camera.fov, root);
}

/** A point in world coordinates → space coordinates. */
export function toSpace(world: THREE.Vector3, root: THREE.Object3D): THREE.Vector3 {
  root.updateWorldMatrix(true, false);
  return world.clone().applyMatrix4(root.matrixWorld.clone().invert());
}

/** Direction (space coords, unit, rounded) from a subject center toward the camera. */
export function directionToCamera(subjectSpace: THREE.Vector3, cameraSpace: Vec3): Vec3 {
  const d = new THREE.Vector3(...cameraSpace).sub(subjectSpace);
  if (d.lengthSq() < 1e-9) return [0, 0, 1];
  d.normalize();
  return [r4(d.x), r4(d.y), r4(d.z)];
}

/** Output size for a form (viewport aspect → width 1280, or the long side capped at 1920). */
export function sizeOf(form: Pick<ShotForm, 'size' | 'width' | 'height'>, viewport?: { width: number; height: number }): { width: number; height: number } {
  const p = SIZES[form.size];
  if (p?.w && p.h) return { width: p.w, height: p.h };
  if (form.size === 'viewport' && viewport && viewport.width > 0 && viewport.height > 0) {
    const aspect = viewport.width / viewport.height;
    const width = aspect >= 1 ? 1280 : Math.round(1280 * aspect);
    const height = aspect >= 1 ? Math.round(1280 / aspect) : 1280;
    return { width: Math.max(16, width), height: Math.max(16, height) };
  }
  const clamp = (v: number) => Math.max(16, Math.min(4096, Math.round(Number.isFinite(v) ? v : 1024)));
  return { width: clamp(form.width), height: clamp(form.height) };
}

export interface BuildEnv {
  /** Desktop camera view (space coords) — needed for kind 'camera' and direction 'camera'. */
  camera?: Extract<ScreenshotView, { kind: 'camera' }>;
  selection?: string | null;
  /** Space-coords center of an entity (for direction 'camera'). */
  entityCenter?(id: string): THREE.Vector3 | null;
  viewport?: { width: number; height: number };
}

/** Form → ScreenshotRequest, or an error message when something required is missing. */
export function buildRequest(form: ShotForm, env: BuildEnv): ScreenshotRequest | { error: string } {
  const { width, height } = sizeOf(form, env.viewport);
  let view: ScreenshotView;
  switch (form.kind) {
    case 'user':
      view = { kind: 'user' };
      break;
    case 'camera':
      if (!env.camera) return { error: 'no camera pose' };
      view = env.camera;
      break;
    case 'entity': {
      const entity = form.entity ?? env.selection ?? null;
      if (!entity) return { error: 'select an entity (or pick one) first' };
      let direction: Vec3 | undefined = DIRECTIONS[form.direction]?.dir;
      if (form.direction === 'camera') {
        const c = env.entityCenter?.(entity);
        if (c && env.camera) direction = directionToCamera(c, env.camera.position);
      }
      view = { kind: 'entity', entity, ...(direction ? { direction } : {}), ...(form.padding !== DEFAULT_FORM.padding ? { padding: form.padding } : {}) };
      break;
    }
    case 'widget': {
      if (!form.widget) return { error: 'pick a widget' };
      const direction = form.direction === 'camera' ? undefined : DIRECTIONS[form.direction]?.dir;
      view = { kind: 'widget', widget: form.widget, ...(form.widgetProps && Object.keys(form.widgetProps).length ? { props: form.widgetProps } : {}), ...(direction ? { direction } : {}) };
      break;
    }
  }
  const background = form.background === 'color' ? form.color : form.background;
  return {
    view, width, height,
    hands: form.hands,
    ...(form.labels ? { labels: true } : {}),
    ...(background !== 'scene' ? { background } : {}),
  };
}

/** One-line caption for a gallery entry. */
export function captionOf(req: ScreenshotRequest): string {
  const v = req.view;
  const size = `${req.width ?? 1024}×${req.height ?? 768}`;
  switch (v.kind) {
    case 'user': return `user view · ${size}`;
    case 'camera': return `camera @ (${v.position.map((x) => x.toFixed(2)).join(', ')}) · fov ${v.fov ?? '—'}° · ${size}`;
    case 'entity': return `entity ${v.entity}${v.direction ? ` · dir (${v.direction.map((x) => x.toFixed(2)).join(', ')})` : ''} · ${size}`;
    case 'widget': return `widget ${v.widget}${v.props ? ' + props' : ''} · ${size}`;
  }
}
