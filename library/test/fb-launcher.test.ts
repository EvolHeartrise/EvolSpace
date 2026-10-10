// fb-launcher — search-first file launcher: model helpers, files protocol, keyboard, control channel, pins.
import { expect, it } from 'vitest';
import * as THREE from 'three';
import launcher from '../widgets/fb-launcher/widget.ts';
import {
  ageLabel, categoryOf, completions, highlightRanges, KEY_ROWS, matchIndices, nextKeys, normQuery, parentOf, parseCtl, relFolder,
} from '../widgets/fb-launcher/model.ts';
import { mount, type Harness } from './harness.ts';

const HOME = '/home/u';
const hit = (display: string, type: 'file' | 'dir' = 'file', mtime = Date.now() - 3600_000) => {
  const name = display.split('/').pop()!;
  return { name, path: display.replace(/^~/, HOME), display, type, size: type === 'file' ? 2048 : null, mtime, ext: type === 'file' && name.includes('.') ? name.split('.').pop()! : '', score: 1 };
};
const reqs = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').map((p) => p.value as Record<string, unknown>);
const lastReq = (h: Harness, cmd?: string) => reqs(h).filter((r) => !cmd || r.cmd === cmd).at(-1)!;
const reply = (h: Harness, query: string, results: ReturnType<typeof hit>[], extra: Record<string, unknown> = {}) => {
  const r = lastReq(h, 'search');
  h.publish(r.reply as string, { kind: 'search', path: `${HOME}/git projects`, display: '~/git projects', query, results, scanned: 100, partial: false, nonce: r.nonce, ...extra } as never);
  h.frame();
};
/** Root-space point of key (row, col): the 'kb' hit box spans the 4×10 key grid. */
function keyPoint(h: Harness, ch: string): [number, number, number] {
  const r = KEY_ROWS.findIndex((row) => row.includes(ch)), c = KEY_ROWS[r].indexOf(ch);
  const kb = h.part('kb');
  h.root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3((c + 0.5) / 10 - 0.5, 0.5 - (r + 0.5) / KEY_ROWS.length, 0).applyMatrix4(kb.matrixWorld);
  h.root.worldToLocal(v);
  return [v.x, v.y, v.z];
}
function tapKey(h: Harness, ch: string, handler = 'press'): void {
  const p = keyPoint(h, ch);
  h.interact({ handler, phase: 'start', objectName: 'kb', localPoint: p });
  h.interact({ handler, phase: 'end', objectName: 'kb', localPoint: p });
}
const settle = (h: Harness) => h.frame(15); // > 150 ms debounce

it('model: matching, highlighting, completions, predictions, paths, ages', () => {
  expect(matchIndices('widget.ts', 'get')).toEqual([3, 4, 5]);
  expect(matchIndices('file-browser.ts', 'fbr')).toEqual([0, 5, 6]);
  expect(matchIndices('abc', 'x')).toEqual([]);
  expect(highlightRanges([3, 4, 5], 1, 2)).toEqual({ 0: 1, 3: 2, 6: 1 });
  expect(highlightRanges([0, 5, 6], 1, 2)).toEqual({ 0: 2, 1: 1, 5: 2, 7: 1 });
  expect(highlightRanges([0, 8], 1, 2, 5)).toEqual({ 0: 2, 1: 1 });
  const names = ['widget.ts', 'widget.ts', 'widgets', 'widget.test.ts'];
  expect(completions(names, 'wid')[0]).toBe('widget');
  expect(completions(names, 'widget')).toContain('widget.ts');
  expect(nextKeys(names, 'widget')[0]).toBe('.');
  expect(categoryOf({ type: 'file', ext: 'py' })).toBe('code');
  expect(categoryOf({ type: 'file', ext: 'png' })).toBe('images');
  expect(categoryOf({ type: 'dir', ext: '' })).toBe('folders');
  expect(relFolder('~/s/a/b/x.ts', '~/s')).toBe('a/b');
  expect(relFolder('~/s/x.ts', '~/s/')).toBe('');
  expect(parentOf('~/git projects/EvolSpace')).toBe('~/git projects');
  expect(parentOf('~')).toBe('~/..');
  const now = Date.parse('2026-10-09T12:00:00Z');
  expect(ageLabel(now - 5 * 60_000, now)).toBe('5m');
  expect(ageLabel(now - 3 * 86400_000, now)).toBe('3d');
  expect(normQuery('Widget dot TS.', true)).toBe('widget.ts');
  expect(normQuery('file browser', true)).toBe('filebrowser');
});

