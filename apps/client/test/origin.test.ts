import { describe, it, expect, beforeAll } from 'vitest';
import { SpaceOrigin, ANCHOR_STORAGE_KEY, type KeyValueStore } from '../src/xr/origin.ts';
import { quatFromYaw, yawOf, transformPoint, type Pose } from '../src/math/space.ts';

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

beforeAll(() => {
  // Minimal XRRigidTransform for createAnchor.
  (globalThis as Record<string, unknown>).XRRigidTransform = class {
    constructor(public position: DOMPointInit, public orientation: DOMPointInit) {}
  };
});

interface FakeAnchor { anchorSpace: { pose: Pose }; deleted: boolean; delete(): void; requestPersistentHandle(): Promise<string> }

function fakeAnchor(pose: Pose, handle: string): FakeAnchor {
  return {
    anchorSpace: { pose },
    deleted: false,
    delete() { this.deleted = true; },
    requestPersistentHandle: async () => handle,
  };
}

function fakeSession(opts: { anchors: boolean; restore?: (uuid: string) => Promise<FakeAnchor> }) {
  const deleted: string[] = [];
  return {
    deleted,
    session: {
      enabledFeatures: opts.anchors ? ['local-floor', 'anchors'] : ['local-floor'],
      restorePersistentAnchor: opts.restore,
      deletePersistentAnchor: async (u: string) => { deleted.push(u); },
    } as unknown as XRSession,
  };
}

function fakeFrame(created: FakeAnchor[], handle = 'new-handle') {
  return {
    createAnchor: (xf: { position: DOMPointInit; orientation: DOMPointInit }) => {
      const p = xf.position, q = xf.orientation;
      const a = fakeAnchor({ position: [p.x!, p.y!, p.z!], rotation: [q.x!, q.y!, q.z!, q.w!] }, handle);
      created.push(a);
      return Promise.resolve(a);
    },
    getPose: (space: { pose: Pose }) => ({
      transform: {
        position: { x: space.pose.position[0], y: space.pose.position[1], z: space.pose.position[2] },
        orientation: { x: space.pose.rotation[0], y: space.pose.rotation[1], z: space.pose.rotation[2], w: space.pose.rotation[3] },
      },
    }),
  } as unknown as XRFrame;
}

const ref = {} as XRReferenceSpace;
const flush = () => new Promise((r) => setTimeout(r, 0));
const head: Pose = { position: [1, 1.7, -2], rotation: quatFromYaw(0.5) };

