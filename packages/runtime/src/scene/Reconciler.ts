// Turns SceneMirror diffs into a three.js scene graph: one Group per entity
// (name "entity:<id>", userData.entityId), parented by entity hierarchy, root
// entities parented to their anchor frame (space root / head / hand / lazy
// head-follow). Widget content is attached by the WidgetHost via hooks.
//
// Local transform previews (an entity being grabbed) override the server
// transform until the server echoes the final value (or a timeout passes),
// so the entity never snaps back mid-gesture.

import * as THREE from 'three';
import type { Entity, Transform } from '@evolspace/protocol';
import type { EntityChange, SceneDiff, SceneMirror } from './SceneMirror.ts';
import { AnchorRig, LazyFollower } from './anchors.ts';
import { applyTransform } from '../util/math.ts';
import { nearlyEqualArrays } from '../util/equal.ts';
import { now } from '../util/rate.ts';

export interface EntityNode {
  readonly id: string;
  readonly object: THREE.Group;
  follower: LazyFollower | null;
  /** True while the declared parent does not exist (attached to the space root meanwhile). */
  orphan: boolean;
}

export interface ReconcilerHooks {
  onAdded?(e: Entity, node: EntityNode): void;
  onRemoved?(id: string, node: EntityNode): void;
  onChanged?(e: Entity, change: EntityChange, node: EntityNode): void;
  onWarning?(message: string): void;
}

interface Preview {
  transform: Transform;
  /** Set when the gesture ended: drop the preview at this time if no echo came. */
  expiresAt: number | null;
}

export class Reconciler {
  readonly nodes = new Map<string, EntityNode>();
  readonly anchors: AnchorRig;
  private previews = new Map<string, Preview>();
  private followers = new Set<EntityNode>();

  constructor(readonly root: THREE.Group, private mirror: SceneMirror, private hooks: ReconcilerHooks = {}) {
    this.anchors = new AnchorRig(root);
  }

  node(id: string): EntityNode | undefined {
    return this.nodes.get(id);
  }

  apply(diff: SceneDiff): void {
    for (const w of diff.warnings) this.hooks.onWarning?.(w);

    for (const id of diff.removed) this.destroy(id);

    for (const id of diff.added) {
      const e = this.mirror.entity(id);
      if (!e) continue;
      this.create(e);
    }
    // Attach new nodes after all were created so batch order doesn't matter,
    // and adopt orphans whose parent just arrived.
    for (const id of diff.added) {
      const node = this.nodes.get(id);
      if (node) this.attach(node);
      for (const c of this.mirror.childrenOf(id)) {
        const cn = this.nodes.get(c);
        if (cn && cn.orphan) this.attach(cn);
      }
    }
    for (const id of diff.added) {
      const e = this.mirror.entity(id);
      const node = this.nodes.get(id);
      if (e && node) this.hooks.onAdded?.(e, node);
    }

    for (const [id, change] of diff.changed) {
      const e = this.mirror.entity(id);
      const node = this.nodes.get(id);
      if (!e || !node) continue;
      if (change.parent || change.anchor) this.attach(node);
      if (change.transform) this.syncTransform(e, node);
      if (change.visible) node.object.visible = e.visible;
      this.hooks.onChanged?.(e, change, node);
    }
  }

  /** Replace everything (used when the scene source switches). */
  clear(): void {
    for (const id of [...this.nodes.keys()]) this.destroy(id);
  }

  private create(e: Entity): EntityNode {
    const object = new THREE.Group();
    object.name = `entity:${e.id}`;
    object.userData.entityId = e.id;
    const node: EntityNode = { id: e.id, object, follower: null, orphan: false };
    applyTransform(object, e.transform);
    object.visible = e.visible;
    this.nodes.set(e.id, node);
    return node;
  }

