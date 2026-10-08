// Controls: slider, button, toggle, number.
import { afterEach, describe, expect, it, vi } from 'vitest';
import slider from '../widgets/slider/widget.ts';
import button from '../widgets/button/widget.ts';
import toggle from '../widgets/toggle/widget.ts';
import numberWidget from '../widgets/number/widget.ts';
import { mount, tensor, type Harness } from './harness.ts';

let h: Harness | null = null;
afterEach(() => {
  if (h) {
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
  }
  h = null;
  vi.useRealTimers();
});

describe('slider', () => {
  it('shows the label/value and does not emit on create by default', async () => {
    h = await mount(slider, { min: 0, max: 10, step: 1, value: 3, label: 'Layer' });
    expect(h.emitsOn('value')).toEqual([]);
    expect(h.hasText('Layer')).toBe(true);
    expect(h.hasText('3')).toBe(true);
    // Integer steps ≤ 24 draw tick marks.
    expect(h.root.getObjectByName('ticks')).toBeTruthy();
  });

  it('registers knob and track as interactive and declares a drag binding', async () => {
    h = await mount(slider, {});
    expect(h.part('knob')).toBeTruthy();
    expect(h.part('track')).toBeTruthy();
    expect(slider.interactions?.[0]).toMatchObject({ pose: 'pinch', action: { type: 'widget', handler: 'drag' } });
  });

  it('dragging the knob changes the value, emits, persists (throttled) and commits', async () => {
    vi.useFakeTimers();
    h = await mount(slider, { min: 0, max: 1, value: 0.5, length: 0.2 });
    h.rec.emits.length = 0;
    // +0.05 m along a 0.2 m track = +0.25
    h.drag('knob', [0.05, 0, 0], { steps: 5 });
    const values = h.emitsOn('value') as number[];
    expect(values.length).toBeGreaterThan(1);
    expect(values[values.length - 1]).toBeCloseTo(0.75, 5);
    expect(h.emitsOn('commit')).toEqual([values[values.length - 1]]);
    // Leading call + flush on end; never one per move.
    expect(h.rec.setProps.length).toBeLessThanOrEqual(2);
    expect(h.rec.setProps[h.rec.setProps.length - 1]).toEqual({ value: 0.75 });
    expect(h.props.value).toBe(0.75);
  });

  it('emitOnCreate emits the stored value once on create', async () => {
    h = await mount(slider, { min: 0, max: 10, step: 1, value: 3, emitOnCreate: true });
    expect(h.emitsOn('value')).toEqual([3]);
    expect(h.rec.setProps).toEqual([]);
  });

  it('dragging is relative: grabbing the knob off-center does not jump', async () => {
    h = await mount(slider, { min: 0, max: 1, value: 0.5, length: 0.2, emitOnCreate: true });
    const [x, y, z] = h.partPosition('knob');
    h.drag('knob', [0, 0, 0], { from: [x + 0.008, y, z] });
    expect(h.lastEmit('value')).toBe(0.5);
  });

  it('pinching the track jumps to that point', async () => {
    h = await mount(slider, { min: 0, max: 100, step: 1, value: 0, length: 0.2 });
    const [, y, z] = h.partPosition('track');
    h.drag('track', [0, 0, 0], { from: [0.05, y, z] }); // 3/4 along the track
    expect(h.lastEmit('value')).toBe(75);
  });

  it('snaps to step and clamps to range', async () => {
    h = await mount(slider, { min: 0, max: 10, step: 2, value: 4, length: 0.2 });
    h.drag('knob', [1, 0, 0]);
    expect(h.lastEmit('value')).toBe(10);
    h.input('value', 3.2);
    expect(h.lastEmit('value')).toBe(4);
    h.input('value', -50);
    expect(h.lastEmit('value')).toBe(0);
  });

  it('input sets, only emits on change (cycle-safe) and persists (throttled), no commit', async () => {
    vi.useFakeTimers();
    h = await mount(slider, { min: 0, max: 1, value: 0.2 });
    h.input('value', 0.6);
    h.input('value', 0.6);
    h.input('value', tensor('f32', [1], [0.6]));
    expect(h.emitsOn('value')).toEqual([0.6]);
    expect(h.emitsOn('commit')).toEqual([]);
    expect(h.rec.setProps).toEqual([{ value: 0.6 }]); // leading call; repeats of the stored value write nothing
    for (let i = 1; i <= 10; i++) h.input('value', i / 10);
    expect(h.rec.setProps.length).toBe(1); // throttled
    vi.advanceTimersByTime(300);
    expect(h.rec.setProps).toEqual([{ value: 0.6 }, { value: 1 }]);
    expect(h.props.value).toBe(1);
  });

  it('the mirror never persists inputs', async () => {
    h = await mount(slider, { min: 0, max: 1, value: 0.2 }, { isMirror: true });
    h.input('value', 0.6);
    expect(h.lastEmit('value')).toBe(0.6);
    expect(h.rec.setProps).toEqual([]);
  });

  it('min/max inputs override the range; an out-of-range value re-applies when the range widens', async () => {
    vi.useFakeTimers();
    h = await mount(slider, { min: 0, max: 11, step: 1, value: 0, decimals: 0 });
    // Channel value arrives before the dataset's size (e.g. interp.ctl.sample before interp.meta).
    h.input('value', 1500);
    expect(h.lastEmit('value')).toBe(11);
    expect(h.rec.setProps).toEqual([{ value: 1500 }]); // the request, not the clamped value
    h.input('max', 2047);
    expect(h.lastEmit('value')).toBe(1500);
    expect(h.hasText('1500')).toBe(true);
    expect(h.root.getObjectByName('ticks')).toBeFalsy(); // 2047 steps: no tick marks
    h.input('max', 'junk');
    h.input('max', Number.NaN);
    expect(h.lastEmit('value')).toBe(1500);
    h.input('max', 9); // range shrinks: clamp
    expect(h.lastEmit('value')).toBe(9);
    expect(h.root.getObjectByName('ticks')).toBeTruthy();
    h.input('min', 5);
    h.input('value', 0);
    expect(h.lastEmit('value')).toBe(5);
    expect(h.emitsOn('commit')).toEqual([]);
    // Dragging covers the overridden range.
    h.drag('knob', [-1, 0, 0]);
    expect(h.lastEmit('value')).toBe(5);
    h.drag('knob', [1, 0, 0]);
    expect(h.lastEmit('value')).toBe(9);
    expect(h.lastEmit('commit')).toBe(9);
    expect(h.rec.errors).toEqual([]);
  });

  it('a range prop edit does not undo an input-driven value', async () => {
    h = await mount(slider, { min: 0, max: 10, step: 1, value: 2 });
    h.input('value', 7);
    await h.setProps({ max: 20 });
    expect(h.lastEmit('value')).toBe(7);
    await h.setProps({ max: 5 });
    expect(h.lastEmit('value')).toBe(5);
    await h.setProps({ max: 20 }); // remembered request fits again
    expect(h.lastEmit('value')).toBe(7);
  });

  it('vertical orientation drags along +Y', async () => {
    h = await mount(slider, { min: 0, max: 1, value: 0, length: 0.2, orientation: 'vertical', emitOnCreate: true });
    h.drag('knob', [0.1, 0, 0]); // sideways: no change
    expect(h.lastEmit('value')).toBe(0);
    h.drag('knob', [0, 0.1, 0]);
    expect(h.lastEmit('value')).toBeCloseTo(0.5, 5);
  });

  it('prop changes from the agent apply (and re-emit); a second hand is ignored while dragging', async () => {
    h = await mount(slider, { min: 0, max: 1, value: 0.1 });
    await h.setProps({ value: 0.9 });
    expect(h.lastEmit('value')).toBe(0.9);
    await h.setProps({ max: 0.5 });
    expect(h.lastEmit('value')).toBe(0.5);
    const p = h.partPosition('knob');
    h.interact({ handler: 'drag', phase: 'start', hand: 'right', objectName: 'knob', localPoint: p });
    h.interact({ handler: 'drag', phase: 'start', hand: 'left', objectName: 'knob', localPoint: p });
    h.interact({ handler: 'drag', phase: 'move', hand: 'left', objectName: 'knob', localPoint: [p[0] - 0.2, p[1], p[2]] });
    expect(h.lastEmit('value')).toBe(0.5);
    h.interact({ handler: 'drag', phase: 'end', hand: 'right', objectName: 'knob', localPoint: p });
  });

  it('hover highlights the knob', async () => {
    h = await mount(slider, {});
    const knob = h.part('knob') as import('three').Mesh;
    const before = knob.scale.x;
    h.interact({ handler: 'hover', phase: 'start', objectName: 'knob' });
    expect(knob.scale.x).toBeGreaterThan(before);
    h.interact({ handler: 'hover', phase: 'end', objectName: 'knob' });
    expect(knob.scale.x).toBeCloseTo(before);
  });
});


