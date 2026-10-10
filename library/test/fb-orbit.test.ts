// fb-orbit — solar-system file browser: layout semantics, the files protocol, navigation by pinching
// bodies / the outer star, previews, rotation vs tap, cancelled presses, shared reply channels.
import { expect, it } from 'vitest';
import orbit, { bodyMeta, fmtBytes } from '../widgets/fb-orbit/widget.ts';
import { ancestorsOf, bodyRadius, latestMtime, layoutSystem, orbitRadius, typeOf, type TNode } from '../widgets/fb-orbit/layout.ts';
import { mount, type Harness } from './harness.ts';

const NOW = Date.now();
const H = 3.6e6;
const file = (dir: string, name: string, size: number, ageH: number): TNode =>
  ({ name, path: `${dir}/${name}`, type: 'file', size, files: 1, mtime: NOW - ageH * H, ext: name.includes('.') ? name.split('.').pop()! : '' });
const dir = (parent: string, name: string, children: TNode[], extra: Partial<TNode> = {}): TNode => {
  const path = `${parent}/${name}`;
  return { name, path, type: 'dir', size: children.reduce((s, c) => s + c.size, 0), files: children.length, mtime: null, ext: '', children, ...extra };
};

/** /home/u/proj: src/ (2 files), docs/ (1 file), notes.md, big.bin, logo.png */
function projTree(): TNode {
  const P = '/home/u/proj';
  return {
    name: 'proj', path: P, type: 'dir', size: 0, files: 0, mtime: null, ext: '',
    children: [
      dir(P, 'src', [file(`${P}/src`, 'main.ts', 40_000, 2), file(`${P}/src`, 'util.ts', 8_000, 30)]),
      file(P, 'big.bin', 5_000_000, 24 * 400),
      dir(P, 'docs', [file(`${P}/docs`, 'guide.md', 3_000, 24 * 20)]),
      file(P, 'notes.md', 1_200, 0.5),
      file(P, 'logo.png', 900, 24 * 3),
    ],
  };
}
const reply = (root: TNode, display: string) => ({ kind: 'tree', path: root.path, display, root, partial: false });

const lastReq = (h: Harness) => h.rec.published.filter((p) => p.channel === 'files.request').at(-1)?.value as Record<string, unknown>;
const bodyPart = (h: Harness, name: string): string => {
  for (const o of h.liveParts()) if (o.name.startsWith('b:') && labelOf(h, o.name) === name) return o.name;
  throw new Error(`no body ${name}`);
};
// The harness can't see body names directly: hover each body and read the tooltip.
function labelOf(h: Harness, part: string): string {
  h.interact({ handler: 'hover', phase: 'start', objectName: part });
  const t = h.texts.find((x) => x.parent && x.parent.visible && x.fontSize === 0.017 && x.text);
  const s = t?.text ?? '';
  h.interact({ handler: 'hover', phase: 'end', objectName: part });
  return s;
}

