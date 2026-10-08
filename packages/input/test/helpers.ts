// Shared test utilities: seeded RNG, standard head/hand placements, library
// loading, and a fake InteractionHost with axis-aligned box entities.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  Entity, HandFrame, Handedness, InteractionBinding, InteractionEvent, InteractionSet, PoseDef, PoseEvent, Quat,
  Transform, Vec3,
} from '@evolspace/protocol';
import { synthHand, wristRotation, HAND_SHAPES, type SynthHandSpec } from '../src/synth.ts';
import type { Hit, InteractionHost } from '../src/engine.ts';
import type { HeadPose } from '../src/features.ts';
import { qFromAxisAngle, qMul, normalize, reject, sub } from '../src/math.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const HEAD: HeadPose = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };

/** mulberry32: small deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const uniform = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

/** Random unit quaternion (uniform). */
export function randomQuat(r: () => number): Quat {
  const u1 = r(), u2 = r(), u3 = r();
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  return [s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3)];
}

/** Small random rotation (up to maxDeg) applied on top of q. */
export function jitterQuat(q: Quat, r: () => number, maxDeg: number): Quat {
  const axis = normalize([uniform(r, -1, 1), uniform(r, -1, 1), uniform(r, -1, 1)]);
  return qMul(qFromAxisAngle(axis, uniform(r, -maxDeg, maxDeg) * Math.PI / 180), q);
}

export const mirrorX = (v: Vec3, hand: Handedness): Vec3 => (hand === 'left' ? [-v[0], v[1], v[2]] : v);

/** Typical wrist positions in front of the user. */
export const wristPos = (hand: Handedness): Vec3 => mirrorX([0.18, 1.25, -0.35], hand);

/** Common hand orientations (fingers direction, palm direction) for a right hand; mirrored for the left. */
export const ORIENT = {
  palmDown: (_hand: Handedness) => wristRotation([0, 0, -1], [0, -1, 0]),
  /** Typical Quest pinch/ray posture: palm facing down and inward. */
  pinchPosture: (hand: Handedness) => wristRotation([0, 0, -1], mirrorX([-0.6, -1, 0], hand)),
  palmIn: (hand: Handedness) => wristRotation([0, 0, -1], mirrorX([-1, 0, 0], hand)),
  palmUp: (_hand: Handedness) => wristRotation([0, 0, -1], [0, 1, 0]),
  /** Palm turned toward the face (Quest system-gesture orientation). */
  palmToHead: (hand: Handedness) => {
    const palm = normalize(sub(HEAD.position, wristPos(hand)));
    return wristRotation(reject([0, 1, 0], palm), palm);
  },
  thumbDown: (hand: Handedness) => wristRotation([0, 0, -1], mirrorX([1, 0, 0], hand)),
  pointUp: (_hand: Handedness) => wristRotation([0, 1, -0.2], [0, 0, 1]),
} satisfies Record<string, (hand: Handedness) => Quat>;

export function shape(name: keyof typeof HAND_SHAPES & string, hand: Handedness, extra: Partial<SynthHandSpec> = {}): HandFrame {
  return synthHand({ hand, position: wristPos(hand), rotation: ORIENT.pinchPosture(hand), ...HAND_SHAPES[name], ...extra });
}

export function loadPoses(): PoseDef[] {
  const dir = join(REPO_ROOT, 'library', 'poses');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as PoseDef);
}

export function loadInteractionSets(): Record<string, InteractionSet> {
  const dir = join(REPO_ROOT, 'library', 'interactions');
  const out: Record<string, InteractionSet> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  }
  return out;
}

// ---------------------------------------------------------------- fake host

export interface FakePart {
  name: string;
  /** Center offset from the entity position (world axes, unscaled). */
  offset: Vec3;
  half: Vec3;
  interactive: boolean;
}

export interface FakeEntity {
  entity: Entity;
  /** Half extents of the body box at scale 1. */
  half: Vec3;
  parts: FakePart[];
}

export type HostCall =
  | { fn: 'setEntityTransform'; id: string; t: Transform; phase: string }
  | { fn: 'deliver'; id: string; e: InteractionEvent }
  | { fn: 'runCommand'; name: string; args: Record<string, unknown> | undefined; phase: string }
  | { fn: 'publish'; channel: string; value: unknown }
  | { fn: 'poseEvent'; e: PoseEvent };