  private destroy(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.hooks.onRemoved?.(id, node);
    node.object.removeFromParent();
    if (node.follower) {
      node.follower.frame.removeFromParent();
      this.followers.delete(node);
      node.follower = null;
    }
    this.previews.delete(id);
    this.nodes.delete(id);
  }

  /** (Re)parent a node according to its entity's parent / anchor. */
  private attach(node: EntityNode): void {
    const e = this.mirror.entity(node.id);
    if (!e) return;
    let target: THREE.Object3D = this.root;
    node.orphan = false;
    let wantsFollower = false;
    if (e.parent) {
      const pn = this.nodes.get(e.parent);
      if (pn) target = pn.object;
      else node.orphan = true;
    } else if (e.anchor) {
      const a = e.anchor;
      if (a.kind === 'head') {
        if (a.lazy) wantsFollower = true;
        else target = this.anchors.head;
      } else if (a.kind === 'hand') {
        target = this.anchors.handGroup(a.hand, a.joint);
      }
    }
    if (wantsFollower) {
      if (!node.follower) {
        node.follower = new LazyFollower();
        node.follower.frame.name = `anchor:lazy:${node.id}`;
        this.root.add(node.follower.frame);
        this.followers.add(node);
      }
      target = node.follower.frame;
    } else if (node.follower) {
      node.follower.frame.removeFromParent();
      this.followers.delete(node);
      node.follower = null;
    }
    if (node.object.parent !== target) target.add(node.object);
  }

  private syncTransform(e: Entity, node: EntityNode): void {
    const p = this.previews.get(e.id);
    if (p) {
      if (p.expiresAt !== null && transformsEqual(p.transform, e.transform)) {
        this.previews.delete(e.id); // the server caught up with our final value
      } else {
        return; // keep showing the local preview
      }
    }
    applyTransform(node.object, e.transform);
  }

  // ------------------------------------------------------------------ previews

  /** Show a local transform (entity-local, i.e. relative to its parent/anchor frame) during a gesture. */
  setPreview(id: string, t: Transform): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.previews.set(id, { transform: t, expiresAt: null });
    applyTransform(node.object, t);
  }

  /** Gesture ended with `t`: keep showing it until the server echoes it or `holdMs` pass. */
  endPreview(id: string, t: Transform, holdMs = 1500): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const e = this.mirror.entity(id);
    if (e && transformsEqual(e.transform, t)) {
      this.previews.delete(id);
      applyTransform(node.object, t);
      return;
    }
    this.previews.set(id, { transform: t, expiresAt: now() + holdMs });
    applyTransform(node.object, t);
  }

  /** Drop a local preview now and show the entity's scene transform. */
  clearPreview(id: string): void {
    if (!this.previews.delete(id)) return;
    const e = this.mirror.entity(id);
    const n = this.nodes.get(id);
    if (e && n) applyTransform(n.object, e.transform);
  }

  hasPreview(id: string): boolean {
    return this.previews.has(id);
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number, headPos: THREE.Vector3, headQuat: THREE.Quaternion, t = now()): void {
    this.anchors.update();
    if (this.previews.size) {
      for (const [id, p] of this.previews) {
        if (p.expiresAt !== null && t >= p.expiresAt) {
          this.previews.delete(id);
          const e = this.mirror.entity(id);
          const n = this.nodes.get(id);
          if (e && n) applyTransform(n.object, e.transform);
        }
      }
    }
    for (const node of this.followers) {
      const e = this.mirror.entity(node.id);
      if (!e || !node.follower) continue;
      _offset.set(e.transform.position[0], e.transform.position[1], e.transform.position[2]);
      node.follower.update(headPos, headQuat, _offset, dt);
    }
  }
}

function transformsEqual(a: Transform, b: Transform): boolean {
  return nearlyEqualArrays(a.position, b.position, 1e-5)
    && nearlyEqualArrays(a.rotation, b.rotation, 1e-5)
    && nearlyEqualArrays(a.scale, b.scale, 1e-5);
}

const _offset = new THREE.Vector3();
