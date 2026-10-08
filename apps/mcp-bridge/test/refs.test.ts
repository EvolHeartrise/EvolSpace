import { describe, expect, it } from 'vitest';
import { formatRef, parseRef, RefError, sameRef } from '../src/refs.ts';

describe('parseRef', () => {
  it('parses entity ports', () => {
    expect(parseRef('e-12.value')).toEqual({ kind: 'port', entity: 'e-12', port: 'value' });
    expect(parseRef('  slider_1.out  ')).toEqual({ kind: 'port', entity: 'slider_1', port: 'out' });
  });

  it('splits at the last dot so entity ids may contain dots', () => {
    expect(parseRef('lens.v2.value')).toEqual({ kind: 'port', entity: 'lens.v2', port: 'value' });
  });

  it('parses channels with # and channel: prefixes', () => {
    expect(parseRef('#weather.seattle')).toEqual({ kind: 'channel', channel: 'weather.seattle' });
    expect(parseRef('channel:interp.ctl.layer')).toEqual({ kind: 'channel', channel: 'interp.ctl.layer' });
  });

  it.each(['', '   ', '#', 'channel:', 'e-12', 'e-12.', '.value', 'e-12.va lue', 'e 12.value', 'e-12.1abc'])(
    'rejects %j with a helpful message',
    (bad) => {
      expect(() => parseRef(bad)).toThrow(RefError);
      try {
        parseRef(bad);
      } catch (e) {
        expect((e as Error).message).toMatch(/e-12\.value|#/);
      }
    },
  );

  it('round-trips through formatRef', () => {
    for (const s of ['e-1.value', '#a.b.c', 'x.y.z']) expect(formatRef(parseRef(s))).toBe(s);
    expect(formatRef(parseRef('channel:q'))).toBe('#q');
  });

  it('compares refs', () => {
    expect(sameRef(parseRef('e-1.v'), parseRef('e-1.v'))).toBe(true);
    expect(sameRef(parseRef('e-1.v'), parseRef('e-2.v'))).toBe(false);
    expect(sameRef(parseRef('#v'), parseRef('channel:v'))).toBe(true);
    expect(sameRef(parseRef('#v'), parseRef('e.v'))).toBe(false);
  });
});
