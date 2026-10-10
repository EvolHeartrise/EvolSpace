// fb-city — city layout model (squarify, levels, heights, hit testing) and the widget: files protocol
// (tree/preview), zoom into districts / two-level jumps, preview billboard, elevator floors, spin.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import fbCity from '../widgets/fb-city/widget.ts';
import { actionTile, buildCity, crumbsOf, DEFAULT_CITY, fmtAge, hitTest, recency, squarify, tileForPath, type Rect, type TreeNode } from '../widgets/fb-city/city.ts';
import { mount, type Harness } from './harness.ts';

const NOW = Date.now();
const H = 3.6e6, DAY = 24 * H;
const areaOf = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
const inside = (a: Rect, b: Rect) => a.x0 >= b.x0 - 1e-9 && a.x1 <= b.x1 + 1e-9 && a.y0 >= b.y0 - 1e-9 && a.y1 <= b.y1 + 1e-9;

const f = (name: string, size: number, age = 30 * DAY): TreeNode => ({ name, path: name, type: 'file', size, files: 1, mtime: NOW - age, ext: name.includes('.') ? name.split('.').pop()! : '' });
const d = (name: string, children: TreeNode[]): TreeNode => ({ name, path: name, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), files: children.reduce((a, c) => a + c.files, 0), mtime: null, ext: '', children });
const fix = (n: TreeNode, p: string): TreeNode => { n.path = p; for (const c of n.children ?? []) fix(c, `${p}/${c.name}`); return n; };

const HOME = '/home/u';
const proj = fix(d('proj', [
  d('data', [f('weights.safetensors', 8e8, 400 * DAY), f('train.csv', 1e8, 2 * DAY), d('raw', [f('a.bin', 3e8), f('b.bin', 1e8)])]),
  d('src', [f('main.ts', 2e8, 0.5 * H), f('util.ts', 1e8, 3 * DAY), d('deep', [f('x.py', 5e7, 2 * H)])]),
  f('video.mp4', 3e8, 800 * DAY),
  f('README.md', 5e4, 10 * DAY),
]), `${HOME}/proj`);

