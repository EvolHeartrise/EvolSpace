// `spawn` server command: spoken widget names, placement in front of the user, declining unknown names.
import { describe, expect, it } from 'vitest';
import type { Quat, SceneOp, Vec3, WidgetManifest } from '@evolspace/protocol';
import { CommandRegistry, placeInFront, registerBuiltinCommands, resolveWidgetName, type BuiltinDeps } from '../src/commands.ts';
import type { SceneStore } from '../src/scene/store.ts';

const IDS = ['explorer', 'line-plot', 'bar-chart', 'bsrl-replay', 'usage', 'weather', 'fb-palm', 'tunnel', 'box', 'text'];

describe('resolveWidgetName', () => {
  it('matches ids however they are spoken', () => {
    expect(resolveWidgetName('explorer', IDS)).toBe('explorer');
    expect(resolveWidgetName('line plot', IDS)).toBe('line-plot');
    expect(resolveWidgetName('a bar chart widget', IDS)).toBe('bar-chart');
    expect(resolveWidgetName('BSRL replay', IDS)).toBe('bsrl-replay');
    expect(resolveWidgetName('fb palm', IDS)).toBe('fb-palm');
    expect(resolveWidgetName('the usage panel', IDS)).toBe('usage');
    expect(resolveWidgetName('box', IDS)).toBe('box');
  });
  it('forgives one STT slip on longer names, not on short ones', () => {
    expect(resolveWidgetName('explorers', IDS)).toBe('explorer');
    expect(resolveWidgetName('weathers', IDS)).toBe('weather');
    expect(resolveWidgetName('tunnels', IDS)).toBe('tunnel');
    expect(resolveWidgetName('fox', IDS)).toBeUndefined();
  });
  it('declines anything that is not just a widget name', () => {
    expect(resolveWidgetName('weather widget for cozumel', IDS)).toBeUndefined();
    expect(resolveWidgetName('this to the workspace', IDS)).toBeUndefined();
    expect(resolveWidgetName('', IDS)).toBeUndefined();
  });
});

describe('placeInFront', () => {
  it('puts content ahead of the head, below eye height, facing back', () => {
    const p = placeInFront({ position: [1, 1.6, 0], rotation: [0, 0, 0, 1] }, [0.4, 0.3, 0.05]);
    expect(p.position[0]).toBeCloseTo(1);
    expect(p.position[1]).toBeCloseTo(1.45);
    expect(p.position[2]).toBeCloseTo(-0.9);
    expect(p.rotation[1]).toBeCloseTo(0);
    expect(p.rotation[3]).toBeCloseTo(1);
    // Head turned 90° left (facing -X): the widget sits at -X and is yawed to face +X.
    const s = Math.SQRT1_2;
    const q = placeInFront({ position: [0, 1.6, 0], rotation: [0, s, 0, s] }, [2, 1, 1]);
    expect(q.position[0]).toBeCloseTo(-2.5);
    expect(q.position[2]).toBeCloseTo(0);
    expect(q.rotation[1]).toBeCloseTo(s);
  });
  it('without a headset: eye height in front of the origin', () => {
    expect(placeInFront(null).position).toEqual([0, 1.3, -0.8]);
  });
});

describe('spawn command', () => {
  const setup = (head: { position: Vec3; rotation: Quat } | null = null) => {
    const ops: Array<{ ops: SceneOp[]; source: string }> = [];
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg, {
      store: {} as SceneStore,
      applyOps: (o, source) => { ops.push({ ops: o, source }); return { ids: ['e-new'] }; },
      widgets: () => IDS.map((id) => ({ id, size: id === 'explorer' ? [1.8, 0.55, 0.3] : undefined }) as unknown as WidgetManifest),
      head: () => head,
    } as unknown as BuiltinDeps);
    return { reg, ops };
  };

  it('adds the resolved widget, named, in front of the user', async () => {
    const { reg, ops } = setup({ position: [0, 1.6, 0], rotation: [0, 0, 0, 1] });
    expect(await reg.run('spawn', { widget: 'line plot' }, { origin: 'voice' })).toEqual({ entity: 'e-new', widget: 'line-plot' });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.source).toBe('voice');
    const op = ops[0]!.ops[0] as Extract<SceneOp, { op: 'add' }>;
    expect(op.entity).toMatchObject({ widget: 'line-plot', name: 'Line Plot', props: {} });
    const [x, y, z] = op.entity.transform!.position;
    expect([x, y, z].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1.45, -0.8]);
    // Bigger widgets go further away.
    await reg.run('spawn', { widget: 'explorer', name: 'Files' }, { origin: 'http' });
    const big = ops[1]!.ops[0] as Extract<SceneOp, { op: 'add' }>;
    expect(big.entity.name).toBe('Files');
    expect(big.entity.transform!.position[2]).toBeCloseTo(-2.3);
  });

  it('declines a name that is no widget (voice hands it to Claude)', async () => {
    const { reg, ops } = setup();
    await expect(reg.run('spawn', { widget: 'weather widget for cozumel' }, { origin: 'voice' }))
      .rejects.toMatchObject({ passToAgent: true, status: 404 });
    expect(ops).toHaveLength(0);
  });
});
