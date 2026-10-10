// fb-shelf — the bookcase file browser: layout (folders first, log sizes, pages), hit lookup, the row
// of ancestor cases, hover labels, pinch / pull-out to open a book, page turning, closing, navigation
// into boxes and back via the ancestor case, sorting, paging.
import { expect, it } from 'vitest';
import * as THREE from 'three';
import fbShelf from '../widgets/fb-shelf/widget.ts';
import {
  bookThickness, boxWidth, caseDims, categoryOf, type Entry, layoutCase, pageSlots, parentOf, pathChain, shelfGeometry, slotAt, sortEntries,
} from '../widgets/fb-shelf/layout.ts';
import { mount, type Harness } from './harness.ts';

const HOME = '/home/u';
type Req = { cmd: string; path: string; reply: string; nonce: number; depth?: number };

const requests = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').map((p) => p.value as Req);
const lastReq = (h: Harness, cmd = 'list') => requests(h).filter((r) => r.cmd === cmd).at(-1)!;
const abs = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? `${HOME}/${p.slice(2)}` : p);
const disp = (p: string) => (p === HOME ? '~' : p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p);
const NOW = Date.now();

function entries(spec: string): Entry[] {
  return spec.split(' ').filter(Boolean).map((n, i) => n.endsWith('/')
    ? { name: n.slice(0, -1), type: 'dir' as const, size: null, mtime: NOW - (i + 2) * 86400_000, ext: '' }
    : { name: n, type: 'file' as const, size: 2048, mtime: NOW - 3600_000 * (i + 1), ext: n.includes('.') ? n.split('.').pop()! : '' });
}

const FS: Record<string, string> = {
  [HOME]: 'git projects/ notes.md',
  '/home': 'u/',
  '/': 'home/ usr/',
  [`${HOME}/git projects`]: 'EvolSpace/ other/',
  [`${HOME}/git projects/EvolSpace`]: 'apps/ library/ packages/ README.md package.json widget.ts',
  [`${HOME}/git projects/EvolSpace/library`]: 'shared/ widgets/ README.md',
};

function answer(h: Harness, r: Req, spec: string) {
  const a = abs(r.path);
  h.publish(r.reply, { kind: 'list', path: a, display: disp(a), parent: a === '/' ? null : a.slice(0, a.lastIndexOf('/')) || '/', entries: entries(spec), truncated: false, nonce: r.nonce });
}

/** Answer every outstanding list request (latest per reply channel), then settle animations. */
function serve(h: Harness, fs: Record<string, string> = FS) {
  for (let round = 0; round < 3; round++) {
    const seen = new Set<string>();
    for (const r of requests(h).reverse()) {
      if (r.cmd !== 'list' || seen.has(r.reply)) continue;
      seen.add(r.reply);
      answer(h, r, fs[abs(r.path)] ?? '');
    }
  }
  h.frame(90);
}

/** The interactive hit box of the main (front, full-size) case. */
function mainCase(h: Harness): string {
  h.root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3(), s = new THREE.Vector3();
  for (const o of h.liveParts()) {
    if (!o.name.startsWith('case:')) continue;
    o.getWorldPosition(v);
    o.parent!.parent!.getWorldScale(s);
    if (Math.abs(v.x) < 1e-3 && Math.abs(s.x - 1) < 1e-3) return o.name;
  }
  throw new Error('no main case');
}

function ancestorCases(h: Harness): string[] {
  return h.liveParts().filter((o) => o.name.startsWith('case:') && o.name !== mainCase(h)).map((o) => o.name);
}

/** Point on the spine of `name` in the main case (as laid out by the pure layout). */
function spinePoint(listing: string, name: string, sort: 'name' | 'recent' = 'name', sizes?: Map<string, number>): [number, number, number] {
  const dims = caseDims(1.4, 1.6);
  const l = layoutCase(sortEntries(entries(listing), sort), dims, sizes);
  const s = l.slots.find((x) => x.name === name)!;
  const g = shelfGeometry(dims);
  return [s.x, g.base(s.shelf) + s.h / 2, g.front + 0.01];
}

