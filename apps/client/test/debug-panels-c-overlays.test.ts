// @vitest-environment happy-dom
// View panel overlays: every overlay's create → update → dispose leaves the
// scene graph and the viewport DOM exactly as before and disposes every GPU
// resource it created (no leaks), never adds anything under entity nodes, and
// releases the userPose poll; wireframe mode restores materials exactly.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import type { Entity, Link, UserPose } from '@evolspace/protocol';
import { synthHand } from '@evolspace/input';
import { DEFAULT_THEME } from '@evolspace/runtime';
import type { DebugContext } from '../src/debug/types.ts';
import { OVERLAYS } from '../src/debug/overlays-impl/index.ts';
import { WireframeMode, wireframeOverlay } from '../src/debug/overlays-impl/wireframe.ts';

const ent = (id: string, widget: string, pos: [number, number, number]): Entity => ({
  id, widget, parent: null, props: {}, transform: { position: pos, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, name: `${widget} ${id}`,
});

function fakeCtx() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.set(0.5, 0, -0.2); // space origin offset
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
  scene.add(root);
  const entities: Record<string, Entity> = { a: ent('a', 'box', [0, 1.2, -1]), b: ent('b', 'slider', [0.4, 1.2, -1]), g: ent('g', 'group', [0, 1, -2]) };
  const links: Record<string, Link> = {
    l1: { id: 'l1', from: { kind: 'port', entity: 'b', port: 'value' }, to: { kind: 'port', entity: 'a', port: 'scale' }, enabled: true },
    l2: { id: 'l2', from: { kind: 'channel', channel: 'demo.x' }, to: { kind: 'port', entity: 'a', port: 'scale' }, enabled: false },
  };
  const nodes: Record<string, THREE.Object3D> = {};
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), new THREE.MeshBasicMaterial());
  knob.name = 'knob';
  const sharedMat = new THREE.MeshBasicMaterial({ color: 'red' });
  for (const e of Object.values(entities)) {
    const node = new THREE.Group();
    node.name = `entity:${e.id}`;
    node.position.fromArray(e.transform.position);
    if (e.widget !== 'group') {
      const content = new THREE.Group();
      content.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), e.id === 'a' ? sharedMat : new THREE.MeshBasicMaterial({ wireframe: true })));
      content.add(new THREE.Mesh(new THREE.SphereGeometry(0.05), sharedMat));
      if (e.id === 'b') content.add(knob);
      node.add(content);
    }
    root.add(node);
    nodes[e.id] = node;
  }
  root.updateWorldMatrix(true, true);
  let outValue = 0.1;
  const runtime = {
    root, theme: DEFAULT_THEME,
    sceneState: { version: 1, workspace: 'w', entities, links },
    entityObject: (id: string) => nodes[id],
    entity: (id: string) => entities[id],
    picker: { localBounds: (id: string) => (entities[id].widget === 'group' ? null : new THREE.Box3(new THREE.Vector3(-0.1, -0.1, -0.1), new THREE.Vector3(0.1, 0.1, 0.1))) },
    frameEntity: (id: string) => new THREE.Box3().setFromObject(nodes[id]),
    widgets: { interactivesOf: (id: string) => (id === 'b' ? new Set([knob]) : undefined), inputValue: () => outValue, contentOf: (id: string) => nodes[id].children[0] ?? null },
    links: { lastOutput: () => outValue },
    environment: { grid: true },
  };
  const right = synthHand({ hand: 'right', pinch: 'index', position: [0.2, 1.2, -0.4] });
  const engine = {
    rays: () => ({ right: { origin: [0.2, 1.25, -0.4], direction: [0, 0, -1], hit: { entity: 'b', point: [0.4, 1.2, -0.9], distance: 0.5, interactive: true, object: 'knob' } } }),
    activePoses: (h: string) => (h === 'right' ? ['pinch'] : []),
  };
  const pose: UserPose = {
    t: Date.now(), mode: 'vr', head: { position: [0, 1.6, 0.5], rotation: [0, 0, 0, 1] }, fov: 90, aspect: 1.1,
    hands: { left: synthHand({ hand: 'left', position: [-0.2, 1.2, 0.1] }), right: synthHand({ hand: 'right', pinch: 'index', position: [0.2, 1.2, 0.1] }) },
    focus: { right: { entity: 'a', point: [0, 1.2, -1] } }, gaze: { entity: 'a', point: [0, 1.25, -0.9] },
  };
  const releases: number[] = [];
  const need = vi.fn(() => { let done = false; return () => { if (!done) { done = true; releases.push(1); } }; });
  const viewport = document.createElement('div');
  const canvas = document.createElement('canvas');
  viewport.appendChild(canvas);
  document.body.appendChild(viewport);
  const camera = new THREE.PerspectiveCamera(70, 1.5, 0.02, 300);
  camera.position.set(0, 1.6, 1);
  camera.updateMatrixWorld();
  const ctx = {
    THREE, scene, camera, runtime, engine,
    renderer: { domElement: canvas },
    client: { hands: { right } },
    store: { selection: signal<string | null>('a'), userPose: signal<UserPose | null>(pose), need },
  } as unknown as DebugContext;
  return { ctx, scene, viewport, need, releases, sharedMat, setOut: (v: number) => { outValue = v; } };
}

