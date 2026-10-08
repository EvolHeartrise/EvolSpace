// Tool definition framework: each tool declares a zod input schema (the single
// source of truth for both the advertised JSON Schema and runtime validation),
// a description written for Claude, and a handler returning compact text and/or
// images. Errors become `isError` results with an actionable message.
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { EvolApi } from './api.ts';
import type { Logger } from './log.ts';
import type { ChannelPumpStats } from './channel.ts';

export interface ToolContext {
  api: EvolApi;
  log: Logger;
  repoRoot: string;
  /** Live stats of the voice→Claude channel loop (for server_status). */
  channelStats(): ChannelPumpStats | undefined;
}

export type ToolOutput = string | CallToolResult;

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** Short human title (MCP annotation). */
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  handler(args: z.output<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

/** Thrown by handlers for user-facing failures (bad arguments, not found, …). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function imageResult(png: Uint8Array, caption: string): CallToolResult {
  return {
    content: [
      { type: 'image', data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: caption },
    ],
  };
}

/** JSON Schema for the MCP tools/list response (draft 2020-12 subset Claude understands). */
export function toolJsonSchema(schema: z.ZodObject): Tool['inputSchema'] {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  stripNoise(js);
  return js as Tool['inputSchema'];
}

/** Remove zod's `propertyNames: {type: 'string'}` (implied by JSON) to keep the schema small. */
function stripNoise(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(stripNoise);
  if (typeof node !== 'object' || node === null) return;
  const o = node as Record<string, unknown>;
  const pn = o.propertyNames as Record<string, unknown> | undefined;
  if (pn && Object.keys(pn).length === 1 && pn.type === 'string') delete o.propertyNames;
  for (const v of Object.values(o)) stripNoise(v);
}

export function toMcpTool(def: ToolDef): Tool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: toolJsonSchema(def.input),
    annotations: {
      title: def.title,
      readOnlyHint: def.readOnly ?? false,
      destructiveHint: def.destructive ?? false,
      openWorldHint: false,
    },
  };
}

/** Validate + run one tool call; never throws. */
export async function runTool(def: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
      .join('; ');
    return errorResult(`Invalid arguments for ${def.name}: ${issues}`);
  }
  try {
    const out = await def.handler(parsed.data, ctx);
    return typeof out === 'string' ? text(out) : out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ToolError)) ctx.log.debug(`tool ${def.name} failed:`, msg);
    return errorResult(msg);
  }
}

// ---------------------------------------------------------------- shared schemas

export const vec3 = z.array(z.number()).length(3);
export const rotationSchema = z
  .array(z.number())
  .min(3)
  .max(4)
  .describe('[x,y,z] Euler degrees (XYZ order) or [x,y,z,w] quaternion');
export const scaleSchema = z.union([z.number().positive(), vec3]).describe('Uniform number or [x,y,z]');
export const anchorSchema = z
  .enum(['space', 'head', 'head-lazy', 'left-hand', 'right-hand'])
  .describe("What a root entity's transform is relative to. head-lazy = HUD that re-centers when out of view; *-hand = wrist-attached");
export const propsSchema = z.record(z.string(), z.unknown());
