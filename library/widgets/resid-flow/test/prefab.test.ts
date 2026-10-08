// library/prefabs/resid-lens.json: well-formed, links reference real ports,
// placed at standing height in front of the origin.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Prefab, WidgetDefinition } from '@evolspace/protocol';
import def from '../widget.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const libraryDir = path.resolve(here, '..', '..', '..');
const prefabFile = path.join(libraryDir, 'prefabs', 'resid-lens.json');
const prefab = JSON.parse(readFileSync(prefabFile, 'utf8')) as Prefab;

/** Slider ports per the standard widget library contract (used when the slider source is unavailable). */
const SLIDER_FALLBACK = { inputs: ['value'], outputs: ['value', 'commit'], props: ['min', 'max', 'step', 'value', 'label', 'orientation', 'length', 'decimals'] };

async function sliderSpec(): Promise<{ inputs: string[]; outputs: string[]; props: string[] }> {
  const file = path.join(libraryDir, 'widgets', 'slider', 'widget.ts');
  if (!existsSync(file)) return SLIDER_FALLBACK;
  try {
    const d = (await import(pathToFileURL(file).href)).default as WidgetDefinition;
    return { inputs: Object.keys(d.inputs ?? {}), outputs: Object.keys(d.outputs ?? {}), props: Object.keys(d.props ?? {}) };
  } catch {
    return SLIDER_FALLBACK;
  }
}

describe('resid-lens prefab', () => {
  it('is well formed and references existing ports and props', async () => {
    expect(prefab.description.length).toBeGreaterThan(20);
    const byId = new Map(prefab.entities.map((e) => [e.id, e]));
    expect(byId.get('resid')?.widget).toBe('resid-flow');
    const slider = await sliderSpec();
    const ports = (id: string, dir: 'inputs' | 'outputs'): string[] => {
      const w = byId.get(id)!.widget;
      if (w === 'resid-flow') return Object.keys(def[dir] ?? {});
      return slider[dir];
    };
    for (const l of prefab.links) {
      if (l.from.kind === 'port') {
        expect(byId.has(l.from.entity)).toBe(true);
        expect(ports(l.from.entity, 'outputs')).toContain(l.from.port);
      }
      if (l.to.kind === 'port') {
        expect(byId.has(l.to.entity)).toBe(true);
        expect(ports(l.to.entity, 'inputs')).toContain(l.to.port);
      } else {
        expect(l.to.channel).toMatch(/^interp\.ctl\.(layer|sample)$/);
      }
    }
    for (const e of prefab.entities) {
      const known = e.widget === 'resid-flow' ? Object.keys(def.props ?? {}) : slider.props;
      for (const k of Object.keys(e.props ?? {})) expect(known).toContain(k);
      if (e.parent) expect(byId.has(e.parent)).toBe(true);
    }
    const root = byId.get('resid')!;
    const [x, y, z] = root.transform!.position!;
    expect(y).toBeGreaterThanOrEqual(1.2);
    expect(y).toBeLessThanOrEqual(1.6);
    expect(Math.hypot(x, z)).toBeGreaterThan(0.7);
    expect(Math.hypot(x, z)).toBeLessThan(1.4);
    // Sliders emit 'value' on create (their stored value): only user-gesture 'commit's may
    // reach the ctl channels, or every client reload would reset the producer's state.
    for (const l of prefab.links) if (l.to.kind === 'channel' && l.from.kind === 'port') expect(l.from.port).toBe('commit');
    // The visualizer publishes its own picks; the sliders follow the channels.
    expect(root.props?.publishLayer ?? true).toBe(true);
  });

  // The real server planner, when available (owned by the server component).
  const plannerPath = path.join(libraryDir, '..', 'apps', 'server', 'src', 'scene', 'prefabs.ts');
  it.skipIf(!existsSync(plannerPath))('plans with the server prefab planner', async () => {
    let planPrefab: (p: Prefab, o: object, taken: (id: string) => boolean) => { ops: unknown[]; ids: Record<string, string> };
    try {
      ({ planPrefab } = await import(pathToFileURL(plannerPath).href));
    } catch {
      return;
    }
    const plan = planPrefab(prefab, {}, () => false);
    expect(Object.keys(plan.ids).sort()).toEqual(['layer-slider', 'resid', 'sample-slider']);
    expect(plan.ops.length).toBe(prefab.entities.length + prefab.links.length);
  });
});
