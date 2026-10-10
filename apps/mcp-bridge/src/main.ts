#!/usr/bin/env node
// EvolSpace MCP bridge entry point (stdio). Registered in the repo's .mcp.json as
// "evolspace"; Claude Code starts it with: node --import tsx apps/mcp-bridge/src/main.ts
// Env: EVOL_URL (default http://127.0.0.1:8787), EVOL_BRIDGE_LOG (debug|info|warn|error),
// EVOL_BRIDGE_CHANNEL=0 disables the voice channel (one-off agents: apps/server/src/oneshot.ts).
// stdout is the MCP wire — all logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from './log.ts';
import { createBridge } from './server.ts';

const log = createLogger();

// A bridge must never die from a stray rejection (e.g. a fetch in a callback)...
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  // ...but a broken stdio pipe means Claude Code is gone: exit instead of lingering
  // as an orphan that keeps long-polling the server and posting "Heard: …" statuses.
  if (isPipeGone(err)) return void shutdown(`stdio pipe closed (${(err as NodeJS.ErrnoException).code})`);
  log.error('uncaught exception:', err);
});

function isPipeGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'EOF';
}

const bridge = createBridge({ log, channel: process.env.EVOL_BRIDGE_CHANNEL !== '0' });
const transport = new StdioServerTransport();

let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`shutting down (${reason})`);
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref();
  try {
    await bridge.close();
  } catch (err) {
    log.warn('error during shutdown:', err);
  }
  process.exit(0);
}

transport.onclose = () => void shutdown('transport closed');
process.stdin.on('end', () => void shutdown('stdin closed'));
process.stdin.on('close', () => void shutdown('stdin closed'));
process.stdin.on('error', (err) => void shutdown(`stdin error: ${err.message}`));
process.stdout.on('error', (err) => void shutdown(`stdout error: ${err.message}`));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGHUP', () => void shutdown('SIGHUP'));

// Orphan guard: if the parent (Claude Code) dies but our stdin stays open — e.g. another
// process inherited the pipe's write end — exit rather than live on as a zombie poller.
const parentPid = process.ppid;
const watchdog = setInterval(() => {
  if (!parentAlive(parentPid)) void shutdown(`parent process ${parentPid} exited`);
}, 5000);
watchdog.unref();

function parentAlive(pid: number): boolean {
  if (!pid || pid <= 1) return true; // unknown / reparented to init: rely on stdin instead
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

await bridge.server.connect(transport);
log.info(`ready (stdio); EvolSpace server ${bridge.api.baseUrl}`);
