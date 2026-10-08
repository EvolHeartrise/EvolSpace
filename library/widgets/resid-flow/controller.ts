// resid-flow controller: channel subscriptions, selection state (lens layer,
// token), interactions, and coalesced rebuilds. Rendering lives in view.ts,
// pure geometry in layout.ts.
//
// Selection sources (latest wins): user interaction, input ports, the
// P.ctl.layer / P.ctl.token channels, and — until anything else selected —
// the layer/token of the producer's P.lens.readout.
//   user interaction → view + emit output + publish P.ctl.* (+ widget event)
//   P.ctl.* channel  → view + emit output (so linked sliders follow)
//   input port       → view only (link the source to the channel as well;
//                      see library/prefabs/resid-lens.json)

import type { InteractionEvent, WidgetContext, WidgetInstance } from '@evolspace/protocol';
import { allDirty, cleanDirty, DATA_KEYS, displayToken, InterpData, type DataKey, type Dirty } from './data.ts';
import { buildArcs, buildLayout, buildTicks, buildTrajectories, emptyRibbons, resolveInto, resolvePoint, type Layout, type PickSlot, type RibbonBuffers, type TickBuffers } from './layout.ts';
import { computeNodeColors, type ColorBy } from './colors.ts';
import { HANDLE_NAME, NODE_PICK_RADIUS, ResidView, themeColors, type Style } from './view.ts';

export interface ResidProps {
  prefix: string;
  width: number;
  height: number;
  layerSpacing: number;
  normalize: 'global' | 'layer';
  depthJitter: number;
  tokenFilter: unknown;
  colorBy: ColorBy;
  probe: string;
  showAttn: boolean;
  showDelta: boolean;
  showParticles: boolean;
  showLabels: boolean;
  showReadout: boolean;
  dimOthers: boolean;
  pickNodeSetsLayer: boolean;
  publishLayer: boolean;
  publishToken: boolean;
  attnHead: number;
  attnTopK: number;
  tubeWidth: number;
  flowSpeed: number;
  [k: string]: unknown;
}

type Source = 'user' | 'channel' | 'input' | 'readout' | 'default';

/** Props that decide which channels are subscribed (a prefix change also drops all data). */
const SUB_KEYS = ['prefix', 'probe', 'colorBy', 'showAttn'];
/** Props whose change requires a geometry rebuild. */
const GEOM_KEYS = ['width', 'height', 'layerSpacing', 'normalize', 'depthJitter', 'tokenFilter', 'colorBy'];
const ATTN_KEYS = ['attnHead', 'attnTopK'];

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

