import { describe, it, expect } from 'vitest';
import { CommandRouter } from '../src/commands.ts';
import { SimHands, isHandFrame } from '../src/sim/sim.ts';
import { buildUserPose, voiceContextOf, RateGate } from '../src/user/pose-stream.ts';
import { parseConfig } from '../src/config.ts';
import type { ClientMessage, HandFrame } from '@evolspace/protocol';

const frame = (hand: 'left' | 'right', v = 0.123456789): HandFrame => ({ hand, joints: new Array(175).fill(v), radii: new Array(25).fill(0.0091234) });

describe('CommandRouter', () => {
  function setup(runtimeKnows: string[] = []) {
    const sent: ClientMessage[] = [];
    const runtimeCalls: string[] = [];
    const registry = new Map<string, (a: Record<string, unknown> | undefined, p: 'start' | 'end') => void>();
    const r = new CommandRouter({
      runLocalCommand: (name, a, phase) => {
        const fn = registry.get(name);
        if (fn) { fn(a, phase); return true; }
        if (!runtimeKnows.includes(name)) return false;
        runtimeCalls.push(`${name}:${phase}`);
        return true;
      },
      registerLocalCommand: (name, fn) => { registry.set(name, fn); return () => registry.delete(name); },
    }, (m) => sent.push(m));
    return { r, sent, runtimeCalls, registry };
  }

  it('routes client → runtime → server', () => {
    const { r, sent, runtimeCalls } = setup(['select']);
    const calls: string[] = [];
    r.register('voice.ptt', (_a, p) => calls.push(p));
    expect(r.run('voice.ptt', undefined, 'start')).toBe('local');
    expect(r.run('voice.ptt', undefined, 'end')).toBe('local');
    expect(r.run('select', { entity: 'a' }, 'start')).toBe('local');
    expect(r.run('undo', undefined, 'start')).toBe('server');
    expect(r.run('undo', undefined, 'end')).toBe('dropped');
    expect(calls).toEqual(['start', 'end']);
    expect(runtimeCalls).toEqual(['select:start']);
    expect(sent).toEqual([{ type: 'command', name: 'undo' }]);
  });

  it('client commands are registered into the runtime registry (server-pushed commands reach them)', () => {
    const { r, registry } = setup();
    const seen: unknown[] = [];
    const off = r.register('session.mode', (a) => seen.push(a));
    registry.get('session.mode')!({ mode: 'ar' }, 'start');
    expect(seen).toEqual([{ mode: 'ar' }]);
    off();
    expect(registry.has('session.mode')).toBe(false);
    expect(r.has('session.mode')).toBe(false);
  });

  it('handler errors do not escape', () => {
    const { r } = setup();
    r.register('boom', () => { throw new Error('x'); });
    expect(() => r.run('boom', undefined)).not.toThrow();
    expect(r.log.at(-1)).toMatchObject({ name: 'boom', route: 'local' });
  });
});

describe('SimHands', () => {
  const synth = (spec: { hand: 'left' | 'right' }) => frame(spec.hand, 0.5);

  it('accepts specs, frames, arrays and records; override until cleared', () => {
    const s = new SimHands(synth);
    expect(s.active).toBe(false);
    s.setHands({ hand: 'right', pinch: 'index' });
    expect(Object.keys(s.get()!)).toEqual(['right']);
    s.setHands([frame('left'), { hand: 'right' }]);
    expect(s.get()!.left!.joints[0]).toBeCloseTo(0.123456789);
    expect(s.get()!.right!.joints[0]).toBe(0.5);
    s.setHands({ left: { hand: 'left' } as never });
    expect(Object.keys(s.get()!)).toEqual(['left']);
    s.clearHands();
    expect(s.get()).toBeNull();
  });

  it('rejects invalid hands and copies frames', () => {
    const s = new SimHands(synth);
    expect(() => s.setHands({ hand: 'middle' } as never)).toThrow(/invalid hand/);
    const f = frame('right');
    s.setHands(f);
    f.joints[0] = 99;
    expect(s.get()!.right!.joints[0]).not.toBe(99);
    expect(isHandFrame(f)).toBe(true);
    expect(isHandFrame({ hand: 'right' })).toBe(false);
  });
});

