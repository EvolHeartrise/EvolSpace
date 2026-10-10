// fb-radial — ring layout, marking-menu flicks, paging, navigation and previews over the files protocol.
import { expect, it } from 'vitest';
import radial, { clockAngle, crumbs, slotAt, slotCount } from '../widgets/fb-radial/widget.ts';
import { mount } from './harness.ts';

it('maps directions to slots and paths to crumbs', () => {
  expect(slotCount(3, 12)).toBe(8);
  expect(slotCount(8, 12)).toBe(8);
  expect(slotCount(9, 12)).toBe(12);
  expect(slotCount(40, 16)).toBe(16);
  expect(slotAt(0, 1, 8)).toBe(0); // 12 o'clock
  expect(slotAt(1, 1, 8)).toBe(1); // NE
  expect(slotAt(1, 0, 8)).toBe(2); // E
  expect(slotAt(0, -1, 8)).toBe(4); // S
  expect(slotAt(-1, 0.05, 8)).toBe(6); // W
  expect(slotAt(-0.1, 1, 8)).toBe(0); // just left of north wraps to 0
  expect(clockAngle(1, 0)).toBeCloseTo(Math.PI / 2);
  expect(crumbs('~/git projects/EvolSpace')).toEqual([
    { label: '~', path: '~' }, { label: 'git projects', path: '~/git projects' }, { label: 'EvolSpace', path: '~/git projects/EvolSpace' }]);
  expect(crumbs('/usr/lib').map((c) => c.path)).toEqual(['/', '/usr', '/usr/lib']);
  expect(crumbs('/')).toEqual([{ label: '/', path: '/' }]);
});

const listing = (path: string, names: Array<[string, 'dir' | 'file']>) => ({
  kind: 'list', path, display: path.replace('/home/u', '~'), parent: path === '/home/u' ? '/home' : path.slice(0, path.lastIndexOf('/')), truncated: false,
  entries: names.map(([name, type]) => ({ name, type, size: type === 'file' ? 1234 : null, mtime: Date.now() - 3600_000, ext: name.includes('.') ? name.split('.').pop() : '' })),
});