it('layout: recent = close, folders bigger, type planes, moons, recency of folders', () => {
  const L = layoutSystem(projTree(), { radius: 0.45, maxBodies: 36, maxMoons: 60, now: NOW });
  const by = (n: string) => L.bodies.find((b) => b.node.name === n)!;
  expect(by('notes.md').orbit).toBeLessThan(by('logo.png').orbit);
  expect(by('logo.png').orbit).toBeLessThan(by('big.bin').orbit);
  expect(by('src').orbit).toBeLessThan(by('docs').orbit); // src has a file touched 2 h ago
  expect(by('src').kind).toBe('planet');
  expect(by('main.ts').kind).toBe('moon');
  expect(by('main.ts').parent).toBe(L.bodies.indexOf(by('src')));
  expect(by('notes.md').type.plane).not.toBe(by('src').type.plane);
  expect(bodyRadius(5_000_000, 'planet')).toBeGreaterThan(bodyRadius(5_000_000, 'file'));
  for (const b of L.bodies) expect(b.hitR).toBeGreaterThanOrEqual(0.0125);
  expect(latestMtime(by('src').node)).toBe(NOW - 2 * H);
  expect(orbitRadius(null, NOW, 0.1, 0.4)).toBe(0.4);
  expect(orbitRadius(NOW, NOW, 0.1, 0.4)).toBe(0.1);
  expect(typeOf({ type: 'file', ext: 'py', name: 'a.py' }).label).toBe('code');
  expect(ancestorsOf('/home/u/proj')).toEqual(['/home/u', '/home', '/']);
  expect(fmtBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  expect(bodyMeta(by('src'), NOW)).toContain('folder');
  // maxBodies keeps the most recent files even when they're small
  const many: TNode = { ...projTree(), children: [...Array.from({ length: 30 }, (_, i) => file('/x', `f${i}.bin`, 1e6 - i, 24 * 300)), file('/x', 'tiny-recent.ts', 10, 0.1)] };
  const L2 = layoutSystem(many, { radius: 0.45, maxBodies: 10, maxMoons: 60, now: NOW });
  expect(L2.bodies.length).toBe(10);
  expect(L2.hidden).toBe(21);
  expect(L2.bodies.some((b) => b.node.name === 'tiny-recent.ts')).toBe(true);
});

it('requests the tree, shows the system, opens planets / previews files / goes up via the outer star', async () => {
  const h = await mount(orbit, { path: '~/proj' });
  const req = lastReq(h);
  expect(req).toMatchObject({ cmd: 'tree', path: '~/proj', depth: 2 });
  const treeReply = req.reply as string;
  expect(treeReply.startsWith('files.fb-orbit.')).toBe(true);
  // another client's reply for another folder is ignored
  h.publish(treeReply, reply({ ...projTree(), path: '/elsewhere', name: 'elsewhere' }, '/elsewhere'));
  h.frame();
  expect(h.liveParts().some((o) => o.name.startsWith('b:'))).toBe(false);

  h.publish(treeReply, reply(projTree(), '~/proj'));
  h.frame(2);
  expect(h.hasText('proj')).toBe(true);
  expect(h.liveParts().filter((o) => o.name.startsWith('b:')).length).toBe(8); // 5 bodies + 3 moons
  expect(h.emitsOn('path').at(-1)).toBe('/home/u/proj');
  expect(h.hasText('~')).toBe(true); // outer star = parent (home)

  // hover: tooltip with size + age
  const src = bodyPart(h, 'src');
  h.interact({ handler: 'hover', phase: 'start', objectName: src });
  expect(h.texts.some((t) => t.text.startsWith('folder · 46.9 KB · 2 files · 2h ago'))).toBe(true);
  h.interact({ handler: 'hover', phase: 'end', objectName: src });

  // pinch a planet → tree request for it; the old system stays until the reply arrives
  h.press(src, 'drag');
  expect(lastReq(h)).toMatchObject({ cmd: 'tree', path: '/home/u/proj/src' });
  h.frame(3);
  expect(h.hasText('proj')).toBe(true);
  const srcNode = projTree().children![0];
  h.publish(treeReply, reply(srcNode, '~/proj/src'));
  h.frame(80); // transition
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj/src' });
  expect(h.liveParts().filter((o) => o.name.startsWith('b:')).length).toBe(2);
  expect(h.liveParts().some((o) => o.name === 'a:0')).toBe(true);

  // pinch a file → preview unfolds with highlighted text
  const main = bodyPart(h, 'main.ts');
  h.press(main, 'drag');
  const pr = lastReq(h);
  expect(pr).toMatchObject({ cmd: 'preview', path: '/home/u/proj/src/main.ts' });
  h.publish(pr.reply as string, { kind: 'preview', path: '/home/u/proj/src/main.ts', name: 'main.ts', size: 40000, mtime: NOW, type: 'text', text: 'const a = 1;\nexport default a;', lines: 2 });
  h.frame(40);
  expect(h.emitsOn('selected').at(-1)).toBe('/home/u/proj/src/main.ts');
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(true);
  h.press('pv:close', 'drag');
  h.frame();
  expect(h.hasText('const a = 1;\nexport default a;')).toBe(false);

  // the outer star goes up (cached → instant, with the reverse transition)
  h.press('a:0', 'drag');
  h.frame(80);
  expect(h.rec.setProps.at(-1)).toEqual({ path: '~/proj' });
  expect(h.liveParts().filter((o) => o.name.startsWith('b:')).length).toBe(8);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('drag rotates instead of tapping; a cancelled press never acts; moons jump two levels', async () => {
  const h = await mount(orbit, { path: '~/proj' });
  const treeReply = lastReq(h).reply as string;
  h.publish(treeReply, reply(projTree(), '~/proj'));
  h.frame(2);
  const n0 = h.rec.published.length;
  const stage = h.root.getObjectByName('stage')!;
  const yaw0 = stage.rotation.y;
  const src = bodyPart(h, 'src');
  h.drag(src, [0.1, 0, 0]);
  expect(stage.rotation.y).toBeGreaterThan(yaw0 + 0.3);
  expect(h.rec.published.length).toBe(n0); // no navigation
  const p = h.partPosition(src);
  h.interact({ handler: 'drag', phase: 'start', objectName: src, localPoint: p });
  h.interact({ handler: 'drag', phase: 'cancel', objectName: src, localPoint: p });
  expect(h.rec.published.length).toBe(n0);
  // a moon (file inside src) → open src and preview the file
  const moon = bodyPart(h, 'main.ts');
  h.press(moon, 'drag');
  const reqs = h.rec.published.slice(n0).map((x) => x.value as Record<string, unknown>);
  expect(reqs.some((r) => r.cmd === 'preview' && r.path === '/home/u/proj/src/main.ts')).toBe(true);
  expect(reqs.some((r) => r.cmd === 'tree' && r.path === '/home/u/proj/src')).toBe(true);
  // errors keep the old system
  h.publish(treeReply, { kind: 'tree', path: '/home/u/proj/src', display: '~/proj/src', root: null, error: 'Permission denied' });
  h.frame();
  expect(h.hasText('Permission denied')).toBe(true);
  expect(h.liveParts().filter((o) => o.name.startsWith('b:')).length).toBe(8);
  // junk input
  h.input('path', 42);
  expect(h.rec.errors.length).toBe(1);
  h.dispose();
});
