// View panel camera math (follow headset, FOV fit, letterbox, ScreenshotView
// JSON) + the Hands workbench driver (sim ownership, mouse passthrough, hold /
// latch, frozen entity placement) and binding explainer.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Entity, HandFrame, Handedness, InteractionSet } from '@evolspace/protocol';
import { synthHand, rayAnchor, contactPoint, computeFeatures, matchesPose } from '@evolspace/input';
import { cameraView, fitFov, followStep, headsetFrameRect, headsetWorldPose, smoothK } from '../src/debug/panels/view/camera.ts';
import { HandSimDriver, patchSim, simHeld, simState, type DriverClient } from '../src/debug/panels/hands/driver.ts';
import { explainPose } from '../src/debug/panels/hands/explain.ts';
import { RELAXED_SHAPE, cloneShape, solvePose } from '../src/debug/panels/hands/solver.ts';

describe('follow-headset camera math', () => {
  it('maps the headset head pose through the space root (position + rotation)', () => {
    const root = new THREE.Object3D();
    root.position.set(1, 0, -2);
    root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    root.updateMatrixWorld();
    const headQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.2);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    headsetWorldPose({ head: { position: [0, 1.6, -1], rotation: [headQ.x, headQ.y, headQ.z, headQ.w] } }, root.matrixWorld, p, q);
    // Space (0,1.6,-1) rotated 90° about Y → (-1,1.6,0), + (1,0,-2) → (0,1.6,-2)
    expect(p.x).toBeCloseTo(0); expect(p.y).toBeCloseTo(1.6); expect(p.z).toBeCloseTo(-2);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    // Head looked along -Z (pitched down) in space → along -X in world.
    expect(fwd.x).toBeLessThan(-0.9);
    expect(fwd.y).toBeCloseTo(-Math.sin(0.2), 3);
  });

  it('fits the FOV so the whole headset view is visible', () => {
    expect(fitFov(90, 1, 1.6)).toBeCloseTo(90); // wider viewport: same vertical FOV
    const v = fitFov(90, 1, 0.5); // narrower: larger vertical FOV so the sides fit
    expect(v).toBeGreaterThan(90);
    const hHalf = Math.atan(Math.tan((v * Math.PI) / 360) * 0.5);
    expect((hHalf * 360) / Math.PI).toBeCloseTo(90, 3); // horizontal FOV = headset's
    const r = headsetFrameRect(90, 1, 90, 1600, 900);
    expect(r.h).toBeCloseTo(900); expect(r.w).toBeCloseTo(900); expect(r.x).toBeCloseTo(350);
    const r2 = headsetFrameRect(60, 1.2, 90, 1000, 1000);
    expect(r2.h).toBeCloseTo(1000 * Math.tan(Math.PI / 6));
  });

  it('smooths exponentially (frame-rate independent) and converges', () => {
    expect(smoothK(0.1, 0.1)).toBeCloseTo(0.5);
    expect(smoothK(0.016, 0)).toBe(1);
    // Two half steps = one full step.
    const a = 1 - (1 - smoothK(0.05, 0.12)) ** 2;
    expect(a).toBeCloseTo(smoothK(0.1, 0.12));
    const cur = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    const target = { p: new THREE.Vector3(1, 2, 3), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1) };
    for (let i = 0; i < 120; i++) followStep(cur, target, 1 / 60, 0.12);
    expect(cur.p.distanceTo(target.p)).toBeLessThan(1e-3);
    expect(cur.q.angleTo(target.q)).toBeLessThan(1e-3);
  });

  it('copies the camera as a ScreenshotView in space coordinates', () => {
    const root = new THREE.Object3D();
    root.position.set(0, 0, -1);
    root.updateMatrixWorld();
    const cam = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    cam.position.set(0.5, 1.5, 1);
    cam.lookAt(0.5, 1.5, 0);
    const v = cameraView(cam, root);
    expect(v).toMatchObject({ kind: 'camera', position: [0.5, 1.5, 2], fov: 55 });
    expect(v.rotation![3]).toBeCloseTo(1);
  });
});