describe('button', () => {
  it('fires press on release with payload, logs an event and reports pressed state', async () => {
    h = await mount(button, { label: 'Run' });
    expect(h.hasText('Run')).toBe(true);
    h.press('button');
    expect(h.emitsOn('pressed')).toEqual([false, true, false]); // initial state, then the press
    expect(h.emitsOn('press')).toEqual([{ label: 'Run', count: 1 }]);
    expect(h.rec.events).toEqual([{ name: 'press', data: { label: 'Run', count: 1 } }]);
    h.press('button');
    expect((h.lastEmit('press') as { count: number }).count).toBe(2);
  });

  it('a cancelled press does not fire; fireOn=press fires on contact', async () => {
    h = await mount(button, { logEvent: false });
    h.interact({ handler: 'press', phase: 'start', objectName: 'button' });
    h.interact({ handler: 'press', phase: 'cancel', objectName: 'button' });
    expect(h.emitsOn('press')).toEqual([]);
    expect(h.rec.events).toEqual([]);
    await h.setProps({ fireOn: 'press' });
    h.interact({ handler: 'press', phase: 'start', objectName: 'button' });
    expect(h.emitsOn('press')).toHaveLength(1);
    h.interact({ handler: 'press', phase: 'end', objectName: 'button' });
    expect(h.emitsOn('press')).toHaveLength(1);
  });

  it('two hands pressing count as one press; plate moves in while held', async () => {
    h = await mount(button, {});
    const plate = h.part('button');
    h.interact({ handler: 'press', phase: 'start', hand: 'left', objectName: 'button' });
    expect(plate.position.z).toBeLessThan(0);
    h.interact({ handler: 'press', phase: 'start', hand: 'right', objectName: 'button' });
    h.interact({ handler: 'press', phase: 'end', hand: 'left', objectName: 'button' });
    expect(h.emitsOn('press')).toHaveLength(0);
    h.interact({ handler: 'press', phase: 'end', hand: 'right', objectName: 'button' });
    expect(h.emitsOn('press')).toHaveLength(1);
    expect(plate.position.z).toBe(0);
    h.frame(30); // release flash animates back without errors
  });

  it('ask sends a request to Claude', async () => {
    h = await mount(button, { ask: 'summarize the plot' });
    h.press('button');
    expect(h.rec.asks).toEqual(['summarize the plot']);
  });
});

