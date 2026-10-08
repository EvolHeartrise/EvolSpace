// bsrl-replay — the BeatSaberRL replay viewer as a diorama: the agent's FK body with sabers and
// swept trails, the note/bomb/chain track with walls, cut debris and flying scores, the in-game HUD
// (combo, score, accuracy + grade, multiplier ring, misses, energy), and a control bar (play/pause,
// ±5 s, speed, prev/next replay, a seek bar graphing total torque with mistakes marked in red).
//
// Data comes from the `bsrl-replay` source (library/sources/bsrl-replay) on channels <prefix>.*:
// meta, q [T,36], chart [N,12], walls [W,7], hud [T,8], torque [T], status; it switches replays on
// <prefix>.ctl.load. Module top level is side-effect free; three.js comes from ctx.THREE.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { dragBinding } from '../../shared/handle.ts';
import { toScalar } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';
import { ReplayStore, KEYS, C, OUTCOME, formatClock, ppLabel, type Replay } from './data.ts';
import { ReplayView } from './view.ts';

interface Props extends Record<string, unknown> {
  prefix: string;
  scale: number;
  trackLength: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  autoNext: boolean;
  showHud: boolean;
  showTrails: boolean;
  trailSeconds: number;
  showControls: boolean;
}

const SPEEDS = [0.25, 0.5, 1, 2];
const BAR_W = 0.6;
const BAR_H = 0.135;
const SEEK_W = 0.56;
const SEEK_Y = 0.0;
const SEEK_H = 0.03;
const BUTTONS = [
  { id: 'prev', label: 'Prev' },
  { id: 'back', label: '−5 s' },
  { id: 'play', label: 'Pause' },
  { id: 'fwd', label: '+5 s' },
  { id: 'speed', label: '1×' },
  { id: 'next', label: 'Next' },
] as const;

