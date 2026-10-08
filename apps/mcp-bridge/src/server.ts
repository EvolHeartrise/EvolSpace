// Assembles the MCP server: tools + claude/channel capability + the channel pump.
// Transport-agnostic so tests can connect it over InMemoryTransport.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EvolApi } from './api.ts';
import { ChannelPump, type ChannelPumpOptions } from './channel.ts';
import { buildInstructions } from './instructions.ts';
import { createLogger, type Logger } from './log.ts';
import { DEFAULT_EVOL_URL, REPO_ROOT } from './paths.ts';
import { errorResult, runTool, toMcpTool, type ToolContext, type ToolDef } from './tool.ts';
import { ALL_TOOLS } from './tools/index.ts';

export const SERVER_NAME = 'evolspace';
export const SERVER_VERSION = '0.1.0';
export const CHANNEL_METHOD = 'notifications/claude/channel';

export interface BridgeOptions {
  evolUrl?: string;
  log?: Logger;
  repoRoot?: string;
  /** Start the voice→Claude channel loop once the client initializes (default true). */
  channel?: boolean;
  /** Overrides for the pump (tests use short waits/backoff). */
  pump?: Partial<Omit<ChannelPumpOptions, 'api' | 'push' | 'log'>>;
  tools?: ToolDef[];
}

export interface Bridge {
  server: Server;
  api: EvolApi;
  pump?: ChannelPump;
  /** Push one channel event to Claude (also used by the pump). */
  pushChannel(content: string, meta: Record<string, string>): Promise<void>;
  close(): Promise<void>;
}

export function createBridge(opts: BridgeOptions = {}): Bridge {
  const log = opts.log ?? createLogger();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const api = new EvolApi({ baseUrl: opts.evolUrl ?? process.env.EVOL_URL ?? DEFAULT_EVOL_URL });
  const tools = opts.tools ?? ALL_TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const mcpTools = tools.map(toMcpTool);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // 'claude/channel' makes Claude Code register a notification listener for
      // notifications/claude/channel. Deliberately NOT 'claude/channel/permission'.
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: buildInstructions(repoRoot),
    },
  );

  const pushChannel = (content: string, meta: Record<string, string>) =>
    server.notification({ method: CHANNEL_METHOD, params: { content, meta } });

  // Last tool call from the client: proof of life for the pump's unanswered-ask detector.
  const now = opts.pump?.now ?? Date.now;
  let lastToolCallAt = 0;

  let pump: ChannelPump | undefined;
  if (opts.channel !== false) pump = new ChannelPump({ api, log, push: pushChannel, activity: () => lastToolCallAt, ...opts.pump });

  const ctx: ToolContext = { api, log, repoRoot, channelStats: () => pump?.stats };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    lastToolCallAt = now();
    const def = byName.get(req.params.name);
    if (!def) return errorResult(`Unknown tool "${req.params.name}". Available: ${[...byName.keys()].join(', ')}`);
    return runTool(def, req.params.arguments, ctx);
  });

  // Notifications can only flow after the handshake completes.
  server.oninitialized = () => {
    const client = server.getClientVersion();
    log.info(`MCP client initialized: ${client?.name ?? '?'} ${client?.version ?? ''} (EvolSpace at ${api.baseUrl})`);
    pump?.start();
  };
  server.onerror = (err) => log.warn('MCP error:', err);

  return {
    server,
    api,
    pump,
    pushChannel,
    async close() {
      await pump?.stop();
      await server.close();
    },
  };
}
