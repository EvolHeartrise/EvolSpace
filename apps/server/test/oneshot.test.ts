import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OneshotAgentStatus } from '@evolspace/protocol';
import { OneshotAgents, oneshotPrompt, parseStreamLine } from '../src/oneshot.ts';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  input = '';
  constructor() {
    super();
    this.stdin.on('data', (c) => { this.input += String(c); });
  }
  kill() { this.killed = true; setImmediate(() => this.emit('close', null)); return true; }
  line(m: unknown) { this.stdout.write(`${JSON.stringify(m)}\n`); }
  exit(code: number, result?: Record<string, unknown>) {
    this.stdout.end(result ? JSON.stringify({ type: 'result', ...result }) : '');
    setImmediate(() => this.emit('close', code));
  }
}

function setup(opts: { maxConcurrent?: number; timeoutMs?: number; lingerMs?: number } = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const said: Array<[string, string]> = [];
  const events: Array<Record<string, unknown>> = [];
  const lists: OneshotAgentStatus[][] = [];
  const agents = new OneshotAgents({
    repoRoot: '/repo',
    baseUrl: () => 'http://127.0.0.1:9999',
    say: (text, kind) => { said.push([kind, text]); },
    event: (_t, d) => { events.push(d); },
    log: () => {},
    onChange: (l) => { lists.push(l); },
  }, {
    bin: 'claude',
    ...opts,
    spawn: ((bin: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd: string }) => {
      calls.push({ bin, args, env: o.env, cwd: o.cwd });
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as never,
  });
  return { agents, children, calls, said, events, lists };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('one-off agents', () => {
  it('runs a headless, non-persisted claude with the request + context and says its result', async () => {
    process.env.CLAUDECODE = '1';
    const { agents, children, calls, said, events } = setup();
    expect(agents.ask('make this red', { target: 'e-1', target_name: 'Ball "big"' })).toBe(1);
    delete process.env.CLAUDECODE;
    const { args, env, cwd } = calls[0];
    expect(cwd).toBe('/repo');
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--output-format', 'stream-json', '--verbose']));
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(env.EVOL_URL).toBe('http://127.0.0.1:9999');
    expect(env.EVOL_BRIDGE_CHANNEL).toBe('0');
    expect(env.EVOL_STATUS_HOOK).toBe('0');
    expect(env.CLAUDECODE).toBeUndefined();
    await tick();
    expect(children[0].input).toContain('<channel source="evolspace" kind="oneshot" target="e-1" target_name="Ball \'big\'">make this red</channel>');
    expect(agents.count).toBe(1);

    children[0].exit(0, { is_error: false, result: 'Made it red.', total_cost_usd: 0.01, num_turns: 3 });
    await tick(); await tick();
    expect(agents.count).toBe(0);
    expect(said.at(-1)).toEqual(['reply', 'Made it red.']);
    expect(events.at(-1)).toMatchObject({ id: 1, phase: 'end', ok: true, result: 'Made it red.' });
  });

  it('reports failures and refuses beyond the concurrency cap', async () => {
    const { agents, children, said } = setup({ maxConcurrent: 1 });
    agents.ask('a');
    expect(agents.ask('b')).toBeNull();
    expect(said.at(-1)?.[1]).toMatch(/Already running 1/);
    children[0].exit(1, { is_error: true, result: 'boom' });
    await tick(); await tick();
    expect(said.at(-1)).toEqual(['error', 'One-off agent failed: boom']);
  });

  it('kills an agent that runs past the timeout', async () => {
    const { agents, children, said } = setup({ timeoutMs: 5 });
    agents.ask('slow');
    await new Promise((r) => setTimeout(r, 20));
    expect(children[0].killed).toBe(true);
    await tick();
    expect(said.at(-1)?.[0]).toBe('error');
    expect(said.at(-1)?.[1]).toMatch(/timed out/);
  });

  it('floats in front of the invoking head pose, shows live activity, lingers when done', async () => {
    const { agents, children, lists } = setup({ lingerMs: 10 });
    const head = { position: [1, 1.6, 0], rotation: [0, 0, 0, 1] }; // looking down -Z
    agents.ask('one', { head });
    agents.ask('two', { head });
    const [a, b] = lists.at(-1)!;
    expect(a.position[0]).toBeCloseTo(1);
    expect(a.position[2]).toBeCloseTo(-0.7);
    expect(a.position[1]).toBeCloseTo(1.45);
    expect(b.position[1]).toBeGreaterThan(a.position[1]); // same spot: stacked, not overlapping
    expect(a).toMatchObject({ state: 'thinking', text: 'one' });

    children[0].line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/library/widgets/clock/widget.ts' } }] } });
    await tick();
    expect(lists.at(-1)![0]).toMatchObject({ state: 'working', detail: 'Editing clock/widget.ts' });

    children[0].exit(0, { result: 'ok' });
    await tick(); await tick();
    expect(lists.at(-1)![0]).toMatchObject({ id: 1, done: true, state: 'idle' });
    expect(agents.count).toBe(1); // the finished one no longer counts toward the cap
    await new Promise((r) => setTimeout(r, 30));
    expect(lists.at(-1)!.map((x) => x.id)).toEqual([2]);
  });

  it('parses stream-json activity', () => {
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hm"}]}}').activity?.state).toBe('thinking');
    expect(parseStreamLine('{"type":"result","result":"x"}').result?.result).toBe('x');
    expect(parseStreamLine('not json')).toEqual({});
  });

  it('prompt omits empty context', () => {
    expect(oneshotPrompt('hi', {})).toContain('<channel source="evolspace" kind="oneshot">hi</channel>');
  });
});
