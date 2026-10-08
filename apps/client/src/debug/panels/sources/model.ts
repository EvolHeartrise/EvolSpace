// Pure helpers of the Sources panel.

import type { ServerEvent, SourceStatus } from '@evolspace/protocol';

/** GET /api/sources returns the supervisor's SourceInfo (SourceStatus + these). */
export type SourceInfo = SourceStatus & { description?: string; autostart?: boolean; error?: string };

export interface SourceExit {
  ts: number;
  seq: number;
  code: number | null;
  signal: string | null;
  ranMs?: number;
  restarting: boolean;
  restarts?: number;
}

/** source.exit events of one source, newest first. */
export function exitsFor(events: readonly ServerEvent[], id: string, max = 20): SourceExit[] {
  const out: SourceExit[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i];
    if (e.type !== 'source.exit' || e.data.id !== id) continue;
    out.push({
      ts: e.ts, seq: e.seq,
      code: typeof e.data.code === 'number' ? e.data.code : null,
      signal: typeof e.data.signal === 'string' ? e.data.signal : null,
      ...(typeof e.data.ranMs === 'number' ? { ranMs: e.data.ranMs } : {}),
      restarting: !!e.data.restarting,
      ...(typeof e.data.restarts === 'number' ? { restarts: e.data.restarts } : {}),
    });
  }
  return out;
}

/** 'e' error-ish line, 'w' warning-ish, '' plain. */
export function lineClass(line: string): 'e' | 'w' | '' {
  if (/\b(error|exception|traceback|fatal|failed|panic|uncaught)\b|^\s*File ".*", line \d+/i.test(line)) return 'e';
  if (/\b(warn(ing)?|deprecat\w*)\b/i.test(line)) return 'w';
  return '';
}

export function exitLabel(x: { code: number | null; signal: string | null }): string {
  return x.signal ? `signal ${x.signal}` : `code ${x.code ?? '?'}`;
}
