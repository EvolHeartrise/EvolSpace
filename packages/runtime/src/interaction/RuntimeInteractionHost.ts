// The runtime's implementation of the input package's InteractionHost.
//
// Transforms: the input engine works in space coordinates; entities store
// transforms relative to their parent / anchor frame, so every setEntityTransform
// is converted into the node's parent frame. During a gesture the result is
// previewed locally every call, sent as a throttled `scene.ops` (source
// 'user') on move, and sent once more on end — all ops of one gesture share a
// `group` so the server undoes the whole drag as one step. A gesture that
// never moved the entity (pinch + release in place) sends nothing, so it does
// not leave an empty step in the undo history.

import * as THREE from 'three';
import type {
  Entity,
  Handedness,
  InteractionBinding,
  InteractionEvent,
  PoseEvent,
  Transform,
  Vec3,
} from '@evolspace/protocol';
import type { ChannelHub } from '../data/ChannelHub.ts';
import type { NetPort } from '../net/types.ts';
import type { Reconciler } from '../scene/Reconciler.ts';
import type { SceneMirror } from '../scene/SceneMirror.ts';
import type { WidgetHost } from '../widgets/WidgetHost.ts';
import type { Picker } from './Picker.ts';
import type { PointerVisuals } from './PointerVisuals.ts';
import type { GesturePhase, Hit, InteractionHost } from './types.ts';
import { matrixFromTransform, transformFromMatrix } from '../util/math.ts';
import { nearlyEqualArrays } from '../util/equal.ts';
import { randomId } from '../util/ids.ts';
import { now } from '../util/rate.ts';

export interface InteractionHostDeps {
  root: THREE.Object3D;
  mirror: SceneMirror;
  reconciler: Reconciler;
  picker: Picker;
  widgets: WidgetHost;
  net: Pick<NetPort, 'send'>;
  channels: ChannelHub;
  pointer: PointerVisuals;
  runLocalCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): boolean;
  /** Throttle for transform ops while moving (ms). */
  moveIntervalMs?: number;
}

interface Gesture {
  group: string;
  lastSent: number;
  pending: Transform | null;
  /** At least one op of this gesture went to the server. */
  sent: boolean;
}

export class RuntimeInteractionHost implements InteractionHost {
  private gestures = new Map<string, Gesture>();
  private readonly moveInterval: number;

  constructor(private d: InteractionHostDeps) {
    this.moveInterval = d.moveIntervalMs ?? 100;
  }

  raycast(origin: Vec3, dir: Vec3): Hit | null {
    return this.d.picker.raycast(origin, dir);
  }

  touch(point: Vec3, radius: number): Hit | null {
    return this.d.picker.touch(point, radius);
  }

  getEntity(id: string): Entity | undefined {
    return this.d.mirror.entity(id);
  }

  getWorldTransform(id: string): Transform {
    const node = this.d.reconciler.node(id);
    if (!node) return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    this.d.root.updateWorldMatrix(true, false);
    node.object.updateWorldMatrix(true, false);
    _m.copy(this.d.root.matrixWorld).invert().multiply(node.object.matrixWorld);
    return transformFromMatrix(_m);
  }

  widgetBindings(widget: string): InteractionBinding[] {
    return this.d.widgets.manifest(widget)?.interactions ?? [];
  }

  setEntityTransform(id: string, t: Transform, phase: GesturePhase): void {
    const node = this.d.reconciler.node(id);
    const entity = this.d.mirror.entity(id);
    if (!node || !entity || entity.locked) {
      // Removed or locked mid-gesture: the gesture is over for us.
      this.drop(id);
      return;
    }
    const local = this.toParentLocal(node.object, t);
    let g = this.gestures.get(id);
    if (!g || phase === 'start') {
      g = { group: randomId('grab-'), lastSent: -Infinity, pending: null, sent: false };
      this.gestures.set(id, g);
    }
    if (phase === 'end') {
      if (g.sent || !sameTransform(entity.transform, local)) this.send(id, local, g);
      this.gestures.delete(id);
      this.d.reconciler.endPreview(id, local);
      this.d.picker.invalidate(id);
      return;
    }
    this.d.reconciler.setPreview(id, local);
    g.pending = local;
    const t0 = now();
    if (phase === 'move' && t0 - g.lastSent >= this.moveInterval) this.send(id, local, g, t0);
  }

  /** Send due trailing move ops (call per frame). */
  flush(t = now()): void {
    for (const [id, g] of this.gestures) {
      const e = this.d.mirror.entity(id);
      if (!e || e.locked || !this.d.reconciler.node(id)) {
        this.drop(id); // removed (or locked) mid-gesture
        continue;
      }
      if (g.pending && t - g.lastSent >= this.moveInterval) this.send(id, g.pending, g, t);
    }
  }

  /** The entity was removed: drop its gesture state (no more ops for it). */
  forget(id: string): void {
    this.gestures.delete(id);
  }

  /** Entities with a gesture in progress (diagnostics, tests). */
  activeGestures(): string[] {
    return [...this.gestures.keys()];
  }

  /** End a gesture without sending anything; a still-present entity snaps back to its scene transform. */
  private drop(id: string): void {
    if (!this.gestures.delete(id)) return;
    this.d.reconciler.clearPreview(id);
  }

  private send(id: string, local: Transform, g: Gesture, t = now()): void {
    g.pending = null;
    g.lastSent = t;
    g.sent = true;
    this.d.net.send({ type: 'scene.ops', ops: [{ op: 'update', id, patch: { transform: local } }], source: 'user', group: g.group });
  }

  /** Space-coords transform → transform relative to the node's current parent frame. */
  private toParentLocal(obj: THREE.Object3D, t: Transform): Transform {
    const parent = obj.parent ?? this.d.root;
    this.d.root.updateWorldMatrix(true, false);
    parent.updateWorldMatrix(true, false);
    matrixFromTransform(t, _m);
    _m2.multiplyMatrices(this.d.root.matrixWorld, _m); // world
    _m3.copy(parent.matrixWorld).invert().multiply(_m2);
    return transformFromMatrix(_m3);
  }

  deliver(id: string, e: InteractionEvent): void {
    const content = this.d.widgets.contentOf(id);
    let localPoint = e.localPoint;
    if (content) {
      content.updateWorldMatrix(true, false);
      _v.set(e.point[0], e.point[1], e.point[2]).applyMatrix4(this.d.root.matrixWorld);
      content.worldToLocal(_v);
      localPoint = [_v.x, _v.y, _v.z];
    }
    this.d.widgets.deliverInteraction(id, { ...e, localPoint });
  }

  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void {
    if (this.d.runLocalCommand(name, args, phase)) return;
    // Server commands are one-shot: they run on the gesture's start.
    if (phase === 'start') this.d.net.send({ type: 'command', name, ...(args ? { args } : {}) });
  }

  publish(channel: string, value: unknown): void {
    this.d.channels.publish(channel, value);
  }

  poseEvent(e: PoseEvent): void {
    this.d.net.send({ type: 'pose.event', event: e });
  }

  hover(hand: Handedness, hit: Hit | null): void {
    this.d.pointer.setHover(hand, hit);
  }
}

function sameTransform(a: Transform, b: Transform): boolean {
  return nearlyEqualArrays(a.position, b.position, 1e-4)
    && nearlyEqualArrays(a.rotation, b.rotation, 1e-4)
    && nearlyEqualArrays(a.scale, b.scale, 1e-4);
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _v = new THREE.Vector3();
