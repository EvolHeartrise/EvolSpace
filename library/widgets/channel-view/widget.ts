// channel-view: a debug inspector for a data channel (or anything linked into
// `value`): name, update count and age, then either pretty JSON or a tensor
// summary (dtype/shape, min/max/mean/std, non-finite count, first values) with
// a value histogram. Rendering is rate-limited, so fast/large channels are safe.

import type { ChannelValue, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { formatAge, formatBytes, formatNumber, truncate } from '../../shared/format.ts';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { buildCard, STYLE } from '../../shared/style.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { isTensor, stats, tensorSignature, toFloat32 } from '../../shared/tensor.ts';

interface ChannelViewProps extends Record<string, unknown> {
  channel: string;
  title: string;
  width: number;
  maxLines: number;
  histogram: boolean;
  refreshHz: number;
}

const BINS = 32;
const LINE = 1.3; // line height in em

const definition: WidgetDefinition<ChannelViewProps> = {
  description:
    'Debug inspector: shows the latest value of `channel` (or of input `value`) — update count, age, and pretty JSON or a tensor summary (dtype/shape, min/max/mean/std, NaN/Inf count, first values, histogram). Rate-limited to refreshHz.',
  version: '1.0.0',
  props: {
    channel: { type: 'channel', default: '', description: 'Channel to inspect.' },
    title: { type: 'string', default: '', description: 'Header; defaults to the channel name.' },
    width: { type: 'number', default: 0.38, min: 0.15, max: 3 },
    maxLines: { type: 'integer', default: 14, min: 3, max: 80, description: 'Body lines shown (longer JSON is truncated).' },
    histogram: { type: 'boolean', default: true, description: 'Histogram strip for tensors.' },
    refreshHz: { type: 'number', default: 5, min: 0.5, max: 60 },
  },
  inputs: {
    value: { type: 'any', description: 'Inspect a linked port value instead of a channel.' },
  },
  size: [0.38, 0.3, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let header: Text | null = null;
    let meta: Text | null = null;
    let kind: Text | null = null;
    let body: Text | null = null;
    let hist: FittedInstances | null = null;
    let histRect = { x0: 0, x1: 0, y0: 0, h: 0 };
    let latest: ChannelValue = undefined;
    let has = false;
    let count = 0;
    let receivedAt = 0;
    let clock = 0;
    let dirty = true;
    let sinceRender = Infinity;
    let sinceAge = Infinity;
    let source = '';
    const m4 = new T.Matrix4();
    const counts = new Float32Array(BINS);
    const channel = new ChannelProp(ctx, (v, ch) => receive(v, ch));

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      const fs = STYLE.labelSize;
      const histH = p.histogram ? 0.04 : 0;
      const H = STYLE.pad * 2 + STYLE.titleSize * 1.5 + fs * LINE + p.maxLines * fs * LINE + (histH ? histH + 0.01 : 0);
      const card = buildCard(ctx, { width: p.width, height: H });
      group = card.group;
      group.name = 'channel-view';
      const x0 = card.inner.x0;
      let y = card.inner.y1;
      header = makeText(ctx, '', { size: STYLE.titleSize, color: ctx.theme.text, anchorX: 'left', anchorY: 'top', weight: 'semibold', whiteSpace: 'nowrap', maxWidth: p.width * 0.62 });
      header.position.set(x0, y, STYLE.zText);
      meta = makeText(ctx, '', { size: fs, color: ctx.theme.textDim, anchorX: 'right', anchorY: 'top', font: 'mono', whiteSpace: 'nowrap' });
      meta.position.set(card.inner.x1, y, STYLE.zText);
      y -= STYLE.titleSize * 1.5;
      kind = makeText(ctx, '', { size: fs, color: ctx.theme.accent, anchorX: 'left', anchorY: 'top', font: 'mono', whiteSpace: 'nowrap' });
      kind.position.set(x0, y, STYLE.zText);
      y -= fs * LINE;
      body = makeText(ctx, '', { size: fs, color: ctx.theme.text, anchorX: 'left', anchorY: 'top', font: 'mono', whiteSpace: 'nowrap', lineHeight: LINE });
      body.position.set(x0, y, STYLE.zText);
      group.add(header, meta, kind, body);
      hist = null;
      if (histH) {
        histRect = { x0, x1: card.inner.x1, y0: card.inner.y0, h: histH };
        hist = new FittedInstances(T, sharedGeometry(T, 'plane'), ownMaterial(T, ctx.theme.accent, { opacity: 0.85 }), BINS);
        hist.mesh.raycast = () => {};
        hist.mesh.name = 'histogram';
        hist.fit(histRect.x0, histRect.y0, STYLE.zOverlay, histRect.x1, histRect.y0 + histRect.h, STYLE.zOverlay);
        group.add(hist.mesh);
      }
      ctx.root.add(group);
      dirty = true;
      sinceAge = Infinity;
    }

    /** Characters that fit on one body line. */
    const cols = () => Math.max(10, Math.floor((ctx.props.width - 2 * STYLE.pad) / (STYLE.labelSize * 0.6)));

    function receive(v: unknown, src: string): void {
      latest = v;
      has = true;
      count++;
      receivedAt = clock;
      source = src;
      dirty = true;
    }

    function render(): void {
      dirty = false;
      sinceRender = 0;
      header?.set(ctx.props.title || source || ctx.props.channel || '(no channel)');
      renderAge();
      const c = cols();
      const maxLines = ctx.props.maxLines;
      if (!has) {
        kind?.set('');
        body?.set(ctx.props.channel ? 'waiting for a value…' : 'set the `channel` prop or link a port into `value`');
        if (hist) hist.commit(0);
        return;
      }
      const v = latest;
      if (isTensor(v)) {
        const data = toFloat32(v);
        const s = stats(data);
        kind?.set(truncate(`tensor ${tensorSignature(v)} · ${formatBytes(v.data.byteLength)}`, c));
        const f = (x: number) => formatNumber(x, { precision: 4 });
        const first: string[] = [];
        for (let i = 0; i < Math.min(8, data.length); i++) first.push(f(data[i]));
        const lines = [
          `min  ${f(s.min)}`,
          `max  ${f(s.max)}`,
          `mean ${f(s.mean)}`,
          `std  ${f(s.std)}`,
          s.nonFinite ? `non-finite ${s.nonFinite} of ${data.length}` : `finite all ${data.length}`,
          truncate(`[${first.join(', ')}${data.length > 8 ? ', …' : ''}]`, c),
        ];
        body?.set(lines.slice(0, maxLines).join('\n'));
        drawHistogram(data, s.min, s.max);
      } else {
        const t = v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? `object(${Object.keys(v as object).length} keys)` : typeof v;
        kind?.set(`json ${t}`);
        let text: string;
        try {
          text = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v);
        } catch {
          text = String(v);
        }
        const lines = text.split('\n');
        const shown = lines.slice(0, maxLines).map((l) => truncate(l, c));
        if (lines.length > maxLines) shown[maxLines - 1] = `… ${lines.length - maxLines + 1} more lines`;
        body?.set(shown.join('\n'));
        if (hist) hist.commit(0);
      }
    }

    function drawHistogram(data: Float32Array, lo: number, hi: number): void {
      if (!hist) return;
      counts.fill(0);
      const span = hi - lo;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const x = data[i];
        if (!Number.isFinite(x)) continue;
        const b = span > 0 ? Math.min(BINS - 1, Math.floor(((x - lo) / span) * BINS)) : BINS >> 1;
        const n = ++counts[b];
        if (n > peak) peak = n;
      }
      const bw = (histRect.x1 - histRect.x0) / BINS;
      for (let b = 0; b < BINS; b++) {
        const h = peak ? Math.max(0.0005, (counts[b] / peak) * histRect.h) : 0.0005;
        m4.makeScale(bw * 0.85, h, 1).setPosition(histRect.x0 + (b + 0.5) * bw, histRect.y0 + h / 2, STYLE.zOverlay);
        hist.setMatrixAt(b, m4);
      }
      hist.commit(BINS);
    }

    function renderAge(): void {
      sinceAge = 0;
      meta?.set(has ? `#${count} · ${formatAge((clock - receivedAt) * 1000)}` : '');
    }

    build();
    return {
      onProps() {
        // Reset BEFORE re-subscribing: a value the new channel already holds is delivered
        // synchronously inside refresh(), and must not be wiped afterwards.
        if (channel.wanted !== channel.channel) {
          has = false;
          count = 0;
          latest = undefined;
          source = channel.wanted;
        }
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'value') receive(v, 'input: value');
      },
      update(dt) {
        clock += dt;
        sinceRender += dt;
        sinceAge += dt;
        if (dirty && sinceRender >= 1 / Math.max(0.5, ctx.props.refreshHz)) render();
        if (sinceAge >= 0.5) renderAge();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