describe('UserPose building', () => {
  it('rounds values and maps rays to focus', () => {
    const p = buildUserPose({
      t: 1234.6,
      mode: 'ar',
      head: { position: [0.123456, 1.6, -0.000049], rotation: [0, 0.7071067, 0, 0.7071067] },
      fov: 97.12345,
      aspect: 0.9123456,
      hands: { right: frame('right') },
      rays: { right: { hit: { entity: 'e1', point: [1.23456, 2, 3] } }, left: { hit: null } },
      gaze: { entity: 'e2', point: [0, 1, -2] },
      selected: 'e1',
    });
    expect(p.t).toBe(1235);
    expect(p.head.position).toEqual([0.1235, 1.6, -0]);
    expect(p.head.rotation[1]).toBe(0.7071);
    expect(p.fov).toBe(97.12);
    expect(p.hands.right!.joints[0]).toBe(0.1235);
    expect(p.hands.left).toBeUndefined();
    expect(p.focus).toEqual({ right: { entity: 'e1', point: [1.2346, 2, 3] }, left: null });
    expect(p.gaze).toEqual({ entity: 'e2', point: [0, 1, -2] });
    expect(voiceContextOf(p)).toEqual({ focus: p.focus, gaze: p.gaze, selected: 'e1', head: p.head });
  });

  it('RateGate averages 30 Hz on a 72/90/120 Hz loop', () => {
    for (const hz of [72, 90, 120]) {
      const g = new RateGate(30);
      let n = 0;
      for (let t = 0; t < 10_000; t += 1000 / hz) if (g.due(t)) n++;
      expect(Math.abs(n - 300)).toBeLessThanOrEqual(hz === 72 ? 12 : 3);
    }
  });
});

describe('RateGate clock jumps', () => {
  it('resyncs when the frame clock jumps backwards instead of stalling', () => {
    const g = new RateGate(30);
    let n = 0;
    for (let t = 50_000; t < 51_000; t += 1000 / 90) if (g.due(t)) n++;
    expect(n).toBeGreaterThanOrEqual(29);
    // New time base (e.g. XR rAF) starting near 0.
    n = 0;
    for (let t = 0; t < 1000; t += 1000 / 90) if (g.due(t)) n++;
    expect(n).toBeGreaterThanOrEqual(29);
    expect(n).toBeLessThanOrEqual(31);
  });
});

describe('parseConfig', () => {
  it('defaults to xr on the same origin', () => {
    const c = parseConfig({ search: '', protocol: 'https:', host: '192.168.1.5:8443' });
    expect(c).toMatchObject({ role: 'xr', wsUrl: 'wss://192.168.1.5:8443/ws', emulate: null, devui: false });
  });
  it('parses role, emulation and overrides', () => {
    const c = parseConfig({ search: '?role=desktop&emulate=quest3&devui=1&server=ws://127.0.0.1:9999&fps=72&autoenter=ar', protocol: 'http:', host: 'x' });
    expect(c).toMatchObject({ role: 'desktop', emulate: 'quest3', devui: true, wsUrl: 'ws://127.0.0.1:9999/ws', frameRate: 72, autoEnter: 'ar' });
    expect(parseConfig({ search: '?role=bogus', protocol: 'http:', host: 'x' }).role).toBe('xr');
  });
  it('normalizes ?server= to a ws(s) URL ending in /ws', () => {
    const ws = (server: string, protocol = 'http:') => parseConfig({ search: `?server=${encodeURIComponent(server)}`, protocol, host: 'page' }).wsUrl;
    expect(ws('https://10.0.0.2:8443')).toBe('wss://10.0.0.2:8443/ws');
    expect(ws('http://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/ws');
    expect(ws('wss://h:1/ws')).toBe('wss://h:1/ws');
    expect(ws('10.0.0.2:8443', 'https:')).toBe('wss://10.0.0.2:8443/ws');
    expect(ws('  ')).toBe('ws://page/ws');
    // ?ws= (the mirror's documented override) is an alias
    expect(parseConfig({ search: '?role=mirror&ws=ws://127.0.0.1:9/ws', protocol: 'http:', host: 'page' }).wsUrl).toBe('ws://127.0.0.1:9/ws');
  });
});
