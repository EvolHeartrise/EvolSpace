// Small timing helpers.

export interface Debounced {
  (): void;
  /** Run now if pending. */
  flush(): void;
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Trailing debounce of a no-arg function. With `maxWaitMs`, a burst of calls
 * that never pauses still runs `fn` at least that often (e.g. autosave while
 * an entity is being dragged continuously).
 */
export function debounce(fn: () => void, ms: number, maxWaitMs = Infinity): Debounced {
  let timer: NodeJS.Timeout | null = null;
  let firstAt = 0;
  const run = () => { timer = null; fn(); };
  const d = (() => {
    const now = Date.now();
    if (timer) clearTimeout(timer); else firstAt = now;
    const delay = Math.max(0, Math.min(ms, firstAt + maxWaitMs - now));
    timer = setTimeout(run, delay);
  }) as Debounced;
  d.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  d.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  Object.defineProperty(d, 'pending', { get: () => timer !== null });
  return d;
}

/** Per-key trailing debounce (e.g. rebuild widget <id> once after a burst of file events). */
export function keyedDebounce(fn: (key: string) => void, ms: number): { (key: string): void; cancelAll(): void } {
  const timers = new Map<string, NodeJS.Timeout>();
  const d = (key: string) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(key, setTimeout(() => { timers.delete(key); fn(key); }, ms));
  };
  d.cancelAll = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  return d;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
