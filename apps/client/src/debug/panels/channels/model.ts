// Channels panel state + pure helpers: filtering, publish rates from seq deltas,
// the selected channel (module signals survive tab switches; other panels call
// focusChannel to jump here).

import { signal } from '@preact/signals';
import type { ChannelInfo } from '@evolspace/protocol';
import type { DebugContext } from '../../types.ts';
import { fmtShape } from './tensor.ts';

export const selectedChannel = signal<string | null>(null);
export const channelQuery = signal('');
/** Channel names created from the panel that have no value yet (shown at the top until published). */
export const draftChannels = signal<readonly string[]>([]);

/** Select a channel in the Channels panel and bring the panel to front. */
export function focusChannel(ctx: Pick<DebugContext, 'layout'>, name: string): void {
  selectedChannel.value = name;
  ctx.layout.show('channels');
}

export function channelType(c: Pick<ChannelInfo, 'kind' | 'dtype' | 'shape'>): string {
  return c.kind === 'tensor' ? `${c.dtype ?? '?'}[${fmtShape(c.shape ?? [])}]` : 'json';
}

/** Case-insensitive substring match on name / producer / type / description; sorted by name. */
export function filterChannels(list: readonly ChannelInfo[], q: string): ChannelInfo[] {
  const s = q.trim().toLowerCase();
  const out = s
    ? list.filter((c) => c.name.toLowerCase().includes(s) || (c.producer ?? '').toLowerCase().includes(s)
      || channelType(c).toLowerCase().includes(s) || (c.description ?? '').toLowerCase().includes(s))
    : list.slice();
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Publish rate per channel (Hz) from seq deltas between polls, smoothed.
 * `fresh` = channels whose seq changed in the last update (row flash).
 */
export class RateTracker {
  private last = new Map<string, { seq: number; t: number; rate: number; changedAt: number }>();
  fresh = new Set<string>();

  update(list: readonly ChannelInfo[], now = Date.now()): void {
    const seen = new Set<string>();
    this.fresh = new Set();
    for (const c of list) {
      seen.add(c.name);
      const p = this.last.get(c.name);
      if (!p) { this.last.set(c.name, { seq: c.seq, t: now, rate: 0, changedAt: c.updatedAt }); continue; }
      const dt = (now - p.t) / 1000;
      if (dt <= 0) continue;
      const d = c.seq - p.seq;
      if (d !== 0) this.fresh.add(c.name);
      const inst = d > 0 ? d / dt : 0;
      const rate = p.rate === 0 || d < 0 ? inst : p.rate * 0.4 + inst * 0.6;
      this.last.set(c.name, { seq: c.seq, t: now, rate: rate < 0.05 ? 0 : rate, changedAt: d ? now : p.changedAt });
    }
    for (const k of [...this.last.keys()]) if (!seen.has(k)) this.last.delete(k);
  }

  rate(name: string): number {
    return this.last.get(name)?.rate ?? 0;
  }
}

export function fmtRate(hz: number): string {
  if (!hz) return '';
  if (hz >= 10) return `${Math.round(hz)}/s`;
  if (hz >= 1) return `${hz.toFixed(1)}/s`;
  return `${(hz * 60).toFixed(hz * 60 >= 10 ? 0 : 1)}/m`;
}

/** Ring buffer of recent scalar samples (numbers, booleans as 0/1) for the rolling sparkline. */
export class History {
  readonly t: number[] = [];
  readonly v: number[] = [];
  constructor(readonly max = 300) {}
  push(x: unknown, t = Date.now()): boolean {
    const n = typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : null;
    if (n === null) return false;
    this.t.push(t);
    this.v.push(n);
    if (this.v.length > this.max) { this.v.shift(); this.t.shift(); }
    return true;
  }
  clear(): void { this.t.length = 0; this.v.length = 0; }
  get length(): number { return this.v.length; }
}

/** Same rule as the server bus: dot-separated segments of [A-Za-z0-9_:-]. */
export const CHANNEL_NAME_RE = /^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/;

export function validateChannelName(n: string): string | null {
  const s = n.trim();
  if (!s) return 'required';
  if (!CHANNEL_NAME_RE.test(s)) return 'dot-separated segments of [A-Za-z0-9_:-]';
  return null;
}