describe('toggle', () => {
  it('emits initial state, flips on press, persists, and animates', async () => {
    h = await mount(toggle, { label: 'Play', value: false });
    expect(h.emitsOn('value')).toEqual([false]);
    h.press('switch');
    expect(h.emitsOn('value')).toEqual([false, true]);
    expect(h.rec.setProps).toEqual([{ value: true }]);
    h.frame(20);
    h.press('switch');
    expect(h.lastEmit('value')).toBe(false);
  });

  it('input sets state without persisting and only emits on change', async () => {
    h = await mount(toggle, {});
    h.input('value', true);
    h.input('value', 1);
    h.input('value', 'false');
    expect(h.emitsOn('value')).toEqual([false, true, false]);
    expect(h.rec.setProps).toEqual([]);
  });

  it('external prop change applies', async () => {
    h = await mount(toggle, {});
    await h.setProps({ value: true });
    expect(h.lastEmit('value')).toBe(true);
  });
});

describe('number', () => {
  it('shows the prop value, then inputs, formatted with unit and label', async () => {
    h = await mount(numberWidget, { value: 1234.5, label: 'Loss', unit: 'ms', format: 'fixed', precision: 1 });
    expect(h.hasText('Loss')).toBe(true);
    expect(h.hasText('1234.5 ms')).toBe(true);
    h.input('value', 0.25);
    expect(h.hasText('0.3 ms')).toBe(true);
  });

  it('handles booleans, strings, scalar tensors and larger tensors', async () => {
    h = await mount(numberWidget, {});
    h.input('value', true);
    expect(h.hasText('true')).toBe(true);
    h.input('value', 'ready');
    expect(h.hasText('ready')).toBe(true);
    h.input('value', tensor('f32', [1], [2.5]));
    expect(h.hasText('2.5')).toBe(true);
    h.input('value', tensor('f32', [2, 3], [1, 2, 3, 4, 5, 6]));
    expect(h.hasText('f32[2, 3]')).toBe(true);
  });

  it('subscribes to the channel prop and switches channels on prop change', async () => {
    h = await mount(numberWidget, { channel: 'metrics.loss', format: 'percent', precision: 0 }, { channels: { 'metrics.loss': 0.5 } });
    expect(h.hasText('50%')).toBe(true);
    h.publish('metrics.loss', 0.75);
    expect(h.hasText('75%')).toBe(true);
    await h.setProps({ channel: 'metrics.acc' });
    expect(h.subscriberCount('metrics.loss')).toBe(0);
    expect(h.subscriberCount('metrics.acc')).toBe(1);
    h.publish('metrics.acc', 0.9);
    expect(h.hasText('90%')).toBe(true);
  });

  it('signColors switches color with the sign', async () => {
    h = await mount(numberWidget, { signColors: true });
    h.input('value', 3);
    const pos = h.texts.filter((t) => !t.disposed && t.name === 'value').pop()!;
    expect(pos.color).toBe('#45d49b');
    h.input('value', -3);
    const neg = h.texts.filter((t) => !t.disposed && t.name === 'value').pop()!;
    expect(neg.color).toBe('#ff5d6c');
    expect(neg.text).toBe('-3');
  });
});

