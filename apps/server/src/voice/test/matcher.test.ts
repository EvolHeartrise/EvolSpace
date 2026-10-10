import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, canonicalForms, normalize, parseNumber } from '../normalize.ts';
import { parseCommands } from '../commands.ts';
import { contextEntities, matchCommand, MissingVariableError, substituteArgs, referencesContext } from '../matcher.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const libraryFile = path.resolve(here, '../../../../../library/voice/commands.json');

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalize('  Delete   THIS! ')).toBe('delete this');
    expect(normalize('Switch to pass-through.')).toBe('switch to pass through');
    expect(normalize('A.R. mode, please?')).toBe('a r mode please');
    expect(normalize('That’s it')).toBe('thats it');
    expect(normalize('Set layer 3.')).toBe('set layer 3');
    expect(normalize('...')).toBe('');
  });

  it('canonical trims fillers, politeness and addressing', () => {
    expect(canonical('Okay, um, undo please.')).toBe('undo');
    expect(canonical('Claude, can you delete this?')).toBe('delete this');
    expect(canonical('Hey Claude, save the workspace, thanks.')).toBe('save the workspace');
    expect(canonical('Um.')).toBe('');
    expect(canonical('make the sphere red')).toBe('make the sphere red');
  });

  it('canonicalForms lists every intermediate trimmed form, least trimmed first', () => {
    expect(canonicalForms('Okay Claude, hide Claude, please.')).toEqual(['claude hide claude please', 'hide claude please', 'hide claude', 'hide']);
    expect(canonicalForms('undo')).toEqual([]);
    expect(canonicalForms('um')).toEqual([]);
  });

  it('parses spoken and written numbers', () => {
    expect(parseNumber('3')).toBe(3);
    expect(parseNumber('-2.5')).toBe(-2.5);
    expect(parseNumber('three')).toBe(3);
    expect(parseNumber('twenty one')).toBe(21);
    expect(parseNumber('twenty-one')).toBe(21);
    expect(parseNumber('one hundred and five')).toBe(105);
    expect(parseNumber('minus four')).toBe(-4);
    expect(parseNumber('to')).toBe(2);
    expect(parseNumber('layer')).toBeUndefined();
    expect(parseNumber('')).toBeUndefined();
  });
});

describe('parseCommands', () => {
  it('accepts valid entries and reports bad ones without dropping the rest', () => {
    const r = parseCommands([
      { id: 'ok', patterns: ['undo'], command: 'undo' },
      { id: 'bad-regex', patterns: ['(unclosed'], command: 'x' },
      { id: 'partly-bad', patterns: ['fine', '[bad'], command: 'x' },
      { patterns: ['x'], command: 'x' },
      { id: 'no-cmd', patterns: ['x'] },
      { id: 'ok', patterns: ['dup'], command: 'y' },
      { id: 'args', patterns: ['a'], command: 'z', args: [] },
      'nope',
    ]);
    expect(r.commands.map((c) => c.def.id)).toEqual(['ok', 'partly-bad']);
    expect(r.commands[1].def.patterns).toEqual(['fine']);
    expect(r.problems).toHaveLength(8);
    expect(r.problems.join('\n')).toMatch(/bad-regex/);
    expect(r.problems.join('\n')).toMatch(/duplicate id/);
  });

  it('rejects a non-array file', () => {
    expect(parseCommands({ foo: 1 }).problems[0]).toMatch(/array/);
    expect(parseCommands({ commands: [{ id: 'a', patterns: ['a'], command: 'a' }] }).commands).toHaveLength(1);
  });

  it('anchors patterns to the whole utterance, case-insensitively', () => {
    const { commands } = parseCommands([{ id: 'u', patterns: ['undo'], command: 'undo' }]);
    expect(matchCommand('UNDO', commands)?.command.def.id).toBe('u');
    expect(matchCommand('undo the color change on the sphere', commands)).toBeNull();
    expect(matchCommand('please undo', commands)?.command.def.id).toBe('u'); // canonical form
  });
});