function at(h: Harness, part: string, p: [number, number, number], handler: string, phase: 'start' | 'move' | 'end' | 'cancel', hand: 'left' | 'right' = 'right') {
  h.interact({ handler, phase, objectName: part, localPoint: p, hand });
}

function pinch(h: Harness, part: string, p: [number, number, number], delta: [number, number, number] = [0, 0, 0], end: 'end' | 'cancel' = 'end') {
  at(h, part, p, 'drag', 'start');
  const q: [number, number, number] = [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
  if (delta.some((d) => d !== 0)) { at(h, part, [p[0] + delta[0] / 2, p[1] + delta[1] / 2, p[2] + delta[2] / 2], 'drag', 'move'); at(h, part, q, 'drag', 'move'); }
  at(h, part, q, 'drag', end);
}

const EVOL = `${HOME}/git projects/EvolSpace`;

it('layout: categories, log sizes, folders first on their own shelves, pages, hit lookup', () => {
  expect(categoryOf({ type: 'dir', ext: '', name: 'x' })).toBe('folder');
  expect(categoryOf({ type: 'file', ext: 'ts', name: 'a.ts' })).toBe('code');
  expect(categoryOf({ type: 'file', ext: 'png', name: 'a.png' })).toBe('image');
  expect(categoryOf({ type: 'file', ext: '', name: 'README' })).toBe('doc');
  expect(bookThickness(10)).toBeLessThan(bookThickness(10_000));
  expect(bookThickness(10_000)).toBeLessThan(bookThickness(1e9));
  expect(bookThickness(0)).toBeGreaterThanOrEqual(0.02); // ≥ 2 cm spines (hit lookup covers the gap too)
  expect(boxWidth(1e10)).toBeGreaterThan(boxWidth(1e5));

  const dims = caseDims(1.4, 1.6);
  expect(dims.shelves).toBe(5);
  const sorted = sortEntries(entries('b.ts a/ z.md c/ A.json'), 'name');
  expect(sorted.map((e) => e.name)).toEqual(['a', 'c', 'A.json', 'b.ts', 'z.md']);
  expect(sortEntries(entries('old.ts new.ts'), 'recent').map((e) => e.name)).toEqual(['old.ts', 'new.ts']); // i=0 is newest
  const l = layoutCase(sorted, dims);
  expect(l.pages).toBe(1);
  expect(l.slots.filter((s) => s.folder).every((s) => s.shelf === 0)).toBe(true);
  expect(l.slots.filter((s) => !s.folder).every((s) => s.shelf === 1)).toBe(true); // books start on a fresh shelf
  const books = l.slots.filter((s) => !s.folder);
  for (let i = 1; i < books.length; i++) expect(books[i].x).toBeGreaterThan(books[i - 1].x);

  const many = layoutCase(sortEntries(entries(Array.from({ length: 400 }, (_, i) => `f${i}.ts`).join(' ')), 'name'), dims);
  expect(many.pages).toBeGreaterThan(1);
  const p0 = pageSlots(many, 0);
  expect(p0.every((s) => s.page === 0)).toBe(true);
  const g = shelfGeometry(dims);
  for (const s of p0) expect(s.x + s.w / 2).toBeLessThanOrEqual(g.x1 + 1e-6);
  // hit lookup: the spine centre and a point in the gap after it both find the book
  const s3 = p0[3];
  expect(slotAt(p0, dims, s3.x, g.base(s3.shelf) + 0.05)).toBe(s3);
  expect(slotAt(p0, dims, s3.x + s3.w / 2 + 0.001, g.base(s3.shelf) + 0.05)).toBe(s3);

  expect(parentOf('/a/b')).toBe('/a');
  expect(parentOf('/a')).toBe('/');
  expect(parentOf('/')).toBe(null);
  expect(pathChain('/a/b/c', 3)).toEqual(['/a/b/c', '/a/b', '/a']);
});

it('stands the folder as a case, with ancestors as dimmer cases to the left', async () => {
  const h = await mount(fbShelf, { path: '~/git projects/EvolSpace' });
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: '~/git projects/EvolSpace' });
  expect(lastReq(h).reply).toBe('files.fb-shelf.test-entity.l0');
  serve(h);
  // ancestors requested on their own channels, folder sizes via tree
  expect(requests(h).filter((r) => r.cmd === 'list').map((r) => r.path)).toEqual(expect.arrayContaining([`${HOME}/git projects`, HOME, '/home']));
  expect(lastReq(h, 'tree')).toMatchObject({ path: EVOL, depth: 1 });
  expect(h.hasText('EvolSpace')).toBe(true);
  expect(h.hasText('git projects')).toBe(true);    // ancestor crest
  expect(h.hasText('6 items')).toBe(true);
  expect(h.hasText('README.md')).toBe(true);        // spine label
  expect(h.hasText('library')).toBe(true);          // box label
  expect(ancestorCases(h)).toHaveLength(3);
  expect(h.emitsOn('folder').at(-1)).toBe(EVOL);
  expect(h.rec.setProps).toEqual([]);               // display path unchanged
  // replies for other paths (another client's requests) are ignored
  h.publish('files.fb-shelf.test-entity.l0', { kind: 'list', path: '/tmp', display: '/tmp', parent: '/', entries: entries('x.ts'), truncated: false });
  h.frame(10);
  expect(h.hasText('EvolSpace')).toBe(true);
  expect(h.hasText('6 items')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('hover slides a book out with a label; pinch opens it as a book; tabs turn and close', async () => {
  const h = await mount(fbShelf, { path: '~/git projects/EvolSpace' });
  serve(h);
  const part = mainCase(h);
  const listing = FS[EVOL];
  const pj = spinePoint(listing, 'package.json');
  at(h, part, pj, 'hover', 'start');
  h.frame(30);
  expect(h.hasText('package.json')).toBe(true);
  expect(h.hasText(/data · 2\.0 KB · \d h ago/)).toBe(true);
  at(h, part, pj, 'hover', 'end');

  // tap → flies out, opens, asks for the preview
  pinch(h, part, spinePoint(listing, 'widget.ts'));
  expect(lastReq(h, 'preview')).toMatchObject({ path: `${EVOL}/widget.ts`, reply: 'files.fb-shelf.test-entity.preview' });
  expect(h.lastEmit('selected')).toBe(`${EVOL}/widget.ts`);
  const text = Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
  h.publish('files.fb-shelf.test-entity.preview', { kind: 'preview', path: `${EVOL}/widget.ts`, name: 'widget.ts', size: 2048, mtime: NOW, type: 'text', text, lines: 120 });
  h.frame(80);
  expect(h.hasText('const line1 = 1;')).toBe(true);
  expect(h.hasText(/120 lines/)).toBe(true);
  expect(h.hasText('const line70 = 70;')).toBe(false);
  h.press('book:right', 'drag');                     // tap the right page → next spread
  expect(h.hasText('const line70 = 70;')).toBe(true);
  h.press('book:left', 'drag');                      // back
  expect(h.hasText('const line1 = 1;')).toBe(true);
  h.press('book:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain(`${EVOL}/widget.ts`);
  h.press('book:close', 'drag');
  h.frame(80);
  expect(h.hasText('const line1 = 1;')).toBe(false);
  expect(() => h.part('book:right')).toThrow();      // book folded away, not hittable

  // a sideways drag or a cancelled pinch does nothing; pulling toward you opens
  const n = requests(h).filter((r) => r.cmd === 'preview').length;
  pinch(h, part, spinePoint(listing, 'README.md'), [0.12, 0, 0]);
  pinch(h, part, spinePoint(listing, 'README.md'), [0, 0, 0], 'cancel');
  expect(requests(h).filter((r) => r.cmd === 'preview').length).toBe(n);
  pinch(h, part, spinePoint(listing, 'README.md'), [0, 0, 0.12]);
  expect(lastReq(h, 'preview').path).toBe(`${EVOL}/README.md`);
  h.frame(80);
  // pinching the same book again puts it back
  pinch(h, part, spinePoint(listing, 'README.md'));
  h.frame(80);
  expect(() => h.part('book:close')).toThrow();
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('pinching a box enters the folder; the ancestor case leads back; sort and paging', async () => {
  const h = await mount(fbShelf, { path: '~/git projects/EvolSpace' });
  serve(h);
  h.publish('files.fb-shelf.test-entity.tree', { kind: 'tree', path: EVOL, root: { name: 'EvolSpace', type: 'dir', size: 1e8, files: 900, children: [{ name: 'library', type: 'dir', size: 5e6, files: 120 }, { name: 'apps', type: 'dir', size: 2e7, files: 300 }] } });
  h.frame(60);
  const sizes = new Map([['library', 5e6], ['apps', 2e7]]);
  const part = mainCase(h);
  const lib = spinePoint(FS[EVOL], 'library', 'name', sizes);
  at(h, part, lib, 'hover', 'start');
  expect(h.hasText(/folder · 4\.8 MB · 120 files/)).toBe(true);
  at(h, part, lib, 'hover', 'end');
  pinch(h, part, lib);
  expect(lastReq(h)).toMatchObject({ path: `${EVOL}/library` });
  serve(h);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/git projects/EvolSpace/library' });
  expect(h.hasText('3 items')).toBe(true);
  expect(h.emitsOn('folder').at(-1)).toBe(`${EVOL}/library`);
  // the parent case (now first to the left) takes us back up
  const anc = ancestorCases(h);
  expect(anc.length).toBe(3);
  const parentPart = anc.find((n) => {
    const o = h.part(n); const v = new THREE.Vector3(); o.getWorldPosition(v); return v.x > -1.3;
  })!;
  const pp = h.partPosition(parentPart);
  pinch(h, parentPart, [pp[0], pp[1] - 0.3, pp[2] + 0.1]);
  serve(h);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/git projects/EvolSpace' });
  expect(h.hasText('6 items')).toBe(true);

  // sort toggle persists
  h.press('btn:sort', 'drag');
  expect(h.rec.setProps.at(-1)).toEqual({ sort: 'recent' });
  h.frame(30);
  expect(h.hasText(/newest first/)).toBe(true);

  // up button
  h.press('btn:up', 'drag');
  expect(requests(h).filter((r) => r.cmd === 'list').slice(-4).map((r) => r.path)).toContain(`${HOME}/git projects`);
  serve(h);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/git projects' });

  // a big folder overflows into more cases (pages)
  const big = Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`).join(' ');
  h.input('path', '~/big');
  serve(h, { ...FS, [`${HOME}/big`]: big });
  expect(h.hasText(/case 1 \/ \d/)).toBe(true);
  expect(() => h.part('pg:prev')).toThrow();
  h.press('pg:next', 'drag');
  h.frame(60);
  expect(h.hasText(/case 2 \/ \d/)).toBe(true);
  // open by name (input) turns to the right page and opens the book
  h.input('open', 'f001.ts');
  h.frame(60);
  expect(lastReq(h, 'preview').path).toBe(`${HOME}/big/f001.ts`);
  expect(h.hasText(/case 1 \/ \d/)).toBe(true);
  h.input('open', '');
  expect(h.rec.errors.length).toBe(1);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('keeps the text budget and survives junk replies', async () => {
  const h = await mount(fbShelf, { path: '~/big' });
  const big = Array.from({ length: 300 }, (_, i) => `f${i}.ts`).join(' ') + ' ' + Array.from({ length: 40 }, (_, i) => `d${i}/`).join(' ');
  serve(h, { ...FS, [`${HOME}/big`]: big });
  expect(h.texts.filter((t) => !t.disposed).length).toBeLessThanOrEqual(60);
  h.publish('files.fb-shelf.test-entity.l0', { kind: 'list', path: 5, entries: 'nope' } as never);
  h.publish('files.fb-shelf.test-entity.tree', { kind: 'tree', path: `${HOME}/big` } as never);
  h.publish('files.fb-shelf.test-entity.preview', 42 as never);
  h.frame(5);
  expect(h.rec.errors.length).toBe(1);
  await h.setProps({ width: 1.8, height: 2 });
  serve(h, { ...FS, [`${HOME}/big`]: big });
  expect(h.hasText('big')).toBe(true);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
