// Types for status.mjs (so TypeScript tests can import its pure functions).
export interface AgentStatusUpdate {
  state: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'working' | 'error';
  detail?: string;
}
export declare const HARD_TIMEOUT_MS: number;
export declare function short(s: unknown, max?: number): string;
export declare function promptText(prompt: unknown): string;
export declare function fileLabel(p: unknown): string;
export declare function describeTool(name: string, input: unknown): string | null;
export declare function mapHookEvent(event: string | undefined, payload?: Record<string, unknown>): AgentStatusUpdate | null;
export declare function readStdin(signal: AbortSignal, stream?: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string>;
export declare function main(argv?: string[], env?: Record<string, string | undefined>): Promise<void>;
