import { describe, it, expect, beforeEach } from 'vitest';
import type { Prefab, SceneOp } from '@evolspace/protocol';
import { SceneStore, SceneError } from '../src/scene/store.ts';
import { planPrefab } from '../src/scene/prefabs.ts';
import { summarizeScene } from '../src/scene/summary.ts';
import { planDuplicate } from '../src/commands.ts';
import { staticCatalog } from './helpers.ts';

/** Full transform at a position (add ops take a full Transform in the contract; the store also accepts partials). */
const at = (position: [number, number, number]) => ({ position, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });

const catalog = staticCatalog([
  {
    id: 'box',
    props: { size: { type: 'number', default: 0.2, min: 0 }, color: { type: 'color', default: '#fff' }, mode: { type: 'enum', options: ['a', 'b'], default: 'a' } },
    inputs: { value: { type: 'number' } },
    outputs: { changed: { type: 'number' } },
  },
  { id: 'slider', props: { value: { type: 'number', default: 0.5 }, label: { type: 'string', default: 'x' } }, outputs: { value: { type: 'number' } } },
  { id: 'group' },
]);

describe('SceneStore', () => {
  let patches: Array<{ version: number; ops: SceneOp[]; source: string }>;
  let now: number;
  let store: SceneStore;
  beforeEach(() => {
    patches = [];
    now = 1000;
    store = new SceneStore({ catalog, onPatch: (version, ops, source) => patches.push({ version, ops, source }), now: () => now });
  });

  it('adds entities with generated short ids, defaults and identity transform', () => {
    const r = store.apply([{ op: 'add', entity: { widget: 'box', props: { size: 0.5 } } }], { source: 'agent' });
    expect(r.ids).toHaveLength(1);
    expect(r.ids[0]).toMatch(/^e-[0-9a-f]{4}$/);
    const e = store.entity(r.ids[0])!;
    expect(e.props).toEqual({ size: 0.5, color: '#fff', mode: 'a' });
    expect(e.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(e.visible).toBe(true);
    expect(e.parent).toBeNull();
    expect(r.version).toBe(1);
    // broadcast carries the normalized full entity
    expect(patches[0].ops[0]).toMatchObject({ op: 'add', entity: { id: r.ids[0], props: { size: 0.5, color: '#fff' } } });
  });

  it('rejects invalid ops with actionable messages and applies batches atomically', () => {
    expect(() => store.apply([{ op: 'add', entity: { widget: 'nope' } }], { source: 'agent' })).toThrow(/unknown widget 'nope' \(available: box, slider, group\)/);
    expect(() => store.apply([{ op: 'add', entity: { widget: 'box', props: { size: 'big' } } }], { source: 'agent' })).toThrow(/prop 'size' of widget 'box' must be a finite number/);
    expect(() => store.apply([{ op: 'add', entity: { widget: 'box', props: { mode: 'c' } } }], { source: 'agent' })).toThrow(/one of \["a","b"\]/);
    expect(() => store.apply([{ op: 'add', entity: { widget: 'box', transform: { position: [0, 1] } as never } }], { source: 'agent' })).toThrow(/position must be \[x, y, z\]/);
    expect(() => store.apply([{ op: 'update', id: 'missing', patch: {} }], { source: 'agent' })).toThrow(/does not exist/);

    // second op fails → first must be rolled back
    let err: unknown;
    try {
      store.apply([
        { op: 'add', entity: { id: 'a', widget: 'box' } },
        { op: 'add', entity: { id: 'b', widget: 'box', parent: 'zzz' } },
      ], { source: 'agent' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SceneError);
    expect((err as SceneError).opIndex).toBe(1);
    expect((err as Error).message).toMatch(/^op\[1\]/);
    expect(store.entity('a')).toBeUndefined();
    expect(store.version).toBe(0);
    expect(patches).toHaveLength(0);
  });

  it('warns (not fails) on unknown props', () => {
    const r = store.apply([{ op: 'add', entity: { widget: 'box', props: { colour: 'red' } } }], { source: 'agent' });
    expect(r.warnings.join()).toMatch(/no prop 'colour'.*props: size, color, mode/);
  });

  it('updates with shallow prop merge and partial transforms; undo/redo restore', () => {
    store.apply([{ op: 'add', entity: { id: 'a', widget: 'box', transform: at([1, 2, 3]) } }], { source: 'agent' });
    store.apply([{ op: 'update', id: 'a', patch: { props: { size: 1 }, transform: { scale: [2, 2, 2] }, name: 'big box' } }], { source: 'agent' });
    let e = store.entity('a')!;
    expect(e.props.size).toBe(1);
    expect(e.props.color).toBe('#fff');
    expect(e.transform.position).toEqual([1, 2, 3]);
    expect(e.transform.scale).toEqual([2, 2, 2]);
    expect(e.name).toBe('big box');

    store.undo();
    e = store.entity('a')!;
    expect(e.props.size).toBe(0.2);
    expect(e.transform.scale).toEqual([1, 1, 1]);
    expect(e.name).toBeUndefined();
    expect(patches.at(-1)!.source).toBe('undo');

    store.redo();
    expect(store.entity('a')!.props.size).toBe(1);
    expect(store.entity('a')!.name).toBe('big box');
    expect(patches.at(-1)!.source).toBe('redo');

    store.undo(); store.undo();
    expect(store.entity('a')).toBeUndefined();
    expect(store.undo().ok).toBe(false);
  });

  it('remove cascades to descendants and links; undo restores everything', () => {
    store.apply([
      { op: 'add', entity: { id: 'root', widget: 'group' } },
      { op: 'add', entity: { id: 'kid', widget: 'box', parent: 'root' } },
      { op: 'add', entity: { id: 'grandkid', widget: 'box', parent: 'kid' } },
      { op: 'add', entity: { id: 's', widget: 'slider' } },
      { op: 'link.add', link: { id: 'l1', from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'grandkid', port: 'value' } } },
      { op: 'link.add', link: { from: { kind: 'channel', channel: 'x.y' }, to: { kind: 'port', entity: 'kid', port: 'value' } } },
    ], { source: 'agent' });
    expect(Object.keys(store.scene.links)).toHaveLength(2);
    store.apply([{ op: 'remove', id: 'root' }], { source: 'agent' });
    expect(Object.keys(store.scene.entities)).toEqual(['s']);
    expect(Object.keys(store.scene.links)).toHaveLength(0);
    store.undo();
    expect(Object.keys(store.scene.entities).sort()).toEqual(['grandkid', 'kid', 'root', 's']);
    expect(store.entity('grandkid')!.parent).toBe('kid');
    expect(Object.keys(store.scene.links)).toHaveLength(2);
  });

  it('validates links: ports, kinds, transforms', () => {
    store.apply([{ op: 'add', entity: { id: 's', widget: 'slider' } }, { op: 'add', entity: { id: 'b', widget: 'box' } }], { source: 'agent' });
    const link = (l: object) => () => store.apply([{ op: 'link.add', link: l as never }], { source: 'agent' });
    expect(link({ from: { kind: 'port', entity: 's', port: 'nope' }, to: { kind: 'port', entity: 'b', port: 'value' } })).toThrow(/no output port 'nope' \(outputs: value\)/);
    expect(link({ from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'b', port: 'changed' } })).toThrow(/no input port 'changed' \(inputs: value\)/);
    expect(link({ from: { kind: 'port', entity: 'ghost', port: 'value' }, to: { kind: 'port', entity: 'b', port: 'value' } })).toThrow(/entity 'ghost' does not exist/);
    expect(link({ from: { kind: 'channel', channel: 'a' }, to: { kind: 'channel', channel: 'b' } })).toThrow(/channel→channel/);
    expect(link({ from: { kind: 'channel', channel: 'bad name!' }, to: { kind: 'port', entity: 'b', port: 'value' } })).toThrow(/channel name/);
    expect(link({ from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'b', port: 'value' }, transform: 'x +' })).toThrow(/not a valid JS expression/);
    const r = store.apply([{ op: 'link.add', link: { from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'b', port: 'value' }, transform: 'Math.round(x * 10)' } }], { source: 'agent' });
    expect(r.ids[0]).toMatch(/^l-/);
    const l = store.scene.links[r.ids[0]];
    expect(l.enabled).toBe(true);
    store.apply([{ op: 'link.update', id: l.id, patch: { enabled: false, transform: 'x * 2' } }], { source: 'agent' });
    expect(store.scene.links[l.id]).toMatchObject({ enabled: false, transform: 'x * 2' });
    store.undo();
    expect(store.scene.links[l.id]).toMatchObject({ enabled: true, transform: 'Math.round(x * 10)' });
  });

  it('prevents parent cycles', () => {
    store.apply([{ op: 'add', entity: { id: 'a', widget: 'group' } }, { op: 'add', entity: { id: 'b', widget: 'group', parent: 'a' } }], { source: 'agent' });
    expect(() => store.apply([{ op: 'update', id: 'a', patch: { parent: 'b' } }], { source: 'agent' })).toThrow(/cycle/);
    expect(() => store.apply([{ op: 'update', id: 'a', patch: { parent: 'a' } }], { source: 'agent' })).toThrow(/cycle/);
  });

  it('groups undo by group id and by source+time window', () => {
    store.apply([{ op: 'add', entity: { id: 'a', widget: 'box' } }], { source: 'agent' });
    // A grab gesture: many throttled updates sharing a group
    for (let i = 1; i <= 5; i++) {
      now += 1000; // far apart in time, but same group
      store.apply([{ op: 'update', id: 'a', patch: { transform: { position: [i, 0, 0] } } }], { source: 'user', group: 'grab-1' });
    }
    // Rapid widget setProps within the merge window → one step
    store.apply([{ op: 'update', id: 'a', patch: { props: { size: 1 } } }], { source: 'widget' }); now += 100;
    store.apply([{ op: 'update', id: 'a', patch: { props: { size: 2 } } }], { source: 'widget' }); now += 100;
    store.apply([{ op: 'update', id: 'a', patch: { props: { size: 3 } } }], { source: 'widget' });
    store.undo(); // undo all widget edits
    expect(store.entity('a')!.props.size).toBe(0.2);
    expect(store.entity('a')!.transform.position).toEqual([5, 0, 0]);
    store.undo(); // undo the whole grab
    expect(store.entity('a')!.transform.position).toEqual([0, 0, 0]);
    store.undo(); // undo the add
    expect(store.entity('a')).toBeUndefined();
  });

  it('agent batches are never merged; new edits clear redo', () => {
    store.apply([{ op: 'add', entity: { id: 'a', widget: 'box' } }], { source: 'agent' });
    store.apply([{ op: 'add', entity: { id: 'b', widget: 'box' } }], { source: 'agent' });
    store.undo();
    expect(store.canRedo).toBe(true);
    store.apply([{ op: 'add', entity: { id: 'c', widget: 'box' } }], { source: 'agent' });
    expect(store.canRedo).toBe(false);
    store.undo();
    expect(store.entity('a')).toBeDefined();
    expect(store.entity('c')).toBeUndefined();
  });

  it('clear + undo', () => {
    store.apply([{ op: 'add', entity: { id: 'p', widget: 'group' } }, { op: 'add', entity: { id: 'k', widget: 'box', parent: 'p' } }], { source: 'agent' });
    store.apply([{ op: 'clear' }], { source: 'agent' });
    expect(store.scene.entities).toEqual({});
    store.undo();
    expect(store.entity('k')!.parent).toBe('p');
  });

  it('widget change fills new defaults; versions are monotonic across reset', () => {
    store.apply([{ op: 'add', entity: { id: 'a', widget: 'box' } }], { source: 'agent' });
    store.apply([{ op: 'update', id: 'a', patch: { widget: 'slider' } }], { source: 'agent' });
    expect(store.entity('a')!.props).toMatchObject({ value: 0.5, label: 'x', size: 0.2 });
    const v = store.version;
    store.reset({}, 'other');
    expect(store.version).toBe(v + 1);
    expect(store.workspace).toBe('other');
    expect(store.canUndo).toBe(false);
  });

  it('duplicate copies a subtree with remapped ids and links', () => {
    store.apply([
      { op: 'add', entity: { id: 'g', widget: 'group', name: 'panel' } },
      { op: 'add', entity: { id: 'k', widget: 'box', parent: 'g' } },
      { op: 'add', entity: { id: 's', widget: 'slider', parent: 'g' } },
      { op: 'link.add', link: { from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'k', port: 'value' } } },
    ], { source: 'agent' });
    const plan = planDuplicate(store, 'g');
    store.apply(plan.ops, { source: 'user' });
    expect(plan.rootId).toBe('g-2');
    expect(store.entity('g-2')!.name).toBe('panel copy');
    expect(store.entity('k-2')!.parent).toBe('g-2');
    const links = Object.values(store.scene.links);
    expect(links).toHaveLength(2);
    expect(links.some((l) => l.from.kind === 'port' && l.from.entity === 's-2' && l.to.kind === 'port' && l.to.entity === 'k-2')).toBe(true);
  });
});

