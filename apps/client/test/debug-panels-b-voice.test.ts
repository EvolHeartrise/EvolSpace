// The Agent panel's dry-run voice matcher (src/debug/panels/agent/voice-match.ts)
// is a client-side REPLICA of the server matcher. This test imports the server
// modules (side-effect free) and cross-checks both on library/voice/commands.json
// plus synthetic commands, so the replica can't silently drift.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VoiceCommand } from '@evolspace/protocol';
import { canonicalForms as sCanonicalForms, normalize as sNormalize, parseNumber as sParseNumber } from '../../server/src/voice/normalize.ts';
import { contextEntities as sContextEntities, matchCommand as sMatch, MissingVariableError as SMissing, substituteArgs as sSubstitute } from '../../server/src/voice/matcher.ts';
import { parseCommands } from '../../server/src/voice/commands.ts';
import {
  canonicalForms, compileCommands, contextEntities, dryRun, matchVoice, normalize, parseNumber, substituteArgs,
} from '../src/debug/panels/agent/voice-match.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIBRARY: VoiceCommand[] = JSON.parse(readFileSync(path.join(ROOT, 'library', 'voice', 'commands.json'), 'utf8'));

const SYNTHETIC: VoiceCommand[] = [
  { id: 'set-layer', patterns: ['(set )?layer (?<value>.+)'], command: 'channel.publish', args: { channel: 'interp.ctl.layer', value: '$value:int' } },
  { id: 'scale-by', patterns: ['scale (this|it) by (?<k>.+)'], command: 'scale', args: { entity: '$target', factor: '$k:number', note: 'from $text' } },
  { id: 'toggle', patterns: ['grid (?<on>on|off)'], command: 'grid.toggle', args: { visible: '$on:bool', list: ['$missing', 'x'] } },
];

const PHRASES = [
  'undo', 'Undo.', 'okay, undo please', 'um undo that', 'Undo the last change!', 'go back one step', 'take it back',
  'redo', 're do it', 'delete this', 'Remove that widget.', 'get rid of it', 'delete the selected one',
  'duplicate this', 'make a copy of that', 'clone the selection', 'select this one', 'clear the selection', 'deselect everything',
  'hide Claude please', 'show me the agent panel', 'open the chat', 'close the panel', 'switch to AR', 'go back to pass-through mode',
  'pass through on', 'VR mode please', 'turn off the passthrough', 'save', 'save the workspace', 'save workspace as My Demo 2',
  'recenter the room', 're-calibrate', 'center the space here', 'nevermind', 'never mind that', 'cancel', 'claude, can you cancel',
  'make this bigger', 'what is the loss on layer three', 'set layer twenty one', 'okay set layer twenty one please', 'layer 4', 'scale it by one and a half',
  'scale this by 2.5', 'grid on', 'grid off', 'um', '', 'thank you', "let's undo", "That's it — undo!", 'A.R. mode',
];

describe('voice matcher replica (cross-check against apps/server/src/voice)', () => {
  it('normalize / canonicalForms / parseNumber agree with the server', () => {
    for (const p of PHRASES) {
      expect(normalize(p), p).toBe(sNormalize(p));
      expect(canonicalForms(p), p).toEqual(sCanonicalForms(p));
    }
    for (const n of ['12', '-3.5', 'twelve', 'twenty one', 'one hundred and five', 'minus four', 'to', 'two thousand three', 'abc', '', 'forty-two']) {
      expect(parseNumber(n), n).toBe(sParseNumber(n));
    }
  });

  it('matches the same command / pattern / groups / form as the server on commands.json + synthetic commands', () => {
    const defs = [...LIBRARY, ...SYNTHETIC];
    const server = parseCommands(defs);
    expect(server.problems).toEqual([]);
    const client = compileCommands(defs);
    let matched = 0;
    for (const p of PHRASES) {
      const s = sMatch(p, server.commands);
      const c = matchVoice(p, client).match;
      if (!s) { expect(c, p).toBeNull(); continue; }
      matched++;
      expect(c, p).not.toBeNull();
      expect(c!.command.id, p).toBe(s.command.def.id);
      expect(c!.pattern, p).toBe(s.pattern);
      expect(c!.groups, p).toEqual(s.groups);
      expect(c!.text, p).toBe(s.text);
    }
    expect(matched).toBeGreaterThan(30);
  });

  it('substitutes args like the server (typed vars, $target, omitted optionals, missing context)', () => {
    const defs = [...LIBRARY, ...SYNTHETIC];
    const server = parseCommands(defs).commands;
    const client = compileCommands(defs);
    const contexts = [undefined, { selected: 'e-7' }, { focus: { right: { entity: 'e-1', point: [0, 0, 0] } }, selected: 'e-7' }, { target: 'e-9' }];
    for (const ctx of contexts) {
      expect(contextEntities(ctx as Record<string, unknown>)).toEqual(sContextEntities(ctx as Record<string, unknown>));
      for (const p of PHRASES) {
        const s = sMatch(p, server);
        if (!s) continue;
        const vars = { groups: s.groups, entities: sContextEntities(ctx as Record<string, unknown>), text: s.text, transcript: p };
        let sv: unknown, se: string | null = null;
        try { sv = sSubstitute(s.command.def.args, vars); } catch (e) { if (!(e instanceof SMissing)) throw e; se = e.message; }
        const d = dryRun(p, client, ctx as Record<string, unknown>);
        if (s.command.def.command === 'none') { expect(d.route, p).toBe('fastpath'); continue; }
        if (se) { expect(d, p).toMatchObject({ route: 'none', error: se }); continue; }
        expect(d.route, p).toBe('fastpath');
        if (d.route === 'fastpath') { expect(d.args, p).toEqual(sv); expect(d.run).toBe(s.command.def.command); }
        let cv: unknown;
        try { cv = substituteArgs(s.command.def.args, vars); } catch { cv = 'threw'; }
        expect(cv, p).toEqual(sv);
      }
    }
  });

  it('dry run: no match → agent; noop command; examples', () => {
    const client = compileCommands([...LIBRARY, ...SYNTHETIC]);
    expect(dryRun('make this bigger', client).route).toBe('agent');
    expect(dryRun('never mind', client)).toMatchObject({ route: 'fastpath', noop: true });
    expect(dryRun('delete this', client)).toMatchObject({ route: 'none', error: 'missing value for $target' });
    expect(dryRun('delete this', client, { selected: 'e-3' })).toMatchObject({ route: 'fastpath', run: 'delete', args: { entity: 'e-3' } });
    expect(dryRun('okay set layer twenty one', client)).toMatchObject({ route: 'fastpath', args: { value: 21 } });
    expect(dryRun('save workspace as My Demo 2', client)).toMatchObject({ route: 'fastpath', args: { name: 'my-demo-2' } });
    expect(dryRun('save', client)).toMatchObject({ route: 'fastpath', args: {} });
  });

  it('invalid patterns are reported and skipped (like the server)', () => {
    const c = compileCommands([{ id: 'bad', patterns: ['(unclosed', 'ok'], command: 'x' }]);
    expect(c[0].errors).toHaveLength(1);
    expect(matchVoice('ok', c).match?.patternIndex).toBe(1);
  });
});
