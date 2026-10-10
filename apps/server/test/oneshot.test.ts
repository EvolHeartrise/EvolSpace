import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { OneshotAgents, oneshotPrompt } from '../src/oneshot.ts';

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
  exit(code: number, stdout = '') {
    this.stdout.end(stdout);
    setImmediate(() => this.emit('close', code));
  }
}

function setup(opts: { maxConcurrent?: number; timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const said: Array<[string, string]> = [];
  const events: Array<Record<string, unknown>> = [];
  const agents = new OneshotAgents({
    repoRoot: '/repo',
    baseUrl: () => 'http://127.0.0.1:9999',
    say: (text, kind) => { said.push([kind, text]); },
    event: (_t, d) => { events.push(d); },
    log: () => {},
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
  return { agents, children, calls, said, events };
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
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--output-format', 'json']));
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(env.EVOL_URL).toBe('http://127.0.0.1:9999');
    expect(env.EVOL_BRIDGE_CHANNEL).toBe('0');
    expect(env.EVOL_STATUS_HOOK).toBe('0');
    expect(env.CLAUDECODE).toBeUndefined();
    await tick();
    expect(children[0].input).toContain('<channel source="evolspace" kind="oneshot" target="e-1" target_name="Ball \'big\'">make this red</channel>');
    expect(agents.count).toBe(1);

    children[0].exit(0, JSON.stringify({ type: 'result', is_error: false, result: 'Made it red.', total_cost_usd: 0.01, num_turns: 3 }));
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
    children[0].exit(1, JSON.stringify({ is_error: true, result: 'boom' }));
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

  it('prompt omits empty context', () => {
    expect(oneshotPrompt('hi', {})).toContain('<channel source="evolspace" kind="oneshot">hi</channel>');
  });
});
