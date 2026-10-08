// Regression tests for bugs found in the hardening review (one block per fix).
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import type { WidgetDefinition } from '@evolspace/protocol';
import { checkDefinition } from './lint.ts';
import { mount, pickerBounds, tensor, type Harness } from './harness.ts';
import button from '../widgets/button/widget.ts';
import channelView from '../widgets/channel-view/widget.ts';
import group from '../widgets/group/widget.ts';
import linePlot from '../widgets/line-plot/widget.ts';
import numberWidget from '../widgets/number/widget.ts';
import panel from '../widgets/panel/widget.ts';
import points from '../widgets/points/widget.ts';
import slider from '../widgets/slider/widget.ts';
import toggle from '../widgets/toggle/widget.ts';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDS = readdirSync(path.join(LIBRARY, 'widgets'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'resid-flow' && existsSync(path.join(LIBRARY, 'widgets', d.name, 'widget.ts')))
  .map((d) => d.name)
  .sort();
const load = async (id: string) => (await import(pathToFileURL(path.join(LIBRARY, 'widgets', id, 'widget.ts')).href)).default as WidgetDefinition;

let h: Harness | null = null;
afterEach(() => {
  if (h) {
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
  }
  h = null;
});

describe('channel prop whose channel already holds a value', () => {
  // ChannelHub.subscribe delivers an existing value synchronously, i.e. inside the
  // ChannelProp constructor. line-plot and line used to crash in create() here
  // (spawning a plot on a live channel, or any hot reload of it).
  const VALUES: unknown[] = [0.5, [1, 2, 3], [[0, 0, 0], [1, 1, 1]], tensor('f32', [3], [1, 2, 3]), tensor('f32', [4, 3], new Array(12).fill(0.25)), { a: 1 }, 'hi', null];
  for (const id of IDS) {
    it(id, async () => {
      const def = await load(id);
      const channelProps = Object.entries(def.props ?? {}).filter(([, s]) => s.type === 'channel').map(([k]) => k);
      for (const prop of channelProps) {
        for (const v of VALUES) {
          const x = await mount(def, { [prop]: 'ch' }, { channels: { ch: v } });
          x.frame(2);
          x.dispose();
          expect(x.rec.afterDispose).toEqual([]);
        }
      }
    });
  }

  it('line-plot plots the value that was already there', async () => {
    h = await mount(linePlot, { channel: 'curve' }, { channels: { curve: tensor('f32', [3], [1, 2, 3]) } });
    h.frame();
    const line = h.root.getObjectByName('series-0') as THREE.Line;
    expect(line.geometry.drawRange.count).toBe(3);
  });

  it('channel-view shows the value of a newly selected channel', async () => {
    h = await mount(channelView, { channel: 'a', refreshHz: 60 }, { channels: { a: 1, b: { hello: 'world' } } });
    h.frame(2);
    expect(h.hasText('#1')).toBe(true);
    await h.setProps({ channel: 'b' });
    h.frame(2);
    expect(h.hasText('hello')).toBe(true);
    expect(h.hasText('waiting for a value')).toBe(false);
    expect(h.hasText('#1')).toBe(true); // count restarted for the new channel
  });
});

describe('group', () => {
  it('declares no size, so an empty group is not a phantom grab box for the picker', async () => {
    expect(group.size).toBeUndefined();
    expect(checkDefinition(group)).toEqual([]);
    h = await mount(group, {});
    expect(pickerBounds(h.root).isEmpty()).toBe(true);
  });
});

describe('points', () => {
  const cloud = (x: Harness) => x.root.getObjectByName('cloud') as THREE.InstancedMesh;
  const many = (n: number) => tensor('f32', [n, 3], Array.from({ length: n * 3 }, (_, i) => (i * 7919) % 101));

  it('never draws more instances than it allocated when maxPoints shrinks after data arrived', async () => {
    h = await mount(points, { maxPoints: 1000 });
    h.input('points', many(500));
    h.frame();
    expect(cloud(h).count).toBe(500);
    await h.setProps({ maxPoints: 100 });
    h.frame();
    expect(cloud(h).count).toBe(100);
    expect(cloud(h).count).toBeLessThanOrEqual(cloud(h).instanceMatrix.count);
    await h.setProps({ maxPoints: 1000 });
    h.frame();
    expect(cloud(h).count).toBe(500); // data kept; raising the cap restores it
  });

  it('a NaN point does not poison the instanced bounds used for picking/framing', async () => {
    h = await mount(points, { fit: false });
    h.input('points', tensor('f32', [3, 3], [0, 0, 0, NaN, 1, 1, 0.1, 0.1, 0.1]));
    h.frame();
    const m = cloud(h);
    m.computeBoundingBox();
    const b = m.boundingBox!;
    for (const v of [b.min, b.max]) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
    expect(b.max.x).toBeGreaterThan(0.09);
  });
});

describe('slider', () => {
  it('keeps an input-driven value when an unrelated prop changes', async () => {
    h = await mount(slider, { min: 0, max: 10, step: 1, value: 3 });
    h.input('value', 7);
    expect(h.lastEmit('value')).toBe(7);
    await h.setProps({ label: 'Gain' });
    expect(h.lastEmit('value')).toBe(7);
    expect(h.hasText('7')).toBe(true);
    await h.setProps({ value: 2 }); // a real prop change still wins
    expect(h.lastEmit('value')).toBe(2);
  });

  it('an ongoing drag survives a rebuild and ignores a concurrent value prop change', async () => {
    h = await mount(slider, { min: 0, max: 1, step: 0, value: 0.5, length: 0.2, emitOnCreate: true });
    const p0 = h.partPosition('knob');
    h.interact({ handler: 'drag', phase: 'start', objectName: 'knob', localPoint: p0 });
    await h.setProps({ label: 'changed mid-drag', value: 0.9 });
    expect(h.lastEmit('value')).toBe(0.5); // the user's hand owns the value while dragging
    h.interact({ handler: 'drag', phase: 'move', objectName: 'knob', localPoint: [p0[0] + 0.04, p0[1], p0[2]] });
    expect(h.lastEmit('value')).toBeCloseTo(0.7, 5);
    h.interact({ handler: 'drag', phase: 'end', objectName: 'knob', localPoint: [p0[0] + 0.04, p0[1], p0[2]] });
    expect(h.lastEmit('commit')).toBeCloseTo(0.7, 5);
  });
});

describe('toggle', () => {
  it('keeps an input-driven state when an unrelated prop changes', async () => {
    h = await mount(toggle, { value: false });
    h.input('value', true);
    await h.setProps({ label: 'Other' });
    expect(h.lastEmit('value')).toBe(true);
    await h.setProps({ value: false }); // re-applying the unchanged prop (false → false) is not a change
    expect(h.lastEmit('value')).toBe(true);
    await h.setProps({ value: true }); // a real change of the prop wins
    expect(h.lastEmit('value')).toBe(true);
    await h.setProps({ value: false });
    expect(h.lastEmit('value')).toBe(false);
  });
});

describe('button', () => {
  it('emits pressed=false initially and when a rebuild or dispose interrupts a hold', async () => {
    h = await mount(button, {});
    expect(h.emitsOn('pressed')).toEqual([false]);
    h.interact({ handler: 'press', phase: 'start', objectName: 'button' });
    expect(h.lastEmit('pressed')).toBe(true);
    await h.setProps({ label: 'Renamed' });
    expect(h.lastEmit('pressed')).toBe(false);
    h.interact({ handler: 'press', phase: 'start', objectName: 'button' });
    h.dispose();
    expect(h.lastEmit('pressed')).toBe(false);
    h = null;
  });
});

describe('number', () => {
  it('switches sign colors without re-creating the SDF text', async () => {
    h = await mount(numberWidget, { signColors: true });
    h.input('value', 1);
    const before = h.texts.filter((t) => !t.disposed).length;
    const value = () => h!.root.getObjectByName('value') as unknown as { color: unknown; uuid: string };
    const id = value().uuid;
    expect(value().color).toBe('#45d49b');
    for (let i = 0; i < 20; i++) h.input('value', i % 2 ? 1 : -1);
    expect(value().uuid).toBe(id);
    expect(value().color).toBe('#45d49b');
    h.input('value', -2);
    expect(value().color).toBe('#ff5d6c');
    expect(h.texts.filter((t) => !t.disposed).length).toBe(before);
  });
});

describe('line-plot', () => {
  it('replacing a series of the same shape rewrites the existing line (no new GPU buffers)', async () => {
    h = await mount(linePlot, {});
    h.input('series', [1, 2, 3]); // capacity 4
    h.frame();
    const line = h.root.getObjectByName('series-0') as THREE.Line;
    const geo = line.geometry;
    h.input('series', [4, 3, 2, 1]); // grows within the power-of-two capacity
    h.frame();
    expect(h.root.getObjectByName('series-0')).toBe(line);
    expect(line.geometry).toBe(geo);
    expect(geo.drawRange.count).toBe(4);
  });

  it('a multi-element tensor on `value` appends one sample per series', async () => {
    h = await mount(linePlot, {});
    h.input('value', tensor('f32', [3], [1, 2, 3]));
    h.input('value', tensor('f32', [3], [2, 3, 4]));
    h.frame();
    for (const i of [0, 1, 2]) expect((h.root.getObjectByName(`series-${i}`) as THREE.Line).geometry.drawRange.count).toBe(2);
  });
});

describe('panel', () => {
  it('a body update with the same block structure reuses the text meshes', async () => {
    h = await mount(panel, { title: 'Status', body: '- step **1**\n- loss 0.5' });
    h.frame(2);
    const created = h.texts.length;
    for (let i = 2; i < 30; i++) {
      h.input('body', `- step **${i}**\n- loss ${(1 / i).toFixed(3)}`);
      h.frame();
    }
    expect(h.texts.length).toBe(created);
    expect(h.hasText('step 29')).toBe(true);
    h.input('title', 'Status 2');
    expect(h.texts.length).toBe(created);
    expect(h.hasText('Status 2')).toBe(true);
    h.input('body', '# Done\nall good'); // different structure → rebuild
    h.frame();
    expect(h.hasText('Done')).toBe(true);
    expect(h.hasText('step 29')).toBe(false);
  });
});
