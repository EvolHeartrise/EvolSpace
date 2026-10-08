// Prefabs (library/prefabs/*.json, except other components' files):
//   - structure: unique ids, parents inside the prefab, at least one root
//   - every entity's widget exists and its props are valid for that widget
//   - links reference real output → input ports (or valid channel names), transforms compile
//   - dataflow: mount every entity in the harness, wire the links like the
//     runtime's LinkEngine (incl. replay of the latest output on link creation),
//     and check values actually flow.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import type { Prefab, PortRef, WidgetDefinition } from '@evolspace/protocol';
import { checkPropValue } from './lint.ts';
import { mount, type Harness } from './harness.ts';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_OURS = new Set(['resid-lens.json']);
const FILES = readdirSync(path.join(LIBRARY, 'prefabs')).filter((f) => f.endsWith('.json') && !NOT_OURS.has(f)).sort();
const CHANNEL_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const readPrefab = (f: string) => JSON.parse(readFileSync(path.join(LIBRARY, 'prefabs', f), 'utf8')) as Prefab;
const defs = new Map<string, WidgetDefinition>();
async function widget(id: string): Promise<WidgetDefinition> {
  if (!defs.has(id)) defs.set(id, (await import(/* @vite-ignore */ pathToFileURL(path.join(LIBRARY, 'widgets', id, 'widget.ts')).href)).default);
  return defs.get(id)!;
}

/** Mounts a prefab's entities and routes values over its links (like the runtime's LinkEngine). */
class PrefabSim {
  readonly h: Record<string, Harness> = {};
  readonly published: Array<{ channel: string; value: unknown }> = [];

  static async create(p: Prefab): Promise<PrefabSim> {
    const sim = new PrefabSim();
    for (const e of p.entities) sim.h[e.id] = await mount(await widget(e.widget), e.props ?? {});
    const compiled = p.links.map((l) => ({ ...l, fn: l.transform ? (new Function('x', `"use strict"; return (${l.transform});`) as (x: unknown) => unknown) : null }));
    const deliver = (to: PortRef, v: unknown) => {
      if (to.kind === 'port') sim.h[to.entity].input(to.port, v);
      else sim.published.push({ channel: to.channel, value: v });
    };
    const fire = (l: (typeof compiled)[number], v: unknown) => {
      const x = l.fn ? l.fn(v) : v;
      if (x !== undefined) deliver(l.to, x);
    };
    for (const [id, h] of Object.entries(sim.h)) {
      h.onEmit = (port, value) => {
        for (const l of compiled) if (l.from.kind === 'port' && l.from.entity === id && l.from.port === port) fire(l, value);
      };
    }
    // Link activation replays each source's latest output.
    for (const l of compiled) {
      if (l.from.kind !== 'port') continue;
      const all = sim.h[l.from.entity].emitsOn(l.from.port);
      if (all.length) fire(l, all[all.length - 1]);
    }
    return sim;
  }

  lastOn(channel: string): unknown {
    const v = this.published.filter((p) => p.channel === channel);
    return v.length ? v[v.length - 1].value : undefined;
  }

  dispose(): void {
    for (const h of Object.values(this.h)) h.dispose();
  }
}

describe.each(FILES)('%s', (file) => {
  it('is structurally valid against the widget library', async () => {
    const p = readPrefab(file);
    expect(typeof p.description).toBe('string');
    expect(p.description.length).toBeGreaterThan(40);
    const ids = p.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.entities.filter((e) => (e.parent ?? null) === null).length).toBeGreaterThanOrEqual(1);
    for (const e of p.entities) {
      if (e.parent) expect(ids).toContain(e.parent);
      const def = await widget(e.widget);
      for (const [k, v] of Object.entries(e.props ?? {})) {
        const spec = def.props?.[k];
        expect(spec, `${e.id}: widget '${e.widget}' has no prop '${k}'`).toBeTruthy();
        expect(checkPropValue(spec!, v), `${e.id}.${k}`).toBeNull();
      }
    }
    for (const l of p.links) {
      for (const [end, ref] of [['from', l.from], ['to', l.to]] as const) {
        if (ref.kind === 'channel') {
          expect(ref.channel).toMatch(CHANNEL_RE);
          continue;
        }
        const e = p.entities.find((x) => x.id === ref.entity);
        expect(e, `link ${end} entity '${ref.entity}'`).toBeTruthy();
        const def = await widget(e!.widget);
        const ports = end === 'from' ? def.outputs : def.inputs;
        expect(ports?.[ref.port], `${e!.widget} has no ${end === 'from' ? 'output' : 'input'} '${ref.port}'`).toBeTruthy();
      }
      if (l.transform) expect(() => new Function('x', `"use strict"; return (${l.transform});`)).not.toThrow();
    }
  });
});

