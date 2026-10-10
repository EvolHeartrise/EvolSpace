// fb-columns — Miller columns on an arc: chain restore, one pinch per level, scrolling, back (button,
// swipe, header, crumbs), previews, persistence, commands.
import { expect, it } from 'vitest';
import fbColumns, { age, arcPlace, baseName, chainFor, findEntry, iconFor, joinPath, metaLabel, type Entry } from '../widgets/fb-columns/widget.ts';
import { mount, type Harness } from './harness.ts';

const HOME = '/home/u';
type Req = { cmd: string; path: string; reply: string; nonce: number; hidden?: boolean };

const requests = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').map((p) => p.value as Req);
const lastReq = (h: Harness, cmd = 'list') => requests(h).filter((r) => r.cmd === cmd).at(-1)!;
const abs = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? `${HOME}/${p.slice(2)}` : p);
const disp = (p: string) => (p === HOME ? '~' : p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p);

function entries(spec: string): Entry[] {
  // "dir/ file.ts" → dirs end with '/'
  return spec.split(' ').filter(Boolean).map((n) => n.endsWith('/')
    ? { name: n.slice(0, -1), type: 'dir' as const, size: null, mtime: Date.now() - 2 * 86400_000, ext: '' }
    : { name: n, type: 'file' as const, size: 2048, mtime: Date.now() - 3600_000, ext: n.includes('.') ? n.split('.').pop()! : '' });
}

/** Answer a list request like the files source would. */
function answer(h: Harness, r: Req, spec: string, extra: Record<string, unknown> = {}) {
  const a = abs(r.path);
  h.publish(r.reply, { kind: 'list', path: a, display: disp(a), parent: a === '/' ? null : a.slice(0, a.lastIndexOf('/')) || '/', entries: entries(spec), truncated: false, nonce: r.nonce, ...extra });
}

const FS: Record<string, string> = {
  [HOME]: 'git projects/ notes.md',
  [`${HOME}/git projects`]: 'EvolSpace/ other/',
  [`${HOME}/git projects/EvolSpace`]: 'apps/ library/ packages/ README.md package.json',
  [`${HOME}/git projects/EvolSpace/library`]: 'shared/ widgets/ README.md',
  [`${HOME}/git projects/EvolSpace/library/widgets`]: 'fb-columns/ gauge/ README.md',
  [`${HOME}/git projects/EvolSpace/library/widgets/gauge`]: 'widget.ts',
};

/** Answer every outstanding list request (latest per reply channel). */
function serve(h: Harness) {
  const seen = new Set<string>();
  for (const r of requests(h).reverse()) {
    if (r.cmd !== 'list' || seen.has(r.reply)) continue;
    seen.add(r.reply);
    answer(h, r, FS[abs(r.path)] ?? '');
  }
  h.frame(40);
}

it('helpers: chains, paths, labels, arc', () => {
  expect(chainFor('~/git projects/EvolSpace')).toEqual(['~', '~/git projects', '~/git projects/EvolSpace']);
  expect(chainFor('/usr/lib/')).toEqual(['/', '/usr', '/usr/lib']);
  expect(chainFor('D:\\Git\\x')).toEqual(['D:\\', 'D:\\Git', 'D:\\Git\\x']);
  expect(chainFor('')).toEqual(['~']);
  expect(chainFor('/' + Array.from({ length: 40 }, (_, i) => `d${i}`).join('/'))).toHaveLength(24);
  expect(joinPath('/', 'a')).toBe('/a');
  expect(joinPath('~/a', 'b')).toBe('~/a/b');
  expect(baseName('~/git projects/EvolSpace')).toBe('EvolSpace');
  expect(baseName('~')).toBe('~');
  expect(baseName('/')).toBe('/');
  expect(iconFor({ type: 'dir', ext: '' })[0]).toBe('folder');
  expect(iconFor({ type: 'file', ext: 'py' })[0]).toBe('file-code');
  const now = Date.parse('2026-10-09T12:00:00Z');
  expect(age(now - 5 * 60_000, now)).toBe('5m');
  expect(age(now - 90 * 86400_000, now)).toBe('3mo');
  expect(metaLabel({ name: 'a', type: 'dir', size: null, mtime: now - 2 * 86400_000, ext: '' }, now)).toBe('2d  ›');
  expect(metaLabel({ name: 'a.ts', type: 'file', size: 2048, mtime: now - 3600_000, ext: 'ts' }, now)).toBe('2.0 KB · 1h');
  expect(findEntry(entries('apps/ library/ README.md'), 'read')).toBe(2);
  expect(findEntry(entries('apps/ library/ README.md'), 'LIB')).toBe(1);
  expect(findEntry(entries('apps/'), 'zzz')).toBe(-1);
  expect(arcPlace(0.3, 0)).toEqual({ x: 0.3, z: 0, ry: 0 });
  const p = arcPlace(Math.PI / 2 * 1.5, 1.5); // quarter circle
  expect(p.x).toBeCloseTo(1.5);
  expect(p.z).toBeCloseTo(1.5);
  expect(p.ry).toBeCloseTo(-Math.PI / 2);
});