describe('model', () => {
  it('squarify fills the rect with proportional areas', () => {
    const r = { x0: -0.6, y0: -0.6, x1: 0.6, y1: 0.6 };
    const rects = squarify([5, 3, 2, 1, 1], r);
    let sum = 0;
    rects.forEach((q, i) => { expect(areaOf(q)).toBeCloseTo(([5, 3, 2, 1, 1][i] / 12) * 1.44, 9); expect(inside(q, r)).toBe(true); sum += areaOf(q); });
    expect(sum).toBeCloseTo(1.44, 9);
  });

  it('recency is monotonic on a log scale, flat after two years', () => {
    expect(recency(NOW, NOW)).toBe(1);
    const xs = [H, DAY, 7 * DAY, 30 * DAY, 365 * DAY].map((a) => recency(NOW - a, NOW));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    expect(xs[0]).toBeGreaterThan(0.8);
    expect(xs[1]).toBeGreaterThan(0.35);
    expect(xs[1]).toBeLessThan(0.55);
    expect(recency(NOW - 3 * 365 * DAY, NOW)).toBe(0);
    expect(recency(null, NOW)).toBe(0);
    expect(fmtAge(NOW - 3 * H, NOW)).toBe('3 h ago');
  });

  it('lays out districts, blocks and buildings in nested footprints; recent = taller; stable', () => {
    const area = { x0: -0.6, y0: -0.6, x1: 0.6, y1: 0.6 };
    const c = buildCity(proj, area, DEFAULT_CITY, 0, NOW);
    expect(c.top).toBe(4);
    const byName = (n: string) => c.tiles.findIndex((t) => t.node?.name === n);
    const data = c.tiles[byName('data')], src = c.tiles[byName('src')];
    expect(data.kind).toBe('district');
    expect(data.content).not.toBeNull();
    expect(data.header).toBeGreaterThan(0);
    const raw = c.tiles[byName('raw')];
    expect(raw.kind).toBe('block');
    expect(raw.level).toBe(2);
    expect(raw.y0).toBeCloseTo(data.y0 + data.h, 9);       // blocks stand on their district
    const a = c.tiles[byName('a.bin')];
    expect(a.level).toBe(3);
    expect(inside(a.r, raw.content!)).toBe(true);
    // heights: recent main.ts (30 min) towers over the year-old weights and the 2-year-old video
    const main = c.tiles[byName('main.ts')], weights = c.tiles[byName('weights.safetensors')], video = c.tiles[byName('video.mp4')];
    expect(main.h).toBeGreaterThan(weights.h * 2);
    expect(video.h).toBeLessThan(DEFAULT_CITY.minHeight + 1e-9);
    expect(src.newest).toBe(NOW - 0.5 * H);
    // same tree → same city
    const again = buildCity(proj, area, DEFAULT_CITY, 0, NOW);
    expect(again.tiles.map((t) => [t.node?.path, t.r])).toEqual(c.tiles.map((t) => [t.node?.path, t.r]));
    // depth 1: districts only, closed (taller plinth)
    const flat = buildCity(proj, area, { ...DEFAULT_CITY, depth: 1 }, 0, NOW);
    expect(flat.tiles.length).toBe(4);
    expect(flat.tiles.find((t) => t.node?.name === 'data')!.content).toBeNull();
  });

  it('balanced footprints keep small code folders as districts; linear merges them into a "+N" lot', () => {
    const area = { x0: -0.6, y0: -0.6, x1: 0.6, y1: 0.6 };
    const repo = fix(d('repo', [d('data', [f('big.mp4', 3e8)]), d('node_modules', [f('x.js', 2.5e8)]),
      ...['library', 'apps', 'packages', 'python', 'scripts', 'tests'].map((n, i) => d(n, [f(`m${i}.ts`, 1e5 * (i + 1)), f(`n${i}.ts`, 2e4)]))]), '/r');
    const names = (c: ReturnType<typeof buildCity>) => c.tiles.slice(0, c.top).map((t) => t.node?.name ?? 'more');
    expect(names(buildCity(repo, area, DEFAULT_CITY, 0, NOW))).toContain('library');
    const linear = buildCity(repo, area, { ...DEFAULT_CITY, gamma: 1 }, 0, NOW);
    expect(names(linear)).not.toContain('library');
    expect(names(linear)).toContain('more');
  });

  it('hit-tests by footprint and height; small level-3 tiles stand for their block', () => {
    const area = { x0: -0.6, y0: -0.6, x1: 0.6, y1: 0.6 };
    const c = buildCity(proj, area, DEFAULT_CITY, 0, NOW);
    const idx = (n: string) => c.tiles.findIndex((t) => t.node?.name === n);
    const main = c.tiles[idx('main.ts')];
    const cx = (main.r.x0 + main.r.x1) / 2, cy = (main.r.y0 + main.r.y1) / 2;
    expect(hitTest(c, cx, cy, main.y0 + main.h)).toBe(idx('main.ts'));       // roof
    expect(hitTest(c, main.r.x1, cy, main.y0 + main.h / 2)).toBe(idx('main.ts')); // side wall
    const src = c.tiles[idx('src')];
    expect(hitTest(c, (src.r.x0 + src.r.x1) / 2, src.r.y0 + 0.01, src.y0 + src.h)).toBe(idx('src')); // sign strip
    expect(hitTest(c, 5, 5)).toBe(-1);
    const x = idx('x.py');
    expect(c.tiles[x].level).toBe(3);
    expect(actionTile(c, x)).toBe(c.tiles[x].parent === idx('deep') && Math.min(c.tiles[x].r.x1 - c.tiles[x].r.x0, c.tiles[x].r.y1 - c.tiles[x].r.y0) < 0.024 ? idx('deep') : x);
    expect(tileForPath(c, `${HOME}/proj/src/deep/x.py`)).toBe(x);
    expect(crumbsOf('~/git projects/EvolSpace').map((k) => k.label)).toEqual(['~', 'git projects', 'EvolSpace']);
  });
});