describe('library/voice/commands.json', () => {
  const parsed = parseCommands(JSON.parse(readFileSync(libraryFile, 'utf8')));
  const id = (t: string) => matchCommand(t, parsed.commands)?.command.def.id ?? null;

  it('parses cleanly', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.commands.length).toBeGreaterThanOrEqual(12);
  });

  it.each([
    ['Undo.', 'undo'],
    ['Undo that', 'undo'],
    ['Okay, undo please', 'undo'],
    ['Redo.', 'redo'],
    ['Delete this.', 'delete-target'],
    ['Delete.', 'delete-target'],
    ['Remove', 'delete-target'],
    ['Remove that widget', 'delete-target'],
    ['Claude, delete this', 'delete-target'],
    ['Duplicate that.', 'duplicate-target'],
    ['Copy this one', 'duplicate-target'],
    ['Select this', 'select-target'],
    ['Clear selection', 'clear-selection'],
    ['Deselect', 'clear-selection'],
    ['Show the Claude panel.', 'show-agent-panel'],
    ['Show the clog panel.', 'show-agent-panel'],
    ['Open agent panel', 'show-agent-panel'],
    ['Hide the agent panel', 'hide-agent-panel'],
    ['Close Claude', 'hide-agent-panel'],
    ['Hide Claude, please.', 'hide-agent-panel'], // trailing "please" trimmed, but not the meaningful trailing "claude"
    ['Okay, show Claude now', 'show-agent-panel'],
    ['Switch to passthrough.', 'mode-ar'],
    ['Switch to pass through.', 'mode-ar'],
    ['Go to AR mode', 'mode-ar'],
    ['Switch to A.R.', 'mode-ar'],
    ['Passthrough on', 'mode-ar'],
    ['Switch to VR.', 'mode-vr'],
    ['Go back to virtual reality', 'mode-vr'],
    ['Passthrough off', 'mode-vr'],
    ['Save the workspace.', 'save-workspace'],
    ['Save', 'save-workspace'],
    ['Save workspace as Weather Demo', 'save-workspace'],
    ['Recalibrate.', 'recalibrate-origin'],
    ['Recenter the origin', 'recalibrate-origin'],
    ['Never mind.', 'cancel'],
    ['Cancel', 'cancel'],
  ])('%s → %s', (text, expected) => {
    expect(id(text)).toBe(expected);
  });

  it.each([
    'Make this bigger and color it red.',
    'Delete all the spheres',
    'Undo the last three changes and then save',
    'Show me the weather in Seattle',
    'Switch the chart to a bar chart',
    'Save a screenshot of this to my desktop',
    'What is this?',
    'Select the red sphere',
  ])('%s → Claude (no fast path)', (text) => {
    expect(id(text)).toBeNull();
  });

  it('save-as names become slugs; plain save passes no name', () => {
    const m = matchCommand('Save workspace as Weather Demo', parsed.commands)!;
    expect(substituteArgs(m.command.def.args, { groups: m.groups, entities: {}, text: m.text, transcript: '' })).toEqual({ name: 'weather-demo' });
    const p = matchCommand('Save the workspace', parsed.commands)!;
    expect(substituteArgs(p.command.def.args, { groups: p.groups, entities: {}, text: p.text, transcript: '' })).toEqual({});
  });

  it("spawn passes the widget name and the speaker's head pose ($head, omitted when unknown)", () => {
    const m = matchCommand('Spawn a line plot', parsed.commands)!;
    expect(m.command.def.id).toBe('spawn-widget');
    const head = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };
    expect(substituteArgs(m.command.def.args, { groups: m.groups, entities: {}, text: m.text, transcript: '', head })).toEqual({ widget: 'line plot', head });
    expect(substituteArgs(m.command.def.args, { groups: m.groups, entities: {}, text: m.text, transcript: '' })).toEqual({ widget: 'line plot' });
  });
});

describe('library/voice/commands.json: video + github fast paths', () => {
  const parsed = parseCommands(JSON.parse(readFileSync(libraryFile, 'utf8')));
  const run = (t: string) => {
    const m = matchCommand(t, parsed.commands);
    if (!m) return null;
    return { id: m.command.def.id, args: substituteArgs(m.command.def.args, { groups: m.groups, entities: {}, text: m.text, transcript: t }) };
  };
  const video = (t: string) => {
    const r = run(t);
    return r && r.args?.channel === 'video.ctl' ? r.args.value : r ? `other:${r.id}` : null;
  };

  it.each<[string, unknown]>([
    ['Play Video.', { cmd: 'play' }],
    ['Resume', { cmd: 'play' }],
    ['Pause.', { cmd: 'pause' }],
    ['Pause the video please', { cmd: 'pause' }],
    ['Stop the video', { cmd: 'pause' }],
    ['Mute.', { cmd: 'mute' }],
    ['Unmute the video', { cmd: 'unmute' }],
    ['Speed it up', { cmd: 'faster' }],
    ['Slow down', { cmd: 'slower' }],
    ['Normal speed', { cmd: 'speed', value: 'normal' }],
    ['Set speed to 1.5', { cmd: 'speed', value: '1 5' }],
    ['Speed 2x', { cmd: 'speed', value: '2' }],
    ['Play at 1.25x', { cmd: 'speed', value: '1 25' }],
    ['Playback speed one point five', { cmd: 'speed', value: 'one point five' }],
    ['Skip ahead 30 seconds', { cmd: 'skip', value: 30 }],
    ['Jump forward thirty seconds', { cmd: 'skip', value: 30 }],
    ['Skip ahead two minutes', { cmd: 'skip', value: 2, unit: 'min' }],
    ['Skip ahead', { cmd: 'skip', value: 10 }],
    ['Fast forward', { cmd: 'skip', value: 10 }],
    ['Go back 15 seconds', { cmd: 'back', value: 15 }],
    ['Rewind 1 minute', { cmd: 'back', value: 1, unit: 'min' }],
    ['Rewind', { cmd: 'back', value: 10 }],
    ['Restart the video', { cmd: 'restart' }],
    ['Go back to the beginning', { cmd: 'restart' }],
  ])('%s → %j', (text, expected) => {
    expect(video(text)).toEqual(expected);
  });

  it.each([
    'Please play the newest 3Blue1Brown YouTube video.',
    'Please add controls to change the video playback speed.',
    'How many times did it fail?',
    'Click.',
    'Stop',
  ])('%s → Claude (no fast path)', (text) => {
    expect(run(text)).toBeNull();
  });

  it("keeps 'go back' as undo", () => {
    expect(run('Go back')?.id).toBe('undo');
  });

  it('browser: back / forward / reload / scroll', () => {
    const b = (t: string) => { const r = run(t); return r?.args?.channel === 'browser.ctl' ? r.args.value : r ? `other:${r.id}` : null; };
    expect(b('Browser back')).toEqual({ cmd: 'back' });
    expect(b('Go forward in the browser')).toEqual({ cmd: 'forward' });
    expect(b('Reload the page')).toEqual({ cmd: 'reload' });
    expect(b('Scroll down.')).toEqual({ cmd: 'scroll', dy: 700 });
    expect(b('Scroll the page up a bit')).toEqual({ cmd: 'scroll', dy: -700 });
    expect(b('Please use browser use to do a Google search for cats')).toBeNull(); // that one is for Claude
  });

  it('github: show issue / PR numbers', () => {
    expect(run('Show me issue number 10.')?.args).toEqual({ channel: 'github.bsrl.ctl.show', value: '10' });
    expect(run('PR 62')?.args).toEqual({ channel: 'github.bsrl.ctl.show', value: '62' });
  });
});

