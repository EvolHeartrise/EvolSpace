// Canvas visualizations for channel values: sparkline (1-D series / rolling
// history, min/max envelope when longer than the canvas) and heatmap (2-D grid,
// diverging ramp when signed) with hover readouts and a color legend.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_THEME } from '@evolspace/runtime';
import { fmtNum } from '../../ui/format.ts';
import {
  colorScale, downsample, envelope, heatmapPixels, hexToRgb, rampAt, stats, type ColorScale, type Grid, type RGB,
} from './tensor.ts';

/** Theme ramps as RGB stops. */
export function ramps(theme = DEFAULT_THEME): { diverging: RGB[]; sequential: RGB[] } {
  return { diverging: theme.diverging.map(hexToRgb), sequential: theme.sequential.map(hexToRgb) };
}

/** Width of an element in CSS px, tracked with a ResizeObserver. */
function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

function prepCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  c.style.height = `${h}px`;
  let g: CanvasRenderingContext2D | null = null;
  try { g = c.getContext('2d'); } catch { g = null; }
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

const css = (name: string, fallback: string) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
};

// ------------------------------------------------------------------ sparkline

export function Sparkline({ values, height = 64, color, label, step = false }: {
  values: ArrayLike<number>; height?: number; color?: string; label?: (i: number) => string; step?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useWidth(box);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const st = stats(values);
  const lo = st.min, hi = st.max === st.min ? st.min + 1 : st.max;
  const span = hi - lo || 1;
  const pad = 4;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !w) return;
    const g = prepCanvas(c, w, height);
    if (!g) return;
    const n = values.length;
    if (!n || !Number.isFinite(lo)) return;
    const y = (v: number) => pad + (1 - (v - lo) / span) * (height - 2 * pad);
    const X = (i: number) => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad));
    if (lo < 0 && hi > 0) {
      g.strokeStyle = css('--line2', '#283244');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, Math.round(y(0)) + 0.5); g.lineTo(w, Math.round(y(0)) + 0.5); g.stroke();
    }
    const stroke = color ?? css('--accent', '#4cc3ff');
    g.strokeStyle = stroke;
    g.fillStyle = stroke;
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    const cols = Math.max(1, Math.floor(w - 2 * pad));
    if (n > cols * 2) {
      // Envelope: one vertical bar per pixel column.
      const env = envelope(values, cols);
      g.globalAlpha = 0.85;
      for (let k = 0; k < cols; k++) {
        const a = env[k * 2], b = env[k * 2 + 1];
        if (Number.isNaN(a)) continue;
        const y0 = y(b), y1 = y(a);
        g.fillRect(pad + k, y0, 1, Math.max(1, y1 - y0));
      }
      g.globalAlpha = 1;
    } else {
      g.beginPath();
      let pen = false;
      let prevY = 0;
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (!pen) { g.moveTo(X(i), y(v)); pen = true; }
        else if (step) { g.lineTo(X(i), prevY); g.lineTo(X(i), y(v)); }
        else g.lineTo(X(i), y(v));
        prevY = y(v);
      }
      g.stroke();
      if (n <= 64) for (let i = 0; i < n; i++) { const v = values[i]; if (Number.isFinite(v)) { g.beginPath(); g.arc(X(i), y(v), 1.8, 0, Math.PI * 2); g.fill(); } }
      else if (Number.isFinite(values[n - 1])) { g.beginPath(); g.arc(X(n - 1), y(values[n - 1]), 2.4, 0, Math.PI * 2); g.fill(); }
    }
    if (hover) {
      g.strokeStyle = css('--dim', '#8b95a5');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(hover.x) + 0.5, 0); g.lineTo(Math.round(hover.x) + 0.5, height); g.stroke();
    }
  });
  const n = values.length;
  const onMove = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - pad) / Math.max(1, r.width - 2 * pad)) * (n - 1))));
    setHover({ x, i });
  };
  return (
    <div class="dbg-viz" ref={box}>
      <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      {hover && n ? (
        <span class="tip" style={{ left: `${Math.min(Math.max(0, hover.x + 8), Math.max(0, w - 120))}px`, top: '4px' }}>
          {label ? label(hover.i) : `[${hover.i}]`} = {fmtNum(values[hover.i])}
        </span>
      ) : null}
      <div class="axis">
        <span>{Number.isFinite(st.min) ? `min ${fmtNum(st.min)}` : '—'}</span>
        <span>{n} pts</span>
        <span>{Number.isFinite(st.max) ? `max ${fmtNum(st.max)}` : ''}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ heatmap

export function Legend({ scale, ramp }: { scale: ColorScale; ramp: readonly RGB[] }) {
  const stops = Array.from({ length: 9 }, (_, i) => { const c = rampAt(ramp, i / 8); return `rgb(${c[0]},${c[1]},${c[2]})`; });
  return (
    <div class="dbg-legend">
      <span>{fmtNum(scale.lo)}</span>
      <span class="bar" style={{ background: `linear-gradient(90deg,${stops.join(',')})` }} />
      <span>{fmtNum(scale.hi)}</span>
      <span>{scale.diverging ? 'diverging · 0 centered' : 'sequential'}</span>
    </div>
  );
}

/** 2-D grid as a heatmap. Cells keep a sane aspect; hover shows [row, col] = value. */
export function Heatmap({ grid, height = 150, scale, rowLabel = 'r', colLabel = 'c' }: {
  grid: Grid; height?: number; scale?: ColorScale; rowLabel?: string; colLabel?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useWidth(box);
  const [hover, setHover] = useState<{ x: number; y: number; r: number; c: number } | null>(null);
  const sc = scale ?? colorScale(stats(grid.values));
  const R = ramps();
  const ramp = sc.diverging ? R.diverging : R.sequential;
  // Fit: fill the width; clamp the cell aspect to [1/3, 3].
  const avail = { w: Math.max(1, w), h: Math.max(16, Math.min(height, 24 * grid.rows + 8)) };
  let cw = avail.w / grid.cols, ch = avail.h / grid.rows;
  if (cw > ch * 3) cw = ch * 3;
  if (ch > cw * 3) ch = cw * 3;
  const dw = Math.max(1, Math.min(avail.w, cw * grid.cols)), dh = Math.max(1, Math.min(avail.h, ch * grid.rows));
  useEffect(() => {
    const c = canvas.current;
    if (!c || !w) return;
    const g = prepCanvas(c, w, dh);
    if (!g) return;
    const ds = downsample(grid, 512);
    const px = heatmapPixels(ds, sc, ramp);
    let off: HTMLCanvasElement | null = null;
    try {
      off = document.createElement('canvas');
      off.width = ds.cols; off.height = ds.rows;
      const og = off.getContext('2d');
      if (!og) return;
      og.putImageData(new ImageData(px, ds.cols, ds.rows), 0, 0);
    } catch { return; }
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, ds.cols, ds.rows, 0, 0, dw, dh);
    if (hover && hover.r >= 0) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1;
      g.strokeRect(Math.floor(hover.c * (dw / grid.cols)) + 0.5, Math.floor(hover.r * (dh / grid.rows)) + 0.5, Math.max(2, dw / grid.cols - 1), Math.max(2, dh / grid.rows - 1));
    }
  });
  const onMove = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x > dw || y > dh) { setHover(null); return; }
    setHover({ x, y, r: Math.min(grid.rows - 1, Math.floor((y / dh) * grid.rows)), c: Math.min(grid.cols - 1, Math.floor((x / dw) * grid.cols)) });
  };
  const v = hover ? grid.values[hover.r * grid.cols + hover.c] : 0;
  return (
    <div class="dbg-viz" ref={box}>
      <canvas ref={canvas} style={{ border: 'none', background: 'transparent' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      {hover ? (
        <span class="tip" style={{ left: `${Math.min(hover.x + 10, Math.max(0, w - 150))}px`, top: `${Math.max(0, hover.y - 22)}px` }}>
          [{rowLabel} {hover.r}, {colLabel} {hover.c}] = {fmtNum(v)}
        </span>
      ) : null}
      <div class="axis" style={{ width: `${dw}px`, maxWidth: '100%' }}>
        <span>{grid.rows} × {grid.cols}{grid.rows * grid.cols > 512 * 512 ? ' (downsampled)' : ''}</span>
        <Legend scale={sc} ramp={ramp} />
      </div>
    </div>
  );
}
