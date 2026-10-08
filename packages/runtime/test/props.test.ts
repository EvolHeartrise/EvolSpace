import { describe, expect, it } from 'vitest';
import { coerce, resolveProps } from '../src/widgets/props.ts';

describe('props', () => {
  it('coerces by spec type', () => {
    expect(coerce({ type: 'number', min: 0, max: 1 }, '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(coerce({ type: 'number', min: 0, max: 1 }, 3)).toMatchObject({ ok: true, value: 1 });
    expect(coerce({ type: 'integer' }, 2.6)).toEqual({ ok: true, value: 3 });
    expect(coerce({ type: 'boolean' }, 'true')).toEqual({ ok: true, value: true });
    expect(coerce({ type: 'boolean' }, 'maybe').ok).toBe(false);
    expect(coerce({ type: 'color' }, '#ff8800')).toEqual({ ok: true, value: '#ff8800' });
    expect(coerce({ type: 'color' }, 0x00ff00)).toEqual({ ok: true, value: '#00ff00' });
    expect(coerce({ type: 'color' }, 'not a color!').ok).toBe(false);
    expect(coerce({ type: 'vec3' }, [1, '2', 3])).toEqual({ ok: true, value: [1, 2, 3] });
    expect(coerce({ type: 'vec3' }, 2)).toEqual({ ok: true, value: [2, 2, 2] });
    expect(coerce({ type: 'vec3' }, [1, 2]).ok).toBe(false);
    expect(coerce({ type: 'enum', options: ['Low', 'High'] }, 'high')).toEqual({ ok: true, value: 'High' });
    expect(coerce({ type: 'enum', options: ['a'] }, 'z').ok).toBe(false);
    expect(coerce({ type: 'json' }, { a: [1] })).toEqual({ ok: true, value: { a: [1] } });
    expect(coerce({ type: 'channel' }, 'interp.meta')).toEqual({ ok: true, value: 'interp.meta' });
  });

  it('applies defaults, falls back on invalid values, passes undeclared props through', () => {
    const specs = {
      n: { type: 'number' as const, default: 1 },
      list: { type: 'json' as const, default: [1, 2] },
      e: { type: 'enum' as const, options: ['x', 'y'] },
      noDefault: { type: 'string' as const },
    };
    const { props, issues } = resolveProps(specs, { n: 'oops', extra: 5 });
    expect(props).toEqual({ n: 1, list: [1, 2], e: 'x', extra: 5 });
    expect(issues.map((i) => i.prop)).toEqual(['n']);
    // Defaults are cloned (a widget mutating its props can't corrupt the manifest).
    (props.list as number[]).push(3);
    expect(resolveProps(specs, {}).props.list).toEqual([1, 2]);
  });
});
