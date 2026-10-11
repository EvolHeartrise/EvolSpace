// LineWindow: a scrolling window of text lines (a code preview, a column of names) without re-layout flicker.
//
// troika lays text out asynchronously: after .set() a text keeps drawing its OLD string for a frame or two.
// Re-setting one multi-line text every time the scroll crosses a line boundary therefore flashes the old
// lines at the new position. Instead, two buffers (each: a set of texts that move together, e.g. code +
// line numbers) hold an over-scan window of `visible + 1 + margin` lines; the shown buffer scrolls by
// MOVING. When the visible lines near the edge of the shown window (or the content changed), the hidden
// buffer is filled with a window around the current position and swapped in only once troika has laid
// it out (TextSync). The caller positions buffers with `offset(buf)` (lines between the buffer's first
// line and the scroll position) and fills them in its `fill` callback.

import type { Text } from './text.ts';
import { TextSync } from './scroll.ts';

export interface LineBuffer {
  readonly texts: Text[];
  readonly sync: TextSync;
  /** First line held (-1 = empty), how many, and the content generation it was filled for. */
  from: number;
  count: number;
  gen: number;
}

/** Put lines [from, from + count) into `texts` (use sync.set so the swap waits for the layout). */
export type FillLines = (texts: Text[], from: number, count: number, sync: TextSync) => void;

export class LineWindow {
  readonly bufs: [LineBuffer, LineBuffer];
  /** Buffer on screen (-1 = none yet) and the one being prepared (-1 = none). */
  private shownIdx = -1;
  private pendingIdx = -1;
  private gen = 0;

  constructor(a: Text[], b: Text[], private readonly margin = 24) {
    this.bufs = [
      { texts: a, sync: new TextSync(), from: -1, count: 0, gen: -1 },
      { texts: b, sync: new TextSync(), from: -1, count: 0, gen: -1 },
    ];
    this.applyVisibility();
  }

  /** The content changed (new file, new list): the next update refills (the old window shows until then). */
  invalidate(): void { this.gen++; }

  /** Forget everything (e.g. the texts were rebuilt): nothing shows until the next fill is laid out. */
  reset(): void {
    this.gen++;
    this.shownIdx = this.pendingIdx = -1;
    for (const b of this.bufs) { b.from = -1; b.count = 0; b.gen = -1; }
    this.applyVisibility();
  }

  /** The buffer on screen, or null before the first fill is laid out. */
  get shown(): LineBuffer | null { return this.shownIdx >= 0 ? this.bufs[this.shownIdx] : null; }

  /** Lines between `buf`'s first line and scroll position `pos` (place the buffer's top `offset` lines above the area's top). */
  offset(buf: LineBuffer, pos: number): number { return pos - Math.max(0, buf.from); }

  /**
   * Make sure a buffer covering lines [first, first + visible] of `total` is (or is being) prepared and swap
   * it in once laid out. Call every frame while it returns true (busy), else on scroll / content changes.
   */
  update(pos: number, visible: number, total: number, fill: FillLines): boolean {
    const first = Math.max(0, Math.floor(pos + 1e-6));
    const need = Math.min(total, first + visible + 1);
    const span = visible + 1 + this.margin;
    const cur = this.shown;
    const quarter = Math.max(1, Math.floor(this.margin / 4));
    const nearEdge = !!cur && this.covers(cur, first, need) && (
      (cur.from > 0 && first - cur.from < quarter) || (cur.from + cur.count < total && cur.from + cur.count - need < quarter));
    if (this.pendingIdx >= 0) {
      const p = this.bufs[this.pendingIdx];
      if (!this.covers(p, first, need)) this.fillBuf(this.pendingIdx, first, span, total, fill); // moved on (or new content) meanwhile
      if (p.sync.ready()) {
        this.shownIdx = this.pendingIdx;
        this.pendingIdx = -1;
        this.applyVisibility();
      }
    } else if (!cur || !this.covers(cur, first, need) || nearEdge) {
      const idx = this.shownIdx === 0 ? 1 : 0;
      this.fillBuf(idx, first, span, total, fill);
      this.pendingIdx = idx;
      if (this.bufs[idx].sync.ready()) { this.shownIdx = idx; this.pendingIdx = -1; }
      this.applyVisibility();
    }
    return this.pendingIdx >= 0;
  }

  private covers(b: LineBuffer, first: number, need: number): boolean {
    return b.gen === this.gen && b.from >= 0 && b.from <= first && b.from + b.count >= need;
  }

  private fillBuf(idx: number, first: number, span: number, total: number, fill: FillLines): void {
    const b = this.bufs[idx];
    const from = Math.max(0, Math.min(first - Math.floor(this.margin / 2), total - span));
    b.from = from;
    b.count = Math.max(0, Math.min(span, total - from));
    b.gen = this.gen;
    fill(b.texts, from, b.count, b.sync);
  }

  private applyVisibility(): void {
    for (let i = 0; i < 2; i++) for (const t of this.bufs[i].texts) t.visible = i === this.shownIdx;
  }
}
