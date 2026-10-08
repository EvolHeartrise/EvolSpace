// bsrl-replay — a synthetic replay on the source's channels: HUD numbers, note/aftermath drawing,
// FK sanity, the control bar (play/pause persisted, prev/next → ctl.load, seek-bar scrubbing).
import { expect, it } from 'vitest';
import type * as THREE from 'three';
import replay from '../widgets/bsrl-replay/widget.ts';
import { BodyFK, F } from '../widgets/bsrl-replay/fk.ts';
import { mount, tensor, type Harness } from './harness.ts';

const T = 60, HZ = 30;

function publishReplay(h: Harness, loadId = 'a-1') {
  const q = new Float32Array(T * 36);
  for (let k = 0; k < T; k++) q.set([0, 0.94, -0.65, 1, 0, 0, 0], k * 36);
  // t x y color angle speed any kind rtick outcome points reason
  const chart = [
    0.5, -0.3, 0.85, 0, 1.5 * Math.PI, 18, 0, 0, 15, 0, 115, 0,
    1.0, 0.3, 1.4, 1, Math.PI / 2, 18, 0, 0, 31, 2, 0, 4,
    1.6, 0.9, 1.9, 1, 0, 18, 1, 0, -1, -1, 0, -1,
  ];
  const hud = new Float32Array(T * 8);
  for (let k = 0; k < T; k++) hud.set(k < 15 ? [0, 0, 0, 1, 0, 0, 0.5, 0] : k < 31 ? [115, 115, 1, 1, 1, 0, 0.51, 1] : [115, 230, 0, 1, 0, 1, 0.36, 1], k * 8);
  h.publish('replay.q', tensor('f32', [T, 36], q));
  h.publish('replay.chart', tensor('f32', [3, 12], chart));
  h.publish('replay.walls', tensor('f32', [1, 7], [1.2, 0.9, 1.5, 0.5, 3, 1, 18]));
  h.publish('replay.hud', tensor('f32', [T, 8], hud));
  h.publish('replay.torque', tensor('f32', [T], new Float32Array(T).fill(10)));
  h.publish('replay.meta', {
    id: 'x', song: 'Felis', difficulty: 'Hard', model: 'v65', pp: 1819, score: 115, ticks: T, hz: HZ,
    handleLen: 0.16, trackAnchor: 'head', notes: 3, walls: 1, index: 0, total: 490, loadId,
  });
}

const drawn = (h: Harness) => {
  const out: THREE.InstancedMesh[] = [];
  h.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh); });
  return out;
};

it('FK of the neutral pose puts the head above the chest and the sabers forward of the wrists', () => {
  const fk = new BodyFK();
  const q = new Float64Array(36);
  q.set([0, 0.94, -0.65, 1, 0, 0, 0]);
  fk.compute(q);
  expect(fk.p[F.HEAD * 3 + 1]).toBeCloseTo(0.94 + 0.1 + 0.66, 6);
  expect(fk.p[F.L_SHOULDER * 3]).toBeCloseTo(-0.2, 6);
  const base = new Float64Array(3), tip = new Float64Array(3), grip = new Float64Array(3);
  fk.saber(1, 0.16, base, tip, grip);
  expect(tip[2] - base[2]).toBeCloseTo(1, 6); // blade along +z (toward the notes) at rest
});

it('renders a replay: HUD, notes, aftermath, control bar', async () => {
  const h = await mount(replay, {});
  h.frame();
  expect(h.hasText('Waiting for replay data (bsrl-replay source)…')).toBe(true);
  publishReplay(h);
  h.input('seek', 0.2);
  h.frame();
  expect(h.hasText('#1/490 Felis · Hard · 1819 pp')).toBe(true);
  expect(h.hasText('Felis · Hard · v65 · 1819 pp')).toBe(true);
  const counts = () => drawn(h).map((m) => m.count);
  expect(counts().some((c) => c >= 2)).toBe(true); // body parts, notes

  h.input('seek', 1.2); // after the miss at tick 31
  h.frame();
  expect(h.hasText('MISS')).toBe(true);
  expect(h.hasText('1')).toBe(true); // misses
  expect(h.hasText('50.00%  B')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('control bar: play/pause persists, prev/next publish ctl.load, the seek bar scrubs and pauses', async () => {
  const h = await mount(replay, {});
  publishReplay(h);
  h.frame();
  h.press('btn:play');
  expect(h.rec.setProps.at(-1)).toEqual({ playing: false });
  expect(h.hasText('Play')).toBe(true);
  h.press('btn:next');
  expect(h.rec.published.at(-1)).toMatchObject({ channel: 'replay.ctl.load', value: { cmd: 'next' } });
  h.press('btn:speed');
  expect(h.rec.setProps.at(-1)).toEqual({ speed: 2 });
  h.press('btn:play');
  h.drag('seek', [0.2, 0, 0], { handler: 'drag' });
  h.frame();
  expect(h.hasText('Play')).toBe(true); // scrubbing paused playback
  // a new replay (new loadId) restarts at 0
  publishReplay(h, 'a-2');
  h.frame();
  expect(h.hasText('0:00 / 0:01')).toBe(true);
  h.dispose();
});
