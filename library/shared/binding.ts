// Small lifecycle helpers: a channel subscription driven by a prop, and a throttle.

import type { ChannelValue, WidgetContext } from '@evolspace/protocol';

/**
 * Subscribe to the channel named by a prop (default prop name 'channel').
 * Call `refresh()` from onProps: it re-subscribes only when the name changed.
 * The runtime also releases subscriptions on dispose; `dispose()` is for
 * explicit teardown.
 *
 * The constructor subscribes immediately, and the runtime delivers a value the
 * channel already holds SYNCHRONOUSLY inside that call — so construct it after
 * your first build() (or make the callback safe to run before it), and reset
 * per-channel state before `refresh()` (see `wanted`).
 */
export class ChannelProp {
  private current = '';
  private off: (() => void) | null = null;

  constructor(
    private ctx: Pick<WidgetContext, 'channels' | 'props'>,
    private onValue: (v: ChannelValue, channel: string) => void,
    private prop = 'channel',
  ) {
    this.refresh();
  }

  get channel(): string {
    return this.current;
  }

  /** The channel the prop names right now (what `refresh()` would subscribe to). */
  get wanted(): string {
    const raw = this.ctx.props[this.prop];
    return typeof raw === 'string' ? raw.trim() : '';
  }

  refresh(): void {
    const name = this.wanted;
    if (name === this.current) return;
    this.off?.();
    this.off = null;
    this.current = name;
    if (name) {
      const ch = name;
      this.off = this.ctx.channels.subscribe(ch, (v) => {
        if (this.current === ch) this.onValue(v, ch);
      });
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.current = '';
  }
}

/**
 * Leading + trailing throttle: the first call runs immediately, later calls
 * within `ms` collapse into one trailing call with the latest argument.
 * `flush()` runs a pending call now; `cancel()` drops it (call in dispose).
 */
export class Throttle<T> {
  private last = -Infinity;
  private pending: { v: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private fn: (v: T) => void, private ms: number, private now: () => number = defaultNow) {}

  call(v: T): void {
    const t = this.now();
    if (t - this.last >= this.ms && !this.timer) {
      this.last = t;
      this.fn(v);
      return;
    }
    this.pending = { v };
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, Math.max(0, this.ms - (t - this.last)));
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const { v } = this.pending;
      this.pending = null;
      this.last = this.now();
      this.fn(v);
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
