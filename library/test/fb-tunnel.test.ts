// fb-tunnel — tunnel geometry/layout model and the widget's flights, previews, paging and protocol.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import tunnel from '../widgets/fb-tunnel/widget.ts';
import {
  GEO, arcCapacity, arcSlots, levels, navKind, normPath, ringPlan, ringZ, rowSpecs, slotPosition, splitEntries, tileLabel, joinPath, folderTitle,
} from '../widgets/fb-tunnel/model.ts';
import { mount, type Harness } from './harness.ts';

describe('model', () => {
  it('splits a path into levels', () => {
    expect(levels('~/git projects/EvolSpace')).toEqual(['~', '~/git projects', '~/git projects/EvolSpace']);
    expect(levels('~')).toEqual(['~']);
    expect(levels('/usr/lib/')).toEqual(['/', '/usr', '/usr/lib']);
    expect(levels('C:\\Users\\me')).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me']);
    expect(normPath(' ~/a/ ')).toBe('~/a');
    expect(joinPath('~/a', 'b')).toBe('~/a/b');
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(folderTitle('~')).toBe('Home');
  });

  it('plans ring motion: entering slides everything toward the viewer, going up recedes', () => {
    const enter = ringPlan('~/a', '~/a/b');
    expect(enter).toEqual([
      { path: '~', from: 1, to: 2 },
      { path: '~/a', from: 0, to: 1 },
      { path: '~/a/b', from: -1, to: 0 },
    ]);
    const up = ringPlan('~/a/b', '~/a');
    expect(up.find((r) => r.path === '~/a/b')).toEqual({ path: '~/a/b', from: 0, to: -1 });
    expect(up.find((r) => r.path === '~/a')).toEqual({ path: '~/a', from: 1, to: 0 });
    expect(navKind('~/a', '~/a/b')).toBe('enter');
    expect(navKind('~/a/b', '~')).toBe('up');
    expect(navKind('~/a/b', '~/c')).toBe('jump');
    // nearer levels are nearer the viewer; the portal is the far end
    expect(ringZ(0)).toBeCloseTo(GEO.Z_FAR);
    for (let d = 0; d < 7; d++) expect(ringZ(d + 1)).toBeGreaterThan(ringZ(d));
  });

  it('lays out a stable wall without overlapping cards (as seen from the eye)', () => {
    const cap = arcCapacity();
    expect(cap).toBeGreaterThanOrEqual(12);
    expect(arcSlots(3, 0).map((s) => s.a.toFixed(4))).toEqual(arcSlots(3, 0).map((s) => s.a.toFixed(4)));
    // a partial row is centered
    const three = arcSlots(3, 0);
    expect(three[1].a).toBeCloseTo(0);
    expect(three[0].a).toBeCloseTo(-three[2].a);
    // angular rectangles of a full wall never overlap
    const rects: Array<[number, number, number, number]> = [];
    for (const arc of [0, 1] as const) {
      for (const s of arcSlots(cap, arc)) {
        const [x, y, z] = slotPosition(arc, s.a, s.r, s.z);
        const dz = GEO.EYE_Z - z, dist = Math.hypot(x, y, dz);
        const u = Math.atan2(x, Math.hypot(dz, y)), v = Math.atan2(y, dz);
        rects.push([u, v, Math.atan((GEO.TILE_W * s.s) / 2 / dist), Math.atan((GEO.TILE_H * s.s) / 2 / dist)]);
      }
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      const gap = Math.max(Math.abs(a[0] - b[0]) - a[2] - b[2], Math.abs(a[1] - b[1]) - a[3] - b[3]);
      expect(gap, `${i}/${j}`).toBeGreaterThan(0);
    }
    expect(rowSpecs().length).toBeGreaterThan(1);
  });

  it('sorts naturally and labels long names in two lines', () => {
    const { dirs, files } = splitEntries([
      { name: 'b10', type: 'dir', size: null, mtime: null, ext: '' },
      { name: 'b2', type: 'dir', size: null, mtime: null, ext: '' },
      { name: 'z.ts', type: 'file', size: 1, mtime: null, ext: 'ts' },
      { name: 'a.ts', type: 'file', size: 1, mtime: null, ext: 'ts' },
    ]);
    expect(dirs.map((d) => d.name)).toEqual(['b2', 'b10']);
    expect(files.map((d) => d.name)).toEqual(['a.ts', 'z.ts']);
    expect(tileLabel('short.ts', 16)).toBe('short.ts');
    const l = tileLabel('a-very-long-file-name-for-testing.json', 16).split('\n');
    expect(l).toHaveLength(2);
    expect(l.every((x) => x.length <= 16)).toBe(true);
    expect(l[1].endsWith('.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------- widget

const HOME = '/home/u';
const entry = (name: string, type: 'dir' | 'file') => ({ name, type, size: type === 'file' ? 2048 : null, mtime: Date.now() - 3600_000, ext: name.includes('.') ? name.split('.').pop()! : '' });
const listing = (display: string, names: Array<[string, 'dir' | 'file']>) => ({
  kind: 'list', path: display.replace(/^~/, HOME), display, parent: null, truncated: false, entries: names.map(([n, t]) => entry(n, t)),
});
const USER = { head: { position: [0, 0, GEO.EYE_Z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] }, hands: {} };

function requests(h: Harness) {
  return h.rec.published.filter((p) => p.channel === 'files.request').map((p) => p.value as { cmd: string; path: string; reply: string; nonce: number });
}
const lastReq = (h: Harness) => requests(h).at(-1)!;

/** Pinch-drag a part with the hand moving `dist` m toward (+) / away from (−) the head. */
function depthDrag(h: Harness, part: string, dist: number, end: 'end' | 'cancel' = 'end'): void {
  const p0 = h.partPosition(part);
  const dir = new THREE.Vector3(-p0[0], -p0[1], GEO.EYE_Z - p0[2]).normalize();
  const at = (k: number): [number, number, number] => [p0[0] + dir.x * k, p0[1] + dir.y * k, p0[2] + dir.z * k];
  const ev = (phase: 'start' | 'move' | 'end' | 'cancel', p: [number, number, number]) =>
    h.interact({ handler: 'drag', phase, objectName: part, localPoint: [p0[0], p0[1], p0[2]], pointer: { position: p, rotation: [0, 0, 0, 1] } });
  ev('start', p0);
  for (let i = 1; i <= 5; i++) { ev('move', at((dist * i) / 5)); h.frame(); }
  ev(end, at(dist));
}

async function opened(path = '~/proj') {
  const h = await mount(tunnel, { path }, { user: USER });
  const r = lastReq(h);
  expect(r).toMatchObject({ cmd: 'list', path });
  expect(r.reply).toBe('files.fb-tunnel.test-entity.list');
  return h;
}

it('opens the folder: folders on the upper arc, files on the lower, ancestors as tagged rings', async () => {
  const h = await opened();
  expect(h.hasText('loading…')).toBe(true);
  h.publish('files.fb-tunnel.test-entity.list', listing('~/proj', [['src', 'dir'], ['docs', 'dir'], ['README.md', 'file'], ['main.ts', 'file']]));
  h.frame(40);
  for (const t of ['proj', 'docs', 'src', 'README.md', 'main.ts', 'Home']) expect(h.hasText(t), t).toBe(true);
  expect(h.hasText(/2 folders · 2 files/)).toBe(true);
  // folders up, files down, sorted
  const cap = arcCapacity();
  expect(h.partPosition('tile:0')[1]).toBeGreaterThan(0.2);
  expect(h.partPosition(`tile:${cap}`)[1]).toBeLessThan(-0.2);
  expect(h.partPosition('tile:0')[0]).toBeLessThan(h.partPosition('tile:1')[0]); // docs left of src
  // a reply for another folder (another client's request) doesn't change the wall
  h.publish('files.fb-tunnel.test-entity.list', listing('~/other', [['zzz', 'dir']]));
  h.frame(5);
  expect(h.hasText('zzz')).toBe(false);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('flies into a pinched folder and backs out with a pull toward yourself', async () => {
  const h = await opened();
  const ch = 'files.fb-tunnel.test-entity.list';
  h.publish(ch, listing('~/proj', [['docs', 'dir'], ['src', 'dir'], ['a.ts', 'file']]));
  h.frame(40);
  h.press('tile:1', 'drag'); // src
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~/proj/src' });
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj/src' });
  expect(h.emitsOn('path').at(-1)).toBe('~/proj/src');
  h.frame(10);
  h.publish(ch, listing('~/proj/src', [['lib', 'dir'], ['index.ts', 'file']]));
  h.frame(60);
  expect(h.hasText('index.ts')).toBe(true);
  expect(h.hasText('a.ts')).toBe(false);
  expect(h.hasText('proj')).toBe(true); // parent ring tag

  // a small pull springs back
  const n = requests(h).length;
  depthDrag(h, 'tile:0', 0.04);
  h.frame(60);
  expect(requests(h).length).toBe(n);
  expect(h.hasText('index.ts')).toBe(true);
  // a cancelled pull never navigates
  depthDrag(h, 'tile:0', 0.15, 'cancel');
  h.frame(60);
  expect(requests(h).length).toBe(n);
  // a full pull goes up (served from the cache at once, refreshed in the background)
  depthDrag(h, 'tile:0', 0.15);
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~/proj' });
  h.frame(60);
  expect(h.hasText('a.ts')).toBe(true);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj' });

  // pushing a folder card away enters it
  depthDrag(h, 'tile:0', -0.15);
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~/proj/docs' });
  h.frame(60);
  h.publish(ch, listing('~/proj/docs', [['x.md', 'file']]));
  h.frame(60);
  expect(h.hasText('x.md')).toBe(true);

  // pinching an ancestor's ring tag jumps back to it
  const ringPart = [...h.interactives].find((o) => o.name.startsWith('ring:') && h.live(o) && h.root.getObjectByName(o.name)?.parent?.children.some((c) => (c as unknown as { text?: string }).text === 'Home'));
  expect(ringPart).toBeTruthy();
  h.press(ringPart!.name, 'drag');
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~' });
  expect(h.rec.errors).toEqual([]);
  h.dispose();
});

it('extrudes a file preview from its card, scrolls it and retracts it', async () => {
  const h = await opened();
  h.publish('files.fb-tunnel.test-entity.list', listing('~/proj', [['main.ts', 'file']]));
  h.frame(40);
  const cap = arcCapacity();
  h.press(`tile:${cap}`, 'drag');
  expect(lastReq(h)).toMatchObject({ cmd: 'preview', path: '~/proj/main.ts', reply: 'files.fb-tunnel.test-entity.preview' });
  expect(h.emitsOn('selected').at(-1)).toBe('~/proj/main.ts');
  expect(h.rec.setProps.at(-1)).toEqual({ file: '~/proj/main.ts' });
  const text = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join('\n');
  // someone else's preview is ignored
  h.publish('files.fb-tunnel.test-entity.preview', { kind: 'preview', path: `${HOME}/proj/other.ts`, name: 'other.ts', type: 'text', text: 'nope', lines: 1 });
  expect(h.hasText('nope')).toBe(false);
  h.publish('files.fb-tunnel.test-entity.preview', { kind: 'preview', path: `${HOME}/proj/main.ts`, name: 'main.ts', size: 900, mtime: Date.now(), type: 'text', text, lines: 80 });
  h.frame(40);
  expect(h.hasText('const v0 = 0;')).toBe(true);
  expect(h.hasText(/^1\n2\n3/)).toBe(true);
  h.drag('pv:text', [0, 0.15, 0]);
  h.frame();
  expect(h.hasText('const v0 = 0;')).toBe(false);
  h.press('pv:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain('~/proj/main.ts');
  h.press(`tile:${cap}`, 'drag'); // same card again → retract
  h.frame(40);
  expect(h.hasText(/const v\d+/)).toBe(false);
  expect(h.rec.setProps.at(-1)).toEqual({ file: '' });
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('pages a crowded arc with a sideways drag', async () => {
  const h = await opened();
  const cap = arcCapacity();
  const names: Array<[string, 'dir' | 'file']> = Array.from({ length: cap + 5 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, 'file']);
  h.publish('files.fb-tunnel.test-entity.list', listing('~/proj', names));
  h.frame(40);
  expect(h.hasText('f00.txt')).toBe(true);
  expect(h.hasText(`f${cap + 4}.txt`)).toBe(false);
  expect(h.hasText('1/2')).toBe(true);
  h.drag(`tile:${cap + 3}`, [-0.12, 0, 0]);
  h.frame(60);
  expect(h.hasText(`f${cap + 4}.txt`)).toBe(true);
  expect(h.hasText('f00.txt')).toBe(false);
  expect(h.hasText('2/2')).toBe(true);
  h.press('pager:1', 'drag');
  h.frame(60);
  expect(h.hasText('f00.txt')).toBe(true);
  h.dispose();
});

it('follows path/file props and inputs, keeps the text budget, survives junk', async () => {
  const h = await opened('~');
  h.publish('files.fb-tunnel.test-entity.list', { kind: 'list', path: HOME, display: '~', parent: '/home', truncated: false, entries: [entry('proj', 'dir')] });
  h.frame(40);
  await h.setProps({ path: '~/proj' });
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~/proj' });
  h.input('path', '~');
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~' });
  h.input('preview', '~/notes.md');
  expect(lastReq(h)).toMatchObject({ cmd: 'preview', path: '~/notes.md' });
  h.publish('files.fb-tunnel.test-entity.list', { kind: 'list', path: 42 } as never);
  h.publish('files.fb-tunnel.test-entity.list', 'garbage');
  h.frame(60);
  expect(h.rec.errors.length).toBe(1);
  expect(h.texts.length).toBeLessThanOrEqual(52);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