it('opens folders by tap and by flicking from the hub, goes up with the hub, previews files', async () => {
  const h = await mount(radial, { path: '~' });
  const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string; query?: string };
  expect(req()).toMatchObject({ cmd: 'list', path: '~' });
  const reply = req().reply;
  expect(reply.startsWith('files.fb-radial.')).toBe(true);
  h.publish(reply, listing('/home/u', [['docs', 'dir'], ['src', 'dir'], ['notes.md', 'file'], ['a.ts', 'file']]));
  h.frame(20);
  for (const t of ['docs', 'src', 'notes.md', 'a.ts', '4 items']) expect(h.hasText(t), t).toBe(true);
  expect(h.emitsOn('folder').at(-1)).toBe('~');

  // tap the wedge at 12 o'clock (slot 0 = docs)
  h.press('w:0', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '/home/u/docs' });
  h.publish(reply, listing('/home/u/docs', [['plan.md', 'file'], ['img.png', 'file']]));
  h.frame(20);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/docs' });
  expect(h.hasText('plan.md')).toBe(true);

  // hub tap = up; the folder we came from is remembered
  h.press('hub', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '/home/u' });
  h.publish(reply, listing('/home/u', [['docs', 'dir'], ['src', 'dir'], ['notes.md', 'file'], ['a.ts', 'file']]));
  h.frame(20);

  // marking-menu flick: pinch the hub, move toward NE (slot 1 = src), release
  const hub = h.partPosition('hub');
  h.drag('hub', [0.09, 0.09, 0], { from: hub });
  expect(req()).toMatchObject({ cmd: 'list', path: '/home/u/src' });
  h.publish(reply, listing('/home/u/src', [['main.ts', 'file']]));
  h.frame(20);

  // a cancelled flick does nothing
  const before = h.rec.published.length;
  h.interact({ handler: 'drag', phase: 'start', objectName: 'hub', localPoint: hub });
  h.interact({ handler: 'drag', phase: 'move', objectName: 'hub', localPoint: [hub[0], hub[1] + 0.12, 0] });
  h.interact({ handler: 'drag', phase: 'cancel', objectName: 'hub', localPoint: [hub[0], hub[1] + 0.12, 0] });
  expect(h.rec.published.length).toBe(before);

  // tap a file → preview with syntax-highlighted text
  h.press('w:0', 'drag');
  expect(req()).toMatchObject({ cmd: 'preview', path: '/home/u/src/main.ts' });
  expect(h.emitsOn('selected').at(-1)).toBe('/home/u/src/main.ts');
  h.publish(req().reply, { kind: 'preview', path: '/home/u/src/main.ts', name: 'main.ts', size: 30, mtime: Date.now(), type: 'text', text: 'const a = 1;\nexport default a;', lines: 2 });
  h.frame();
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(true);
  expect(h.hasText('1\n2')).toBe(true);
  h.press('btn:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain('/home/u/src/main.ts');
  h.press('btn:close', 'drag');
  h.frame();
  expect(h.hasText('const a = 1;')).toBe(false);

  // breadcrumbs jump, home, errors
  h.press('crumb:0', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '~' });
  h.press('btn:home', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '~' });
  h.publish(reply, { ...listing('/home/u/private', []), error: 'Permission denied' });
  h.frame();
  expect(h.hasText('Permission denied')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('pages big folders by turning the rim, keeps directions stable, and shows recent files', async () => {
  const h = await mount(radial, { path: '~/big', slots: 12 });
  const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string; query?: string };
  const reply = req().reply;
  const names: Array<[string, 'file']> = Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, 'file']);
  h.publish(reply, listing('/home/u/big', names));
  h.frame(20);
  expect(h.hasText('1 / 3  ·  f')).toBe(true);
  expect(h.hasText('f00.txt')).toBe(true);
  expect(h.hasText('f12.txt')).toBe(false);

  // turn the rim clockwise from 12 o'clock to 3 o'clock → next page (no file opened)
  const n0 = h.rec.published.length;
  h.drag('w:0', [0.17, -0.17, 0], { from: [0, 0.17, 0] });
  h.frame(20);
  expect(h.rec.published.length).toBe(n0);
  expect(h.hasText('2 / 3  ·  f')).toBe(true);
  expect(h.hasText('f12.txt')).toBe(true);
  // slot 0 now holds f12
  h.press('w:0', 'drag');
  expect(req()).toMatchObject({ cmd: 'preview', path: '/home/u/big/f12.txt' });
  h.press('btn:prev', 'drag');
  h.frame(20);
  expect(h.hasText('1 / 3  ·  f')).toBe(true);

  // inputs: open by name / slot, page
  h.input('page', 'next');
  h.frame();
  expect(h.hasText('2 / 3  ·  f')).toBe(true);
  h.input('open', 'f29.txt');
  h.frame();
  expect(req()).toMatchObject({ cmd: 'preview', path: '/home/u/big/f29.txt' });
  expect(h.hasText('3 / 3  ·  f')).toBe(true);

  // recent files ring
  h.press('btn:recent', 'drag');
  expect(req()).toMatchObject({ cmd: 'search', query: '', path: '/home/u/big' });
  h.publish(req().reply, { kind: 'search', path: '/home/u/big', query: '', results: [{ name: 'fresh.py', path: '/home/u/big/x/fresh.py', display: '~/big/x/fresh.py', type: 'file', size: 10, mtime: Date.now(), ext: 'py' }] });
  h.frame(20);
  expect(h.hasText('Recent')).toBe(true);
  expect(h.hasText('fresh.py')).toBe(true);
  h.press('w:0', 'drag');
  expect(req()).toMatchObject({ cmd: 'preview', path: '/home/u/big/x/fresh.py' });
  h.press('hub', 'drag'); // back to the folder
  h.frame(20);
  expect(h.hasText('f00.txt') || h.hasText('f24.txt')).toBe(true);

  h.input('open', 'nope');
  expect(h.rec.errors.length).toBe(1);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
