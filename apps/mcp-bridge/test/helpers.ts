// Connect an in-process MCP client to a bridge instance over InMemoryTransport.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Notification } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, type BridgeOptions } from '../src/server.ts';
import { silentLogger } from '../src/log.ts';

export async function connectBridge(opts: BridgeOptions) {
  const bridge = createBridge({ log: silentLogger, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n);
  };
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; result: CallToolResult }> {
    const result = await call(name, args);
    return { text: textOf(result), isError: !!result.isError, result };
  }
  async function close() {
    await client.close();
    await bridge.close();
  }
  return { bridge, client, notifications, call, callText, close };
}

export function textOf(r: CallToolResult): string {
  return r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