describe('SpaceOrigin', () => {
  it('without anchors: local-floor identity, recalibrate moves it in memory', () => {
    const o = new SpaceOrigin(new MemStore());
    o.onSessionStart(fakeSession({ anchors: false }).session);
    expect(o.status).toBe('floor');
    o.update(fakeFrame([]), ref, head);
    expect(o.pose.position).toEqual([0, 0, 0]);
    o.recalibrate(head);
    expect(o.status).toBe('manual');
    expect(o.pose.position).toEqual([1, 0, -2]);
    expect(yawOf(o.pose.rotation)).toBeCloseTo(0.5, 6);
    // inverse is kept in sync
    const back = transformPoint(o.inverse, o.pose.position);
    back.forEach((v) => expect(v).toBeCloseTo(0, 9));
  });

  it('first anchored session: anchors at the feet and persists the handle', async () => {
    const store = new MemStore();
    const o = new SpaceOrigin(store);
    o.onSessionStart(fakeSession({ anchors: true }).session);
    expect(o.status).toBe('anchoring');
    const created: FakeAnchor[] = [];
    o.update(fakeFrame(created), ref, head);
    await flush();
    expect(created).toHaveLength(1);
    expect(o.status).toBe('anchored');
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBe('new-handle');
    // follows the anchor pose
    created[0].anchorSpace.pose = { position: [1.01, 0, -2], rotation: quatFromYaw(0.5) };
    o.update(fakeFrame(created), ref, head);
    expect(o.pose.position[0]).toBeCloseTo(1.01, 6);
  });

  it('restores a persisted anchor', async () => {
    const store = new MemStore();
    store.setItem(ANCHOR_STORAGE_KEY, 'saved');
    const restored = fakeAnchor({ position: [5, 0, 5], rotation: quatFromYaw(1) }, 'saved');
    const o = new SpaceOrigin(store);
    o.onSessionStart(fakeSession({ anchors: true, restore: async (u) => { expect(u).toBe('saved'); return restored; } }).session);
    expect(o.status).toBe('restoring');
    await flush();
    o.update(fakeFrame([]), ref, head);
    expect(o.status).toBe('anchored');
    expect(o.pose.position).toEqual([5, 0, 5]);
  });

  it('falls back to re-anchoring when restore fails', async () => {
    const store = new MemStore();
    store.setItem(ANCHOR_STORAGE_KEY, 'stale');
    const o = new SpaceOrigin(store);
    o.onSessionStart(fakeSession({ anchors: true, restore: async () => { throw new Error('not found'); } }).session);
    await flush();
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBeNull();
    const created: FakeAnchor[] = [];
    o.update(fakeFrame(created, 'fresh'), ref, head);
    await flush();
    expect(created).toHaveLength(1);
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBe('fresh');
  });

  it('recalibrate re-anchors, deletes the old anchor and the old persistent handle', async () => {
    const store = new MemStore();
    const o = new SpaceOrigin(store);
    const s = fakeSession({ anchors: true });
    o.onSessionStart(s.session);
    const created: FakeAnchor[] = [];
    o.update(fakeFrame(created, 'h1'), ref, head);
    await flush();
    o.recalibrate({ position: [3, 1.6, 3], rotation: quatFromYaw(-1) });
    o.update(fakeFrame(created, 'h2'), ref, head);
    await flush();
    expect(created).toHaveLength(2);
    expect(created[0].deleted).toBe(true);
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBe('h2');
    expect(s.deleted).toEqual(['h1']);
    expect(o.pose.position).toEqual([3, 0, 3]);
    o.update(fakeFrame(created, 'h3'), ref, head); // now follows the new anchor
    expect(o.pose.position).toEqual([3, 0, 3]);
  });

  it('a slow restore that resolves after a recalibration does not pull the origin back', async () => {
    const store = new MemStore();
    store.setItem(ANCHOR_STORAGE_KEY, 'saved');
    const restored = fakeAnchor({ position: [5, 0, 5], rotation: quatFromYaw(1) }, 'saved');
    let resolveRestore!: (a: FakeAnchor) => void;
    const o = new SpaceOrigin(store);
    const s = fakeSession({ anchors: true, restore: () => new Promise((r) => { resolveRestore = r; }) });
    o.onSessionStart(s.session);
    expect(o.status).toBe('restoring');
    // The user recalibrates while the headset is still localizing the saved anchor.
    o.recalibrate({ position: [2, 1.6, 2], rotation: quatFromYaw(0) });
    const created: FakeAnchor[] = [];
    o.update(fakeFrame(created, 'recal'), ref, head);
    await flush();
    expect(o.status).toBe('anchored');
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBe('recal');
    expect(s.deleted).toEqual(['saved']); // the superseded persistent anchor is cleaned up
    // Now the stale restore finally resolves: it must be discarded.
    resolveRestore(restored);
    await flush();
    expect(restored.deleted).toBe(true);
    o.update(fakeFrame(created), ref, head);
    expect(o.pose.position).toEqual([2, 0, 2]);
    expect(created[0].deleted).toBe(false);
  });

  it('a slow anchor creation superseded by a newer recalibration is discarded', async () => {
    const store = new MemStore();
    const o = new SpaceOrigin(store);
    o.onSessionStart(fakeSession({ anchors: true }).session);
    const resolvers: Array<() => void> = [];
    const anchors: FakeAnchor[] = [];
    const slowFrame = (handle: string) => ({
      ...(fakeFrame([]) as unknown as Record<string, unknown>),
      createAnchor: (xf: { position: DOMPointInit; orientation: DOMPointInit }) => {
        const p = xf.position, q = xf.orientation;
        const a = fakeAnchor({ position: [p.x!, p.y!, p.z!], rotation: [q.x!, q.y!, q.z!, q.w!] }, handle);
        anchors.push(a);
        return new Promise<FakeAnchor>((r) => resolvers.push(() => r(a)));
      },
    }) as unknown as XRFrame;
    o.update(slowFrame('first'), ref, head); // initial anchor (from head) — slow
    o.recalibrate({ position: [4, 1.6, 4], rotation: quatFromYaw(0) });
    o.update(slowFrame('second'), ref, head);
    resolvers[1](); // newer resolves first
    await flush();
    resolvers[0](); // stale one resolves last
    await flush();
    expect(anchors[0].deleted).toBe(true);
    expect(anchors[1].deleted).toBe(false);
    expect(store.getItem(ANCHOR_STORAGE_KEY)).toBe('second');
    o.update(slowFrame('x'), ref, head);
    expect(o.pose.position).toEqual([4, 0, 4]);
  });

  it('ignores anchor results from an ended session', async () => {
    const o = new SpaceOrigin(new MemStore());
    o.onSessionStart(fakeSession({ anchors: true }).session);
    const created: FakeAnchor[] = [];
    o.update(fakeFrame(created), ref, head);
    o.onSessionEnd();
    await flush();
    expect(created[0].deleted).toBe(true);
    expect(o.status).not.toBe('anchored');
  });
});
