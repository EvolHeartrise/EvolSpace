// Preact hooks shared by debug panels.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { DebugContext } from '../types.ts';
import type { NeedKind } from '../store.ts';

/** Keep a ref-counted store poller running while the component is mounted. */
export function useNeed(ctx: DebugContext, ...kinds: NeedKind[]): void {
  const key = kinds.join(',');
  useEffect(() => {
    const releases = kinds.map((k) => ctx.store.need(k));
    return () => { for (const r of releases) r(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key]);
}

/** setInterval while mounted (the latest `fn` is always called). */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Re-evaluate `read()` every `ms` (for non-signal live values, e.g. port values). */
export function usePoll<T>(read: () => T, ms: number, deps: unknown[] = []): T {
  const [v, setV] = useState<T>(read);
  const ref = useRef(read);
  ref.current = read;
  useEffect(() => { setV(() => ref.current()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);
  useInterval(() => setV(() => ref.current()), ms);
  return v;
}

/** Copy text to the clipboard (with a fallback for non-secure contexts). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
