// fb-palm — fan layout, navigation over the files protocol, hold-to-peek, drag-out placement (files.palm.place
// contract + world-fixed ghost), recents, and the palm-facing show/hide when anchored to a hand.
import { expect, it } from 'vitest';
import * as THREE from 'three';
import palm, { facingYaw, HOLD_S, PLACE_DIST } from '../widgets/fb-palm/widget.ts';
import { baseName, cardLabel, fanSlots, samePath, textEm, tierSplit } from '../widgets/fb-palm/layout.ts';
import { mount, type Harness } from './harness.ts';

it('lays out the fan and labels cards', () => {
  expect(tierSplit(0)).toEqual([]);
  expect(tierSplit(5)).toEqual([5]);
  expect(tierSplit(10)).toEqual([4, 6]);
  expect(tierSplit(12)).toEqual([4, 8]);
  const s = fanSlots(10);
  expect(s).toHaveLength(10);
  // symmetric left→right per tier, cards tilt toward the fan's center
  expect(s[0].x).toBeCloseTo(-s[3].x);
  expect(s[4].x).toBeCloseTo(-s[9].x);
  expect(s[0].x).toBeLessThan(0);
  expect(s[0].rot).toBeGreaterThan(0);
  expect(Math.min(...s.map((c) => c.y))).toBeGreaterThan(0.05); // clear of the base row
  expect(cardLabel('widget.ts')).toBe('widget.ts');
  expect(cardLabel('very-long-component-name.tsx')).toBe('very-long-\ncomp…e.tsx');
  expect(cardLabel('README.markdown')).toBe('README.\nmarkdown');
  expect(cardLabel('CLAUDE.md')).toBe('CLAUDE.md');
  for (const n of ['ARCHITECTURE.md', 'abcdefghijklmnopqrstuvwxyz', 'MMMMMMMMMMMMMMMMMMMM', 'someVeryLongCamelCaseName.ts']) {
    const lines = cardLabel(n).split('\n');
    expect(lines.length, n).toBe(2);
    for (const l of lines) expect(textEm(l), l).toBeLessThanOrEqual(5.4);
  }
  expect(baseName('~/git projects/EvolSpace')).toBe('EvolSpace');
  expect(baseName('~')).toBe('~');
  expect(baseName('/')).toBe('/');
  expect(samePath('~/a', { path: '/home/u/a', display: '~/a' })).toBe(true);
  expect(samePath('/home/u/a/', { path: '/home/u/a', display: '~/a' })).toBe(true);
  expect(samePath('~/b', { path: '/home/u/a', display: '~/a' })).toBe(false);
  // yaw-only rotation whose +Z faces the head
  const q = facingYaw([0, 1, -1], [0, 1.6, 0]);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...q));
  expect(z.z).toBeCloseTo(1);
  const q2 = facingYaw([1, 1, 0], [0, 1.6, 0]);
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...q2)).x).toBeCloseTo(-1);
});

const listing = (path: string, names: Array<[string, 'dir' | 'file']>) => ({
  kind: 'list', path, display: path.replace('/home/u', '~'), parent: path === '/home/u' ? '/home' : path.slice(0, path.lastIndexOf('/')), truncated: false,
  entries: names.map(([name, type]) => ({ name, type, size: type === 'file' ? 1234 : null, mtime: Date.now() - 3600_000, ext: name.includes('.') ? name.split('.').pop() : '' })),
});
const HOME: Array<[string, 'dir' | 'file']> = [['docs', 'dir'], ['src', 'dir'], ['a.ts', 'file'], ['b.ts', 'file'], ['c.ts', 'file'], ['d.ts', 'file'],
  ['e.ts', 'file'], ['f.ts', 'file'], ['g.ts', 'file'], ['h.ts', 'file'], ['i.ts', 'file'], ['notes.md', 'file']];

const reqs = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').map((p) => p.value as { cmd: string; path: string; reply: string; query?: string });
const last = (h: Harness) => reqs(h).at(-1)!;

async function boot(props: Record<string, unknown> = {}) {
  const h = await mount(palm, { path: '~', ...props });
  const reply = last(h).reply;
  h.publish(reply, listing('/home/u', HOME));
  h.frame(30);
  return { h, reply };
}

