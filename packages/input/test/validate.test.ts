import { describe, expect, it } from 'vitest';
import { validateInteractionBinding, validateInteractionSet, validatePoseDef } from '../src/validate.ts';

describe('validators', () => {
  it('flags broken pose files precisely', () => {
    const v = validatePoseDef({ id: 'x', description: 'd', hand: 'both', source: 'mine', conditions: [{ feature: 'curl.index' }, { feature: 'pinch.indx', min: 0.5, max: 0.1 }] }, 'y');
    expect(v.errors).toEqual(expect.arrayContaining([
      'id "x" must equal the file name "y"',
      'hand must be "left", "right" or "either"',
      'source must be "builtin", "recorded" or "manual"',
      'conditions[0] (curl.index) needs min and/or max',
      'conditions[1] (pinch.indx): min > max',
    ]));
    expect(v.warnings[0]).toContain('unknown feature "pinch.indx"');
    expect(validatePoseDef(null).errors).toEqual(['pose must be a JSON object']);
    expect(validatePoseDef({ id: 'ok', description: '', hand: 'left', source: 'manual', conditions: [] }).errors).toEqual(['conditions must be a non-empty array']);
  });

  it('flags broken interaction sets and bindings', () => {
    const v = validateInteractionSet({
      description: '', scope: 'everywhere', bindings: [
        { id: 'a', pose: 'pinch', target: 'none', action: { type: 'grab' } },
        { id: 'a', pose: 'nope', target: 'ray', hand: 'third', action: { type: 'command' } },
        { id: 'c', pose: 'pinch', target: 'near', action: { type: 'teleport' } },
      ],
    }, ['pinch']);
    expect(v.errors).toEqual(expect.arrayContaining([
      'scope must be "global" or "entity-default"',
      'bindings[0]: grab needs a target (ray|touch|near)',
      'bindings[1].hand must be left|right|either|both',
      'bindings[1].action.command must be a string',
      'bindings[1]: duplicate id "a"',
      'bindings[2].action.type must be grab|scale|widget|command|channel',
    ]));
    expect(v.warnings).toEqual(['bindings[1]: pose "nope" does not exist in library/poses']);
    expect(validateInteractionBinding({ id: 'w', pose: 'pinch', target: 'near', action: { type: 'channel', channel: 'x' } }).errors)
      .toEqual(['binding.action.value is required']);
  });
});
