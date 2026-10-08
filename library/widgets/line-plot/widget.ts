// line-plot: time series / curves on a card with a y axis.
//   - Streaming: link numbers into `value` → appended to a rolling window
//     (an array of numbers appends one sample to each of several series).
//   - Whole series: `series` = number[] | number[][] | tensor [N] | [S, N]
//     replaces the data (e.g. a loss curve or a probe score across layers).
// Geometry: one preallocated line per series; vertices rewritten at most once
// per frame when data changed (many samples per frame coalesce).

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { paletteColor, resolveColor } from '../../shared/color.ts';
import { formatNumber } from '../../shared/format.ts';
import { niceRange } from '../../shared/layout.ts';
import { disposeTree } from '../../shared/resources.ts';
import { buildCard, PlotAxes, STYLE, type Rect } from '../../shared/style.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { asSeries, asVector, isTensor, toScalar } from '../../shared/tensor.ts';

interface LinePlotProps extends Record<string, unknown> {
  title: string;
  width: number;
  height: number;
  window: number;
  autoscale: boolean;
  min: number;
  max: number;
  color: string;
  showAxes: boolean;
  showLatest: boolean;
  channel: string;
}

const MAX_SERIES = 8;

interface Series {
  /** Ring buffer (stream mode) or plain data (series mode). */
  buf: Float32Array;
  line: THREE.Line;
  positions: Float32Array;
}