const definition: WidgetDefinition<Props> = {
  description:
    'BeatSaberRL replay viewer diorama: FK body + sabers with trails, notes/bombs/chains/walls with cut debris and flying scores, ' +
    'the game HUD (combo, score, accuracy/grade, multiplier, misses, energy) and a control bar (play/pause, ±5 s, speed, prev/next replay, ' +
    "torque seek bar with mistakes). Needs the 'bsrl-replay' source (channels <prefix>.*). Inputs: seek (s), playing, speed, load (replay id/index/'next'/'prev').",
  version: '1.0.0',
  props: {
    prefix: { type: 'string', default: 'replay', description: 'Channel prefix of the bsrl-replay source (<prefix>.meta, .q, .chart, …).' },
    scale: { type: 'number', default: 0.25, min: 0.02, max: 1.5, step: 0.01, description: 'Diorama scale (1 = life size).' },
    trackLength: { type: 'number', default: 8, min: 2, max: 14, step: 0.5, description: 'Visible note track length in game meters.' },
    playing: { type: 'boolean', default: true, description: 'Playing or paused (persisted when toggled in the bar).' },
    speed: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.05, description: 'Playback speed.' },
    loop: { type: 'boolean', default: true, description: 'Restart at the end (unless autoNext).' },
    autoNext: { type: 'boolean', default: false, description: 'Load the next replay at the end.' },
    showHud: { type: 'boolean', default: true, description: 'In-game HUD down the track.' },
    showTrails: { type: 'boolean', default: true, description: 'Swept saber trails.' },
    trailSeconds: { type: 'number', default: 0.1, min: 0, max: 0.5, step: 0.01, description: 'Trail length in seconds.' },
    showControls: { type: 'boolean', default: true, description: 'Control bar in front of the platform.' },
  },
  inputs: {
    seek: { type: 'number', description: 'Jump to this time (s).' },
    playing: { type: 'boolean', description: 'Play (true) / pause (false).' },
    speed: { type: 'number', description: 'Playback speed.' },
    load: { type: 'any', description: "Replay to load: catalog id, index, 'next' or 'prev' (forwarded to <prefix>.ctl.load)." },
  },
  outputs: {},
  interactions: [dragBinding('replay-drag', 'drag')],
  size: [0.8, 0.7, 2.6],
  create(ctx) {
    const T = ctx.THREE;
    const store = new ReplayStore();
    let view: ReplayView | null = null;
    let bar: THREE.Group | null = null;
    let barInv: THREE.Matrix4 = new T.Matrix4();
    let title: Text | null = null;
    let clock: Text | null = null;
    let playLabel: Text | null = null;
    let speedLabel: Text | null = null;
    let playhead: THREE.Mesh | null = null;
    let graph: THREE.Group | null = null;
    const buttons = new Map<string, THREE.Mesh>();
    let pressAnim = 0;
    let pressed: THREE.Mesh | null = null;

    let time = 0;
    let playing = ctx.props.playing;
    let speed = ctx.props.speed;
    let dirty = true;
    let lastClock = -1;
    let scrubHand: string | null = null;
    let pressPart: string | null = null;
    let pressHand: string | null = null;
    const v = new T.Vector3();
    let unsub: Array<() => void> = [];

    function rep(): Replay | null { return store.replay; }

    function build(): void {
      if (view) disposeTree(view.group);
      if (bar) disposeTree(bar);
      const p = ctx.props;
      view = new ReplayView(ctx, {
        scale: p.scale, trackLength: p.trackLength, showTrails: p.showTrails, trailSeconds: p.trailSeconds, showHud: p.showHud,
      });
      ctx.root.add(view.group);
      view.setReplay(rep());
      bar = p.showControls ? buildBar() : null;
      if (bar) { ctx.root.add(bar); rebuildGraph(); }
      lastClock = -1;
      dirty = true;
    }

    // ---- control bar --------------------------------------------------------------------------

    function buildBar(): THREE.Group {
      const theme = ctx.theme;
      const g = new T.Group();
      g.name = 'controls';
      const s = ctx.props.scale;
      // in front of the platform (toward the viewer), tilted back so it reads from above
      g.position.set(0, -1.2 * s - 0.03, s + 0.09);
      g.rotation.x = -0.55;
      g.add(ctx.ui.panel(BAR_W, BAR_H));
      title = makeText(ctx, 'Waiting for replay data…', { size: 0.015, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', maxWidth: 0.42, whiteSpace: 'nowrap' });
      title.position.set(-SEEK_W / 2, 0.047, STYLE.zText);
      clock = makeText(ctx, '', { size: 0.013, anchorX: 'right', anchorY: 'middle', color: theme.textDim, font: 'mono' });
      clock.position.set(SEEK_W / 2, 0.047, STYLE.zText);
      g.add(title, clock);

      const track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
      track.scale.set(SEEK_W, SEEK_H, 1);
      track.position.set(0, SEEK_Y, STYLE.zContent);
      track.raycast = () => {};
      // a taller invisible hit strip makes the seek bar easy to pinch
      const seekHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      seekHit.scale.set(SEEK_W + 0.02, SEEK_H + 0.02, 0.02);
      seekHit.position.set(0, SEEK_Y, 0.005);
      seekHit.name = 'seek';
      ctx.interactive(seekHit);
      playhead = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent));
      playhead.scale.set(0.003, SEEK_H + 0.008, 1);
      playhead.position.set(-SEEK_W / 2, SEEK_Y, STYLE.zOverlay + 0.001);
      playhead.raycast = () => {};
      g.add(track, seekHit, playhead);

      const bw = 0.088, gap = (SEEK_W - BUTTONS.length * bw) / (BUTTONS.length - 1);
      buttons.clear();
      BUTTONS.forEach((b, i) => {
        const btn = ctx.ui.panel(bw, 0.03, { color: theme.surface });
        btn.position.set(-SEEK_W / 2 + bw / 2 + i * (bw + gap), -0.042, STYLE.zContent);
        btn.name = `btn:${b.id}`;
        ctx.interactive(btn);
        const label = makeText(ctx, b.label, { size: 0.012, anchorX: 'center', anchorY: 'middle', color: theme.text });
        label.position.set(0, 0, STYLE.zText);
        btn.add(label);
        if (b.id === 'play') playLabel = label;
        if (b.id === 'speed') speedLabel = label;
        buttons.set(b.id, btn);
        g.add(btn);
      });
      g.updateMatrix();
      barInv = g.matrix.clone().invert();
      paintButtons();
      return g;
    }

    /** Torque over the replay as a filled-looking line plus red ticks at mistakes. */
    function rebuildGraph(): void {
      if (!bar) return;
      if (graph) disposeTree(graph);
      graph = null;
      const r = rep();
      if (!r) return;
      graph = new T.Group();
      const M = 280, x0 = -SEEK_W / 2, y0 = SEEK_Y - SEEK_H / 2 + 0.002, h = SEEK_H - 0.004;
      const buckets = new Float32Array(M);
      for (let k = 0; k < r.T; k++) {
        const b = Math.min(M - 1, Math.floor((k / r.T) * M));
        if (r.torque[k] > buckets[b]) buckets[b] = r.torque[k];
      }
      const sorted = Float32Array.from(buckets).sort();
      const top = sorted[Math.floor(M * 0.98)] || 1;
      const seg: number[] = [];
      for (let b = 0; b < M; b++) {
        const x = x0 + ((b + 0.5) / M) * SEEK_W, y = y0 + Math.min(1, buckets[b] / top) * h;
        seg.push(x, y0, 0, x, y, 0);
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(seg, 3));
      const lines = new T.LineSegments(geo, new T.LineBasicMaterial({ color: ctx.theme.accent, transparent: true, opacity: 0.45 }));
      lines.position.z = STYLE.zOverlay;
      lines.raycast = () => {};
      graph.add(lines);
      const bad: number[] = [];
      for (let i = 0; i < r.N; i++) {
        const o = i * C.N, out = r.chart[o + C.OUTCOME], rt = r.chart[o + C.RTICK];
        if (rt < 0 || out === OUTCOME.GOOD || out === OUTCOME.NONE) continue;
        const x = x0 + (rt / (r.T - 1)) * SEEK_W;
        bad.push(x, y0 - 0.002, 0, x, y0 + h + 0.002, 0);
      }
      if (bad.length) {
        const bg = new T.BufferGeometry();
        bg.setAttribute('position', new T.Float32BufferAttribute(bad, 3));
        const marks = new T.LineSegments(bg, new T.LineBasicMaterial({ color: '#ff4a4a' }));
        marks.position.z = STYLE.zOverlay + 0.0005;
        marks.raycast = () => {};
        graph.add(marks);
      }
      bar.add(graph);
    }

    function paintButtons(): void {
      playLabel?.set(playing ? 'Pause' : 'Play');
      speedLabel?.set(`${speed}×`);
    }

    function paintBar(): void {
      if (!bar) return;
      const r = rep();
      if (title) {
        if (r) {
          const m = r.meta;
          const idx = m.index >= 0 ? `${m.model} #${m.index + 1}/${m.total} · ` : '';
          const loading = store.status.startsWith('Loading') || store.status.startsWith('Error') ? `  (${store.status})` : '';
          title.set(`${idx}${m.song} · ${m.difficulty}${ppLabel(m)}${loading}`);
        } else title.set(store.status || 'Waiting for replay data (bsrl-replay source)…');
      }
      if (r && playhead) playhead.position.x = -SEEK_W / 2 + (time / r.duration) * SEEK_W;
      const sec = Math.floor(time);
      if (r && clock && sec !== lastClock) {
        lastClock = sec;
        clock.set(`${formatClock(time)} / ${formatClock(r.duration)}`);
      }
    }

    // ---- playback -----------------------------------------------------------------------------

    function seek(t: number): void {
      const r = rep();
      time = r ? Math.min(Math.max(t, 0), r.duration) : 0;
      dirty = true;
    }

    function setPlaying(on: boolean, persist: boolean): void {
      if (on === playing) return;
      playing = on;
      paintButtons();
      if (persist) ctx.setProps({ playing });
      dirty = true;
    }

    function load(v: unknown): void {
      const s = typeof v === 'string' ? v.trim() : v;
      let msg: unknown = null;
      if (s === 'next' || s === 'prev') msg = { cmd: s, nonce: Date.now() };
      else if (typeof s === 'string' && s) msg = /^\d+$/.test(s) ? Number(s) : s;
      else if (typeof s === 'number' && Number.isFinite(s)) msg = Math.round(s);
      else if (s && typeof s === 'object') msg = s;
      if (msg !== null) ctx.channels.publish(`${ctx.props.prefix}.ctl.load`, msg as never);
    }

    function click(id: string): void {
      if (id === 'play') {
        const r = rep();
        if (!playing && r && time >= r.duration) seek(0);
        setPlaying(!playing, true);
      } else if (id === 'back') seek(time - 5);
      else if (id === 'fwd') seek(time + 5);
      else if (id === 'speed') {
        const i = SPEEDS.indexOf(speed);
        speed = SPEEDS[(i + 1) % SPEEDS.length];
        paintButtons();
        ctx.setProps({ speed });
      } else if (id === 'prev' || id === 'next') load(id);
    }

    function seekFromLocal(lp: readonly number[]): void {
      const r = rep();
      if (!r) return;
      v.set(lp[0], lp[1], lp[2]).applyMatrix4(barInv);
      const u = Math.min(1, Math.max(0, (v.x + SEEK_W / 2) / SEEK_W));
      seek(u * r.duration);
    }

    // ---- data ---------------------------------------------------------------------------------

    function subscribe(): void {
      for (const u of unsub) u();
      unsub = KEYS.map((k) =>
        ctx.channels.subscribe(`${ctx.props.prefix}.${k}`, (val) => {
          const prevVersion = store.version;
          if (!store.set(k, val)) return;
          if (store.replay && store.version !== prevVersion) {
            time = 0;
            view?.setReplay(store.replay);
            rebuildGraph();
            lastClock = -1;
          }
          dirty = true;
        }),
      );
    }

    build();
    subscribe();

    return {
      onProps(p, prev) {
        if (p.playing !== prev.playing) { playing = !!p.playing; paintButtons(); }
        if (p.speed !== prev.speed) { speed = Number(p.speed) || 1; paintButtons(); }
        const rebuild = (['scale', 'trackLength', 'showHud', 'showTrails', 'trailSeconds', 'showControls'] as const).some((k) => p[k] !== prev[k]);
        if (rebuild) build();
        if (p.prefix !== prev.prefix) subscribe();
        dirty = true;
      },
      onInput(port, value) {
        if (port === 'seek') { const n = toScalar(value); if (Number.isFinite(n)) seek(n); }
        else if (port === 'playing') setPlaying(!!value && value !== 'false', false);
        else if (port === 'speed') { const n = toScalar(value); if (n > 0 && Number.isFinite(n)) { speed = n; paintButtons(); } }
        else if (port === 'load') load(value);
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName;
        if (e.phase === 'start') {
          if (part === 'seek') {
            scrubHand = e.hand;
            setPlaying(false, false);
            seekFromLocal(e.localPoint);
          } else if (part?.startsWith('btn:')) {
            pressPart = part.slice(4);
            pressHand = e.hand;
            pressed = buttons.get(pressPart) ?? null;
            pressAnim = 0.15;
          }
        } else if (e.phase === 'move') {
          if (scrubHand === e.hand) seekFromLocal(e.localPoint);
        } else {
          if (scrubHand === e.hand) scrubHand = null;
          if (pressHand === e.hand) {
            if (e.phase === 'end' && pressPart) click(pressPart);
            pressHand = null;
            pressPart = null;
          }
        }
      },
      update(dt) {
        const r = rep();
        if (pressAnim > 0) {
          pressAnim = Math.max(0, pressAnim - dt);
          pressed?.scale.setScalar(pressAnim > 0 ? 0.92 : 1);
        }
        if (!r || !view) { if (dirty) { paintBar(); dirty = false; } return; }
        if (playing) {
          time += Math.min(dt, 0.1) * speed;
          if (time >= r.duration) {
            if (ctx.props.autoNext) { time = 0; load('next'); }
            else if (ctx.props.loop) time = 0;
            else { time = r.duration; setPlaying(false, false); }
          }
          dirty = true;
        }
        if (!dirty) return;
        dirty = false;
        view.render(time);
        paintBar();
      },
      dispose() {
        for (const u of unsub) u();
        if (view) disposeTree(view.group);
        if (bar) disposeTree(bar);
      },
    };
  },
};

export default definition;
