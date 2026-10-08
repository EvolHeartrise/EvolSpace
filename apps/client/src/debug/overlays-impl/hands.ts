// Hand overlays: this page's hand rays (engine.rays(): smoothed shoulder→hand
// ray, full length to the hit, hit cross + entity label, touch radius ring at
// the contact point, active poses at the wrist) and the headset user's avatar
// (store.userPose: head frustum with the headset's FOV/aspect, gaze and focus
// rays, ghost hands via the runtime's createHandVisual, 'Headset' label).

import type * as THREE_NS from 'three';
import type { HandFrame, Handedness, UserPose } from '@evolspace/protocol';
import { contactPoint, pinchPoint } from '@evolspace/input';
import { createHandVisual, type HandVisual } from '@evolspace/runtime';
import type { DebugContext, OverlayDef, OverlayInstance } from '../types.ts';
import { entityLabel } from '../entity.ts';
import { LabelLayer, LineBatch, OverlayRoot, esc, overlayColors } from './common.ts';

const HANDS: readonly Handedness[] = ['left', 'right'];

function nameOf(ctx: DebugContext, id: string): string {
  const e = ctx.runtime.sceneState.entities[id];
  return e ? entityLabel(e) : id;
}

/** Billboard ring (camera-facing) of `r` meters around a world point. */
function ring(batch: LineBatch, cam: THREE_NS.Camera, c: THREE_NS.Vector3, r: number, color: THREE_NS.Color, tmp: THREE_NS.Vector3[]): void {
  const [right, up, a, b] = tmp;
  right.set(1, 0, 0).applyQuaternion(cam.quaternion);
  up.set(0, 1, 0).applyQuaternion(cam.quaternion);
  const N = 20;
  for (let i = 0; i < N; i++) {
    const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
    a.copy(c).addScaledVector(right, Math.cos(t0) * r).addScaledVector(up, Math.sin(t0) * r);
    b.copy(c).addScaledVector(right, Math.cos(t1) * r).addScaledVector(up, Math.sin(t1) * r);
    batch.segV(a, b, color);
  }
}

function cross3(batch: LineBatch, p: THREE_NS.Vector3, s: number, color: THREE_NS.Color): void {
  batch.seg(p.x - s, p.y, p.z, p.x + s, p.y, p.z, color);
  batch.seg(p.x, p.y - s, p.z, p.x, p.y + s, p.z, color);
  batch.seg(p.x, p.y, p.z - s, p.x, p.y, p.z + s, color);
}

export const raysOverlay: OverlayDef = {
  id: 'rays',
  title: 'Hand rays & hits',
  description: "This page's hand rays (engine.rays), hit points + targets, touch radius, active poses",
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const root = new OverlayRoot(ctx, 'rays');
    const batch = new LineBatch(T, { opacity: 0.95, depthTest: false, renderOrder: 960, name: 'rays' });
    root.world.add(batch.lines);
    const layer = new LabelLayer(ctx);
    const col = overlayColors(ctx);
    const o = new T.Vector3(), d = new T.Vector3(), e = new T.Vector3(), p = new T.Vector3();
    const tmp = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
    const m = new T.Matrix4();
    const dimmed = { left: col.left.clone().multiplyScalar(0.55), right: col.right.clone().multiplyScalar(0.55) };
    return {
      update() {
        root.sync();
        ctx.camera.updateMatrixWorld();
        m.copy(root.space.matrix); // space → world
        batch.begin();
        layer.begin();
        let rays: ReturnType<DebugContext['engine']['rays']> = {};
        try { rays = ctx.engine.rays(); } catch { /* not ready */ }
        for (const h of HANDS) {
          const r = rays[h];
          const c = h === 'left' ? col.left : col.right;
          if (r) {
            o.fromArray(r.origin).applyMatrix4(m);
            d.fromArray(r.direction).transformDirection(m);
            if (r.hit) {
              e.fromArray(r.hit.point).applyMatrix4(m);
              batch.segV(o, e, c);
              cross3(batch, e, 0.025, r.hit.interactive ? col.pos : col.accent2);
              layer.put(`hit-${h}`, e, `${h === 'left' ? 'L' : 'R'} → ${esc(nameOf(ctx, r.hit.entity))}${r.hit.interactive ? ' · <b>interactive</b>' : ''} <span class="i">${r.hit.distance.toFixed(2)} m</span>`, 'hit', -8);
            } else {
              e.copy(o).addScaledVector(d, 3);
              batch.segV(o, e, dimmed[h], dimmed[h]);
            }
          }
          const f = ctx.client.hands[h];
          if (f) {
            p.fromArray(contactPoint(f)).applyMatrix4(m);
            ring(batch, ctx.camera, p, 0.03, c, tmp);
            const poses = ctx.engine.activePoses(h);
            if (poses.length) {
              e.set(f.joints[0], f.joints[1], f.joints[2]).applyMatrix4(m);
              layer.put(`poses-${h}`, e, `${h === 'left' ? 'L' : 'R'} · ${esc(poses.join(', '))}`, '', 22);
            }
          }
        }
        batch.end();
        layer.end();
      },
      dispose() { batch.dispose(); layer.dispose(); root.dispose(); },
    };
  },
};

// ------------------------------------------------------------------ headset avatar