function graph(o: THREE.Object3D): string[] {
  const out: string[] = [];
  o.traverse((c) => out.push(`${c.uuid}:${c.children.length}`));
  return out;
}

describe('overlays', () => {
  it('registers the expected overlays', () => {
    expect(OVERLAYS.map((o) => o.id)).toEqual(['bounds', 'labels', 'axes', 'interactive', 'rays', 'links', 'avatar', 'wireframe']);
  });

  for (const def of OVERLAYS) {
    it(`${def.id}: create/update/dispose leaves the scene graph and DOM unchanged and frees its resources`, () => {
      const f = fakeCtx();
      const before = graph(f.scene);
      const domBefore = f.viewport.innerHTML;
      const nodeKids = ['a', 'b', 'g'].map((id) => f.ctx.runtime.entityObject(id)!.children.length);
      const inst = def.create(f.ctx);
      for (let i = 0; i < 3; i++) { f.setOut(i); inst.update?.(1 / 60, i * 16); }
      // Overlay objects are never under entity nodes.
      expect(['a', 'b', 'g'].map((id) => f.ctx.runtime.entityObject(id)!.children.length)).toEqual(nodeKids);
      // Collect what the overlay added, to check disposal.
      const added: THREE.Object3D[] = [];
      f.scene.traverse((o) => { if (o.userData.debugOverlay || o.name.startsWith('debug-overlay') || o.name.startsWith('avatar-hand')) added.push(o); });
      const disposed = new Set<unknown>();
      const resources = new Set<THREE.BufferGeometry | THREE.Material>();
      for (const top of added) top.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) resources.add(m.geometry);
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const x of mats) resources.add(x);
      });
      for (const r of resources) r.addEventListener('dispose', () => disposed.add(r));
      if (def.id !== 'wireframe' && def.id !== 'labels') expect(added.length).toBeGreaterThan(0);
      for (const o of added) expect(typeof o.raycast).toBe('function');
      inst.dispose();
      expect(graph(f.scene)).toEqual(before);
      expect(f.viewport.innerHTML).toBe(domBefore);
      expect([...resources].filter((r) => !disposed.has(r))).toEqual([]);
      if (def.id === 'avatar') { expect(f.need).toHaveBeenCalledWith('userPose'); expect(f.releases).toHaveLength(1); }
    });
  }

  it('overlay lines are never hit by a raycast', () => {
    const f = fakeCtx();
    const inst = OVERLAYS.find((o) => o.id === 'bounds')!.create(f.ctx);
    inst.update?.(1 / 60, 0);
    const rc = new THREE.Raycaster(new THREE.Vector3(0.5, 1.2, 2), new THREE.Vector3(0, 0, -1));
    rc.params.Line = { threshold: 1 };
    const hits = rc.intersectObjects(f.scene.children, true).filter((h) => h.object.userData.debugOverlay);
    expect(hits).toEqual([]);
    inst.dispose();
  });

  it('labels: one DOM label per entity, selected highlighted, removed on dispose', () => {
    const f = fakeCtx();
    const inst = OVERLAYS.find((o) => o.id === 'labels')!.create(f.ctx);
    inst.update?.(1 / 60, 0);
    const labels = [...f.viewport.querySelectorAll('.vw-label')];
    expect(labels).toHaveLength(3);
    expect(labels.filter((l) => l.classList.contains('sel'))).toHaveLength(1);
    expect(labels.map((l) => l.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('box a')]));
    inst.dispose();
    expect(f.viewport.querySelectorAll('.vw-label')).toHaveLength(0);
  });
});

describe('wireframe mode', () => {
  it('turns every mesh material to wireframe and restores the exact originals (shared + pre-wireframe materials)', () => {
    const f = fakeCtx();
    const mats = new Map<THREE.Material, boolean>();
    f.ctx.runtime.root.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m) mats.set(m, m.wireframe); });
    expect([...mats.values()]).toContain(true); // one pre-existing wireframe material
    const inst = wireframeOverlay.create(f.ctx);
    for (const m of mats.keys()) expect((m as THREE.MeshBasicMaterial).wireframe).toBe(true);
    // A widget created later is picked up by the periodic re-scan.
    const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    f.ctx.runtime.entityObject('a')!.add(late);
    inst.update?.(0.6, 600);
    expect((late.material as THREE.MeshBasicMaterial).wireframe).toBe(true);
    inst.dispose();
    for (const [m, was] of mats) expect((m as THREE.MeshBasicMaterial).wireframe).toBe(was);
    expect((late.material as THREE.MeshBasicMaterial).wireframe).toBe(false);
  });

  it('skips troika text and debug overlay objects; scan is idempotent', () => {
    const root = new THREE.Group();
    const text = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()) as THREE.Mesh & { isTroikaText?: boolean };
    text.isTroikaText = true;
    const dbg = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    dbg.userData.debugOverlay = true;
    const plain = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    root.add(text, dbg, plain);
    const w = new WireframeMode(root);
    expect(w.scan()).toBe(1);
    expect(w.scan()).toBe(0);
    expect((text.material as THREE.MeshBasicMaterial).wireframe).toBe(false);
    expect((dbg.material as THREE.MeshBasicMaterial).wireframe).toBe(false);
    w.restore();
    expect((plain.material as THREE.MeshBasicMaterial).wireframe).toBe(false);
  });
});