function parseFilter(v: unknown): Set<string> | null {
  let list: string[] = [];
  if (Array.isArray(v)) list = v.map((x) => String(x));
  else if (typeof v === 'string') list = v.split(',');
  list = list.map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

export class ResidFlow implements WidgetInstance {
  readonly data = new InterpData();
  readonly view: ResidView;
  /** Live subscriptions by channel name (diffed on prop changes). */
  private subs = new Map<string, () => void>();
  private dirty: Dirty = allDirty();
  private layout: Layout | null = null;
  private nodeColor: Float32Array | undefined;
  private traj: RibbonBuffers = emptyRibbons();
  private arcBuf: RibbonBuffers = emptyRibbons();
  private arcKeys: number[] = [];
  private ticks: TickBuffers | undefined;
  private attnRow = new Float32Array(16);
  private readonly colors: ReturnType<typeof themeColors>;

  /** Selected lens layer / token; null = not chosen yet (defaults apply). */
  private layer: number | null = null;
  private token: number | null = null;
  private layerSrc: Source = 'default';
  private tokenSrc: Source = 'default';
  /** Current hover target (kind: -1 none, 0 empty, 1 layer, 2 token, 3 handle). */
  private readonly hover = { hand: '', kind: -1, token: -1, layer: -1 };
  private readonly pick: PickSlot = { kind: 0, token: -1, layer: -1 };
  private drag: { hand: string; y0: number; layer0: number } | null = null;
  private lastSample: number | null = null;

  constructor(private ctx: WidgetContext<ResidProps>) {
    const { THREE } = ctx;
    this.colors = themeColors(THREE, ctx.theme);
    this.view = new ResidView(
      { THREE, ui: ctx.ui, theme: ctx.theme, interactive: (o) => ctx.interactive(o), isMirror: ctx.isMirror },
      this.style(),
    );
    ctx.root.add(this.view.group);
    this.view.showWaiting(this.waitingText());
    this.subscribe();

    // Inputs that arrived before creation (the host also replays them via onInput).
    const li = ctx.input('layer');
    if (typeof li === 'number') this.setLayer(li, 'input');
    const ti = ctx.input('token');
    if (typeof ti === 'number') this.setToken(ti, 'input');
  }

  private get prefix(): string {
    const p = this.ctx.props.prefix;
    return typeof p === 'string' && p.trim() ? p.trim() : 'interp';
  }

  private ch(suffix: string): string {
    return `${this.prefix}.${suffix}`;
  }

  // ---------------------------------------------------------------- props

  private style(): Style {
    const p = this.ctx.props;
    const T = this.data.T || 32;
    // Thinner nodes/tubes for long sequences so dense stacks stay readable.
    const density = Math.min(1, Math.max(0.45, Math.sqrt(40 / Math.max(1, T))));
    return {
      tubeWidth: num(p.tubeWidth, 0.005) * density,
      nodeSize: 0.011 * density,
      showParticles: bool(p.showParticles, true),
      showDelta: bool(p.showDelta, true),
      showAttn: bool(p.showAttn, true),
      showLabels: bool(p.showLabels, true),
      showReadout: bool(p.showReadout, true),
      dimOthers: bool(p.dimOthers, true),
      flowSpeed: num(p.flowSpeed, 1.4),
    };
  }

  onProps(props: Record<string, unknown>, prev: Record<string, unknown>): void {
    const changed = (keys: string[]) => keys.some((k) => JSON.stringify(props[k]) !== JSON.stringify(prev[k]));
    if (changed(SUB_KEYS)) {
      const prefixChanged = props.prefix !== prev.prefix;
      this.subscribe(prefixChanged);
    }
    if (changed(GEOM_KEYS)) this.dirty.geometry = true;
    if (changed(ATTN_KEYS)) this.dirty.attn = true;
    this.view.setStyle(this.style());
    this.dirty.labels = true;
  }

  // ---------------------------------------------------------------- channels

  /** Channels this instance should listen to for the current props: name → (data key | ctl handler). */
  private wanted(): Map<string, DataKey | ((v: unknown) => void)> {
    const p = this.ctx.props;
    const out = new Map<string, DataKey | ((v: unknown) => void)>();
    for (const key of DATA_KEYS) {
      // P.attn is optional and large ([L, H, T, T]): only fetch it while arcs are shown.
      if (key === 'attn' && !bool(p.showAttn, true)) continue;
      out.set(this.ch(key), key);
    }
    const probe = typeof p.probe === 'string' ? p.probe.trim() : '';
    if (p.colorBy === 'probe' && probe) out.set(this.ch(`probe.${probe}`), 'probe');
    out.set(this.ch('ctl.layer'), (v) => { if (typeof v === 'number' && Number.isFinite(v)) this.setLayer(v, 'channel'); });
    out.set(this.ch('ctl.token'), (v) => { if (typeof v === 'number' && Number.isFinite(v)) this.setToken(v, 'channel'); });
    return out;
  }

  /**
   * Bring subscriptions in line with the props: channels no longer wanted are
   * released (and their data dropped), new ones subscribed (the host fires
   * them immediately with a cached value). `resetData` (prefix change) also
   * forgets all data and the selection.
   */
  private subscribe(resetData = true): void {
    if (resetData) {
      for (const off of this.subs.values()) off();
      this.subs.clear();
      this.data.clear();
      this.layer = this.token = null;
      this.layerSrc = this.tokenSrc = 'default';
      this.dirty = allDirty();
    }
    const want = this.wanted();
    // Release first so a replaced probe channel clears before the new one delivers.
    for (const [name, off] of [...this.subs]) {
      if (want.has(name)) continue;
      off();
      this.subs.delete(name);
      const key = this.keyOf(name);
      if (key) this.onData(key, null);
    }
    for (const [name, h] of want) {
      if (this.subs.has(name)) continue;
      const cb = typeof h === 'function' ? h : (v: unknown) => this.onData(h, v);
      this.subs.set(name, this.ctx.channels.subscribe(name, cb));
    }
  }

  /** Data key of a subscribed channel name (null for ctl channels). */
  private keyOf(name: string): DataKey | null {
    const suffix = name.slice(this.prefix.length + 1);
    if ((DATA_KEYS as readonly string[]).includes(suffix)) return suffix as DataKey;
    return suffix.startsWith('probe.') ? 'probe' : null;
  }

  private onData(key: DataKey, v: unknown): void {
    const d = this.data.set(key, v);
    this.dirty.geometry ||= d.geometry;
    this.dirty.delta ||= d.delta;
    this.dirty.attn ||= d.attn;
    this.dirty.readout ||= d.readout;
    this.dirty.labels ||= d.labels;
    if (key === 'lens.readout' && this.data.readout) {
      // Adopt the producer's selection until something else chose one.
      const r = this.data.readout;
      if (this.layerSrc === 'default' && r.layer >= 0) this.setLayer(r.layer, 'readout');
      if (this.tokenSrc === 'default' && r.token >= 0) this.setToken(r.token, 'readout');
    }
  }

  // ---------------------------------------------------------------- selection

  /** Effective lens layer (selection clamped to the data, default = last layer). */
  get lensLayer(): number {
    const L1 = this.data.L1;
    if (!L1) return Math.max(0, this.layer ?? 0);
    const l = this.layer ?? L1 - 1;
    return Math.min(L1 - 1, Math.max(0, Math.round(l)));
  }

  /** Effective token (selection clamped; default = last existing token at the top layer; −1 = none). */
  get selectedToken(): number {
    const T = this.data.T;
    if (!T) return this.token ?? -1;
    if (this.token !== null) return Math.min(T - 1, Math.max(0, Math.round(this.token)));
    for (let t = T - 1; t >= 0; t--) if (this.data.exists(this.data.L1 - 1, t)) return t;
    return T - 1;
  }

  private setLayer(v: number, src: Source): void {
    const prev = this.layer === null ? null : this.lensLayer;
    this.layer = Math.round(v);
    if (src !== 'readout') this.layerSrc = src;
    const cur = this.lensLayer;
    if (prev === cur && src !== 'user') return this.refreshSelection();
    this.refreshSelection();
    if (src === 'user' || src === 'channel') this.ctx.emit('layer', cur);
    if (src === 'user' && bool(this.ctx.props.publishLayer, true)) this.publishCtl('layer', cur);
  }

  private setToken(v: number, src: Source): void {
    const prev = this.token === null ? null : this.selectedToken;
    this.token = Math.round(v);
    if (src !== 'readout') this.tokenSrc = src;
    const cur = this.selectedToken;
    if (prev === cur && src !== 'user') return this.refreshSelection();
    this.refreshSelection();
    if (src === 'user' || src === 'channel') this.ctx.emit('token', cur);
    if (src === 'user' && bool(this.ctx.props.publishToken, true)) this.publishCtl('token', cur);
  }

  private publishCtl(what: 'layer' | 'token' | 'sample', v: number): void {
    const name = this.ch(`ctl.${what}`);
    if (this.ctx.channels.get(name) === v) return;
    this.ctx.channels.publish(name, v);
  }

  /** Push the current selection to the view (cheap) and invalidate arcs/readout. */
  private refreshSelection(): void {
    this.dirty.attn = true;
    this.dirty.readout = true;
    this.dirty.labels = true;
    if (!this.layout) return;
    const l = this.lensLayer, t = this.selectedToken;
    this.view.setLens(l, this.data.layerLabel(l));
    this.view.setSelectedToken(t, t >= 0 ? `${displayToken(this.data.tokenLabel(t))}  #${t}` : '');
  }

  // ---------------------------------------------------------------- inputs & interaction

  onInput(port: string, value: unknown): void {
    const v = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(v)) return;
    if (port === 'layer') this.setLayer(v, 'input');
    else if (port === 'token') this.setToken(v, 'input');
    else if (port === 'sample') {
      const s = Math.max(0, Math.round(v));
      if (s === this.lastSample) return;
      this.lastSample = s;
      this.publishCtl('sample', s);
    }
  }

  onInteraction(e: InteractionEvent): void {
    const L = this.layout;
    if (!L) return;
    if (e.handler === 'hover') return this.onHover(e, L);
    if (e.handler !== 'pick' && e.handler !== 'press') return;
    const p = e.localPoint;
    if (e.phase === 'start') {
      if (this.isHandle(e)) {
        this.drag = { hand: e.hand, y0: p[1], layer0: this.lensLayer };
        return;
      }
      // Ray hits land exactly on nodes; touches are looser (pinch point near a node).
      const r = resolvePoint(L, p, NODE_PICK_RADIUS * 1.6);
      if (!r) return;
      if (r.kind === 'token') {
        this.setToken(r.token, 'user');
        if (bool(this.ctx.props.pickNodeSetsLayer, true)) this.setLayer(r.layer, 'user');
      } else {
        this.setLayer(r.layer, 'user');
      }
      this.ctx.event('select', this.selectionInfo());
      return;
    }
    if (!this.drag || this.drag.hand !== e.hand) return;
    if (e.phase === 'move') {
      const steps = Math.round((p[1] - this.drag.y0) / L.spacing);
      const l = Math.min(L.L1 - 1, Math.max(0, this.drag.layer0 + steps));
      if (l !== this.lensLayer) this.setLayer(l, 'user');
    } else {
      this.drag = null;
      this.ctx.event('select', this.selectionInfo());
    }
  }

  private isHandle(e: InteractionEvent): boolean {
    if (e.objectName === HANDLE_NAME) return true;
    const h = this.view.handlePosition();
    const p = e.localPoint;
    return Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]) < 0.03;
  }

  private onHover(e: InteractionEvent, L: Layout): void {
    const h = this.hover;
    if (e.phase === 'end' || e.phase === 'cancel') {
      if (h.hand === e.hand) {
        h.hand = '';
        h.kind = -1;
        this.view.setHover(-1, -1, '', false);
      }
      return;
    }
    // Hover 'move' arrives every frame: compare numerically, build labels only on change.
    const p = e.localPoint;
    const handle = this.isHandle(e);
    const r = this.pick;
    if (handle) { r.kind = 0; r.token = -1; r.layer = -1; } else resolveInto(L, p[0], p[1], p[2], NODE_PICK_RADIUS * 1.6, r);
    const kind = handle ? 3 : r.kind;
    if (h.hand === e.hand && h.kind === kind && h.token === r.token && h.layer === r.layer) return;
    h.hand = e.hand; h.kind = kind; h.token = r.token; h.layer = r.layer;
    let label = '';
    if (kind === 2) {
      const g = this.data.tokenGroup(r.token);
      label = `${displayToken(this.data.tokenLabel(r.token))}  #${r.token}${g ? ` · ${g}` : ''} · ${this.data.layerLabel(r.layer)}`;
    } else if (kind === 1) {
      label = this.data.layerLabel(r.layer);
    }
    this.view.setHover(kind === 2 ? r.token : -1, kind === 1 || kind === 2 ? r.layer : -1, label, handle);
  }

  private clearHover(): void {
    const h = this.hover;
    if (h.kind === -1 && h.hand === '') return;
    h.hand = ''; h.kind = -1; h.token = -1; h.layer = -1;
    this.view.setHover(-1, -1, '', false);
  }

  private selectionInfo(): Record<string, unknown> {
    const l = this.lensLayer, t = this.selectedToken;
    return { layer: l, layerLabel: this.data.layerLabel(l), token: t, tokenLabel: t >= 0 ? this.data.tokenLabel(t) : null };
  }

  // ---------------------------------------------------------------- rebuilds

  update(dt: number, t: number): void {
    if (this.dirty.geometry || this.dirty.delta || this.dirty.attn || this.dirty.readout || this.dirty.labels) {
      const d = this.dirty;
      this.dirty = cleanDirty();
      try {
        if (d.geometry) this.rebuildGeometry();
        if (this.layout) {
          if (d.geometry || d.delta) this.rebuildTicks();
          if (d.geometry || d.attn) this.rebuildArcs();
          if (d.geometry || d.readout) this.rebuildReadout();
        }
        if (d.geometry || d.labels) this.rebuildLabels();
      } catch (err) {
        this.ctx.error(`resid-flow rebuild failed: ${(err as Error)?.message ?? err}`, (err as Error)?.stack);
      }
    }
    this.view.update(dt, t);
  }

  private rebuildGeometry(): void {
    const p = this.ctx.props;
    const filter = parseFilter(p.tokenFilter);
    const L1 = this.data.L1;
    if (!this.data.proj) {
      this.layout = null;
      this.drag = null;
      this.clearHover();
      this.view.showWaiting(this.waitingText());
      return;
    }
    const height = Math.max(0.05, num(p.height, 0.8));
    const spacing = num(p.layerSpacing, 0) > 0 ? num(p.layerSpacing, 0) : height / Math.max(1, L1 - 1);
    const data = this.data;
    this.layout = buildLayout(data, {
      width: Math.max(0.05, num(p.width, 0.6)),
      spacing,
      normalize: p.normalize === 'layer' ? 'layer' : 'global',
      depthJitter: Math.max(0, num(p.depthJitter, 0)),
      tokenVisible: filter ? (t) => filter.has(data.tokenGroup(t) ?? '') : undefined,
    }, this.layout ?? undefined);
    const L = this.layout!;
    const mode = (['group', 'position', 'norm', 'probe'] as const).includes(p.colorBy as ColorBy) ? (p.colorBy as ColorBy) : 'group';
    this.nodeColor = computeNodeColors(data, L, mode, this.colors, this.nodeColor);
    const visibleTokens = L.visible.subarray(0, L.T).reduce((a, b) => a + b, 0);
    const S = Math.min(8, Math.max(2, Math.floor(40000 / Math.max(1, visibleTokens * Math.max(1, L1 - 1)))));
    buildTrajectories(L, this.nodeColor, S, this.traj);
    this.view.setStyle(this.style()); // density depends on T
    this.view.setLayout(L, data, this.nodeColor, this.traj);
    // Node positions moved: drop the hover tooltip; the next hover 'move' re-resolves it.
    this.clearHover();
    this.refreshSelection();
  }

  private rebuildTicks(): void {
    const L = this.layout!;
    const delta = this.data.delta;
    if (!delta) return this.view.setTicks(null);
    this.ticks = buildTicks(L, delta, this.ticks);
    this.view.setTicks(this.ticks);
  }

  private rebuildArcs(): void {
    const L = this.layout!;
    const attn = this.data.attn;
    const layer = this.lensLayer, q = this.selectedToken;
    if (!attn || layer < 1 || q < 0) return this.view.setArcs(null);
    // The residual at layer l was written by block l−1: show that block's attention.
    const [, H, T] = attn.shape;
    const b = layer - 1;
    const head = Math.round(num(this.ctx.props.attnHead, -1));
    let row: Float32Array;
    if (head >= 0 && head < H) {
      const o = ((b * H + head) * T + q) * T;
      row = attn.data.subarray(o, o + T);
    } else {
      if (this.attnRow.length < T) this.attnRow = new Float32Array(T);
      row = this.attnRow.subarray(0, T);
      row.fill(0);
      for (let h = 0; h < H; h++) {
        const o = ((b * H + h) * T + q) * T;
        for (let k = 0; k < T; k++) row[k] += attn.data[o + k] / H;
      }
    }
    buildArcs(L, layer, q, row, {
      topK: Math.max(1, Math.round(num(this.ctx.props.attnTopK, 8))),
      minWeight: 0.02,
      samples: 18,
      color: this.colors.accent,
    }, this.arcBuf, this.arcKeys);
    this.view.setArcs(this.arcBuf);
  }

  private rebuildReadout(): void {
    const r = this.data.readout;
    const l = this.lensLayer, t = this.selectedToken;
    const stale = !!r && (r.layer !== l || r.token !== t);
    const lens = this.data.meta?.lens?.kind || 'lens';
    const fallback = `${lens} · ${this.data.layerLabel(l)} · ${t >= 0 ? displayToken(this.data.tokenLabel(t)) : '—'}`;
    this.view.setReadout(r, stale, fallback, `waiting for ${this.ch('lens.readout')}`);
  }

  private rebuildLabels(): void {
    const d = this.data;
    if (!this.layout) {
      this.view.showWaiting(this.waitingText());
      return;
    }
    const m = d.meta;
    const title = m?.model ? `${m.model}${m.checkpoint ? ` · ${m.checkpoint}` : ''}` : 'residual stream';
    const parts: string[] = [];
    if (m?.sample) parts.push(`sample ${m.sample.index + 1}/${m.sample.total}${m.sample.label ? ` · ${m.sample.label}` : ''}`);
    parts.push(`${d.T} tokens × ${d.L1} layers`);
    const l = this.lensLayer, t = this.selectedToken;
    parts.push(`lens ${d.layerLabel(l)}${t >= 0 ? ` · ${displayToken(d.tokenLabel(t))} #${t}` : ''}`);
    const status: string[] = [];
    for (const key of ['meta', 'resid.norm', 'resid.mask', 'resid.delta', 'attn'] as const) {
      if (key === 'attn' && !bool(this.ctx.props.showAttn, true)) continue; // not subscribed
      const s = d.status(key);
      if (s === 'missing') status.push(`no ${key}`);
      else if (s !== 'ok') status.push(`${key}: ${s} ${JSON.stringify(d.rawShape(key) ?? [])}`);
    }
    if (this.ctx.props.colorBy === 'probe') {
      const s = d.status('probe');
      if (s !== 'ok') status.push(`probe '${this.ctx.props.probe || '?'}': ${s}`);
    }
    this.view.setHeader(title, parts.join('   '), status.join(' · '));
  }

  private waitingText(): string {
    const d = this.data;
    const lines = [`waiting for data on '${this.prefix}.*'`, ''];
    const mark = (s: string) => (s === 'ok' ? 'ok ' : s === 'missing' ? '-- ' : 'bad');
    for (const key of DATA_KEYS) {
      if (key === 'attn' && !bool(this.ctx.props.showAttn, true)) {
        lines.push(`off ${this.ch(key)}  (showAttn: false)`);
        continue;
      }
      const s = d.status(key);
      const req = key === 'resid.proj' ? '  (required)' : '';
      const extra = s === 'shape' || s === 'invalid' ? `  ${s} ${JSON.stringify(d.rawShape(key) ?? [])}` : '';
      lines.push(`${mark(s)} ${this.ch(key)}${req}${extra}`);
    }
    lines.push('', 'demo: npx tsx library/widgets/resid-flow/demo-data.ts');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- lifecycle

  dispose(): void {
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.view.dispose();
  }

  /** Diagnostics for tests and the agent (not part of the widget contract). */
  debug(): { layer: number; token: number; layout: Layout | null; arcKeys: number[]; view: ReturnType<ResidView['stats']>; status: Record<string, string> } {
    const status: Record<string, string> = {};
    for (const k of DATA_KEYS) status[k] = this.data.status(k);
    return { layer: this.lensLayer, token: this.selectedToken, layout: this.layout, arcKeys: [...this.arcKeys], view: this.view.stats(), status };
  }
}

