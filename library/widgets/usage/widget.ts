// usage — Claude plan usage limits: one bar per rate-limit window (current 5-hour session,
// weekly, …) with % used, colored by level, and a live "resets in" countdown. Data from the
// `claude-usage` source on `claude.usage`: {windows: [{key, label, pct, resetsAt (ms)}], model, at}.

import type { ChannelValue, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { resolveColor } from '../../shared/color.ts';
import { formatAge } from '../../shared/format.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  channel: string;
  width: number;
  warnAt: number;
  alertAt: number;
}

interface Win { key: string; label: string; pct: number; resetsAt: number | null }

const PAD = 0.018;
const MAX_ROWS = 4;

/** "2h 14m", "3d 4h", "45s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function resetLabel(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const when = sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return `Resets in ${formatDuration(at - now)} · ${when}`;
}

const definition: WidgetDefinition<Props> = {
  description:
    'Claude plan usage limits: a bar per window (current 5-hour session, weekly…) with % used colored by level and a live reset countdown. ' +
    "Reads the claude-usage source's claude.usage channel ({windows: [{key, label, pct, resetsAt}], model, at}).",
  version: '1.0.0',
  props: {
    channel: { type: 'channel', default: 'claude.usage', description: 'Usage channel.' },
    width: { type: 'number', default: 0.42, min: 0.25, max: 1.5, step: 0.01, description: 'Card width (m).' },
    warnAt: { type: 'number', default: 50, min: 0, max: 100, description: 'Bars turn amber at this % used.' },
    alertAt: { type: 'number', default: 80, min: 0, max: 100, description: 'Bars turn red at this % used.' },
  },
  inputs: {},
  outputs: {},
  size: [0.42, 0.24, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let group: THREE.Group | null = null;
    let windows: Win[] = [];
    let at: number | null = null;
    let model = '';
    let note = '';
    let built = -1;
    let tick = 0;
    const rows: Array<{ label: Text; pct: Text; reset: Text; fill: THREE.Mesh; mat: THREE.MeshBasicMaterial; level: string }> = [];
    let footer: Text | null = null;
    let subtitle: Text | null = null;

    const W = () => ctx.props.width;
    const rowH = 0.072;

    function build(): void {
      if (group) disposeTree(group);
      rows.length = 0;
      const n = Math.min(MAX_ROWS, Math.max(1, windows.length));
      built = windows.length;
      const h = PAD * 2 + 0.05 + n * rowH + 0.02;
      const g = (group = new T.Group());
      g.add(ctx.ui.panel(W(), h));
      const x0 = -W() / 2 + PAD, x1 = W() / 2 - PAD;
      let y = h / 2 - PAD;
      const title = makeText(ctx, 'Claude usage', { size: 0.02, anchorX: 'left', anchorY: 'top', color: theme.text, weight: 'semibold' });
      title.position.set(x0, y, STYLE.zText);
      subtitle = makeText(ctx, '', { size: 0.011, anchorX: 'right', anchorY: 'top', color: theme.textDim });
      subtitle.position.set(x1, y - 0.004, STYLE.zText);
      g.add(title, subtitle);
      y -= 0.05;
      if (!windows.length) {
        const t = makeText(ctx, note || 'Waiting for usage data (claude-usage source)…', { size: 0.012, anchorX: 'left', anchorY: 'top', color: theme.textDim, maxWidth: x1 - x0 });
        t.position.set(x0, y, STYLE.zText);
        g.add(t);
      }
      for (let i = 0; i < Math.min(MAX_ROWS, windows.length); i++) {
        const label = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text });
        label.position.set(x0, y - 0.008, STYLE.zText);
        const pct = makeText(ctx, '', { size: 0.017, anchorX: 'right', anchorY: 'middle', color: theme.text, weight: 'semibold', font: 'mono' });
        pct.position.set(x1, y - 0.008, STYLE.zText);
        const track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
        track.scale.set(x1 - x0, 0.012, 1);
        track.position.set(0, y - 0.03, STYLE.zContent);
        const mat = ownMaterial(T, resolveColor(theme, 'accent'));
        const fill = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        fill.position.set(0, y - 0.03, STYLE.zOverlay);
        const reset = makeText(ctx, '', { size: 0.0105, anchorX: 'left', anchorY: 'middle', color: theme.textDim });
        reset.position.set(x0, y - 0.05, STYLE.zText);
        for (const m of [track, fill]) m.raycast = () => {};
        g.add(label, pct, track, fill, reset);
        rows.push({ label, pct, reset, fill, mat, level: '' });
        y -= rowH;
      }
      footer = makeText(ctx, '', { size: 0.0095, anchorX: 'left', anchorY: 'bottom', color: theme.textDim });
      footer.position.set(x0, -h / 2 + PAD * 0.7, STYLE.zText);
      g.add(footer);
      ctx.root.add(g);
      render();
    }

    function render(): void {
      if (!group) return;
      const now = Date.now();
      const x0 = -W() / 2 + PAD, x1 = W() / 2 - PAD, bw = x1 - x0;
      subtitle?.set(model);
      rows.forEach((r, i) => {
        const w = windows[i];
        r.label.set(w.label);
        r.pct.set(`${Math.round(w.pct)}%`);
        const u = Math.min(1, Math.max(0, w.pct / 100));
        r.fill.visible = u > 0;
        r.fill.scale.set(Math.max(0.0005, bw * u), 0.012, 1);
        r.fill.position.x = x0 + (bw * u) / 2;
        const level = w.pct >= ctx.props.alertAt ? 'alert' : w.pct >= ctx.props.warnAt ? 'warn' : 'ok';
        if (level !== r.level) {
          r.level = level;
          r.mat.color.set(level === 'alert' ? resolveColor(theme, 'negative') : level === 'warn' ? '#e3b341' : resolveColor(theme, 'positive'));
        }
        r.reset.set(w.resetsAt ? (w.resetsAt > now ? resetLabel(w.resetsAt, now) : 'Reset — waiting for fresh numbers') : '');
      });
      footer?.set(at ? `updated ${formatAge(now - at)}${now - at < 1000 ? '' : ' ago'} · from Claude Code's status line` : '');
    }

    function setData(v: ChannelValue): void {
      const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      if (!o || !Array.isArray(o.windows)) { ctx.error('usage: expected {windows: [...]}'); return; }
      windows = (o.windows as unknown[]).flatMap((x) => {
        const w = x as Partial<Win>;
        return w && typeof w.label === 'string' && Number.isFinite(w.pct) ? [{ key: String(w.key ?? ''), label: w.label, pct: Number(w.pct), resetsAt: Number.isFinite(w.resetsAt) ? Number(w.resetsAt) : null }] : [];
      });
      at = Number.isFinite(o.at) ? Number(o.at) : null;
      model = typeof o.model === 'string' ? o.model : '';
      note = typeof o.note === 'string' ? o.note : '';
      if (windows.length !== built || !windows.length) build();
      else render();
    }

    build();
    const channel = new ChannelProp(ctx, setData);
    return {
      onProps(p, prev) {
        if (p.channel !== prev.channel) channel.refresh();
        if (p.width !== prev.width) build();
        else render();
      },
      update(dt) {
        tick += dt;
        if (tick < 1) return; // countdowns and "updated … ago" at 1 Hz (text.set is a no-op when unchanged)
        tick = 0;
        render();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
