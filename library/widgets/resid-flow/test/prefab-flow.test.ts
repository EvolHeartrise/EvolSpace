// Dataflow of library/prefabs/resid-lens.json with the real widgets (resid-flow,
// the standard slider) and the runtime's real LinkEngine: instantiating or
// reloading the rig must not overwrite the producer's interp.ctl.* state, and
// every control source (visualizer pick, slider, Claude/voice via the channel)
// must converge without duplicate publishes.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChannelValue, Prefab, WidgetDefinition } from '@evolspace/protocol';
import residDef from '../widget.ts';
import type { ResidFlow } from '../controller.ts';
import { layerY } from '../layout.ts';
import { generateSample } from '../demo-data.ts';
import { interaction } from './fake-ctx.ts';
import { Rig } from './rig.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const libraryDir = path.resolve(here, '..', '..', '..');
const prefab = JSON.parse(readFileSync(path.join(libraryDir, 'prefabs', 'resid-lens.json'), 'utf8')) as Prefab;
const sliderFile = path.join(libraryDir, 'widgets', 'slider', 'widget.ts');

async function sliderDef(): Promise<WidgetDefinition | null> {
  if (!existsSync(sliderFile)) return null;
  try {
    return (await import(pathToFileURL(sliderFile).href)).default as WidgetDefinition;
  } catch {
    return null;
  }
}

/** Server state of a running session: data for sample 7, lens at b3 (layer 4). */
function session(): Record<string, ChannelValue> {
  const s = generateSample(7, { layers: 10, heads: 4 });
  return {
    'interp.meta': s.meta, 'interp.resid.proj': s.proj, 'interp.resid.norm': s.norm, 'interp.resid.mask': s.mask,
    'interp.resid.delta': s.delta, 'interp.attn': s.attn,
    'interp.ctl.layer': 4, 'interp.ctl.sample': 7, 'interp.ctl.token': 3,
  };
}

const ctlPublishes = (rig: Rig) => rig.published.filter((p) => p.name.startsWith('interp.ctl.'));
const lastEmit = (rig: Rig, entity: string, port: string) => rig.emitted.filter((e) => e.entity === entity && e.port === port).at(-1)?.value;

const slider = await sliderDef();

describe.skipIf(!slider)('resid-lens prefab dataflow', () => {
  const defs = () => ({ 'resid-flow': residDef, slider: slider! } as Record<string, WidgetDefinition>);
  const orders = [
    ['layer-slider', 'sample-slider', 'resid'],
    ['resid', 'layer-slider', 'sample-slider'],
    ['sample-slider', 'resid', 'layer-slider'],
  ];

  for (const order of orders) {
    it(`instantiation/reload (${order.join(' → ')}) adopts the channels and publishes nothing`, async () => {
      const rig = new Rig(prefab, defs(), session());
      for (const id of order) await rig.create(id);
      rig.frame();
      expect(ctlPublishes(rig)).toEqual([]);
      const resid = rig.entities.get('resid')!.inst as ResidFlow;
      expect(resid.debug().layer).toBe(4);
      expect(resid.debug().token).toBe(3);
      expect(lastEmit(rig, 'layer-slider', 'value')).toBe(4);
      expect(lastEmit(rig, 'sample-slider', 'value')).toBe(7);
      expect(rig.errors).toEqual([]);
    });
  }

  for (const order of orders) {
    it(`slider ranges follow interp.meta; a big sample index survives the default max (${order.join(' → ')})`, async () => {
      const server = session();
      const meta = server['interp.meta'] as { sample: { index: number; total: number }; layers: string[] };
      server['interp.meta'] = { ...meta, sample: { ...meta.sample, index: 1500, total: 2048 } };
      server['interp.ctl.sample'] = 1500;
      const rig = new Rig(prefab, defs(), server);
      for (const id of order) await rig.create(id);
      rig.frame();
      expect(ctlPublishes(rig)).toEqual([]);
      // Prefab default max is 11: ctl.sample 1500 must not be clamped for good (or persisted clamped).
      expect(lastEmit(rig, 'sample-slider', 'value')).toBe(1500);
      expect(rig.entities.get('sample-slider')!.ctx.props.value).toBe(1500);
      expect(lastEmit(rig, 'layer-slider', 'value')).toBe(4);
      // Smaller model: the layer slider's max follows meta.layers.
      rig.serverPublish('interp.meta', { ...meta, layers: ['embed', 'b0', 'b1', 'b2'], sample: { index: 3, total: 10 } });
      expect(lastEmit(rig, 'layer-slider', 'value')).toBe(3);
      expect(lastEmit(rig, 'sample-slider', 'value')).toBe(9);
      // Partial meta (no sample / layers) is filtered by the transforms, not an error.
      rig.serverPublish('interp.meta', { model: 'x' });
      expect(ctlPublishes(rig)).toEqual([]);
      expect(rig.errors).toEqual([]);
    });
  }

  it('routes picks, slider drags and channel changes without duplicate publishes', async () => {
    const rig = new Rig(prefab, defs(), session());
    for (const id of ['resid', 'layer-slider', 'sample-slider']) await rig.create(id);
    rig.frame();
    const resid = rig.entities.get('resid')!.inst as ResidFlow;
    const L = resid.debug().layout!;

    // Pinch layer plane 2 in the visualizer → one publish; the slider follows.
    resid.onInteraction!(interaction('pick', 'start', [0.299, layerY(L, 2), -0.299], 'layer:2'));
    expect(ctlPublishes(rig)).toEqual([{ name: 'interp.ctl.layer', value: 2 }]);
    expect(lastEmit(rig, 'layer-slider', 'value')).toBe(2);

    // Slider drag: live lens preview on 'value' (no publish), one publish on 'commit'.
    rig.published.length = 0;
    const sl = rig.entities.get('layer-slider')!.ctx;
    sl.emit('value', 7);
    expect(resid.debug().layer).toBe(7);
    expect(ctlPublishes(rig)).toEqual([]);
    sl.emit('commit', 7);
    expect(ctlPublishes(rig)).toEqual([{ name: 'interp.ctl.layer', value: 7 }]);

    // Claude / voice / the producer change the channels → everything follows, nothing republishes.
    rig.published.length = 0;
    rig.serverPublish('interp.ctl.layer', 9);
    rig.serverPublish('interp.ctl.sample', 2);
    rig.frame();
    expect(resid.debug().layer).toBe(9);
    expect(lastEmit(rig, 'layer-slider', 'value')).toBe(9);
    expect(lastEmit(rig, 'sample-slider', 'value')).toBe(2);
    expect(ctlPublishes(rig)).toEqual([]);

    // Sample slider commit → one publish.
    rig.entities.get('sample-slider')!.ctx.emit('commit', 5);
    expect(ctlPublishes(rig)).toEqual([{ name: 'interp.ctl.sample', value: 5 }]);
    expect(rig.errors).toEqual([]);
  });
});
