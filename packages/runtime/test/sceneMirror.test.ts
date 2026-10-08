import { describe, expect, it } from 'vitest';
import type { SceneState } from '@evolspace/protocol';
import { SceneMirror } from '../src/scene/SceneMirror.ts';
import { entity } from './helpers.ts';

function snap(entities: ReturnType<typeof entity>[], version = 1, links: SceneState['links'] = {}): SceneState {
  return { version, workspace: 'w', entities: Object.fromEntries(entities.map((e) => [e.id, e])), links };
}

describe('SceneMirror', () => {
  it('diffs snapshots (added / removed / changed, unchanged keep identity)', () => {
    const m = new SceneMirror();
    let d = m.applySnapshot(snap([entity('a', 'box'), entity('b', 'box')]));
    expect(d.added.sort()).toEqual(['a', 'b']);
    const a = m.entity('a');
    d = m.applySnapshot(snap([entity('a', 'box'), entity('b', 'box', { props: { x: 1 } }), entity('c', 'sphere')], 2));
    expect(d.added).toEqual(['c']);
    expect(d.removed).toEqual([]);
    expect([...d.changed.keys()]).toEqual(['b']);
    expect(d.changed.get('b')).toEqual({ props: true });
    expect(m.entity('a')).toBe(a);
    d = m.applySnapshot(snap([entity('c', 'sphere')], 3));
    expect(d.removed.sort()).toEqual(['a', 'b']);
    expect(m.version).toBe(3);
  });

  it('applies add/update with defaults, shallow props merge and partial transforms', () => {
    const m = new SceneMirror();
    m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'box', props: { a: 1, b: 2 } } }]);
    const e = m.entity('a')!;
    expect(e).toMatchObject({ parent: null, visible: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
    const d = m.applyOps([{ op: 'update', id: 'a', patch: { props: { b: 3 }, transform: { position: [1, 2, 3] }, name: 'hello' } }]);
    expect(m.entity('a')!.props).toEqual({ a: 1, b: 3 });
    expect(m.entity('a')!.transform.scale).toEqual([1, 1, 1]);
    expect(m.entity('a')!.transform.position).toEqual([1, 2, 3]);
    expect(d.changed.get('a')).toEqual({ props: true, transform: true, meta: true });
  });

  it('remove takes descendants and touching links', () => {
    const m = new SceneMirror();
    m.applySnapshot(snap(
      [entity('p', 'panel'), entity('c', 'box', { parent: 'p' }), entity('g', 'box', { parent: 'c' }), entity('x', 'box')],
      1,
      {
        l1: { id: 'l1', from: { kind: 'port', entity: 'g', port: 'out' }, to: { kind: 'port', entity: 'x', port: 'in' }, enabled: true },
        l2: { id: 'l2', from: { kind: 'channel', channel: 'c' }, to: { kind: 'port', entity: 'x', port: 'in' }, enabled: true },
      },
    ));
    const d = m.applyOps([{ op: 'remove', id: 'p' }], 2);
    expect(d.removed.sort()).toEqual(['c', 'g', 'p']);
    expect(Object.keys(m.state.links)).toEqual(['l2']);
    expect(d.linksChanged).toBe(true);
    expect(m.childrenOf(null)).toEqual(new Set(['x']));
  });

  it('ignores stale versioned patches', () => {
    const m = new SceneMirror();
    m.applySnapshot(snap([entity('a', 'box')], 5));
    const d = m.applyOps([{ op: 'remove', id: 'a' }], 5);
    expect(d.removed).toEqual([]);
    expect(m.entity('a')).toBeDefined();
    m.applyOps([{ op: 'remove', id: 'a' }], 6);
    expect(m.entity('a')).toBeUndefined();
  });

  it('add then remove in one batch is a no-op; remove then re-add is a replace', () => {
    const m = new SceneMirror();
    let d = m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'box' } }, { op: 'remove', id: 'a' }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    m.applyOps([{ op: 'add', entity: { id: 'b', widget: 'box' } }]);
    d = m.applyOps([{ op: 'remove', id: 'b' }, { op: 'add', entity: { id: 'b', widget: 'sphere' } }]);
    expect(d.removed).toEqual(['b']);
    expect(d.added).toEqual(['b']);
    expect(m.entity('b')!.widget).toBe('sphere');
  });

  it('re-adding an existing id replaces in place with a field diff', () => {
    const m = new SceneMirror();
    m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'box', props: { v: 1 } } }]);
    const d = m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'box', props: { v: 2 } } }]);
    expect(d.added).toEqual([]);
    expect(d.changed.get('a')).toEqual({ props: true });
  });

  it('rejects reparenting cycles', () => {
    const m = new SceneMirror();
    m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'x' } }, { op: 'add', entity: { id: 'b', widget: 'x', parent: 'a' } }]);
    const d = m.applyOps([{ op: 'update', id: 'a', patch: { parent: 'b' } }]);
    expect(m.entity('a')!.parent).toBeNull();
    expect(d.warnings.some((w) => w.includes('cycle'))).toBe(true);
  });

  it('link ops and clear', () => {
    const m = new SceneMirror();
    m.applyOps([
      { op: 'add', entity: { id: 'a', widget: 'x' } },
      { op: 'link.add', link: { id: 'l', from: { kind: 'channel', channel: 'c' }, to: { kind: 'port', entity: 'a', port: 'in' } } },
    ]);
    expect(m.state.links.l.enabled).toBe(true);
    m.applyOps([{ op: 'link.update', id: 'l', patch: { transform: 'x*2' } }]);
    expect(m.state.links.l.transform).toBe('x*2');
    const d = m.applyOps([{ op: 'clear' }]);
    expect(d.removed).toEqual(['a']);
    expect(m.state.links).toEqual({});
  });

  it('null in a patch clears optional fields', () => {
    const m = new SceneMirror();
    m.applyOps([{ op: 'add', entity: { id: 'a', widget: 'x', anchor: { kind: 'head' }, name: 'n' } }]);
    m.applyOps([{ op: 'update', id: 'a', patch: { anchor: null as never, name: null as never } }]);
    expect(m.entity('a')!.anchor).toBeUndefined();
    expect(m.entity('a')!.name).toBeUndefined();
  });
});