describe('prefabs', () => {
  const prefab: Prefab = {
    description: 'slider driving a box',
    entities: [
      { id: 'root', widget: 'group', transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { id: 'slider', widget: 'slider', parent: 'root', props: { label: 'size' } },
      { id: 'box', widget: 'box', parent: 'root' },
    ],
    links: [
      { from: { kind: 'port', entity: 'slider', port: 'value' }, to: { kind: 'port', entity: 'box', port: 'value' } },
      { from: { kind: 'channel', channel: 'demo.x' }, to: { kind: 'port', entity: 'box', port: 'value' } },
    ],
  };

  it('remaps ids (incl. parents and links), composes the placement and applies prop overrides', () => {
    const store = new SceneStore({ catalog });
    const plan = planPrefab(prefab, { transform: { position: [2, 0, 0] }, props: { slider: { value: 0.9 } } }, (x) => x in store.scene.entities);
    store.apply(plan.ops, { source: 'agent' });
    const { root, slider, box } = plan.ids;
    expect(new Set([root, slider, box]).size).toBe(3);
    expect(store.entity(root)!.transform.position).toEqual([2, 1, 0]);
    expect(store.entity(slider)!.parent).toBe(root);
    expect(store.entity(slider)!.props).toMatchObject({ label: 'size', value: 0.9 });
    const links = Object.values(store.scene.links);
    expect(links).toHaveLength(2);
    expect(links[0].from).toEqual({ kind: 'port', entity: slider, port: 'value' });
    expect(links[0].to).toEqual({ kind: 'port', entity: box, port: 'value' });
    expect(links[1].from).toEqual({ kind: 'channel', channel: 'demo.x' });
    // Instantiating twice gives independent copies
    const plan2 = planPrefab(prefab, {}, (x) => x in store.scene.entities);
    store.apply(plan2.ops, { source: 'agent' });
    expect(Object.keys(store.scene.entities)).toHaveLength(6);
  });

  it('rejects bad prefab references', () => {
    const bad: Prefab = { description: '', entities: [{ id: 'a', widget: 'box', parent: 'zz' }], links: [] };
    expect(() => planPrefab(bad, {}, () => false)).toThrow(/parent 'zz'/);
    expect(() => planPrefab(prefab, { props: { nope: {} } }, () => false)).toThrow(/not an entity of this prefab/);
  });
});

describe('summary', () => {
  it('builds a tree and elides large values', () => {
    const store = new SceneStore({ catalog });
    store.apply([
      { op: 'add', entity: { id: 'g', widget: 'group', name: 'G', transform: at([0.12345, 1, 2]) } },
      { op: 'add', entity: { id: 'b', widget: 'box', parent: 'g', props: { big: Array.from({ length: 100 }, (_, i) => i), long: 'x'.repeat(500) } } },
      { op: 'link.add', link: { from: { kind: 'channel', channel: 'a.b' }, to: { kind: 'port', entity: 'b', port: 'value' }, transform: 'x*2' } },
    ], { source: 'agent' });
    const s = summarizeScene(store.scene);
    expect(s.roots).toHaveLength(1);
    expect(s.roots[0].position).toEqual([0.123, 1, 2]);
    expect(s.roots[0].children![0].props.big).toBe('[array(100) elided]');
    expect(String(s.roots[0].children![0].props.long)).toMatch(/500 chars/);
    expect(s.links[0]).toMatchObject({ from: 'channel:a.b', to: 'b.value', transform: 'x*2' });
  });
});
