// Simulated-hands driver of the Hands workbench. Per hand: enable, a shape
// (from a solved pose preset or the manual sliders), hold-to-apply or latch,
// and a placement — 'cursor' (right hand: the desktop mouse hand's placement,
// re-posed), 'camera' (fixed in front of the camera) or 'entity' (contact point
// on the selected entity, frozen while the pose is applied so a grab can't run
// away). Runs as a frame hook (after the engine update), so its frames are
// used on the next frame — via client.sim, which overrides real/desktop hands.
// A hand that is not simulated keeps the desktop mouse hand (right) so the
// mouse still works; LMB still pinches while the right hand is simulated and
// the pose is not applied.

import { signal, type Signal } from '@preact/signals';
import type { HandFrame, Handedness, Quat, Vec3 } from '@evolspace/protocol';
import { math, rayAnchor } from '@evolspace/input';
import type { DebugContext } from '../../types.ts';
import { CANON_OFFSET, RELAXED_SHAPE, cloneShape, synthShape, type Placement, type SimShape, type SolveResult } from './solver.ts';

export type PlacementMode = 'cursor' | 'camera' | 'entity';
export type ApplyMode = 'hold' | 'latch';

export interface HandSimState {
  enabled: boolean;
  /** Pose id of the preset, or 'custom' after manual edits. */
  preset: string;
  shape: SimShape;
  solve: SolveResult | null;
  mode: ApplyMode;
  latched: boolean;
  placement: PlacementMode;
  /** Extra offset in the placement frame (m). */
  offset: Vec3;
}

export const HANDS: readonly Handedness[] = ['left', 'right'];

function initial(hand: Handedness): HandSimState {
  return {
    enabled: false,
    preset: 'pinch',
    shape: cloneShape(RELAXED_SHAPE),
    solve: null,
    mode: hand === 'left' ? 'hold' : 'latch',
    latched: false,
    placement: hand === 'right' ? 'cursor' : 'camera',
    offset: [0, 0, 0],
  };
}

/** Module-level: survives tab switches. */
export const simState: Record<Handedness, Signal<HandSimState>> = { left: signal(initial('left')), right: signal(initial('right')) };
/** Hold-to-apply buttons currently pressed. */
export const simHeld: Record<Handedness, Signal<boolean>> = { left: signal(false), right: signal(false) };

export function patchSim(hand: Handedness, patch: Partial<HandSimState>): void {
  simState[hand].value = { ...simState[hand].value, ...patch };
}

export function isApplied(hand: Handedness): boolean {
  const s = simState[hand].peek();
  return s.mode === 'latch' ? s.latched : simHeld[hand].peek();
}

/** Narrow client surface the driver needs (fakeable). */
export interface DriverClient {
  readonly sim: { get(): Partial<Record<Handedness, HandFrame>> | null; setHands(h: Partial<Record<Handedness, HandFrame>>): unknown; clearHands(): void };
  readonly desktop: { hand(): HandFrame | null; pinching: boolean } | null;
  readonly head: { position: Vec3; rotation: Quat };
  onFrame(cb: (dt: number, tMs: number) => void): () => void;
}

export interface DriverDeps {
  client: DriverClient;
  /** Selected entity's world-space bounds → space-coord target {center, surface point toward the head}. */
  entityTarget(head: { position: Vec3; rotation: Quat }): { point: Vec3; center: Vec3 } | null;
}

export class HandSimDriver {
  private owned: Partial<Record<Handedness, HandFrame>> | null = null;
  private cursorCache: { rot: Quat; anchor: Vec3 } | null = null;
  private frozen: Partial<Record<Handedness, { at: Vec3; base: Quat } | null>> = {};
  private wasApplied: Record<Handedness, boolean> = { left: false, right: false };
  private readonly off: () => void;
  /** Last frames produced per hand (for the panel). */
  readonly last: Partial<Record<Handedness, HandFrame>> = {};

  constructor(private readonly d: DriverDeps) {
    this.off = d.client.onFrame(() => this.tick());
  }

  dispose(): void {
    this.off();
    this.release();
  }

  private release(): void {
    if (this.owned && this.d.client.sim.get() === this.owned) this.d.client.sim.clearHands();
    this.owned = null;
  }