// ------------------------------------------------------------------ driver

function fakeClient(deskHand: HandFrame | null) {
  let frames: Partial<Record<Handedness, HandFrame>> | null = null;
  const hooks: Array<() => void> = [];
  const client: DriverClient & { desk: { hand(): HandFrame | null; pinching: boolean } } = {
    sim: { get: () => frames, setHands: (h) => { frames = { ...h }; return frames; }, clearHands: () => { frames = null; } },
    desktop: null as unknown as DriverClient['desktop'],
    desk: { hand: () => deskHand, pinching: false },
    head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] },
    onFrame: (cb) => { hooks.push(() => cb(1 / 60, 0)); return () => {}; },
  };
  (client as { desktop: unknown }).desktop = client.desk;
  return { client, tick: () => hooks.forEach((h) => h()), frames: () => frames };
}

afterEach(() => {
  for (const h of ['left', 'right'] as const) {
    patchSim(h, { enabled: false, latched: false, placement: h === 'right' ? 'cursor' : 'camera', offset: [0, 0, 0], shape: cloneShape(RELAXED_SHAPE), mode: h === 'left' ? 'hold' : 'latch' });
    simHeld[h].value = false;
  }
});

const POSE_PTT = { id: 'pinch-middle', description: '', hand: 'either' as const, source: 'builtin' as const, conditions: [{ feature: 'pinch.middle', max: 0.025 }, { feature: 'pinch.index', min: 0.03 }] };

describe('hand sim driver', () => {
  it('owns client.sim only while a hand is simulated; keeps the mouse hand; hold applies the pose', () => {
    const desk = synthHand({ hand: 'right', position: [0.2, 1.3, -0.5] });
    const f = fakeClient(desk);
    const d = new HandSimDriver({ client: f.client, entityTarget: () => null });
    f.tick();
    expect(f.frames()).toBeNull(); // nothing simulated: real input untouched
    const r = solvePose(POSE_PTT, 'left');
    patchSim('left', { enabled: true, shape: r.shape, preset: 'pinch-middle', mode: 'hold' });
    f.tick();
    expect(Object.keys(f.frames()!).sort()).toEqual(['left', 'right']);
    expect(f.frames()!.right).toEqual(desk); // mouse hand passes through
    const head = f.client.head;
    expect(matchesPose(POSE_PTT, computeFeatures(f.frames()!.left!, head))).toBe(false); // rest pose
    simHeld.left.value = true;
    f.tick();
    expect(matchesPose(POSE_PTT, computeFeatures(f.frames()!.left!, head))).toBe(true);
    simHeld.left.value = false;
    f.tick();
    expect(matchesPose(POSE_PTT, computeFeatures(f.frames()!.left!, head))).toBe(false);
    patchSim('left', { enabled: false });
    f.tick();
    expect(f.frames()).toBeNull(); // released
    d.dispose();
  });

  it('cursor placement keeps the mouse ray anchor and orientation; LMB pinch passes through when not applied', () => {
    const desk = synthHand({ hand: 'right', position: [0.25, 1.3, -0.5], rotation: [0, 0.2, 0, 0.98] });
    const f = fakeClient(desk);
    const d = new HandSimDriver({ client: f.client, entityTarget: () => null });
    patchSim('right', { enabled: true, placement: 'cursor', mode: 'latch', latched: true, shape: solvePose({ ...POSE_PTT, id: 'p', conditions: [{ feature: 'pinch.index', max: 0.025 }] }, 'right').shape });
    f.tick();
    const fr = f.frames()!.right!;
    const a = rayAnchor(fr), b = rayAnchor(desk);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-6);
    patchSim('right', { latched: false });
    f.client.desk.pinching = true;
    f.tick();
    expect(f.frames()!.right).toEqual(desk);
    d.dispose();
  });

  it('entity placement puts the contact point on the target and freezes it while applied', () => {
    const f = fakeClient(null);
    let target: [number, number, number] = [0, 1.2, -1];
    const d = new HandSimDriver({ client: f.client, entityTarget: () => ({ point: target, center: [target[0], target[1], target[2] - 0.1] }) });
    patchSim('right', { enabled: true, placement: 'entity', mode: 'latch', latched: false });
    f.tick();
    let c = contactPoint(f.frames()!.right!);
    expect(c[2]).toBeCloseTo(-1, 5);
    patchSim('right', { latched: true });
    f.tick();
    target = [0, 1.2, -0.5]; // the grabbed entity moved: the hand must not chase it
    f.tick();
    c = contactPoint(f.frames()!.right!);
    expect(c[2]).toBeCloseTo(-1, 2);
    patchSim('right', { latched: false });
    f.tick();
    c = contactPoint(f.frames()!.right!);
    expect(c[2]).toBeCloseTo(-0.5, 5);
    d.dispose();
    expect(simState.right.value.enabled).toBe(true);
  });
});

