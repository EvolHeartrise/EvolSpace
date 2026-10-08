// Contract + robustness checks applied to EVERY standard widget:
//   - static definition passes the library lint (valid typed props with defaults, ports, size)
//   - mounts with defaults (and in mirror mode) without errors
//   - survives every enum option, junk on every input port, stray interaction events
//   - never moves ctx.root, and disposes cleanly (nothing left under root, no calls after dispose)

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WidgetDefinition } from '@evolspace/protocol';
import { checkDefinition } from './lint.ts';
import { mount, tensor } from './harness.ts';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_OURS = new Set(['resid-flow']);
const IDS = readdirSync(path.join(LIBRARY, 'widgets'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !NOT_OURS.has(d.name) && existsSync(path.join(LIBRARY, 'widgets', d.name, 'widget.ts')))
  .map((d) => d.name)
  .sort();

async function load(id: string): Promise<WidgetDefinition> {
  const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(LIBRARY, 'widgets', id, 'widget.ts')).href);
  return mod.default as WidgetDefinition;
}

const JUNK: unknown[] = [undefined, null, 0, -1, 1e9, NaN, '', 'text', true, [], [1, 2, 3], [[1, 2], [3, 4]], {}, { a: 1 },
  tensor('f32', [0], []), tensor('f32', [3], [1, 2, 3]), tensor('f32', [4, 3], new Array(12).fill(0.5)), tensor('u8', [2, 2, 3], new Array(12).fill(9)), tensor('f16', [2], [0x3c00, 0x7e00])];

describe.each(IDS)('%s', (id) => {
  it('has a valid definition', async () => {
    expect(checkDefinition(await load(id))).toEqual([]);
  });

  it('mounts with defaults, runs frames, and disposes cleanly', async () => {
    const def = await load(id);
    for (const isMirror of [false, true]) {
      const h = await mount(def, {}, { isMirror });
      h.frame(5);
      expect(h.rec.errors).toEqual([]);
      expect(h.root.position.toArray()).toEqual([0, 0, 0]);
      expect(h.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      expect(h.root.scale.toArray()).toEqual([1, 1, 1]);
      h.dispose();
      expect(h.root.children).toHaveLength(0);
      expect(h.rec.afterDispose).toEqual([]);
    }
  });

  it('handles every enum option and re-applied defaults', async () => {
    const def = await load(id);
    const h = await mount(def, {});
    for (const [name, spec] of Object.entries(def.props ?? {})) {
      for (const opt of spec.type === 'enum' ? spec.options ?? [] : []) {
        await h.setProps({ [name]: opt });
        h.frame();
      }
      await h.setProps({ [name]: spec.default });
      h.frame();
    }
    expect(h.root.children.length).toBeGreaterThanOrEqual(id === 'group' ? 0 : 1);
    h.dispose();
    expect(h.root.children).toHaveLength(0);
  });

  it('never throws on junk inputs or stray interactions', async () => {
    const def = await load(id);
    const h = await mount(def, {});
    for (const port of Object.keys(def.inputs ?? {})) {
      for (const v of JUNK) {
        h.input(port, v);
        h.frame();
      }
    }
    const handlers = ['press', 'hover', 'drag', ...(def.interactions ?? []).map((b) => (b.action.type === 'widget' ? b.action.handler : ''))];
    const names = [undefined, ...[...h.interactives].map((o) => o.name)];
    for (const handler of handlers) {
      for (const objectName of names) {
        for (const phase of ['start', 'move', 'move', 'end', 'cancel', 'end'] as const) {
          h.interact({ handler, phase, objectName, localPoint: [Math.random() * 0.2 - 0.1, Math.random() * 0.2 - 0.1, 0] });
        }
      }
    }
    h.frame(3);
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
  });
});
