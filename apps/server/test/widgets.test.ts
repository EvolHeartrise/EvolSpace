import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import type { WidgetManifest } from '@evolspace/protocol';
import { compileWidget } from '../src/widgets/compiler.ts';
import { evaluateWidget } from '../src/widgets/evaluate.ts';
import { WidgetLibrary, type BuildEvent } from '../src/widgets/library.ts';
import { silentLogger } from '../src/log.ts';
import { makeLibrary, rmDir, until, writeFiles, BOX_WIDGET } from './helpers.ts';

const BAD_SYNTAX = `export default { description: 'x', create( { }`;
const BARE_THREE = `import * as THREE from 'three';\nexport default { description: 'uses three', create() { return { m: new THREE.Mesh() }; } };`;
const TYPE_ONLY = `import type * as THREE from 'three';\nimport type { WidgetDefinition } from '@evolspace/protocol';\nconst d: WidgetDefinition = { description: 'types only', create(ctx) { const g: THREE.Group = ctx.root; return {}; } };\nexport default d;`;
const DOM_TOP = `const el = document.createElement('div');\nexport default { description: 'touches DOM', create() { return {}; } };`;
const NO_DESC = `export default { create() { return {}; } };`;
const PROTO_VALUE = `import { IDENTITY_TRANSFORM } from '@evolspace/protocol';\nexport default { description: 'uses a protocol value', size: [1,1,1], create() { return { t: IDENTITY_TRANSFORM }; } };`;
const OUTSIDE = `import x from '../../../outside.ts';\nexport default { description: 'escapes', create() { return { x }; } };`;

describe('widget compiler', () => {
  let lib: string;
  beforeAll(() => {
    lib = makeLibrary({
      'widgets/bad/widget.ts': BAD_SYNTAX,
      'widgets/three/widget.ts': BARE_THREE,
      'widgets/typeonly/widget.ts': TYPE_ONLY,
      'widgets/dom/widget.ts': DOM_TOP,
      'widgets/nodesc/widget.ts': NO_DESC,
      'widgets/proto/widget.ts': PROTO_VALUE,
      'widgets/outside/widget.ts': OUTSIDE,
    });
  });
  afterAll(() => rmDir(lib));

  it('bundles a good widget (incl. library/shared imports) into self-contained ESM', async () => {
    const r = await compileWidget(lib, 'box');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(r.code).toContain('export');
    expect(r.code).not.toMatch(/from\s+['"]/); // no remaining imports
    expect(r.inputs.some((p) => p.endsWith(path.join('shared', 'math.ts')))).toBe(true);
    const ev = await evaluateWidget(r.code);
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.statics.description).toBe('A test box.');
      expect(ev.statics.props.size).toMatchObject({ type: 'number', default: 0.2 });
      expect(ev.statics.outputs).toHaveProperty('changed');
      expect(ev.statics.size).toEqual([0.2, 0.2, 0.2]);
    }
  });

  it('reports syntax errors with file:line', async () => {
    const r = await compileWidget(lib, 'bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/widgets\/bad\/widget\.ts:1:\d+/);
  });

  it('forbids runtime npm imports with an actionable message, allows import type', async () => {
    const r = await compileWidget(lib, 'three');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/imports 'three' at runtime.*use ctx\.THREE/s);
    const t = await compileWidget(lib, 'typeonly');
    expect(t.ok).toBe(true);
  });

  it('bundles @evolspace/protocol values', async () => {
    const r = await compileWidget(lib, 'proto');
    expect(r.ok).toBe(true);
  });

  it('forbids imports outside library/', async () => {
    const r = await compileWidget(lib, 'outside');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside library/);
  });

  it('evaluation errors explain the top-level rule; missing fields are reported', async () => {
    const dom = await compileWidget(lib, 'dom');
    expect(dom.ok).toBe(true);
    if (dom.ok) {
      const ev = await evaluateWidget(dom.code);
      expect(ev.ok).toBe(false);
      if (!ev.ok) expect(ev.error).toMatch(/document is not defined[\s\S]*must not touch DOM/);
    }
    const nd = await compileWidget(lib, 'nodesc');
    if (nd.ok) {
      const ev = await evaluateWidget(nd.code);
      expect(ev.ok).toBe(false);
      if (!ev.ok) expect(ev.error).toMatch(/description must be a non-empty string/);
    }
  });

  it('times out modules that block at top level', async () => {
    const ev = await evaluateWidget('while (true) {}\nexport default {};', 300);
    expect(ev.ok).toBe(false);
    if (!ev.ok) expect(ev.error).toMatch(/longer than 300ms/);
  });
});

describe('WidgetLibrary (watching)', () => {
  let lib: string;
  let library: WidgetLibrary;
  const builds: BuildEvent[] = [];
  const updated: WidgetManifest[] = [];
  const catalogs: WidgetManifest[][] = [];

  beforeAll(async () => {
    lib = makeLibrary({ 'widgets/broken/widget.ts': BAD_SYNTAX });
    library = new WidgetLibrary({
      libraryDir: lib, log: silentLogger, watch: true, debounceMs: 50,
      onBuild: (e) => builds.push(e), onUpdated: (m) => updated.push(m), onCatalog: (c) => catalogs.push(c),
    });
    await library.init();
  });
  afterAll(async () => { await library.close(); rmDir(lib); });

  it('builds all widgets at init and lists broken ones with errors', () => {
    const list = library.list();
    expect(list.map((m) => m.id)).toEqual(['box', 'broken']);
    const box = library.manifest('box')!;
    expect(box.url).toBe(`/widgets/box.js?h=${box.hash}`);
    expect(box.error).toBeUndefined();
    expect(library.manifest('broken')!.error).toBeTruthy();
    expect(library.bundle('broken')).toBeUndefined();
    expect(builds.filter((b) => b.ok)).toHaveLength(1);
  });

  it('keeps the last good bundle when an edit breaks the widget, then recovers', async () => {
    const file = path.join(lib, 'widgets', 'box', 'widget.ts');
    const goodHash = library.manifest('box')!.hash;
    writeFileSync(file, BAD_SYNTAX);
    await until(() => !!library.manifest('box')!.error);
    expect(library.bundle('box')!.hash).toBe(goodHash); // last good still served
    expect(library.manifest('box')!.hash).toBe(goodHash);
    expect(updated.at(-1)!.error).toBeTruthy();
    expect(builds.at(-1)).toMatchObject({ widget: 'box', ok: false });

    writeFileSync(file, BOX_WIDGET.replace('A test box.', 'A changed box.'));
    await until(() => library.manifest('box')!.description === 'A changed box.');
    expect(library.manifest('box')!.error).toBeUndefined();
    expect(library.manifest('box')!.hash).not.toBe(goodHash);
  });

  it('rebuilds dependents when a library/shared file changes', async () => {
    const before = library.manifest('box')!.hash;
    writeFileSync(path.join(lib, 'shared', 'math.ts'), `export const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;\n`);
    await until(() => library.manifest('box')!.hash !== before);
  });

  it('adds new widgets (catalog broadcast) and removes deleted ones', async () => {
    writeFiles(lib, { 'widgets/fresh/widget.ts': `export default { description: 'new one', create() { return {}; } };` });
    await until(() => !!library.manifest('fresh')?.hash);
    expect(catalogs.at(-1)!.map((m) => m.id)).toContain('fresh');
    rmSync(path.join(lib, 'widgets', 'fresh'), { recursive: true, force: true });
    await until(() => !library.manifest('fresh'));
    expect(catalogs.at(-1)!.map((m) => m.id)).not.toContain('fresh');
  });
});
