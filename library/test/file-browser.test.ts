// file-browser — listing, navigation, previews; the files source's privacy rules.
import { expect, it } from 'vitest';
import os from 'node:os';
import fileBrowser, { ageLabel, iconFor, shortPath } from '../widgets/file-browser/widget.ts';
// @ts-expect-error plain JS module (the source driver)
import { denied, displayPath, resolvePath } from '../sources/files/files.mjs';
import { mount } from './harness.ts';

it('never lists or reads keys, secrets and credentials', () => {
  for (const p of ['/home/u/.ssh/id_ed25519', '/home/u/.ssh', '/home/u/.config/evolspace/secrets.env', '/repo/.env', '/repo/.env.local', '/home/u/.aws/credentials',
    '/home/u/.claude/.credentials.json', '/home/u/.config/gh/hosts.yml', '/home/u/keys/id_rsa', '/home/u/.netrc']) expect(denied(p), p).toBe(true);
  for (const p of ['/home/u/notes.md', '/home/u/.config/evolspace', '/repo/env.ts', '/home/u/.bashrc']) expect(denied(p), p).toBe(false);
  expect(resolvePath('~')).toBe(os.homedir());
  expect(displayPath(`${os.homedir()}/a/b`)).toBe('~/a/b');
});

it('labels entries', () => {
  expect(iconFor({ type: 'dir', ext: '' })[0]).toBe('folder');
  expect(iconFor({ type: 'file', ext: 'ts' })[0]).toBe('file-code');
  expect(iconFor({ type: 'file', ext: 'png' })[0]).toBe('file-image');
  expect(iconFor({ type: 'file', ext: 'weird' })[0]).toBe('file');
  const now = Date.parse('2026-10-09T12:00:00Z');
  expect(ageLabel(now - 5 * 60_000, now)).toBe('5m');
  expect(ageLabel(now - 3 * 86400_000, now)).toBe('3d');
  expect(shortPath('~/git projects/EvolSpace/library/widgets', 20)).toBe('…ace/library/widgets');
  expect(shortPath('~/a', 20)).toBe('~/a');
});

const listing = (path: string, names: Array<[string, 'dir' | 'file']>) => ({
  kind: 'list', path, display: path.replace('/home/u', '~'), parent: path === '/home/u' ? '/home' : '/home/u', truncated: false,
  entries: names.map(([name, type]) => ({ name, type, size: type === 'file' ? 1234 : null, mtime: Date.now() - 3600_000, ext: name.includes('.') ? name.split('.').pop() : '' })),
});

it('lists a folder, opens subfolders, previews files, goes up and home', async () => {
  const h = await mount(fileBrowser, { path: '~', rows: 5 });
  const req = () => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as { cmd: string; path: string; reply: string };
  expect(req()).toMatchObject({ cmd: 'list', path: '~' });
  const reply = req().reply;
  h.publish(reply, listing('/home/u', [['docs', 'dir'], ['src', 'dir'], ['notes.md', 'file'], ['a.ts', 'file'], ['b.ts', 'file'], ['c.ts', 'file']]));
  h.frame();
  for (const t of ['~', '6 items', 'docs', 'notes.md', '1.2 KB   1h']) expect(h.hasText(t), t).toBe(true);
  expect(h.hasText('c.ts')).toBe(false); // 5 rows

  h.press('row:0', 'drag'); // docs/
  expect(req()).toMatchObject({ cmd: 'list', path: '/home/u/docs' });
  h.publish(reply, listing('/home/u/docs', [['plan.md', 'file']]));
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/docs' });
  h.press('row:0', 'drag'); // plan.md → preview
  expect(req()).toMatchObject({ cmd: 'preview', path: '/home/u/docs/plan.md' });
  expect(h.emitsOn('selected').at(-1)).toBe('/home/u/docs/plan.md');
  const previewReply = req().reply;
  h.publish(previewReply, { kind: 'preview', path: '/home/u/docs/plan.md', name: 'plan.md', size: 20, mtime: Date.now(), type: 'text', text: '# Plan\nstep one\nstep two', lines: 3 });
  h.frame();
  expect(h.hasText('plan.md')).toBe(true);
  expect(h.hasText('# Plan\nstep one\nstep two')).toBe(true);
  expect(h.hasText('1\n2\n3')).toBe(true);
  h.press('btn:ask', 'drag');
  expect(h.rec.asks.at(-1)).toContain('/home/u/docs/plan.md');
  h.press('btn:close', 'drag');
  h.frame();
  expect(h.hasText('step one')).toBe(false);

  h.press('btn:up', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '/home/u' });
  h.press('btn:home', 'drag');
  expect(req()).toMatchObject({ cmd: 'list', path: '~' });
  h.publish(reply, { ...listing('/home/u/private', []), error: 'Permission denied' });
  h.frame();
  expect(h.hasText('Permission denied')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