  tick(): void {
    const any = HANDS.some((h) => simState[h].peek().enabled);
    if (!any) {
      if (this.owned) this.release();
      delete this.last.left;
      delete this.last.right;
      return;
    }
    const frames: Partial<Record<Handedness, HandFrame>> = {};
    const desk = this.d.client.desktop;
    const deskHand = desk?.hand() ?? null;
    if (deskHand) this.cursorCache = { rot: jointRot(deskHand, 0), anchor: rayAnchor(deskHand) };
    for (const hand of HANDS) {
      const st = simState[hand].peek();
      if (!st.enabled) {
        delete this.last[hand];
        if (hand === 'right' && deskHand) frames.right = deskHand; // keep the mouse hand working
        continue;
      }
      const f = this.frameFor(hand, st, deskHand, !!desk?.pinching);
      if (f) frames[hand] = f;
      if (f) this.last[hand] = f; else delete this.last[hand];
    }
    this.d.client.sim.setHands(frames);
    this.owned = this.d.client.sim.get();
  }

  private frameFor(hand: Handedness, st: HandSimState, deskHand: HandFrame | null, deskPinching: boolean): HandFrame | null {
    const applied = isApplied(hand);
    const justApplied = applied && !this.wasApplied[hand];
    this.wasApplied[hand] = applied;
    const shape = applied ? st.shape : RELAXED_SHAPE;
    const head = this.d.client.head;

    if (st.placement === 'cursor' && hand === 'right') {
      // LMB pinch keeps working while the preset is not applied.
      if (!applied && deskPinching && deskHand) return deskHand;
      const c = this.cursorCache;
      if (c) {
        const off = math.qRotate(c.rot, st.offset);
        return synthShape(shape, hand, { base: c.rot, at: math.add(c.anchor, off), by: 'anchor' });
      }
      return synthShape(shape, hand, cameraPlacement(hand, head, st.offset));
    }
    if (st.placement === 'entity') {
      let fr = this.frozen[hand];
      if (!applied || justApplied || !fr) {
        const t = this.d.entityTarget(head);
        fr = t ? { at: t.point, base: math.yawOnly(math.lookRotation(math.sub(t.center, head.position))) } : null;
        this.frozen[hand] = fr;
      }
      if (fr) {
        return synthShape(shape, hand, { base: fr.base, at: math.add(fr.at, math.qRotate(fr.base, st.offset)), by: 'contact' });
      }
    }
    return synthShape(shape, hand, cameraPlacement(hand, head, st.offset));
  }
}

/** In front of the camera (position follows the full head pose; orientation yaw-only so "palm up" stays up). */
export function cameraPlacement(hand: Handedness, head: { position: Vec3; rotation: Quat }, offset: Vec3 = [0, 0, 0]): Placement {
  const side = hand === 'right' ? 1 : -1;
  const local: Vec3 = [CANON_OFFSET[0] * side + offset[0], CANON_OFFSET[1] + offset[1], CANON_OFFSET[2] + offset[2]];
  return { base: math.yawOnly(head.rotation), at: math.add(head.position, math.qRotate(head.rotation, local)), by: 'anchor' };
}

function jointRot(f: HandFrame, i: number): Quat {
  const o = i * 7;
  return [f.joints[o + 3], f.joints[o + 4], f.joints[o + 5], f.joints[o + 6]];
}

/** Install the driver for a debug context. */
export function installHandSim(ctx: DebugContext): HandSimDriver {
  const THREE = ctx.THREE;
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const head = new THREE.Vector3();
  const ray = new THREE.Ray();
  const hitP = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  return new HandSimDriver({
    client: ctx.client as unknown as DriverClient,
    entityTarget: (h) => {
      const id = ctx.store.selection.peek();
      if (!id) return null;
      const b = ctx.runtime.frameEntity(id);
      if (!b || b.isEmpty()) return null;
      box.copy(b);
      // World → space (the root may be offset by the origin anchor).
      const root = ctx.runtime.root;
      root.updateWorldMatrix(true, false);
      inv.copy(root.matrixWorld).invert();
      box.getCenter(c);
      head.set(h.position[0], h.position[1], h.position[2]).applyMatrix4(root.matrixWorld);
      ray.set(head, c.clone().sub(head).normalize());
      const p = ray.intersectBox(box, hitP) ?? c;
      const sp = p.clone().applyMatrix4(inv);
      const sc = c.clone().applyMatrix4(inv);
      return { point: [sp.x, sp.y, sp.z], center: [sc.x, sc.y, sc.z] };
    },
  });
}