it('deals a folder, pages, opens folders, goes up and home', async () => {
  const h = await mount(palm, { path: '~' });
  expect(last(h)).toMatchObject({ cmd: 'list', path: '~', reply: 'files.fb-palm.test-entity.list' });
  const reply = last(h).reply;
  h.publish(reply, listing('/home/u', HOME));
  h.frame(30);
  for (const t of ['docs', 'src', 'a.ts', '12 items · 1/2']) expect(h.hasText(t), t).toBe(true);
  expect(h.hasText('i.ts')).toBe(false); // page 2
  expect(h.emitsOn('folder').at(-1)).toBe('~');
  expect(h.visibleTexts().length).toBeLessThanOrEqual(30);

  h.press('btn:page', 'drag');
  h.frame(30);
  expect(h.hasText('i.ts')).toBe(true);
  expect(h.hasText('12 items · 2/2')).toBe(true);
  h.press('btn:page', 'drag');
  h.frame(30);

  h.press('card:0', 'drag'); // docs
  expect(last(h)).toMatchObject({ cmd: 'list', path: '/home/u/docs' });
  h.publish(reply, listing('/home/u/docs', [['plan.md', 'file'], ['img', 'dir']]));
  h.frame(30);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/docs' });
  expect(h.hasText('plan.md')).toBe(true);
  expect(h.hasText('docs')).toBe(true); // hub title

  // a reply for some other folder (another client sharing the channel) is ignored
  h.publish(reply, listing('/home/u/other', [['zzz.txt', 'file']]));
  h.frame(5);
  expect(h.hasText('zzz.txt')).toBe(false);

  h.press('btn:up', 'drag');
  expect(last(h)).toMatchObject({ cmd: 'list', path: '/home/u' });
  h.frame(30);
  expect(h.hasText('a.ts')).toBe(true); // cached listing shows instantly
  h.press('btn:home', 'drag');
  expect(last(h)).toMatchObject({ cmd: 'list', path: '~' });
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('previews a file in the hand and closes it with a tap', async () => {
  const { h } = await boot();
  h.press('card:2', 'press'); // a.ts — by poke
  expect(last(h)).toMatchObject({ cmd: 'preview', path: '/home/u/a.ts', reply: 'files.fb-palm.test-entity.preview' });
  expect(h.emitsOn('selected').at(-1)).toBe('/home/u/a.ts');
  h.publish('files.fb-palm.test-entity.preview', { kind: 'preview', path: '/home/u/other.ts', name: 'other.ts', type: 'text', text: 'nope', lines: 1 });
  expect(h.hasText('nope')).toBe(false);
  h.publish('files.fb-palm.test-entity.preview', { kind: 'preview', path: '/home/u/a.ts', name: 'a.ts', size: 30, mtime: Date.now(), type: 'text', text: 'const a = 1;\nexport default a;', lines: 2 });
  h.frame(10);
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(true);
  expect(h.hasText(/2 lines/)).toBe(true);
  h.press('preview', 'drag');
  h.frame(5);
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(false);
  // the preview input opens a file directly (~ paths match the absolute reply)
  h.input('preview', '~/notes.md');
  expect(last(h)).toMatchObject({ cmd: 'preview', path: '~/notes.md' });
  h.publish('files.fb-palm.test-entity.preview', { kind: 'preview', path: '/home/u/notes.md', name: 'notes.md', size: 5, mtime: Date.now(), type: 'text', text: '# hi', lines: 1 });
  expect(h.hasText('# hi')).toBe(true);
  h.dispose();
});

it('places a card dragged out of the fan; short drags and cancels do nothing', async () => {
  const { h } = await boot();
  const placed = () => h.rec.published.filter((p) => p.channel === 'files.palm.place').map((p) => p.value as Record<string, unknown>);
  // short drag → snaps back, no request, no navigation
  const n0 = reqs(h).length;
  h.drag('card:2', [0, PLACE_DIST * 0.5, 0]);
  h.frame(10);
  expect(placed()).toHaveLength(0);
  expect(reqs(h).length).toBe(n0);

  // cancelled drag → nothing
  const p0 = h.partPosition('card:3');
  h.interact({ handler: 'drag', phase: 'start', objectName: 'card:3', localPoint: p0 });
  h.interact({ handler: 'drag', phase: 'move', objectName: 'card:3', localPoint: [p0[0], p0[1] + 0.2, p0[2]] });
  h.interact({ handler: 'drag', phase: 'cancel', objectName: 'card:3', localPoint: [p0[0], p0[1] + 0.2, p0[2]] });
  expect(placed()).toHaveLength(0);

  // real drag-out
  const from = h.partPosition('card:2');
  h.drag('card:2', [0.05, 0.12, 0.1]);
  h.frame(2);
  expect(placed()).toHaveLength(1);
  const req = placed()[0];
  expect(req).toMatchObject({ path: '/home/u/a.ts', name: 'a.ts', type: 'file', from: 'test-entity', reply: 'files.fb-palm.test-entity.placed' });
  const pos = req.position as number[];
  expect(pos[0]).toBeCloseTo(from[0] + 0.05);
  expect(pos[1]).toBeCloseTo(from[1] + 0.12);
  expect((req.rotation as number[])).toHaveLength(4);
  expect(h.emitsOn('placed')).toHaveLength(1);
  expect(h.rec.events.at(-1)?.name).toBe('place');
  expect(h.hasText('a.ts\nplacing…')).toBe(true);
  // the ghost sits at the drop point
  const ghost = h.root.getObjectByName('ghost')!;
  h.root.updateWorldMatrix(true, true);
  const gp = new THREE.Vector3().setFromMatrixPosition(ghost.matrixWorld);
  expect(gp.toArray().map((v, i) => Math.abs(v - pos[i])).every((d) => d < 1e-6)).toBe(true);
  h.publish('files.fb-palm.test-entity.placed', { nonce: req.nonce, ok: true });
  expect(h.hasText('a.ts\nplaced')).toBe(true);
  h.frame(200); // > 2.2 s
  expect(h.root.getObjectByName('ghost')).toBeUndefined();

  // folders can be placed too
  h.drag('card:0', [0, 0.15, 0]);
  expect(placed().at(-1)).toMatchObject({ path: '/home/u/docs', type: 'dir' });
  // the button row never carries
  h.drag('btn:up', [0, 0.15, 0]);
  expect(placed()).toHaveLength(2);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('peeks into a held folder and jumps to the item slid onto', async () => {
  const { h } = await boot();
  const p0 = h.partPosition('card:1'); // src/
  h.interact({ handler: 'drag', phase: 'start', objectName: 'card:1', localPoint: p0 });
  h.frame(Math.ceil((HOLD_S * 72) / 2)); // not yet
  expect(reqs(h).some((r) => r.reply.endsWith('.peek'))).toBe(false);
  h.frame(Math.ceil(HOLD_S * 72));
  expect(last(h)).toMatchObject({ cmd: 'list', path: '/home/u/src', reply: 'files.fb-palm.test-entity.peek' });
  h.publish('files.fb-palm.test-entity.peek', listing('/home/u/src', [['lib', 'dir'], ['main.ts', 'file'], ['util.ts', 'file']]));
  h.frame(2);
  for (const t of ['src · 3', 'lib', 'main.ts', 'util.ts']) expect(h.hasText(t), t).toBe(true);
  // slide onto "lib" (mini 0) and release
  const mini = h.root.getObjectByName('mini:0')!;
  h.root.updateWorldMatrix(true, true);
  const at = new THREE.Vector3().setFromMatrixPosition(mini.matrixWorld).toArray() as [number, number, number];
  h.interact({ handler: 'drag', phase: 'move', objectName: 'card:1', localPoint: [(p0[0] + at[0]) / 2, (p0[1] + at[1]) / 2, at[2]] });
  h.interact({ handler: 'drag', phase: 'move', objectName: 'card:1', localPoint: at });
  h.interact({ handler: 'drag', phase: 'end', objectName: 'card:1', localPoint: at });
  expect(last(h)).toMatchObject({ cmd: 'list', path: '/home/u/src/lib', reply: 'files.fb-palm.test-entity.list' });
  expect(h.rec.published.some((p) => p.channel === 'files.palm.place')).toBe(false); // a peek never places
  expect(h.root.getObjectByName('peek')!.visible).toBe(false);

  // hold + release elsewhere: closes the peek, no navigation
  const { h: h2 } = await boot();
  const q0 = h2.partPosition('card:0');
  h2.interact({ handler: 'drag', phase: 'start', objectName: 'card:0', localPoint: q0 });
  h2.frame(Math.ceil(HOLD_S * 72) + 2);
  const n = reqs(h2).length;
  h2.interact({ handler: 'drag', phase: 'end', objectName: 'card:0', localPoint: q0 });
  expect(reqs(h2).length).toBe(n);
  expect(h2.root.getObjectByName('peek')!.visible).toBe(false);
  h.dispose();
  h2.dispose();
});

it('shows recent files from the clock chip', async () => {
  const { h } = await boot({ recentsRoot: '~/work' });
  h.press('btn:recent', 'drag');
  expect(last(h)).toMatchObject({ cmd: 'search', path: '~/work', query: '', reply: 'files.fb-palm.test-entity.recent' });
  h.publish('files.fb-palm.test-entity.recent', {
    kind: 'search', path: '/home/u/work', display: '~/work', query: '', scanned: 10, partial: false,
    results: [{ name: 'fresh.py', path: '/home/u/work/x/fresh.py', display: '~/work/x/fresh.py', type: 'file', size: 10, mtime: Date.now(), ext: 'py', score: 0 }],
  });
  h.frame(30);
  expect(h.hasText('Recent')).toBe(true);
  expect(h.hasText('fresh.py')).toBe(true);
  expect(h.hasText('docs')).toBe(false);
  h.press('card:0', 'drag');
  expect(last(h)).toMatchObject({ cmd: 'preview', path: '/home/u/work/x/fresh.py' });
  h.press('btn:up', 'drag'); // back to the folder
  h.frame(30);
  expect(h.hasText('docs')).toBe(true);
  h.dispose();
});

it('anchored to the left hand: opens only while the palm faces the head, ignores the holding hand, keeps the ghost fixed in the room', async () => {
  const h = await mount(palm, { path: '~' }, { user: { head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} } });
  h.publish(last(h).reply, listing('/home/u', HOME));
  // scene graph like the runtime: space root → hand anchor frame (wrist) → entity node → widget content
  const space = new THREE.Group();
  space.name = 'space';
  const wrist = new THREE.Group();
  wrist.name = 'anchor:left:wrist';
  const node = new THREE.Group();
  node.name = 'entity:test-entity';
  node.position.set(0, -0.07, -0.06); // above the palm
  space.add(wrist);
  wrist.add(node);
  node.add(h.root);
  wrist.position.set(-0.15, 1.1, -0.35);
  const fan = h.root.getObjectByName('fan')!;

  // palm down (identity wrist: -Y out of the palm) → folds away, nothing hittable
  wrist.quaternion.identity();
  h.frame(40);
  expect(fan.visible).toBe(false);
  expect(h.liveParts()).toHaveLength(0);

  // palm up (rotate 180° about the finger axis) → opens and faces the head
  wrist.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  h.frame(40);
  expect(fan.visible).toBe(true);
  expect(h.hasText('a.ts')).toBe(true);
  h.root.updateWorldMatrix(true, true);
  const fz = new THREE.Vector3(0, 0, 1).transformDirection(fan.matrixWorld);
  const fp = new THREE.Vector3().setFromMatrixPosition(fan.matrixWorld);
  const toHead = new THREE.Vector3(0, 1.6, 0).sub(fp).normalize();
  expect(fz.dot(toHead)).toBeGreaterThan(0.99);

  // the thumb-side (left) chip is "up"
  const up = new THREE.Vector3().setFromMatrixPosition(h.part('btn:up').matrixWorld);
  const home = new THREE.Vector3().setFromMatrixPosition(h.part('btn:home').matrixWorld);
  const right = new THREE.Vector3(1, 0, 0).transformDirection(fan.matrixWorld);
  expect(up.clone().sub(home).dot(right)).toBeLessThan(0);

  // the holding (left) hand never operates its own fan
  const n = reqs(h).length;
  h.press('card:0', 'drag', 'left');
  expect(reqs(h).length).toBe(n);

  // place with the right hand; then move the hand: the ghost stays where it was dropped (space coords)
  const p0 = h.partPosition('card:2');
  const end: [number, number, number] = [p0[0], p0[1] + 0.15, p0[2]];
  const endSpace = h.root.localToWorld(new THREE.Vector3(...end)); // space root is at the world origin here
  h.interact({ handler: 'drag', phase: 'start', objectName: 'card:2', localPoint: p0, point: h.root.localToWorld(new THREE.Vector3(...p0)).toArray() as [number, number, number] });
  h.interact({ handler: 'drag', phase: 'move', objectName: 'card:2', localPoint: end, point: endSpace.toArray() as [number, number, number] });
  h.interact({ handler: 'drag', phase: 'end', objectName: 'card:2', localPoint: end, point: endSpace.toArray() as [number, number, number] });
  const req = h.rec.published.filter((p) => p.channel === 'files.palm.place').at(-1)!.value as { position: number[] };
  expect(req.position[1]).toBeCloseTo(endSpace.y);
  h.frame(15);
  wrist.position.x += 0.3;
  wrist.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.9);
  h.frame(5);
  h.root.updateWorldMatrix(true, true);
  const g = new THREE.Vector3().setFromMatrixPosition(h.root.getObjectByName('ghost')!.matrixWorld);
  expect(g.distanceTo(endSpace)).toBeLessThan(1e-4);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
