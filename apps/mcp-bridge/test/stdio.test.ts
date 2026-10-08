// End-to-end: spawn the bridge exactly as .mcp.json tells Claude Code to (from
// the repo root), talk MCP over stdio, list tools, call one, and receive a
// channel notification for a voice request.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { deadUrl, EventLog, FakeEvol, until } from './fake-evol.ts';
import { textOf } from './helpers.ts';
import { CHANNEL_METHOD } from '../src/server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('bridge over stdio (as launched by Claude Code)', () => {
  const log = new EventLog();
  let fake: FakeEvol;
  let client: Client;
  let stderr = '';
  const notifications: Notification[] = [];

  beforeAll(async () => {
    fake = await new FakeEvol()
      .on('GET /api/events', log.handler())
      .on('GET /api/scene', { json: { version: 1, workspace: 'w', entities: {}, links: {} } })
      .on('POST /api/agent/status', { json: {} })
      .on('GET /api/health', { json: { ok: true, version: '9.9.9', clients: [] } })
      .start();
    const mcp = JSON.parse(readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
    const cfg = mcp.mcpServers.evolspace as { command: string; args: string[] };
    expect(cfg.command).toBe('node');
    const transport = new StdioClientTransport({
      command: process.execPath, // = "node" from .mcp.json, resolved
      args: cfg.args,
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), EVOL_URL: fake.url, MCP_PROTOCOL_NEGOTIATION: 'legacy' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => (stderr += d));
    client = new Client({ name: 'stdio-test', version: '0' });
    client.fallbackNotificationHandler = async (n) => {
      notifications.push(n);
    };
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await fake?.stop();
  });

  it('identifies as evolspace with the channel capability', () => {
    expect(client.getServerVersion()?.name).toBe('evolspace');
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({});
  });

  it('lists tools and answers a call', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(28);
    expect(tools.map((t) => t.name)).toContain('screenshot');
    const r = await client.callTool({ name: 'server_status', arguments: {} });
    expect(textOf(r as never)).toContain('(v9.9.9)');
  });

  it('pushes a voice request as a channel notification', async () => {
    await until(() => fake.find('GET', '/api/events').length > 0, 10_000);
    log.add('agent.ask', { text: 'show me layer five', utteranceId: 'u-42' });
    await until(() => notifications.some((n) => n.method === CHANNEL_METHOD), 10_000);
    const n = notifications.find((x) => x.method === CHANNEL_METHOD)!;
    expect(n.params).toEqual({ content: 'show me layer five', meta: { kind: 'voice', utterance_id: 'u-42' } });
  });

  it('logs only to stderr', () => {
    expect(stderr).toContain('[evolspace-mcp]');
  });
});

describe('bridge process lifetime', () => {
  const MAIN = path.join(ROOT, 'apps', 'mcp-bridge', 'src', 'main.ts');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  it('exits when stdin closes (Claude Code went away)', async () => {
    const p = spawn(process.execPath, ['--import', 'tsx', MAIN], {
      cwd: ROOT, env: { ...process.env, EVOL_URL: await deadUrl() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let it boot
      p.stdin.end();
      const code = await Promise.race([
        new Promise<number | null>((r) => p.on('exit', r)),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 5000)),
      ]);
      expect(code).toBe(0);
    } finally {
      if (p.exitCode === null) p.kill();
    }
  }, 15_000);

  it('does not outlive a hard-killed parent', async () => {
    // parent → bridge (detached, so Windows' kill-on-job-close does not do the work for us),
    // with the bridge's stdin inherited from the parent whose own stdin pipe we hold open.
    // Depending on the OS the bridge notices via stdin EOF/close or via the ppid watchdog.
    const script = `const c=require('child_process').spawn(process.execPath,['--import','tsx',${JSON.stringify(MAIN)}],{detached:true,windowsHide:true,stdio:['inherit','ignore','ignore'],cwd:${JSON.stringify(ROOT)}});process.stdout.write(String(c.pid)+String.fromCharCode(10));setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ['-e', script], {
      cwd: ROOT, env: { ...process.env, EVOL_URL: await deadUrl() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bridgePid = 0;
    try {
      bridgePid = await new Promise<number>((resolve, reject) => {
        parent.stdout.once('data', (d) => resolve(Number(String(d).trim())));
        let err = '';
        parent.stderr.on('data', (d) => (err += d));
        parent.once('exit', (c) => reject(new Error(`parent exited early (${c}): ${err}`)));
      });
      expect(bridgePid).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1500));
      expect(alive(bridgePid)).toBe(true);
      parent.kill();
      await until(() => !alive(bridgePid), 12_000, 200);
    } finally {
      if (parent.exitCode === null) parent.kill();
      if (bridgePid && alive(bridgePid)) process.kill(bridgePid);
      parent.stdin.end();
    }
  }, 25_000);
});