const definition: WidgetDefinition<LinePlotProps> = {
  description:
    'Line plot on a card with y axis. Stream: link numbers (or number[] for several series) into `value` → rolling window of `window` samples. ' +
    'Whole data: `series` = number[] | number[][] | tensor [N] or [S, N] (up to 8 series, palette colors). Autoscaling y unless autoscale=false (then min/max).',
  version: '1.0.0',
  props: {
    title: { type: 'string', default: '' },
    width: { type: 'number', default: 0.4, min: 0.1, max: 4 },
    height: { type: 'number', default: 0.22, min: 0.06, max: 4 },
    window: { type: 'integer', default: 200, min: 2, max: 10000, description: 'Samples kept in streaming mode.' },
    autoscale: { type: 'boolean', default: true },
    min: { type: 'number', default: 0, description: 'Y min when autoscale is off.' },
    max: { type: 'number', default: 1, description: 'Y max when autoscale is off.' },
    color: { type: 'color', default: 'accent', description: 'Color of the first series (others use the palette).' },
    showAxes: { type: 'boolean', default: true },
    showLatest: { type: 'boolean', default: true, description: 'Show the latest value of series 0 in the title row.' },
    channel: { type: 'channel', default: '', description: 'Optional channel: numbers are streamed, arrays/tensors replace the series.' },
  },
  inputs: {
    value: { type: 'any', description: 'Number (or number[] for multiple series) appended to the rolling window.' },
    series: { type: 'any', description: 'Replaces all data: number[] | number[][] | tensor [N] / [S, N].' },
    clear: { type: 'event', description: 'Clears the data.' },
  },
  size: [0.4, 0.22, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let rect: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
    let axes: PlotAxes | null = null;
    let latest: Text | null = null;
    let series: Series[] = [];
    /** Stream mode: ring buffers with shared head/count. */
    let streaming = true;
    let head = 0;
    let count = 0;
    let dirty = true;

    const cap = () => Math.max(2, Math.floor(ctx.props.window));

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      const card = buildCard(ctx, { width: p.width, height: p.height, title: p.title || undefined });
      group = card.group;
      group.name = 'line-plot';
      const inner = card.inner;
      rect = p.showAxes
        ? { x0: inner.x0 + STYLE.yGutter, x1: inner.x1, y0: inner.y0 + STYLE.xGutter, y1: inner.y1 - 0.004 }
        : { x0: inner.x0, x1: inner.x1, y0: inner.y0, y1: inner.y1 };
      axes = null;
      if (p.showAxes) {
        axes = new PlotAxes(ctx, rect, { xLabels: true });
        group.add(axes.group);
      }
      latest = null;
      if (p.showLatest) {
        latest = makeText(ctx, '', { size: STYLE.labelSize * 1.1, color: resolveColor(ctx.theme, p.color, 'accent'), anchorX: 'right', anchorY: 'top', font: 'mono' });
        latest.position.set(p.width / 2 - STYLE.pad, p.height / 2 - STYLE.pad, STYLE.zText);
        group.add(latest);
      }
      // Rebuild series lines with the current data preserved (a new window size resets a stream).
      const old = series;
      series = [];
      if (streaming && old.length && old[0].buf.length !== cap()) {
        head = 0;
        count = 0;
      } else {
        for (let i = 0; i < old.length; i++) addSeries(old[i].buf);
      }
      ctx.root.add(group);
      dirty = true;
    }

    function seriesColor(i: number): string {
      return i === 0 ? resolveColor(ctx.theme, ctx.props.color, 'accent') : paletteColor(ctx.theme, i);
    }

    function addSeries(buf: Float32Array): Series {
      // Capacity in powers of two: a whole series that grows by a sample per update
      // (e.g. a loss curve re-published each epoch) is rewritten in place, not reallocated.
      let capacity = 2;
      while (capacity < buf.length) capacity *= 2;
      const positions = new Float32Array(capacity * 3);
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(positions, 3));
      const line = new T.Line(geo, new T.LineBasicMaterial({ color: seriesColor(series.length) }));
      line.position.z = STYLE.zOverlay;
      line.frustumCulled = false;
      line.raycast = () => {};
      line.name = `series-${series.length}`;
      group!.add(line);
      const s = { buf, line, positions };
      series.push(s);
      return s;
    }

    function ensureStreamSeries(n: number): void {
      const c = cap();
      if (!streaming || series.length !== n || series.some((s) => s.buf.length !== c)) {
        for (const s of series) disposeTree(s.line);
        series = [];
        streaming = true;
        head = 0;
        count = 0;
        for (let i = 0; i < n; i++) addSeries(new Float32Array(c));
      }
    }

    function push(v: unknown): void {
      // One sample per series: a number, a number[] or a multi-element tensor/typed array.
      const vec = !Array.isArray(v) && typeof v === 'object' && v !== null ? asVector(v) : null;
      const values: number[] = Array.isArray(v)
        ? (v as unknown[]).slice(0, MAX_SERIES).map(toScalar)
        : vec && vec.length > 1 ? Array.from(vec.subarray(0, MAX_SERIES)) : [toScalar(v)];
      if (!values.length) return;
      ensureStreamSeries(values.length);
      const c = cap();
      for (let i = 0; i < series.length; i++) series[i].buf[head] = values[i];
      head = (head + 1) % c;
      count = Math.min(c, count + 1);
      dirty = true;
    }

    function setSeries(v: unknown): void {
      const data = asSeries(v);
      if (!data) {
        if (v !== undefined && v !== null) ctx.error(`line-plot: unsupported series value (${isTensor(v) ? `tensor ${v.dtype}[${v.shape}]` : typeof v})`);
        return;
      }
      const list = data.slice(0, MAX_SERIES);
      const reuse = !streaming && series.length === list.length && series.every((s, i) => s.positions.length >= list[i].length * 3);
      if (reuse) {
        // Same layout: copy into the existing buffers (no GPU reallocation).
        for (let i = 0; i < list.length; i++) {
          const s = series[i];
          if (s.buf.length === list[i].length) s.buf.set(list[i]);
          else s.buf = Float32Array.from(list[i]);
        }
      } else {
        for (const s of series) disposeTree(s.line);
        series = [];
        streaming = false;
        for (const d of list) addSeries(Float32Array.from(d));
      }
      dirty = true;
    }

    function clear(): void {
      for (const s of series) disposeTree(s.line);
      series = [];
      head = 0;
      count = 0;
      dirty = true;
    }

    /** i-th sample (chronological) of a series. */
    function sample(s: Series, i: number): number {
      if (!streaming) return s.buf[i];
      const c = s.buf.length;
      return s.buf[(head - count + i + c) % c];
    }

    function redraw(): void {
      dirty = false;
      const n = streaming ? count : series.reduce((a, s) => Math.max(a, s.buf.length), 0);
      // Y range.
      let lo = Infinity;
      let hi = -Infinity;
      if (ctx.props.autoscale) {
        for (const s of series) {
          const len = streaming ? count : s.buf.length;
          for (let i = 0; i < len; i++) {
            const y = sample(s, i);
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
        }
        [lo, hi] = Number.isFinite(lo) ? niceRange(lo, hi) : [0, 1];
      } else {
        lo = ctx.props.min;
        hi = ctx.props.max > ctx.props.min ? ctx.props.max : ctx.props.min + 1;
      }
      const r = rect;
      const xs = n > 1 ? (r.x1 - r.x0) / ((streaming ? cap() : n) - 1) : 0;
      for (const s of series) {
        const len = streaming ? count : s.buf.length;
        const pos = s.positions;
        let k = 0;
        // Streaming: right-align so the newest sample sits at the right edge.
        const x0 = streaming ? r.x1 - (len - 1) * xs : r.x0;
        for (let i = 0; i < len; i++) {
          let y = sample(s, i);
          if (!Number.isFinite(y)) y = lo;
          const t = hi > lo ? (y - lo) / (hi - lo) : 0.5;
          pos[k++] = x0 + i * xs;
          pos[k++] = r.y0 + (t < 0 ? 0 : t > 1 ? 1 : t) * (r.y1 - r.y0);
          pos[k++] = 0;
        }
        s.line.geometry.setDrawRange(0, len);
        (s.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        s.line.visible = len > 1;
      }
      axes?.update(lo, hi, streaming ? (count ? `−${count - 1}` : '') : '0', streaming ? 'now' : n ? String(n - 1) : '');
      if (latest) {
        const s0 = series[0];
        const len = s0 ? (streaming ? count : s0.buf.length) : 0;
        latest.set(len ? formatNumber(sample(s0, len - 1), { precision: 4 }) : '');
      }
    }

    build();
    // Created after the first build: subscribing fires synchronously when the channel already has a value.
    // Plain numbers stream; anything else (array/tensor) replaces the series.
    const channel = new ChannelProp(ctx, (v) => (typeof v === 'number' ? push(v) : setSeries(v)));
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'value') push(v);
        else if (port === 'series') setSeries(v);
        else if (port === 'clear') clear();
      },
      update() {
        if (dirty && group) redraw();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