describe('number fit', () => {
  it('shrinks long values to fit the card width', async () => {
    h = await mount(numberWidget, { width: 0.1, size: 0.04 });
    h.input('value', 1);
    const v = () => h!.texts.filter((t) => !t.disposed && t.name === 'value').pop()!;
    expect(v().scale.x).toBe(1);
    h.input('value', 123456.789);
    h.frame();
    const bb = v().textRenderInfo!.blockBounds;
    expect((bb[2] - bb[0]) * v().scale.x).toBeLessThanOrEqual(0.1 - 2 * 0.014 + 1e-9);
    expect(v().scale.x).toBeLessThan(1);
  });
});

describe('rebuilds and stale hit targets', () => {
  it('after a prop rebuild only the new parts are live; old ones are hidden (never hit)', async () => {
    h = await mount(slider, {});
    const oldKnob = h.part('knob');
    await h.setProps({ label: 'changed' });
    expect(h.liveParts().map((o) => o.name).sort()).toEqual(['knob', 'track']);
    expect(h.part('knob')).not.toBe(oldKnob);
    expect(h.live(oldKnob)).toBe(false);
    // The detached subtree is invisible, so a picker that checks ancestor visibility ignores it.
    let top = oldKnob;
    while (top.parent) top = top.parent;
    expect(top.visible).toBe(false);
  });
});