// ------------------------------------------------------------------ explain

describe('binding explainer', () => {
  const sets: Record<string, InteractionSet> = {
    standard: { description: '', scope: 'entity-default', bindings: [
      { id: 'press', pose: 'pinch', hand: 'either', target: 'near', action: { type: 'widget', handler: 'press' }, priority: 10 },
      { id: 'grab', pose: 'pinch', hand: 'either', target: 'near', action: { type: 'grab' } },
      { id: 'scale', pose: 'pinch', hand: 'both', target: 'near', action: { type: 'scale' }, priority: 20 },
    ] },
    global: { description: '', scope: 'global', bindings: [
      { id: 'ptt', pose: 'pinch-middle', hand: 'left', target: 'none', action: { type: 'command', command: 'voice.ptt' } },
      { id: 'select', pose: 'pinch-middle', hand: 'right', target: 'ray', action: { type: 'command', command: 'select' } },
    ] },
  };
  const ents: Record<string, Entity> = {
    box: { id: 'box', widget: 'box', parent: null, props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true },
    own: { id: 'own', widget: 'box', parent: null, props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true,
      interactions: [{ id: 'own-undo', pose: 'pinch', target: 'none', action: { type: 'command', command: 'undo' } }] },
    lockd: { id: 'lockd', widget: 'box', parent: null, props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, locked: true },
  };
  const base = { getEntity: (id: string) => ents[id], widgetBindings: () => [], sets, poseActive: () => false, sessions: [] };

  it('resolves entity > entity-default > global with priorities and target rules', () => {
    expect(explainPose({ ...base, hand: 'right', pose: 'pinch', rayHit: { entity: 'box', interactive: false }, touchHit: null }).winner?.binding.id).toBe('grab');
    expect(explainPose({ ...base, hand: 'right', pose: 'pinch', rayHit: { entity: 'box', interactive: true }, touchHit: null }).winner?.binding.id).toBe('press');
    expect(explainPose({ ...base, hand: 'right', pose: 'pinch', rayHit: null, touchHit: { entity: 'own', interactive: false } }).winner).toMatchObject({ scope: 'entity', binding: { id: 'own-undo' } });
    const locked = explainPose({ ...base, hand: 'right', pose: 'pinch', rayHit: { entity: 'lockd', interactive: false }, touchHit: null });
    expect(locked.winner).toBeNull();
    expect(locked.considered.find((c) => c.binding.id === 'grab')?.reason).toBe('entity locked');
    expect(explainPose({ ...base, hand: 'left', pose: 'pinch-middle', rayHit: null, touchHit: null }).winner?.binding.id).toBe('ptt');
    expect(explainPose({ ...base, hand: 'right', pose: 'pinch-middle', rayHit: null, touchHit: null }).winner?.binding.id).toBe('select');
  });

  it('scale needs the other hand grabbing the target', () => {
    const sessions = [{ hand: 'left' as const, pose: 'pinch', binding: 'grab', action: 'grab', target: 'box', mode: 'grab' as const }];
    const r = explainPose({ ...base, sessions, poseActive: () => true, hand: 'right', pose: 'pinch', rayHit: { entity: 'box', interactive: false }, touchHit: null });
    expect(r.winner).toMatchObject({ binding: { id: 'scale' }, target: 'box' });
  });
});