it('model: control-channel parsing', () => {
  expect(parseCtl({ cmd: 'query', text: 'Widget.ts' })).toEqual({ cmd: 'query', text: 'widget.ts', entity: undefined });
  expect(parseCtl('resid flow')).toEqual({ cmd: 'query', text: 'residflow' });
  expect(parseCtl({ cmd: 'open', index: 'three' })).toMatchObject({ cmd: 'open', index: 3 });
  expect(parseCtl({ cmd: 'open', index: '7' })).toMatchObject({ cmd: 'open', index: 7 });
  expect(parseCtl({ cmd: 'open', index: 0 })).toBeNull();
  expect(parseCtl({ cmd: 'filter', filter: 'pictures' })).toMatchObject({ cmd: 'filter', filter: 'images' });
  expect(parseCtl({ cmd: 'scope', path: '~/notes/' })).toMatchObject({ cmd: 'scope', path: '~/notes' });
  expect(parseCtl({ cmd: 'nope' })).toBeNull();
  expect(parseCtl(42)).toBeNull();
});

it('shows recents, searches with debounce, highlights matches, opens a preview, pins', async () => {
  const h = await mount(launcher, {});
  h.frame();
  expect(lastReq(h)).toMatchObject({ cmd: 'search', path: '~/git projects', query: '' });
  expect(String(lastReq(h).reply)).toBe('files.fb-launcher.test-entity.search');
  reply(h, '', [hit('~/git projects/EvolSpace/library/widgets/gauge/widget.ts'), hit('~/git projects/notes.md')]);
  for (const t of ['RECENT', 'widget.ts', 'EvolSpace/library/widgets/gauge/', 'notes.md', '1h', '~/git projects', '2 items']) expect(h.hasText(t), t).toBe(true);

  // typing on the keyboard: no request until the debounce elapses, then one for the final query
  const before = reqs(h).length;
  for (const ch of 'wid') tapKey(h, ch);
  expect(h.hasText('wid')).toBe(true);
  expect(reqs(h).length).toBe(before);
  settle(h);
  expect(reqs(h).length).toBe(before + 1);
  expect(lastReq(h)).toMatchObject({ cmd: 'search', query: 'wid' });
  expect(h.emitsOn('query').at(-1)).toBe('wid');
  // stale reply (older query) is ignored
  reply(h, 'w', [hit('~/git projects/w.txt')]);
  expect(h.hasText('w.txt')).toBe(false);
  reply(h, 'wid', [hit('~/git projects/EvolSpace/a/widget.ts'), hit('~/git projects/EvolSpace/a/widgets', 'dir'), hit('~/git projects/b/widget.ts')]);
  expect(h.hasText('3 matches')).toBe(true);
  expect(h.hasText('widget')).toBe(true); // completion chip
  const name = h.texts.find((t) => t.text === 'widget.ts' && h.live(t))!;
  expect(name.colorRanges![0]).toBe(0x4cc3ff); // 'wid' at 0 → accent
  expect(name.colorRanges![3]).toBe(0xe9eef5);
  expect(h.hasText('1\n2\n3')).toBe(true); // numbered rows

  // pinch result 1 → preview
  h.press('row:0', 'drag');
  expect(lastReq(h)).toMatchObject({ cmd: 'preview', path: `${HOME}/git projects/EvolSpace/a/widget.ts`, reply: 'files.fb-launcher.test-entity.preview' });
  expect(h.emitsOn('selected').at(-1)).toBe(`${HOME}/git projects/EvolSpace/a/widget.ts`);
  expect(h.rec.setProps.at(-1)).toEqual({ history: ['wid'] });
  h.publish('files.fb-launcher.test-entity.preview', { kind: 'preview', path: `${HOME}/git projects/EvolSpace/a/widget.ts`, name: 'widget.ts', size: 30, mtime: Date.now(), type: 'text', text: 'const a = 1;\nexport default a;', lines: 2 });
  h.frame();
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(true);
  expect(h.hasText('1\n2')).toBe(true);
  h.press('btn:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain('widget.ts');
  h.press('btn:close', 'drag');
  h.frame();
  expect(h.hasText('export default a;')).toBe(false);

  // pin result 3, then clear: it shows under PINNED
  h.press('pin:2', 'drag');
  expect((h.rec.setProps.at(-1)!.pins as Array<{ path: string }>)[0].path).toBe(`${HOME}/git projects/b/widget.ts`);
  h.press('btn:clear', 'drag');
  h.frame();
  expect(h.hasText('PINNED')).toBe(true);
  expect(h.hasText('wid')).toBe(true); // recent query chip
  expect(h.hasText('notes.md')).toBe(true); // cached recents show at once, before the fresh reply
  h.press('chip:0', 'drag');
  expect(h.hasText(/^wid$/)).toBe(true);

  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('keyboard: cancelled and slid-off presses never type; backspace; hold deletes words', async () => {
  const h = await mount(launcher, {});
  h.frame();
  const p = keyPoint(h, 'q');
  h.interact({ handler: 'drag', phase: 'start', objectName: 'kb', localPoint: p });
  h.interact({ handler: 'drag', phase: 'cancel', objectName: 'kb', localPoint: p });
  h.interact({ handler: 'press', phase: 'start', objectName: 'kb', localPoint: p });
  h.interact({ handler: 'press', phase: 'move', objectName: 'kb', localPoint: [p[0] + 0.1, p[1], p[2]] });
  h.interact({ handler: 'press', phase: 'end', objectName: 'kb', localPoint: [p[0] + 0.1, p[1], p[2]] });
  expect(h.emitsOn('query')).toEqual([]);
  for (const ch of 'ab.c') tapKey(h, ch, 'drag');
  expect(h.emitsOn('query').at(-1)).toBe('ab.c');
  tapKey(h, '\b');
  expect(h.emitsOn('query').at(-1)).toBe('ab.');
  // hold backspace: deletes by words after 0.5 s and does not also delete a char on release
  const b = keyPoint(h, '\b');
  h.interact({ handler: 'press', phase: 'start', objectName: 'kb', localPoint: b });
  h.frame(45); // ~0.6 s
  expect(h.emitsOn('query').at(-1)).toBe('ab');
  h.interact({ handler: 'press', phase: 'end', objectName: 'kb', localPoint: b });
  expect(h.emitsOn('query').at(-1)).toBe('ab');
  h.dispose();
});

it('control channel: ignores the value present at subscribe, then query/open/filter/scope/pop/clear', async () => {
  const h = await mount(launcher, {}, { channels: { 'files.launcher.ctl': { cmd: 'query', text: 'old' } } });
  h.frame();
  expect(h.emitsOn('query')).toEqual([]);
  h.publish('files.launcher.ctl', { cmd: 'query', text: 'Widget dot TS.' });
  h.frame();
  expect(lastReq(h)).toMatchObject({ cmd: 'search', query: 'widget.ts' });
  reply(h, 'widget.ts', [hit('~/git projects/a/widget.ts'), hit('~/git projects/b/widget.ts'), hit('~/git projects/c/pic.png')]);
  h.publish('files.launcher.ctl', { cmd: 'open', index: 2 });
  expect(lastReq(h)).toMatchObject({ cmd: 'preview', path: `${HOME}/git projects/b/widget.ts` });
  h.publish('files.launcher.ctl', { cmd: 'open', index: 2, entity: 'someone-else' });
  expect(reqs(h).filter((r) => r.cmd === 'preview').length).toBe(1);
  h.publish('files.launcher.ctl', { cmd: 'filter', filter: 'images' });
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ filter: 'images' });
  expect(h.hasText('pic.png')).toBe(true); // type filters apply client-side, immediately
  expect(h.visibleTexts().filter((t) => t === 'widget.ts').length).toBe(1); // only the query field, no rows
  h.publish('files.launcher.ctl', { cmd: 'scope', path: '~/git projects/EvolSpace' });
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ scope: '~/git projects/EvolSpace' });
  expect(lastReq(h)).toMatchObject({ cmd: 'search', path: '~/git projects/EvolSpace', query: '' });
  h.publish('files.launcher.ctl', { cmd: 'pop' });
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ scope: '~/git projects' });
  h.publish('files.launcher.ctl', 'notes');
  h.frame(15);
  expect(lastReq(h)).toMatchObject({ query: 'notes' });
  h.publish('files.launcher.ctl', { cmd: 'clear' });
  expect(h.emitsOn('query').at(-1)).toBe('');
  h.publish('files.launcher.ctl', { cmd: 'bogus' });
  expect(h.rec.errors).toEqual([]);
  h.dispose();
});