// ---- widget ------------------------------------------------------------------------------------------

const reply = (node: TreeNode, extra: Record<string, unknown> = {}) => ({ kind: 'tree', path: node.path, display: node.path.replace(HOME, '~'), root: node, partial: false, ...extra });
const lastReq = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string; depth?: number };
const instances = (h: Harness) => { let m: THREE.InstancedMesh | null = null; h.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) m = o as THREE.InstancedMesh; }); return m!; };

/** ctx.root point on the roof of the building / plinth named `name` (through the widget's own frames). */
function roofOf(h: Harness, name: string, meta: RegExp): [number, number, number] {
  const mesh = instances(h);
  const city = mesh.parent!;
  h.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const tip = () => h.visibleTexts().some((t) => t === name || t === `${name}/`) && h.visibleTexts().some((t) => meta.test(t));
  for (let k = 0; k < mesh.count; k++) {
    mesh.getMatrixAt(k, m);
    box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)).applyMatrix4(m).applyMatrix4(mesh.matrix);
    const p = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    city.localToWorld(p);
    h.root.worldToLocal(p);
    h.interact({ handler: 'hover', phase: 'move', objectName: 'city', localPoint: [p.x, p.y, p.z] });
    if (tip()) return [p.x, p.y, p.z];
  }
  throw new Error(`no tile ${name}`);
}