describe('slider-number dataflow', () => {
  it('the read-out follows the slider (initial value and drags)', async () => {
    const sim = await PrefabSim.create(readPrefab('slider-number.json'));
    expect(sim.h.readout.hasText('5.0')).toBe(true);
    sim.h.slider.drag('knob', [0.24 / 10, 0, 0]); // +1 on a 0..10 slider of length 0.24 m
    expect(sim.h.readout.hasText('6.0')).toBe(true);
    sim.dispose();
  });
});

describe('control-panel dataflow and layout', () => {
  it('publishes initial control values to channels', async () => {
    const sim = await PrefabSim.create(readPrefab('control-panel.json'));
    expect(sim.lastOn('ui.control.gain')).toBe(1);
    expect(sim.lastOn('ui.control.threshold')).toBe(0.5);
    expect(sim.lastOn('ui.control.enabled')).toBe(true);
    expect(sim.lastOn('ui.control.reset')).toBeUndefined(); // events are not replayed until pressed
    sim.dispose();
  });

  it('controls publish on change; Reset restores slider defaults via port→port links', async () => {
    const sim = await PrefabSim.create(readPrefab('control-panel.json'));
    sim.h.gain.drag('knob', [0.06, 0, 0]);
    expect(sim.lastOn('ui.control.gain')).toBeCloseTo(1.5, 5);
    sim.h.enabled.press('switch');
    expect(sim.lastOn('ui.control.enabled')).toBe(false);
    sim.h.reset.press('button');
    expect(sim.lastOn('ui.control.reset')).toEqual({ label: 'Reset', count: 1 });
    expect(sim.lastOn('ui.control.gain')).toBe(1);
    expect(sim.h.gain.lastEmit('value')).toBe(1);
    sim.dispose();
  });

  it('children sit inside the panel card and do not overlap each other', async () => {
    const p = readPrefab('control-panel.json');
    const sim = await PrefabSim.create(p);
    for (const h of Object.values(sim.h)) h.frame();
    const card = sim.h.panel.bounds();
    const boxes: Array<[string, THREE.Box3]> = [];
    for (const e of p.entities.filter((x) => x.parent === 'panel')) {
      const b = sim.h[e.id].bounds().translate(new THREE.Vector3(...e.transform!.position));
      expect(card.containsBox(new THREE.Box3(b.min.clone().setZ(card.min.z), b.max.clone().setZ(card.max.z))), `${e.id} inside panel`).toBe(true);
      for (const [other, ob] of boxes) {
        const flat = (x: THREE.Box3) => new THREE.Box3(x.min.clone().setZ(0), x.max.clone().setZ(0));
        expect(flat(b).intersectsBox(flat(ob)) && flat(b).intersect(flat(ob)).getSize(new THREE.Vector3()).x > 0.002 && flat(b).intersect(flat(ob)).getSize(new THREE.Vector3()).y > 0.002, `${e.id} overlaps ${other}`).toBe(false);
      }
      boxes.push([e.id, b]);
    }
    // The panel's own title/body text stays above the controls.
    let textBottom = Infinity;
    sim.h.panel.root.traverseVisible((o) => {
      const bb = (o as unknown as { textRenderInfo?: { blockBounds: number[] } }).textRenderInfo?.blockBounds;
      if (bb && (o as unknown as { text: string }).text) textBottom = Math.min(textBottom, o.position.y + bb[1]);
    });
    const controlsTop = Math.max(...boxes.map(([, b]) => b.max.y));
    expect(textBottom).toBeGreaterThan(controlsTop);
    sim.dispose();
  });
});