it('opening a folder makes it the scope; the scope chip pops back', async () => {
  const h = await mount(launcher, { scope: '~/git projects' });
  h.frame();
  h.input('query', 'evol');
  h.frame();
  reply(h, 'evol', [hit('~/git projects/EvolSpace', 'dir')]);
  expect(h.hasText('folder')).toBe(true);
  h.press('row:0', 'drag');
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ scope: '~/git projects/EvolSpace' });
  expect(h.hasText('~/git projects/EvolSpace')).toBe(true);
  expect(lastReq(h)).toMatchObject({ path: '~/git projects/EvolSpace', query: '' });
  h.press('btn:pop', 'drag');
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ scope: '~/git projects' });
  h.press('btn:pop', 'drag'); // empty stack → parent folder
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ scope: '~' });
  h.dispose();
});

it('re-asks when a request gets no reply, and reports an offline source', async () => {
  const h = await mount(launcher, {});
  h.frame();
  const n0 = reqs(h).length;
  h.frame(72 * 4); // 4 s
  expect(reqs(h).length).toBe(n0 + 1);
  h.frame(72 * 10);
  expect(h.hasText(/No reply from the 'files' source/)).toBe(true);
  reply(h, '', [], { error: 'Permission denied' });
  expect(h.hasText('Permission denied')).toBe(true);
  h.dispose();
});

it('survives junk replies and prop changes', async () => {
  const h = await mount(launcher, { pins: [{ path: '/x/a.md', name: 'a.md' }, 'junk', null] });
  h.frame();
  expect(h.hasText('PINNED')).toBe(true);
  expect(h.hasText('a.md')).toBe(true);
  const { reply: r, nonce } = lastReq(h, 'search') as { reply: string; nonce: number };
  for (const v of [null, 5, 'x', [], { kind: 'search' }, { kind: 'search', query: '', nonce, results: [null, { name: 3 }, { name: 'ok.txt', path: '/p/ok.txt' }] }]) h.publish(r, v as never);
  h.frame();
  expect(h.hasText('ok.txt')).toBe(true);
  await h.setProps({ rows: 5, keyboard: false, tilt: 40 });
  h.frame();
  expect(() => h.part('kb')).toThrow();
  await h.setProps({ keyboard: true });
  h.frame();
  expect(h.part('kb')).toBeTruthy();
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