it('restores the column chain of the start path, one reply channel per depth', async () => {
  const h = await mount(fbColumns, { path: '~/git projects/EvolSpace' });
  const lists = requests(h).filter((r) => r.cmd === 'list');
  expect(lists.map((r) => r.path)).toEqual(['~', '~/git projects', '~/git projects/EvolSpace']);
  expect(new Set(lists.map((r) => r.reply)).size).toBe(3);
  for (const r of lists) expect(r.reply.startsWith('files.fb-columns.test-entity.')).toBe(true);
  serve(h);
  for (const t of ['Home', 'EvolSpace', 'git projects', 'apps', 'README.md', '5 items', '2.0 KB · 1h']) expect(h.hasText(t), t).toBe(true);
  // ancestors keep the opened folder highlighted; it is the visible path
  expect(h.rec.errors).toEqual([]);
  // stale replies (wrong nonce, other folder) are ignored
  answer(h, { ...lists[2], nonce: 1 }, 'bogus.txt', { path: '/elsewhere', display: '/elsewhere' });
  h.frame();
  expect(h.hasText('bogus.txt')).toBe(false);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('one pinch per level, slides old columns into crumbs, back by button / swipe / header / crumb', async () => {
  const h = await mount(fbColumns, { path: '~/git projects/EvolSpace', columns: 3 });
  serve(h);
  const rowOf = (name: string): string => {
    for (const o of h.liveParts()) {
      if (!o.name.startsWith('row:')) continue;
      const [, v, r] = o.name.split(':').map(Number);
      // find the view whose names text lists `name` at row r
      const g = o.parent!;
      const names = g.children.find((c) => (c as unknown as { text?: string }).text?.includes(name) && (c as unknown as { anchorY?: string }).anchorY === 'top' && (c as unknown as { anchorX?: string }).anchorX === 'left') as unknown as { text: string } | undefined;
      if (names && names.text.split('\n')[r] === name && v >= 0) return o.name;
    }
    throw new Error(`no row ${name}`);
  };
  h.press(rowOf('library'), 'drag');
  expect(lastReq(h)).toMatchObject({ cmd: 'list', path: `${HOME}/git projects/EvolSpace/library` });
  serve(h);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~/git projects/EvolSpace/library' });
  expect(h.emitsOn('folder').at(-1)).toBe('~/git projects/EvolSpace/library');
  // 4 levels with 3 visible columns: "~" slid out into a crumb
  expect(h.hasText('PATH')).toBe(true);
  h.press(rowOf('widgets'), 'drag');
  serve(h);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~/git projects/EvolSpace/library/widgets' });
  expect(h.hasText('PATH')).toBe(true);
  expect(h.liveParts().filter((o) => o.name.startsWith('rail:crumb:')).length).toBe(2); // ~, git projects

  // back button: one level up, the folder we came from stays highlighted
  h.press('rail:back', 'drag');
  h.frame(40);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~/git projects/EvolSpace/library' });
  // swipe right inside a column: back again
  const part = rowOf('apps');
  h.drag(part, [0.1, 0.005, 0]);
  h.frame(40);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~/git projects/EvolSpace' });
  // tapping the highlighted folder of an ancestor jumps there; tapping a crumb jumps back to root
  h.press(rowOf('library'), 'drag');
  serve(h);
  h.press(rowOf('widgets'), 'drag');
  serve(h);
  h.press('rail:crumb:0', 'drag');
  h.frame(40);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~' });
  expect(requests(h).filter((r) => r.cmd === 'list').length).toBeGreaterThan(5);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
});

it('scrolls with pinch-drag (no tap), ignores cancelled presses', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`).join(' ');
  const h = await mount(fbColumns, { path: '/data', rows: 8 });
  for (const r of requests(h)) answer(h, r, r.path === '/data' ? many : 'data/');
  h.frame(40);
  expect(h.hasText('f00.txt')).toBe(true);
  expect(h.hasText('f20.txt')).toBe(false);
  // the deepest column (the one with 8 live rows) lists f00…f07
  const views = h.liveParts().filter((o) => o.name.startsWith('row:') && o.name.endsWith(':0')).map((o) => o.name.split(':')[1]);
  const v = views.find((vv) => h.liveParts().some((o) => o.name === `row:${vv}:7`))!;
  const before = requests(h).length;
  h.drag(`row:${v}:0`, [0, 0.036 * 12, 0], { steps: 6 });
  h.frame();
  expect(h.hasText('f12.txt')).toBe(true);
  expect(h.hasText('f00.txt')).toBe(false);
  expect(requests(h).length).toBe(before); // a drag is not a tap
  h.interact({ handler: 'drag', phase: 'start', objectName: `row:${v}:0`, localPoint: h.partPosition(`row:${v}:0`) });
  h.interact({ handler: 'drag', phase: 'cancel', objectName: `row:${v}:0`, localPoint: h.partPosition(`row:${v}:0`) });
  expect(requests(h).length).toBe(before);
  h.dispose();
});

it('previews files with syntax highlighting, persists the file, closes, asks Claude', async () => {
  const h = await mount(fbColumns, { path: '~/git projects/EvolSpace/library/widgets/gauge' });
  serve(h);
  const v = h.liveParts().find((o) => o.name.startsWith('row:') && (o.parent!.children.some((c) => (c as unknown as { text?: string }).text === 'widget.ts')))!;
  h.press(v.name, 'drag');
  const pr = lastReq(h, 'preview');
  expect(pr).toMatchObject({ path: `${HOME}/git projects/EvolSpace/library/widgets/gauge/widget.ts` });
  expect(h.emitsOn('selected').at(-1)).toBe(pr.path);
  expect(h.rec.setProps.at(-1)).toMatchObject({ file: '~/git projects/EvolSpace/library/widgets/gauge/widget.ts' });
  h.publish(pr.reply, { kind: 'preview', path: pr.path, name: 'widget.ts', size: 40, mtime: Date.now(), type: 'text', text: 'const a = 1;\n// hi\nexport default a;', lines: 3, nonce: pr.nonce });
  h.frame(40);
  expect(h.hasText('const a = 1;\n// hi\nexport default a;')).toBe(true);
  expect(h.hasText('1\n2\n3')).toBe(true);
  expect(h.hasText('3 lines')).toBe(true);
  const body = h.texts.find((t) => t.text.startsWith('const a'))!;
  expect(body.colorRanges).not.toBeNull();
  h.press('pv:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain('gauge/widget.ts');
  h.press('pv:close', 'drag');
  h.frame(40);
  expect(h.hasText('export default a;')).toBe(false);
  expect(h.rec.setProps.at(-1)).toMatchObject({ file: '' });
  // image + binary previews don't throw in Node
  h.input('preview', '~/pics/cat.png');
  const ir = lastReq(h, 'preview');
  h.publish(ir.reply, { kind: 'preview', path: `${HOME}/pics/cat.png`, name: 'cat.png', type: 'image', src: '/media/preview-x.jpg', nonce: ir.nonce });
  h.frame(5);
  expect(h.hasText('cat.png')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('restores a persisted file preview and handles commands, props and errors', async () => {
  const h = await mount(fbColumns, { path: '~/git projects/EvolSpace', file: '~/git projects/EvolSpace/README.md' });
  expect(lastReq(h, 'preview')).toMatchObject({ path: '~/git projects/EvolSpace/README.md' });
  serve(h);
  h.input('command', 'open lib');
  expect(lastReq(h)).toMatchObject({ path: `${HOME}/git projects/EvolSpace/library` });
  serve(h);
  h.input('command', 'back');
  h.frame(40);
  expect(h.rec.setProps.at(-1)).toMatchObject({ path: '~/git projects/EvolSpace' });
  h.input('command', 'home');
  expect(lastReq(h)).toMatchObject({ path: '~' });
  h.input('command', 'hidden');
  expect(h.rec.setProps.at(-1)).toMatchObject({ showHidden: true });
  expect(lastReq(h).hidden).toBe(true);
  h.input('command', 'open nothing-like-this');
  h.input('command', 'dance');
  expect(h.rec.events.map((e) => e.name)).toEqual(['fb-columns.notfound', 'fb-columns.unknown-command']);
  await h.setProps({ path: '/srv' });
  expect(lastReq(h)).toMatchObject({ path: '/srv' });
  answer(h, lastReq(h), '', { error: 'Permission denied' });
  h.frame(40);
  expect(h.hasText('Permission denied')).toBe(true);
  await h.setProps({ columns: 4, rows: 16, radius: 0 });
  h.frame(40);
  expect(h.hasText('Permission denied')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('screenshots (mirror) never persist navigation', async () => {
  const h = await mount(fbColumns, { path: '/x' }, { isMirror: true });
  for (const r of requests(h)) answer(h, r, 'a/');
  h.frame(10);
  expect(h.rec.setProps).toEqual([]);
  h.dispose();
});

it("video previews: converting notice, then the converted file (another client's reply counts too)", async () => {
  const h = await mount(fbColumns, { path: '~/git projects/EvolSpace' });
  serve(h);
  h.input('preview', '~/videos/clip.mov');
  const vr = lastReq(h, 'preview');
  const path = `${HOME}/videos/clip.mov`;
  h.publish(vr.reply, { kind: 'preview', path, name: 'clip.mov', size: 1e6, type: 'video', converting: true, nonce: vr.nonce });
  h.frame(5);
  expect(h.hasText('Converting this video for the headset…')).toBe(true);
  // the follow-up arrives with another client's nonce: still ours (same file)
  h.publish(vr.reply, { kind: 'preview', path, name: 'clip.mov', size: 1e6, type: 'video', src: '/media/video-x.mp4', nonce: 12345 });
  h.frame(5);
  expect(h.hasText('Converting this video for the headset…')).toBe(false);
  expect(h.hasText('Video plays in the headset / browser')).toBe(true); // no DOM in tests
  h.press('pv:close', 'drag');
  h.frame(5);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
