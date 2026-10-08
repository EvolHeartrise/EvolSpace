import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HAND_JOINTS, type HandFrame } from '@evolspace/protocol';
import { SceneMirror } from '../src/scene/SceneMirror.ts';
import { Reconciler } from '../src/scene/Reconciler.ts';
import { entity } from './helpers.ts';

function setup() {
  const root = new THREE.Group();
  const mirror = new SceneMirror();
  const events: string[] = [];
  const rec = new Reconciler(root, mirror, {
    onAdded: (e) => events.push(`+${e.id}`),
    onRemoved: (id) => events.push(`-${id}`),
    onChanged: (e, c) => events.push(`~${e.id}:${Object.keys(c).join(',')}`),
  });
  const apply = (ops: Parameters<SceneMirror['applyOps']>[0]) => rec.apply(mirror.applyOps(ops));
  return { root, mirror, rec, events, apply };
}

const head = new THREE.Vector3(0, 1.6, 0);
const ident = new THREE.Quaternion();

describe('Reconciler', () => {
  it('builds a group per entity with transforms and parent hierarchy, regardless of op order', () => {
    const { root, rec, apply, events } = setup();
    apply([
      { op: 'add', entity: { id: 'c', widget: 'box', parent: 'p', transform: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
      { op: 'add', entity: { id: 'p', widget: 'panel', transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2] } } },
    ]);
    const p = rec.node('p')!.object;
    const c = rec.node('c')!.object;
    expect(p.parent).toBe(root);
    expect(c.parent).toBe(p);
    expect(p.name).toBe('entity:p');
    expect(p.userData.entityId).toBe('p');
    expect(p.position.toArray()).toEqual([1, 2, 3]);
    root.updateMatrixWorld(true);
    const w = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    expect(w.toArray().map((x) => +x.toFixed(5))).toEqual([1, 2.2, 3]);
    expect(events.sort()).toEqual(['+c', '+p']);
  });

  it('adopts orphans when the parent arrives later', () => {
    const { root, rec, apply } = setup();
    apply([{ op: 'add', entity: { id: 'c', widget: 'box', parent: 'p' } }]);
    expect(rec.node('c')!.orphan).toBe(true);
    expect(rec.node('c')!.object.parent).toBe(root);
    apply([{ op: 'add', entity: { id: 'p', widget: 'panel' } }]);
    expect(rec.node('c')!.orphan).toBe(false);
    expect(rec.node('c')!.object.parent).toBe(rec.node('p')!.object);
  });

  it('reparents, updates visibility, and removes subtrees', () => {
    const { root, rec, apply, events } = setup();
    apply([
      { op: 'add', entity: { id: 'a', widget: 'x' } },
      { op: 'add', entity: { id: 'b', widget: 'x' } },
      { op: 'add', entity: { id: 'c', widget: 'x', parent: 'a' } },
    ]);
    apply([{ op: 'update', id: 'c', patch: { parent: 'b', visible: false } }]);
    expect(rec.node('c')!.object.parent).toBe(rec.node('b')!.object);
    expect(rec.node('c')!.object.visible).toBe(false);
    events.length = 0;
    apply([{ op: 'remove', id: 'b' }]);
    expect(rec.node('b')).toBeUndefined();
    expect(rec.node('c')).toBeUndefined();
    expect(events.sort()).toEqual(['-b', '-c']);
    expect(root.children.filter((o) => o.name.startsWith('entity:')).map((o) => o.name)).toEqual(['entity:a']);
  });

  it('reflects snapshots after reconnect without recreating unchanged entities', () => {
    const { mirror, rec } = setup();
    rec.apply(mirror.applySnapshot({ version: 1, workspace: 'w', links: {}, entities: { a: entity('a', 'x'), b: entity('b', 'x') } }));
    const a = rec.node('a')!.object;
    rec.apply(mirror.applySnapshot({ version: 9, workspace: 'w', links: {}, entities: { a: entity('a', 'x', { transform: { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }) } }));
    expect(rec.node('a')!.object).toBe(a);
    expect(a.position.x).toBe(5);
    expect(rec.node('b')).toBeUndefined();
  });

  it('anchors: head, hand (hidden while untracked), lazy head-follow', () => {
    const { rec, apply } = setup();
    apply([
      { op: 'add', entity: { id: 'h', widget: 'x', anchor: { kind: 'head' } } },
      { op: 'add', entity: { id: 'w', widget: 'x', anchor: { kind: 'hand', hand: 'left' } } },
      { op: 'add', entity: { id: 'j', widget: 'x', anchor: { kind: 'hand', hand: 'right', joint: 'index-finger-tip' } } },
      { op: 'add', entity: { id: 'l', widget: 'x', anchor: { kind: 'head', lazy: true }, transform: { position: [0, 0, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
    ]);
    expect(rec.node('h')!.object.parent).toBe(rec.anchors.head);
    const leftFrame = rec.node('w')!.object.parent!;
    expect(leftFrame.name).toBe('anchor:left:wrist');
    rec.update(0.016, head, ident);
    expect(leftFrame.visible).toBe(false);
    rec.anchors.setHandPose('left', { position: [0.2, 1, -0.3], rotation: [0, 0, 0, 1], tracked: true });
    rec.update(0.016, head, ident);
    expect(leftFrame.visible).toBe(true);
    expect(leftFrame.position.toArray()).toEqual([0.2, 1, -0.3]);

    // Joint anchor from a full hand frame.
    const joints = new Array(HAND_JOINTS.length * 7).fill(0);
    const tip = HAND_JOINTS.indexOf('index-finger-tip');
    joints.splice(tip * 7, 7, 0.1, 1.2, -0.4, 0, 0, 0, 1);
    const frame: HandFrame = { hand: 'right', joints, radii: new Array(25).fill(0.01) };
    rec.anchors.setHandFrame('right', frame);
    rec.update(0.016, head, ident);
    expect(rec.node('j')!.object.parent!.position.toArray()).toEqual([0.1, 1.2, -0.4]);

    // Lazy follow: snaps on first update, then stays until the content leaves the view.
    const lazy = rec.node('l')!;
    expect(lazy.follower).not.toBeNull();
    const frameObj = lazy.follower!.frame;
    rec.update(0.016, head, ident);
    expect(frameObj.position.toArray()).toEqual([0, 1.6, 0]);
    // Small head turn (10°): no re-centering.
    const small = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(10));
    rec.update(0.1, head, small);
    expect(frameObj.quaternion.angleTo(ident)).toBeCloseTo(0, 5);
    // Big turn (90°): glides toward the new yaw over time.
    const big = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    for (let i = 0; i < 120; i++) rec.update(1 / 60, head, big);
    expect(frameObj.quaternion.angleTo(big)).toBeLessThan(0.05);
  });

  it('local previews win over server transforms until the echo arrives', () => {
    const { rec, apply, mirror } = setup();
    apply([{ op: 'add', entity: { id: 'a', widget: 'x' } }]);
    const t1 = { position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
    const t2 = { ...t1, position: [2, 0, 0] as [number, number, number] };
    rec.setPreview('a', t1);
    expect(rec.node('a')!.object.position.x).toBe(1);
    rec.endPreview('a', t2, 10_000);
    // Stale echo of an intermediate value: ignored for display.
    rec.apply(mirror.applyOps([{ op: 'update', id: 'a', patch: { transform: t1 } }]));
    expect(rec.node('a')!.object.position.x).toBe(2);
    // Final echo: preview released.
    rec.apply(mirror.applyOps([{ op: 'update', id: 'a', patch: { transform: t2 } }]));
    expect(rec.hasPreview('a')).toBe(false);
    // Later server moves apply normally.
    rec.apply(mirror.applyOps([{ op: 'update', id: 'a', patch: { transform: { position: [3, 0, 0] } } }]));
    expect(rec.node('a')!.object.position.x).toBe(3);
  });

  it('previews expire if no echo arrives', () => {
    const { rec, apply } = setup();
    apply([{ op: 'add', entity: { id: 'a', widget: 'x' } }]);
    rec.endPreview('a', { position: [9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 100);
    expect(rec.node('a')!.object.position.x).toBe(9);
    rec.update(0.016, head, ident, performance.now() + 1000);
    expect(rec.node('a')!.object.position.x).toBe(0);
  });
});
