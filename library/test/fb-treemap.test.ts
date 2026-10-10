// fb-treemap — squarify layout, tile model, files protocol (tree/preview), zoom navigation, breadcrumbs.
import { describe, expect, it } from 'vitest';
import fbTreemap from '../widgets/fb-treemap/widget.ts';
import { buildLayout, categoryOf, crumbsOf, DEFAULT_LAYOUT, fmtSize, groupChildren, hitTest, squarify, tileForPath, type Rect, type TreeNode } from '../widgets/fb-treemap/layout.ts';
import { mount } from './harness.ts';

const areaOf = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

describe('squarify', () => {
  const cases: Array<[number[], Rect]> = [
    [[6, 6, 4, 3, 2, 2, 1], { x0: 0, y0: 0, x1: 6, y1: 4 }],
    [[100, 1, 1, 1], { x0: -0.5, y0: -0.3, x1: 0.5, y1: 0.3 }],
    [Array.from({ length: 60 }, (_, i) => 1000 / (i + 1) ** 1.5), { x0: -0.55, y0: -0.3, x1: 0.55, y1: 0.31 }],
    [[5], { x0: 0, y0: 0, x1: 1, y1: 2 }],
    [[3, 3, 3, 3], { x0: 0, y0: 0, x1: 0.2, y1: 1 }],
  ];
  it.each(cases)('areas proportional, no overlaps, inside bounds (%#)', (values, r) => {
    const rects = squarify(values, r);
    const total = values.reduce((a, b) => a + b, 0);
    const A = areaOf(r), eps = 1e-9 * Math.max(1, A);
    let sum = 0;
    rects.forEach((q, i) => {
      expect(areaOf(q)).toBeCloseTo((values[i] / total) * A, 9);
      expect(q.x0).toBeGreaterThanOrEqual(r.x0 - 1e-12);
      expect(q.x1).toBeLessThanOrEqual(r.x1 + 1e-12);
      expect(q.y0).toBeGreaterThanOrEqual(r.y0 - 1e-12);
      expect(q.y1).toBeLessThanOrEqual(r.y1 + 1e-12);
      expect(q.x1).toBeGreaterThanOrEqual(q.x0);
      expect(q.y1).toBeGreaterThanOrEqual(q.y0);
      sum += areaOf(q);
      for (let j = 0; j < i; j++) expect(overlap(q, rects[j])).toBeLessThan(eps);
    });
    expect(sum).toBeCloseTo(A, 9); // fills the rect exactly
  });

  it('is reasonably square and puts the biggest top-left', () => {
    const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x0: 0, y0: 0, x1: 6, y1: 4 });
    for (const q of rects) {
      const w = q.x1 - q.x0, h = q.y1 - q.y0;
      expect(Math.max(w / h, h / w)).toBeLessThan(3);
    }
    expect(rects[0].x0).toBe(0);
    expect(rects[0].y1).toBe(4);
  });

  it('handles zeros and degenerate input', () => {
    const rects = squarify([3, 0, 1], { x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(areaOf(rects[1])).toBe(0);
    expect(areaOf(rects[0]) + areaOf(rects[2])).toBeCloseTo(1, 12);
    expect(squarify([], { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
    expect(areaOf(squarify([1, 2], { x0: 0, y0: 0, x1: 0, y1: 1 })[0])).toBe(0);
  });
});

const f = (name: string, size: number, dir = '/r'): TreeNode => ({ name, path: `${dir}/${name}`, type: 'file', size, files: 1, mtime: 0, ext: name.includes('.') ? name.split('.').pop()! : '' });
const d = (name: string, children: TreeNode[], dir = '/r'): TreeNode => {
  const path = `${dir}/${name}`;
  const kids = children.map((c) => ({ ...c, path: `${path}/${c.name}` }));
  return { name, path, type: 'dir', size: kids.reduce((a, c) => a + c.size, 0), files: kids.reduce((a, c) => a + c.files, 0), mtime: null, ext: '', children: kids };
};

describe('tile model', () => {
  it('categorizes and formats', () => {
    expect(categoryOf({ type: 'dir', ext: '' })).toBe('folder');
    expect(categoryOf({ type: 'file', ext: 'ts' })).toBe('code');
    expect(categoryOf({ type: 'file', ext: 'safetensors' })).toBe('data');
    expect(categoryOf({ type: 'file', ext: 'MP4' })).toBe('video');
    expect(categoryOf({ type: 'file', ext: 'weird' })).toBe('other');
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(99063779748)).toBe('92.3 GB');
    expect(fmtSize(1536)).toBe('1.50 KB');
  });

  it('merges the tail into "+N more" and lays out nested tiles inside folder tiles', () => {
    const many = Array.from({ length: 120 }, (_, i) => f(`f${i}.ts`, i < 5 ? 1e6 : 10));
    const g = groupChildren(many, 0.6, DEFAULT_LAYOUT.minArea, DEFAULT_LAYOUT.maxTiles);
    expect(g.items.length).toBe(5);
    expect(g.more).toMatchObject({ count: 115, size: 1150, skip: 5 });
    expect(groupChildren(many, 0.6, DEFAULT_LAYOUT.minArea, 64, 5).items[0].name).toBe('f5.ts');

    const root = d('r', [d('data', [f('a.bin', 6e8), f('b.csv', 3e8), f('c.txt', 1e8)]), f('big.mp4', 5e8), f('x.ts', 2e7), f('empty', 0)], '');
    expect(root.path).toBe('/r');
    const area = { x0: -0.5, y0: -0.3, x1: 0.5, y1: 0.3 };
    const l = buildLayout(root, area);
    expect(l.top).toBe(3);
    expect(l.empty).toBe(1);
    const data = l.tiles[0];
    expect(data.node!.name).toBe('data');
    expect(data.content).not.toBeNull();
    expect(data.last - data.first).toBe(3);
    for (let k = data.first; k < data.last; k++) {
      const t = l.tiles[k];
      expect(t.parent).toBe(0);
      expect(t.r.x0).toBeGreaterThanOrEqual(data.content!.x0 - 1e-9);
      expect(t.r.y1).toBeLessThanOrEqual(data.content!.y1 + 1e-9);
    }
    // hit test: nested tile wins, header strip hits its folder
    const inner = l.tiles[data.first];
    expect(hitTest(l, (inner.r.x0 + inner.r.x1) / 2, (inner.r.y0 + inner.r.y1) / 2)).toBe(data.first);
    expect(hitTest(l, (data.r.x0 + data.r.x1) / 2, data.r.y1 - 0.005)).toBe(0);
    expect(hitTest(l, 5, 5)).toBe(-1);
    expect(tileForPath(l, '/r/data/b.csv')).toBeGreaterThan(2);
    expect(tileForPath(l, '/r/data')).toBe(0);
    expect(l.byCat.data).toBe(9e8);
    expect(l.byCat.video).toBe(5e8);
  });

  it('builds breadcrumbs', () => {
    expect(crumbsOf('~/git projects/EvolSpace').map((c) => c.path)).toEqual(['~', '~/git projects', '~/git projects/EvolSpace']);
    expect(crumbsOf('/usr/lib/').map((c) => c.label)).toEqual(['/', 'usr', 'lib']);
    expect(crumbsOf('~')).toEqual([{ label: '~', path: '~' }]);
  });
});

// ---- widget ------------------------------------------------------------------------------------------

const HOME = '/home/u';
const proj = d('proj', [
  d('data', [f('weights.safetensors', 8e8), f('train.csv', 1e8)], HOME),
  d('src', [f('main.ts', 2e8), f('util.ts', 1e8), d('deep', [f('x.py', 5e7)], `${HOME}/src`)], HOME),
  f('video.mp4', 3e8, HOME),
  f('README.md', 5e4, HOME),
], HOME);
const fix = (n: TreeNode, p: string): void => { n.path = p; for (const c of n.children ?? []) fix(c, `${p}/${c.name}`); };
fix(proj, `${HOME}/proj`);
const reply = (node: TreeNode, extra: Record<string, unknown> = {}) => ({ kind: 'tree', path: node.path, display: node.path.replace(HOME, '~'), root: node, partial: false, ...extra });

describe('widget', () => {
  it('requests a tree, draws tiles + labels + legend, zooms into folders, previews files, jumps back with the breadcrumb', async () => {
    const h = await mount(fbTreemap, { path: '~/proj' });
    const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string; depth?: number };
    expect(req()).toMatchObject({ cmd: 'tree', path: '~/proj', depth: 2 });
    expect(req().reply).toMatch(/^files\.fb-treemap\./);
    const treeReply = req().reply;
    h.frame(30); // loading state, no reply yet
    expect(h.hasText(/scanning/)).toBe(true);
    h.publish(treeReply, reply(proj));
    h.frame(30);
    for (const t of [/^data\//, /^video\.mp4/, '~', 'proj', /^Data \d+%$/, /^Video \d+%$/, /^1\.44 GB · 7 files/]) expect(h.hasText(t), String(t)).toBe(true);
    expect(h.emitsOn('path').at(-1)).toBe(`${HOME}/proj`);
    expect(h.rec.setProps).toEqual([]); // path prop already '~/proj'

    // zoom into "src" via the open input (same code path as a pinch on its tile)
    h.input('open', 'src');
    expect(req()).toMatchObject({ cmd: 'tree', path: `${HOME}/proj/src` });
    h.frame(40); // zoom animation, then the provisional layout from the depth-2 data
    expect(h.hasText(/^main\.ts/)).toBe(true);
    const src = proj.children!.find((c) => c.name === 'src')!;
    h.publish(treeReply, reply(src));
    h.frame(5);
    expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj/src' });
    expect(h.hasText('src')).toBe(true);

    // a file tile previews (with syntax highlighting text + line numbers)
    h.input('open', 'main.ts');
    expect(req()).toMatchObject({ cmd: 'preview', path: `${HOME}/proj/src/main.ts` });
    expect(h.emitsOn('selected').at(-1)).toBe(`${HOME}/proj/src/main.ts`);
    h.publish(req().reply, { kind: 'preview', path: `${HOME}/proj/src/main.ts`, name: 'main.ts', size: 30, mtime: Date.now(), type: 'text', text: 'const a = 1;\nexport {}', lines: 2 });
    h.frame();
    expect(h.hasText('const a = 1;\nexport {}')).toBe(true);
    expect(h.hasText('1\n2')).toBe(true);
    h.press('pv:ask', 'drag');
    expect(h.rec.asks.at(-1)).toContain('main.ts');
    h.press('pv:close', 'drag');
    h.frame();
    expect(h.hasText('const a = 1;\nexport {}')).toBe(false);

    // breadcrumb "proj" (cached) → zooms back out at once
    const crumb = h.liveParts().find((o) => o.name.startsWith('crumb:') && o.userData.path === '~/proj');
    expect(crumb).toBeTruthy();
    h.press(crumb!.name, 'drag');
    expect(req()).toMatchObject({ cmd: 'tree', path: '~/proj' });
    h.frame(40);
    expect(h.hasText(/^video\.mp4/)).toBe(true);
    expect(h.rec.errors).toEqual([]);
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
  });

  it('pinch on the map: tap opens, drag does not; hover shows a tooltip', async () => {
    const h = await mount(fbTreemap, { path: '~/proj' });
    const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string };
    h.publish(req().reply, reply(proj));
    h.frame(30);
    // find the video tile through the layout the widget uses: probe the map with hover
    const map = h.part('map');
    const box = new (await import('three')).Box3().setFromObject(map);
    let found: [number, number, number] | null = null;
    for (let y = box.max.y - 0.01; y > box.min.y && !found; y -= 0.01) {
      for (let x = box.min.x + 0.01; x < box.max.x && !found; x += 0.01) {
        h.interact({ handler: 'hover', phase: 'move', objectName: 'map', localPoint: [x, y, 0.005] });
        if (h.hasText(/^video\.mp4$/) && h.hasText(/pinch: preview/)) found = [x, y, 0.005];
      }
    }
    expect(found).not.toBeNull();
    expect(h.hasText(/300 MB|286 MB/)).toBe(true);
    const before = h.rec.published.length;
    // a drag is not a tap
    h.interact({ handler: 'drag', phase: 'start', objectName: 'map', localPoint: found! });
    h.interact({ handler: 'drag', phase: 'move', objectName: 'map', localPoint: [found![0] + 0.05, found![1], found![2]] });
    h.interact({ handler: 'drag', phase: 'end', objectName: 'map', localPoint: [found![0] + 0.05, found![1], found![2]] });
    // a cancelled press does nothing
    h.interact({ handler: 'drag', phase: 'start', objectName: 'map', localPoint: found! });
    h.interact({ handler: 'drag', phase: 'cancel', objectName: 'map', localPoint: found! });
    expect(h.rec.published.length).toBe(before);
    h.interact({ handler: 'drag', phase: 'start', objectName: 'map', localPoint: found! });
    h.interact({ handler: 'drag', phase: 'end', objectName: 'map', localPoint: found! });
    expect(req()).toMatchObject({ cmd: 'preview', path: `${HOME}/proj/video.mp4` });
    h.interact({ handler: 'hover', phase: 'end', objectName: 'map', localPoint: found! });
    expect(h.hasText(/pinch: preview/)).toBe(false);
    h.dispose();
  });

  it('shows partial scans, errors, unknown folders and the "+N more" tail', async () => {
    const h = await mount(fbTreemap, { path: '~/big' });
    const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string };
    const big = d('big', Array.from({ length: 150 }, (_, i) => f(`f${i}.log`, i < 4 ? 1e9 : 3e6 + i, `${HOME}/big`)), HOME);
    h.publish(req().reply, reply(big, { partial: true }));
    h.frame(30);
    expect(h.hasText(/^≥ 4\.\d+ GB · 150 files/)).toBe(true);
    expect(h.hasText(/partial scan/)).toBe(true);
    expect(h.hasText(/^\+146 more/)).toBe(true);
    h.input('open', '+146'); // not a name: ignored with an event
    expect(h.rec.events.at(-1)?.name).toBe('fb-treemap.open');
    // the up button / input goes to the parent
    h.input('up', true);
    expect(req()).toMatchObject({ cmd: 'tree', path: '~' });
    h.publish(req().reply, { kind: 'tree', path: HOME, display: '~', root: null, partial: false, error: 'Permission denied' });
    h.frame(30);
    expect(h.hasText('Permission denied')).toBe(true);
    h.publish(req().reply, { kind: 'tree', path: '/other', display: '/other', root: { junk: true }, partial: false }); // someone else's / malformed
    h.publish(req().reply, 'garbage');
    h.frame(5);
    expect(h.rec.errors.filter((e) => !/malformed/.test(e.message))).toEqual([]);
    h.dispose();
  });
});
