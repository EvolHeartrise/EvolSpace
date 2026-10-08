// bar-chart: categorical values as vertical bars on a card with a y axis.
// Accepts {label, value}[] | Record<string, number> | number[] | tensor.
// Bars are one InstancedMesh (one draw call); labels/value texts are pooled
// and shown only while they fit (≤ 24 bars).

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { paletteColor, resolveColor } from '../../shared/color.ts';
import { formatNumber, truncate } from '../../shared/format.ts';
import { niceRange } from '../../shared/layout.ts';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { buildCard, PlotAxes, STYLE, type Rect } from '../../shared/style.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { asLabeled, isTensor } from '../../shared/tensor.ts';
import { PressTracker } from '../../shared/handle.ts';
import { FittedInstances } from '../../shared/instanced.ts';

interface BarProps extends Record<string, unknown> {
  title: string;
  width: number;
  height: number;
  color: string;
  autoscale: boolean;
  min: number;
  max: number;
  showValues: boolean;
  labels: string[];
  maxBars: number;
  interactive: boolean;
  channel: string;
}

const MAX_TEXT_BARS = 24;

const definition: WidgetDefinition<BarProps> = {
  description:
    'Bar chart on a card with y axis. Input `data`: {label, value}[] | {name: number} | number[] | tensor (flattened). Negative values hang below zero. ' +
    'color = theme token/CSS or "palette" for one categorical color per bar. With interactive=true, pressing a bar emits `bar` {index, label, value}.',
  version: '1.0.0',
  props: {
    title: { type: 'string', default: '' },
    width: { type: 'number', default: 0.4, min: 0.1, max: 4 },
    height: { type: 'number', default: 0.24, min: 0.06, max: 4 },
    color: { type: 'color', default: 'accent', description: 'Bar color, or "palette" for per-bar categorical colors.' },
    autoscale: { type: 'boolean', default: true, description: 'Fit the y range to the data (always including 0).' },
    min: { type: 'number', default: 0 },
    max: { type: 'number', default: 1 },
    showValues: { type: 'boolean', default: true, description: 'Value labels above bars (≤ 24 bars).' },
    labels: { type: 'json', default: [], description: 'Category labels (string[]) used when the data has none.' },
    maxBars: { type: 'integer', default: 64, min: 1, max: 4096 },
    interactive: { type: 'boolean', default: false, description: 'Bars become pressable (then grab the chart by its frame).' },
    channel: { type: 'channel', default: '', description: 'Optional data channel (alternative to linking into `data`).' },
  },
  inputs: {
    data: { type: 'any', description: 'Values to plot (see description).' },
  },
  outputs: {
    bar: { type: 'json', description: 'Pressed bar {index, label, value} (interactive only).' },
  },
  size: [0.4, 0.24, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let bars: FittedInstances | null = null;
    let axes: PlotAxes | null = null;
    let rect: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
    let labelTexts: Text[] = [];
    let valueTexts: Text[] = [];
    let values: Float32Array = new Float32Array(0);
    let labels: string[] | null = null;
    let dirty = true;
    const press = new PressTracker(['press']);
    const m4 = new T.Matrix4();
    const col = new T.Color();
    const channel = new ChannelProp(ctx, (v) => setData(v));

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      const card = buildCard(ctx, { width: p.width, height: p.height, title: p.title || undefined });
      group = card.group;
      group.name = 'bar-chart';
      const hasLabels = true; // reserve the label row; it stays empty when there are no labels
      rect = {
        x0: card.inner.x0 + STYLE.yGutter,
        x1: card.inner.x1,
        y0: card.inner.y0 + (hasLabels ? STYLE.xGutter : 0),
        y1: card.inner.y1 - (p.showValues ? STYLE.labelSize * 1.4 : 0.004),
      };
      axes = new PlotAxes(ctx, rect);
      group.add(axes.group);
      const cap = Math.max(1, Math.floor(p.maxBars));
      bars = new FittedInstances(T, sharedGeometry(T, 'plane'), ownMaterial(T, '#ffffff'), cap);
      bars.mesh.name = 'bars';
      bars.fit(rect.x0, rect.y0, STYLE.zOverlay, rect.x1, rect.y1, STYLE.zOverlay);
      group.add(bars.mesh);
      if (p.interactive) ctx.interactive(bars.mesh);
      labelTexts = [];
      valueTexts = [];
      for (let i = 0; i < Math.min(cap, MAX_TEXT_BARS); i++) {
        const lt = makeText(ctx, '', { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: 'center', anchorY: 'top', whiteSpace: 'nowrap' });
        lt.visible = false;
        group.add(lt);
        labelTexts.push(lt);
        if (p.showValues) {
          const vt = makeText(ctx, '', { size: STYLE.labelSize, color: ctx.theme.text, anchorX: 'center', anchorY: 'bottom', font: 'mono', whiteSpace: 'nowrap' });
          vt.visible = false;
          group.add(vt);
          valueTexts.push(vt);
        }
      }
      ctx.root.add(group);
      dirty = true;
    }

    function setData(v: unknown): void {
      const d = asLabeled(v);
      if (!d) {
        if (v !== undefined && v !== null) ctx.error(`bar-chart: unsupported data (${isTensor(v) ? `tensor ${v.dtype}[${v.shape}]` : typeof v})`);
        return;
      }
      values = d.values;
      labels = d.labels;
      dirty = true;
    }

    function redraw(): void {
      dirty = false;
      if (!bars || !axes) return;
      const p = ctx.props;
      const n = Math.min(values.length, bars.mesh.instanceMatrix.count);
      let lo = 0;
      let hi = 0;
      if (p.autoscale) {
        for (let i = 0; i < n; i++) {
          const x = values[i];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        [lo, hi] = hi > lo ? niceRange(lo, hi) : [0, 1];
      } else {
        lo = p.min;
        hi = p.max > p.min ? p.max : p.min + 1;
      }
      axes.update(lo, hi);
      const r = rect;
      const span = hi - lo;
      const yOf = (v: number) => r.y0 + Math.min(1, Math.max(0, (v - lo) / span)) * (r.y1 - r.y0);
      const base = yOf(0);
      const bw = n ? (r.x1 - r.x0) / n : 0;
      const usePalette = p.color === 'palette';
      const single = resolveColor(ctx.theme, usePalette ? 'accent' : p.color, 'accent');
      const fallbackLabels = Array.isArray(p.labels) ? p.labels : [];
      const showText = n <= MAX_TEXT_BARS;
      for (let i = 0; i < n; i++) {
        const v = Number.isFinite(values[i]) ? values[i] : 0;
        const y = yOf(v);
        const h = Math.max(1e-4, Math.abs(y - base));
        const cx = r.x0 + (i + 0.5) * bw;
        m4.makeScale(bw * 0.72, h, 1).setPosition(cx, (y + base) / 2, STYLE.zOverlay);
        bars.setMatrixAt(i, m4);
        bars.setColorAt(i, col.set(usePalette ? paletteColor(ctx.theme, i) : single));
        if (showText && i < labelTexts.length) {
          const label = labels?.[i] ?? (fallbackLabels[i] !== undefined ? String(fallbackLabels[i]) : '');
          const lt = labelTexts[i];
          lt.set(truncate(label, Math.max(3, Math.floor(bw / (STYLE.labelSize * 0.55)))));
          lt.position.set(cx, r.y0 - 0.004, STYLE.zText);
          lt.visible = !!label;
          const vt = valueTexts[i];
          if (vt) {
            vt.set(formatNumber(v, { precision: 3 }));
            vt.position.set(cx, Math.max(y, base) + 0.003, STYLE.zText);
            vt.visible = true;
          }
        }
      }
      for (let i = showText ? n : 0; i < labelTexts.length; i++) {
        labelTexts[i].visible = false;
        if (valueTexts[i]) valueTexts[i].visible = false;
      }
      bars.commit(n);
    }

    build();
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'data') setData(v);
      },
      onInteraction(e: InteractionEvent) {
        if (!ctx.props.interactive || press.handle(e) !== 'down') return;
        const n = bars?.mesh.count ?? 0;
        if (!n) return;
        const i = Math.floor(((e.localPoint[0] - rect.x0) / (rect.x1 - rect.x0)) * n);
        if (i < 0 || i >= n) return;
        const fallback = Array.isArray(ctx.props.labels) ? ctx.props.labels : [];
        ctx.emit('bar', { index: i, label: labels?.[i] ?? (fallback[i] !== undefined ? String(fallback[i]) : String(i)), value: values[i] });
      },
      update() {
        if (dirty) redraw();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