describe('context + substitution', () => {
  const ctx = {
    focus: { right: { entity: 'e-right', point: [0, 0, 0] as [number, number, number] }, left: { entity: 'e-left', point: [0, 0, 0] as [number, number, number] } },
    gaze: { entity: 'e-gaze', point: [0, 0, 0] as [number, number, number] },
    selected: 'e-sel',
  };

  it('target priority: right focus → left focus → selected → gaze; explicit target wins', () => {
    expect(contextEntities(ctx).target).toBe('e-right');
    expect(contextEntities({ ...ctx, focus: { right: null, left: ctx.focus.left } }).target).toBe('e-left');
    expect(contextEntities({ ...ctx, focus: {} }).target).toBe('e-sel');
    expect(contextEntities({ gaze: ctx.gaze }).target).toBe('e-gaze');
    expect(contextEntities({ ...ctx, target: 'e-explicit' }).target).toBe('e-explicit');
    expect(contextEntities({})).toEqual({});
    expect(contextEntities(undefined)).toEqual({});
  });

  const vars = (groups: Record<string, string> = {}) => ({ groups, entities: contextEntities(ctx), text: 'set layer three', transcript: 'Set layer three.' });

  it('substitutes $target/$selected/$gaze and named groups, recursively', () => {
    const out = substituteArgs(
      { entity: '$target', nested: { sel: '$selected', list: ['$gaze', 'x-$value'] }, keep: 5, nil: null, text: '$text' },
      vars({ value: 'three' }),
    );
    expect(out).toEqual({ entity: 'e-right', nested: { sel: 'e-sel', list: ['e-gaze', 'x-three'] }, keep: 5, nil: null, text: 'set layer three' });
  });

  it('typed substitution: number/int/slug/bool', () => {
    expect(substituteArgs({ v: '$v:number' }, vars({ v: 'twenty one' }))).toEqual({ v: 21 });
    expect(substituteArgs({ v: '$v:int' }, vars({ v: '2.6' }))).toEqual({ v: 3 });
    expect(substituteArgs({ v: '$v:slug' }, vars({ v: 'My Cool Space!' }))).toEqual({ v: 'my-cool-space' });
    expect(substituteArgs({ v: '$v:bool' }, vars({ v: 'on' }))).toEqual({ v: true });
    expect(() => substituteArgs({ v: '$v:number' }, vars({ v: 'banana' }))).toThrow(MissingVariableError);
  });

  it('unmatched optional groups omit the key; missing context throws', () => {
    expect(substituteArgs({ name: '$name', other: 1 }, vars())).toEqual({ other: 1 });
    expect(() => substituteArgs({ entity: '$target' }, { groups: {}, entities: {}, text: '', transcript: '' })).toThrow(MissingVariableError);
    expect(substituteArgs(undefined, vars())).toBeUndefined();
  });

  it('referencesContext lists the deictic variables used', () => {
    expect(referencesContext({ a: '$target', b: ['$gaze'], c: '$value' }).sort()).toEqual(['gaze', 'target']);
  });
});
