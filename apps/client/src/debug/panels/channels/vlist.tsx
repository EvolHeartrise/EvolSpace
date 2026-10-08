// Minimal fixed-row-height virtual list (only the visible window + overscan
// is rendered), for lists that can hold hundreds/thousands of rows.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Visible index window [start, end) for a scroll position. */
export function visibleRange(count: number, rowH: number, scrollTop: number, viewH: number, overscan = 6): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + Math.max(viewH, rowH)) / rowH) + overscan);
  return [start, Math.max(start, end)];
}

export function VirtualList<T>({ items, rowHeight, render, class: cls, scrollTo }: {
  items: readonly T[]; rowHeight: number; render: (item: T, index: number, top: number) => ComponentChildren; class?: string;
  /** Scroll this index into view when it changes. */
  scrollTo?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 400 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setView((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight || 400 }));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || scrollTo === undefined || scrollTo < 0) return;
    const y = scrollTo * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  }, [scrollTo]);
  const [a, b] = visibleRange(items.length, rowHeight, view.top, view.h);
  const rows: ComponentChildren[] = [];
  for (let i = a; i < b; i++) rows.push(render(items[i], i, i * rowHeight));
  return (
    <div ref={ref} class={`dbg-vlist${cls ? ` ${cls}` : ''}`} onScroll={(e) => { const el = e.currentTarget as HTMLDivElement; setView({ top: el.scrollTop, h: el.clientHeight || 400 }); }}>
      <div style={{ height: `${items.length * rowHeight}px`, position: 'relative' }}>{rows}</div>
    </div>
  );
}
