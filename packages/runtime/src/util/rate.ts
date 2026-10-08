// Small timing helpers. All take an explicit `now` (ms) so they are
// deterministic in tests and never schedule timers on their own.

export const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * Suppresses repeats of the same key within a window. Used to avoid spamming
 * the server/agent with the same widget error every frame.
 */
export class Deduper {
  private last = new Map<string, number>();
  constructor(private windowMs: number, private maxKeys = 512) {}

  /** True if `key` should be let through now. */
  allow(key: string, t = now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    if (this.last.size >= this.maxKeys) this.last.clear();
    this.last.set(key, t);
    return true;
  }

  clear(): void { this.last.clear(); }
}

/** Token bucket: `rate` tokens per second, burst `capacity`. */
export class TokenBucket {
  private tokens: number;
  private lastT: number;
  constructor(private rate: number, private capacity: number, t = now()) {
    this.tokens = capacity;
    this.lastT = t;
  }
  take(t = now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.lastT) / 1000) * this.rate);
    this.lastT = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