export const avatarOverlay: OverlayDef = {
  id: 'avatar',
  title: 'Headset user',
  description: 'Head frustum (headset FOV), gaze + focus rays and ghost hands from the live user pose',
  defaultEnabled: true,
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const release = ctx.store.need('userPose');
    const root = new OverlayRoot(ctx, 'avatar');
    const batch = new LineBatch(T, { opacity: 0.9, renderOrder: 930, name: 'avatar-lines' });
    root.space.add(batch.lines);
    const col = overlayColors(ctx);
    const ghost: Record<Handedness, HandVisual> = {
      left: createHandVisual(ctx.runtime.theme, { color: ctx.runtime.theme.positive, jointColor: ctx.runtime.theme.positive, opacity: 0.45 }),
      right: createHandVisual(ctx.runtime.theme, { color: ctx.runtime.theme.positive, jointColor: ctx.runtime.theme.positive, opacity: 0.45 }),
    };
    for (const h of HANDS) { ghost[h].object.name = `avatar-hand-${h}`; root.space.add(ghost[h].object); }
    const layer = new LabelLayer(ctx);
    const hp = new T.Vector3(), hq = new T.Quaternion(), a = new T.Vector3(), b = new T.Vector3(), w = new T.Vector3();
    const corners = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
    const gazeDim = col.pos.clone().multiplyScalar(0.5);
    let last: UserPose | null = null;
    return {
      update() {
        root.sync();
        const pose = ctx.store.userPose.peek();
        batch.begin();
        layer.begin();
        if (pose) {
          avatarLines(batch, pose, { hp, hq, a, b, corners }, col.pos, gazeDim, col.accent2);
          // Label above the head (world coords).
          w.set(pose.head.position[0], pose.head.position[1] + 0.16, pose.head.position[2]).applyMatrix4(root.space.matrix);
          const age = Date.now() - pose.t;
          layer.put('headset', w, `Headset${pose.mode !== 'inline' ? ` · ${pose.mode.toUpperCase()}` : ''}${age > 2000 ? ` <span class="i">${Math.round(age / 1000)}s old</span>` : ''}`, 'headset');
        }
        if (pose !== last) {
          for (const h of HANDS) ghost[h].update(pose?.hands?.[h]);
          last = pose;
        }
        batch.end();
        layer.end();
      },
      dispose() {
        release();
        for (const h of HANDS) { ghost[h].object.removeFromParent(); ghost[h].dispose(); }
        batch.dispose();
        layer.dispose();
        root.dispose();
      },
    };
  },
};

/**
 * Lines of the avatar in space coordinates: head frustum (apex at the eyes,
 * 0.22 m deep, FOV/aspect from the pose; a tick marks "up"), a small head
 * cross, the gaze ray (to the gaze hit or 1.5 m) and per-hand focus rays
 * (pinch point → focus point).
 */
export function avatarLines(
  batch: LineBatch, pose: UserPose,
  s: { hp: THREE_NS.Vector3; hq: THREE_NS.Quaternion; a: THREE_NS.Vector3; b: THREE_NS.Vector3; corners: THREE_NS.Vector3[] },
  color: THREE_NS.Color, dim: THREE_NS.Color, focus: THREE_NS.Color,
): void {
  const { hp, hq, a, b, corners } = s;
  hp.fromArray(pose.head.position);
  hq.fromArray(pose.head.rotation);
  const vfov = ((pose.fov ?? 90) * Math.PI) / 180;
  const aspect = pose.aspect ?? 1;
  const D = 0.22;
  const hy = Math.tan(vfov / 2) * D, hx = hy * aspect;
  const local: Array<[number, number]> = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  for (let i = 0; i < 4; i++) corners[i].set(local[i][0], local[i][1], -D).applyQuaternion(hq).add(hp);
  for (let i = 0; i < 4; i++) {
    batch.segV(hp, corners[i], color);
    batch.segV(corners[i], corners[(i + 1) % 4], color);
  }
  // Up marker: small triangle on the top edge.
  a.set(-hx * 0.25, hy, -D).applyQuaternion(hq).add(hp);
  b.set(0, hy * 1.25, -D).applyQuaternion(hq).add(hp);
  batch.segV(a, b, color);
  a.set(hx * 0.25, hy, -D).applyQuaternion(hq).add(hp);
  batch.segV(a, b, color);
  // Head cross.
  for (const ax of [[0.06, 0, 0], [0, 0.06, 0], [0, 0, 0.06]] as const) {
    a.set(ax[0], ax[1], ax[2]).applyQuaternion(hq);
    batch.seg(hp.x - a.x, hp.y - a.y, hp.z - a.z, hp.x + a.x, hp.y + a.y, hp.z + a.z, color);
  }
  // Gaze.
  if (pose.gaze) {
    b.fromArray(pose.gaze.point);
    batch.segV(hp, b, color);
  } else {
    b.set(0, 0, -1.5).applyQuaternion(hq).add(hp);
    batch.segV(hp, b, dim, dim);
  }
  // Focus rays (hand → what its ray hits).
  for (const h of HANDS) {
    const f = pose.focus?.[h];
    const frame = pose.hands?.[h];
    if (!f || !frame) continue;
    a.fromArray(pinchPoint(frame as HandFrame));
    b.fromArray(f.point);
    batch.segV(a, b, focus);
  }
}