describe('widget', () => {
  it('requests a depth-3 tree, builds the city, zooms into a district, previews a file, goes up via the elevator', async () => {
    const h = await mount(fbCity, { path: '~/proj' });
    expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: '~/proj', depth: 3 });
    const treeCh = lastReq(h).reply;
    expect(treeCh).toBe('files.fb-city.test-entity.tree');
    h.frame(5);
    expect(h.hasText(/scanning/)).toBe(true);
    h.publish(treeCh, reply(proj));
    h.frame(60); // the city rises
    expect(instances(h).count).toBeGreaterThan(8);
    for (const t of [/^data\/  /, /^src\/  /, 'proj', /^1\.\d+ GB · 9 files/]) expect(h.hasText(t), String(t)).toBe(true);
    expect(h.emitsOn('path').at(-1)).toBe(`${HOME}/proj`);
    expect(h.rec.setProps).toEqual([]);

    // hover a building: floating label with name, size, age, hint
    const at = roofOf(h, 'main.ts', /min ago · Code/);
    expect(h.hasText(/^191 MB · 30 min ago · Code\npinch: preview$/)).toBe(true);
    // a cancelled pinch does nothing; a tap previews
    const before = h.rec.published.length;
    h.interact({ handler: 'drag', phase: 'start', objectName: 'city', localPoint: at });
    h.interact({ handler: 'drag', phase: 'cancel', objectName: 'city', localPoint: at });
    expect(h.rec.published.length).toBe(before);
    h.interact({ handler: 'drag', phase: 'start', objectName: 'city', localPoint: at });
    h.interact({ handler: 'drag', phase: 'end', objectName: 'city', localPoint: at });
    expect(lastReq(h)).toMatchObject({ cmd: 'preview', path: `${HOME}/proj/src/main.ts`, reply: 'files.fb-city.test-entity.preview' });
    h.publish(lastReq(h).reply, { kind: 'preview', path: `${HOME}/proj/other.ts`, name: 'other.ts', type: 'text', text: 'nope', lines: 1 }); // someone else's
    expect(h.hasText('nope')).toBe(false);
    h.publish(lastReq(h).reply, { kind: 'preview', path: `${HOME}/proj/src/main.ts`, name: 'main.ts', size: 30, mtime: NOW, type: 'text', text: 'const a = 1;\nexport {}', lines: 2 });
    h.frame(40);
    expect(h.hasText('const a = 1;\nexport {}')).toBe(true);
    const beam = (() => { let b: THREE.Mesh | null = null; h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && (m.material as THREE.MeshBasicMaterial)?.opacity === 0.7) b = m; }); return b!; })();
    expect(beam.visible).toBe(true);
    // pinching the building again lowers the billboard
    h.interact({ handler: 'drag', phase: 'start', objectName: 'city', localPoint: at });
    h.interact({ handler: 'drag', phase: 'end', objectName: 'city', localPoint: at });
    h.frame();
    expect(h.hasText('const a = 1;\nexport {}')).toBe(false);
    expect(beam.visible).toBe(false);

    // zoom into "src" (its district grows into the city; the provisional depth-2 data shows at once)
    h.input('open', 'src');
    expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: `${HOME}/proj/src` });
    h.frame(80);
    expect(h.hasText(/^deep\//)).toBe(true);
    const src = proj.children!.find((c) => c.name === 'src')!;
    h.publish(treeCh, reply(src));
    h.frame(5);
    expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj/src' });
    // elevator: current floor + parents; the "proj" floor goes back up (cached → zooms out at once)
    expect(h.hasText('src') && h.hasText('proj') && h.hasText('~')).toBe(true);
    const floor = h.liveParts().find((o) => o.name.startsWith('floor:') && o.userData.path === '~/proj');
    expect(floor).toBeTruthy();
    h.press(floor!.name, 'drag');
    expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: '~/proj' });
    h.frame(60);
    expect(h.hasText(/^data\/  /)).toBe(true);
    expect(h.rec.errors).toEqual([]);
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
  });

  it('pinch-drag on the rim or city spins the table (persisted), a drag never opens anything', async () => {
    const h = await mount(fbCity, { path: '~/proj' });
    h.publish(lastReq(h).reply, reply(proj));
    h.frame(60);
    const n = h.rec.published.length;
    // rim at the right edge (+x): drag it toward −z (counter-clockwise from above) by 0.3 m
    h.drag('rim', [0, 0, -0.3], { from: [0.62, 0.03, 0] });
    expect(h.rec.published.length).toBe(n);
    const spin = h.rec.setProps.at(-1)?.spin as number;
    expect(spin).toBeGreaterThan(20);
    expect(spin).toBeLessThan(40);
    // dragging the city (beyond the tap threshold) spins too, without a click
    h.drag('city', [-0.2, 0, 0], { from: [0.3, 0.1, 0.3] });
    expect(h.rec.setProps.at(-1)?.spin).not.toBe(spin);
    expect(h.rec.published.length).toBe(n);
    // an agent update of spin is adopted
    await h.setProps({ spin: 90 });
    expect(h.rec.errors).toEqual([]);
    h.dispose();
  });

  it('keeps the old city while loading; errors, malformed and foreign replies; two-level jump', async () => {
    const h = await mount(fbCity, { path: '~/proj' });
    const ch = lastReq(h).reply;
    h.publish(ch, reply(proj));
    h.frame(60);
    // up: request the parent; the old city stays until it arrives
    h.input('up', true);
    expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: '~' });
    h.frame(10);
    expect(h.hasText(/^data\/  /)).toBe(true);
    h.publish(ch, { kind: 'tree', path: '/other', display: '/other', root: { junk: true }, partial: false }); // malformed, foreign
    h.publish(ch, 'garbage');
    h.publish(ch, { kind: 'tree', path: HOME, display: '~', root: null, partial: false, error: 'Permission denied' });
    h.frame(5);
    expect(h.hasText('Permission denied')).toBe(true);
    expect(h.rec.errors.filter((e) => !/malformed/.test(e.message))).toEqual([]);
    // back to proj (cached), then jump two levels into the block "raw" inside "data"
    h.input('path', '~/proj');
    h.frame(60);
    h.input('open', 'raw');
    expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: `${HOME}/proj/data/raw` });
    h.input('open', 'nothing-like-this');
    expect(h.rec.events.at(-1)?.name).toBe('fb-city.open');
    h.dispose();
  });
});
