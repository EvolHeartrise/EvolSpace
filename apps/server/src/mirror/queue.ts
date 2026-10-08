// Small async primitives for the mirror: a strictly serial task queue and a
// promise timeout. Kept dependency-free so they are trivially unit-testable.

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Races `p` against a timer. On timeout, `onTimeout` runs (fire-and-forget; use it
 * to kill whatever is hung) and the returned promise rejects with a TimeoutError.
 * The timer is always cleared, so no handles leak.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new TimeoutError(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs tasks one at a time, in submission order. A failing task does not affect
 * the ones queued after it. `pending` counts queued + running tasks.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  get pending(): number {
    return this.count;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.count++;
    const result = this.tail.then(() => task());
    // The chain must never reject, or later tasks would see a rejected predecessor.
    this.tail = result.then(
      () => { this.count--; },
      () => { this.count--; },
    );
    return result;
  }

  /** Resolves once everything queued so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