/** Slab-method ray / AABB intersection; returns distance or null. */
function rayBox(o: Vec3, d: Vec3, c: Vec3, h: Vec3): number | null {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < c[i] - h[i] || o[i] > c[i] + h[i]) return null;
      continue;
    }
    const t1 = (c[i] - h[i] - o[i]) / d[i];
    const t2 = (c[i] + h[i] - o[i]) / d[i];
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  if (tmax < Math.max(tmin, 0)) return null;
  return tmin >= 0 ? tmin : 0;
}

function boxDist(p: Vec3, c: Vec3, h: Vec3): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(0, Math.abs(p[i] - c[i]) - h[i]);
    s += d * d;
  }
  return Math.sqrt(s);
}

export class FakeHost implements InteractionHost {
  readonly entities = new Map<string, FakeEntity>();
  readonly calls: HostCall[] = [];
  readonly widgetDefaults = new Map<string, InteractionBinding[]>();
  hovers: Array<{ hand: Handedness; hit: Hit | null }> = [];

  add(id: string, position: Vec3, opts: Partial<Entity> & { half?: Vec3; parts?: FakePart[] } = {}): FakeEntity {
    const { half = [0.05, 0.05, 0.05], parts = [], ...rest } = opts;
    const entity: Entity = {
      id, parent: null, widget: 'box', props: {}, visible: true,
      transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...rest,
    };
    const fe = { entity, half, parts };
    this.entities.set(id, fe);
    return fe;
  }

  private boxes(): Array<{ id: string; c: Vec3; h: Vec3; object: string; interactive: boolean }> {
    const out: Array<{ id: string; c: Vec3; h: Vec3; object: string; interactive: boolean }> = [];
    for (const [id, fe] of this.entities) {
      const t = fe.entity.transform;
      const s = t.scale;
      for (const p of fe.parts) {
        out.push({
          id, object: p.name, interactive: p.interactive,
          c: [t.position[0] + p.offset[0] * s[0], t.position[1] + p.offset[1] * s[1], t.position[2] + p.offset[2] * s[2]],
          h: [p.half[0] * s[0], p.half[1] * s[1], p.half[2] * s[2]],
        });
      }
      out.push({ id, object: 'body', interactive: false, c: t.position, h: [fe.half[0] * s[0], fe.half[1] * s[1], fe.half[2] * s[2]] });
    }
    return out;
  }

  raycast(origin: Vec3, dir: Vec3): Hit | null {
    let best: Hit | null = null;
    for (const b of this.boxes()) {
      const t = rayBox(origin, dir, b.c, b.h);
      // Parts are listed before their body, so on equal distance the part wins.
      if (t !== null && (!best || t < best.distance - 1e-9)) {
        best = { entity: b.id, distance: t, object: b.object, interactive: b.interactive,
          point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t] };
      }
    }
    return best;
  }

  touch(point: Vec3, radius: number): Hit | null {
    let best: Hit | null = null;
    for (const b of this.boxes()) {
      const d = boxDist(point, b.c, b.h);
      if (d <= radius && (!best || d < best.distance - 1e-9)) {
        best = { entity: b.id, distance: d, object: b.object, interactive: b.interactive, point: [...point] as Vec3 };
      }
    }
    return best;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id)?.entity;
  }

  getWorldTransform(id: string): Transform {
    const t = this.entities.get(id)!.entity.transform;
    return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } as Transform;
  }

  widgetBindings(widget: string): InteractionBinding[] {
    return this.widgetDefaults.get(widget) ?? [];
  }

  setEntityTransform(id: string, t: Transform, phase: 'start' | 'move' | 'end'): void {
    this.calls.push({ fn: 'setEntityTransform', id, t, phase });
    const fe = this.entities.get(id);
    if (fe) fe.entity.transform = t;
  }

  deliver(id: string, e: InteractionEvent): void {
    this.calls.push({ fn: 'deliver', id, e });
  }

  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void {
    this.calls.push({ fn: 'runCommand', name, args, phase });
  }

  publish(channel: string, value: unknown): void {
    this.calls.push({ fn: 'publish', channel, value });
  }

  poseEvent(e: PoseEvent): void {
    this.calls.push({ fn: 'poseEvent', e });
  }

  hover(hand: Handedness, hit: Hit | null): void {
    this.hovers.push({ hand, hit });
  }

  of<F extends HostCall['fn']>(fn: F): Extract<HostCall, { fn: F }>[] {
    return this.calls.filter((c) => c.fn === fn) as Extract<HostCall, { fn: F }>[];
  }

  clear(): void {
    this.calls.length = 0;
    this.hovers = [];
  }
}
