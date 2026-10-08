// video — a video screen with controls. `url` can be a YouTube (or any yt-dlp-supported) link or a
// direct video URL: the `video` source downloads it into data/media and the server serves it
// same-origin at /media/<file> (WebGL needs CORS-clean video; the headset only reaches us over
// HTTPS). Paths starting with /media/ (or other same-origin URLs) play directly.
//
// The picture is a VideoTexture on an unlit plane sized from the video's aspect ratio. Controls
// under it (Lucide icons, shared/icons.ts): title + time, a seek bar (pinch-drag), back 10 s,
// play/pause, forward 10 s, speed − / + (0.25×–2×), mute. Playback is local to each client
// (headset, desktop, the screenshot mirror — which is always muted).

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { toScalar } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  url: string;
  speed: number;
  width: number;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  volume: number;
  showControls: boolean;
  prefix: string;
}

interface MediaEntry { status: string; progress: number; src: string; title: string; duration: number | null; error?: string }

const BAR_H = 0.088;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** The next speed step up/down from `cur` (snaps an off-list speed to the list). */
export function stepSpeed(cur: number, dir: 1 | -1): number {
  if (dir > 0) return SPEEDS.find((s) => s > cur + 1e-6) ?? SPEEDS[SPEEDS.length - 1];
  return [...SPEEDS].reverse().find((s) => s < cur - 1e-6) ?? SPEEDS[0];
}

/** Same-origin or /media/… → play directly; anything else http(s) goes through the video source. */
export function needsFetch(url: string, origin: string | null): boolean {
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith('/')) return false;
  if (origin && u.startsWith(origin + '/')) return false;
  return /^https?:\/\//i.test(u);
}

export function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const definition: WidgetDefinition<Props> = {
  description:
    'Video player screen with Lucide-icon controls (play/pause, ±10 s, speed −/+, mute, pinch-drag seek bar, time, title). url: YouTube or any yt-dlp-supported / ' +
    "direct video link (fetched by the 'video' source into data/media, served at /media/…), or a /media/<file> path. " +
    'Inputs: url, playing, seek (s), speed.',
  version: '1.0.0',
  props: {
    url: { type: 'string', default: '', description: 'YouTube / video URL, or /media/<file>.' },
    speed: { type: 'number', default: 1, min: 0.25, max: 2, step: 0.25, description: 'Playback speed (persisted when changed in the bar).' },
    width: { type: 'number', default: 0.9, min: 0.1, max: 6, step: 0.05, description: 'Screen width (m); height follows the video aspect.' },
    autoplay: { type: 'boolean', default: true, description: 'Start playing when ready (the browser may require a tap first for sound).' },
    loop: { type: 'boolean', default: false, description: 'Loop playback.' },
    muted: { type: 'boolean', default: false, description: 'Muted (persisted when toggled).' },
    volume: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, description: 'Volume.' },
    showControls: { type: 'boolean', default: true, description: 'Control bar under the screen.' },
    prefix: { type: 'string', default: 'video', description: "Channel prefix of the 'video' source (<prefix>.request / <prefix>.media)." },
  },
  inputs: {
    url: { type: 'string', description: 'Load this URL.' },
    playing: { type: 'boolean', description: 'Play (true) / pause (false).' },
    seek: { type: 'number', description: 'Jump to this time (s).' },
    speed: { type: 'number', description: 'Playback speed (0.25–2).' },
  },
  outputs: {},
  interactions: [dragBinding('video-drag', 'drag')],
  size: [0.9, 0.58, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const hasDom = typeof document !== 'undefined';
    const origin = typeof location !== 'undefined' ? location.origin : null;
    let url = String(ctx.props.url ?? '').trim();
    let video: HTMLVideoElement | null = null;
    let texture: THREE.VideoTexture | null = null;
    let group: THREE.Group | null = null;
    let screen: THREE.Mesh | null = null;
    let screenMat: THREE.MeshBasicMaterial | null = null;
    let status: Text | null = null;
    let titleText: Text | null = null;
    let timeText: Text | null = null;
    let playIcon: THREE.Mesh | null = null;
    let muteIcon: THREE.Mesh | null = null;
    let speedText: Text | null = null;
    let speed = clampSpeed(Number(ctx.props.speed));
    let fill: THREE.Mesh | null = null;
    let barInv = new T.Matrix4();
    let aspect = 16 / 9;
    let src = '';
    let entry: MediaEntry | null = null;
    let title = '';
    let message = '';
    let blocked = false; // autoplay refused: waiting for a tap
    let scrub: string | null = null;
    let press: { hand: string; part: string } | null = null;
    let timer = 0;
    let offMedia: (() => void) | null = null;
    const v3 = new T.Vector3();

    function clampSpeed(x: number): number { return Number.isFinite(x) ? Math.min(2, Math.max(0.25, x)) : 1; }
    const W = () => ctx.props.width;
    const H = () => W() / aspect;
    const muted = () => ctx.isMirror || !!ctx.props.muted;

    // ---- video element ------------------------------------------------------------------------

    function ensureVideo(): HTMLVideoElement | null {
      if (!hasDom) return null;
      if (video) return video;
      const v = (video = document.createElement('video'));
      v.crossOrigin = 'anonymous';
      v.playsInline = true;
      v.preload = 'auto';
      v.addEventListener('loadedmetadata', () => {
        if (v.videoWidth && v.videoHeight) {
          const a = v.videoWidth / v.videoHeight;
          if (Math.abs(a - aspect) > 1e-3) { aspect = a; build(); }
        }
        message = '';
        paint();
        if (ctx.props.autoplay) play();
      });
      v.addEventListener('play', paint);
      v.addEventListener('pause', paint);
      v.addEventListener('ended', paint);
      v.addEventListener('error', () => { message = `Can't play this video (${v.error?.message || 'decode error'})`; paint(); });
      texture = new T.VideoTexture(v);
      texture.colorSpace = T.SRGBColorSpace;
      return v;
    }

    function setSrc(s: string): void {
      if (s === src) return;
      src = s;
      const v = ensureVideo();
      if (!v) return;
      v.loop = !!ctx.props.loop;
      v.muted = muted();
      v.volume = Math.min(1, Math.max(0, Number(ctx.props.volume)));
      v.src = s;
      v.playbackRate = v.defaultPlaybackRate = speed;
      v.load();
      if (screenMat && texture) { screenMat.map = texture; screenMat.color.set('#ffffff'); screenMat.needsUpdate = true; }
    }

    function play(): void {
      const v = video;
      if (!v || !src) return;
      v.play().then(() => { blocked = false; paint(); }).catch(() => {
        // most likely autoplay with sound before any user gesture: try muted, ask for a tap to unmute
        if (!v.muted) { v.muted = true; v.play().catch(() => {}); }
        blocked = true;
        paint();
      });
    }

    // ---- url → src ----------------------------------------------------------------------------

    function load(u: string): void {
      url = u.trim();
      entry = null;
      title = '';
      message = '';
      offMedia?.();
      offMedia = null;
      if (!url) { setSrc(''); message = 'No video: set url (YouTube or a video link)'; paint(); return; }
      if (!needsFetch(url, origin)) { setSrc(url); message = 'Loading…'; paint(); return; }
      message = 'Requesting…';
      const prefix = ctx.props.prefix || 'video';
      offMedia = ctx.channels.subscribe(`${prefix}.media`, (val) => {
        const all = val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, MediaEntry>) : {};
        const e = all[url];
        if (!e) return;
        entry = e;
        title = e.title || '';
        if (e.status === 'ready' && e.src) { message = src === e.src ? message : 'Loading…'; setSrc(e.src); }
        else if (e.status === 'error') message = `Couldn't fetch: ${truncate(e.error ?? 'unknown error', 90)}`;
        else if (e.status === 'downloading') message = `Downloading${e.progress ? ` ${Math.round(e.progress * 100)}%` : '…'}`;
        else message = 'Queued…';
        paint();
      });
      // ask (again): cached URLs come back ready at once
      ctx.channels.publish(`${prefix}.request`, { url, nonce: Date.now() } as never);
      paint();
    }

    // ---- scene --------------------------------------------------------------------------------

    function build(): void {
      if (group) disposeTree(group);
      const g = (group = new T.Group());
      const w = W(), h = H();
      screenMat = new T.MeshBasicMaterial({ color: texture && src ? '#ffffff' : '#000000', map: texture && src ? texture : null, toneMapped: false });
      screen = new T.Mesh(sharedGeometry(T, 'plane'), screenMat);
      screen.scale.set(w, h, 1);
      screen.name = 'screen';
      ctx.interactive(screen);
      const frame = ctx.ui.panel(w + 0.02, h + 0.02, { color: '#05070a' });
      frame.position.z = -0.002;
      status = makeText(ctx, '', { size: Math.max(0.014, w * 0.03), anchorX: 'center', anchorY: 'middle', color: '#e6edf3', maxWidth: w * 0.85, textAlign: 'center' });
      status.position.z = 0.003;
      g.add(frame, screen, status);
      if (ctx.props.showControls) {
        const bw = Math.max(0.4, Math.min(w, 1.2));
        const bar = new T.Group();
        bar.position.set(0, -h / 2 - 0.012 - BAR_H / 2, 0.005);
        bar.add(ctx.ui.panel(bw, BAR_H));
        const x0 = -bw / 2 + 0.014, x1 = bw / 2 - 0.014;
        const top = BAR_H / 2;
        titleText = makeText(ctx, '', { size: 0.0125, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', maxWidth: bw * 0.68, whiteSpace: 'nowrap' });
        titleText.position.set(x0, top - 0.014, STYLE.zText);
        timeText = makeText(ctx, '', { size: 0.011, anchorX: 'right', anchorY: 'middle', color: theme.textDim, font: 'mono' });
        timeText.position.set(x1, top - 0.014, STYLE.zText);
        const sw = x1 - x0, sy = top - 0.031;
        const track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
        track.scale.set(sw, 0.006, 1);
        track.position.set(0, sy, STYLE.zContent);
        fill = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent));
        fill.position.set(x0, sy, STYLE.zOverlay);
        fill.userData.y = sy;
        const seekHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        seekHit.scale.set(sw + 0.01, 0.022, 0.02);
        seekHit.position.set(0, sy, 0.006);
        seekHit.name = 'seek';
        ctx.interactive(seekHit);
        for (const m of [track, fill]) m.raycast = () => {};
        bar.add(titleText, timeText, track, fill, seekHit);

        // button row: [back 10] [play] [fwd 10] … [speed − 1× +] [volume]
        const by = -BAR_H / 2 + 0.024;
        const round = (id: string, cx: number, d: number, icon: string, opts: { accent?: boolean; label?: string } = {}) => {
          const b = ctx.ui.panel(d, d, { color: opts.accent ? theme.accent : theme.surface, radius: d / 2 });
          b.position.set(cx, by, STYLE.zContent);
          b.name = `btn:${id}`;
          ctx.interactive(b);
          const ic = makeIcon(ctx, icon, { size: d * (opts.label ? 0.66 : 0.56), color: opts.accent ? theme.background : theme.text });
          ic.position.z = STYLE.zText;
          b.add(ic);
          if (opts.label) {
            const t = makeText(ctx, opts.label, { size: d * 0.18, anchorX: 'center', anchorY: 'middle', color: theme.text, weight: 'semibold' });
            t.position.set(0, -d * 0.01, STYLE.zText + 0.0005);
            b.add(t);
          }
          bar.add(b);
          return ic;
        };
        const d = 0.032, big = 0.04, gap = 0.012;
        round('back', x0 + d / 2, d, 'rotate-ccw', { label: '10' });
        playIcon = round('play', x0 + d + gap + big / 2, big, 'play', { accent: true });
        round('fwd', x0 + d + gap + big + gap + d / 2, d, 'rotate-cw', { label: '10' });
        muteIcon = round('mute', x1 - d / 2, d, 'volume-2');
        const sx = x1 - d - gap * 1.6; // speed group, right-aligned before the volume button
        const sd = 0.026;
        round('faster', sx - sd / 2, sd, 'plus');
        speedText = makeText(ctx, '', { size: 0.0125, anchorX: 'center', anchorY: 'middle', color: theme.text, font: 'mono', weight: 'semibold' });
        speedText.position.set(sx - sd - 0.024, by, STYLE.zText);
        bar.add(speedText);
        round('slower', sx - sd - 0.048 - sd / 2, sd, 'minus');
        const gauge = makeIcon(ctx, 'gauge', { size: 0.018, color: theme.textDim });
        gauge.position.set(sx - 2 * sd - 0.048 - 0.016, by, STYLE.zText);
        bar.add(gauge);
        g.add(bar);
        bar.updateMatrix();
        barInv = bar.matrix.clone().invert();
      } else {
        titleText = timeText = speedText = null;
        playIcon = muteIcon = null;
        fill = null;
      }
      ctx.root.add(g);
      paint();
    }

    function paint(): void {
      const v = video;
      const playing = !!v && !v.paused && !v.ended;
      const ready = !!v && v.readyState >= 2;
      const msg = message || (!hasDom ? 'Video plays in the headset / browser' : blocked ? 'Tap the screen for sound' : !ready && src ? 'Loading…' : !playing && src ? '' : '');
      status?.set(msg);
      if (status) status.visible = !!msg;
      if (screenMat) {
        const showPicture = !!(texture && src && ready);
        if ((screenMat.map !== null) !== showPicture) {
          screenMat.map = showPicture ? texture : null;
          screenMat.color.set(showPicture ? '#ffffff' : '#000000');
          screenMat.needsUpdate = true;
        }
      }
      titleText?.set(truncate(title || (entry ? '' : url.replace(/^https?:\/\//, '')) || 'Video', 70));
      if (playIcon) setIcon(T, playIcon, playing ? 'pause' : 'play');
      if (muteIcon) setIcon(T, muteIcon, v?.muted || muted() ? 'volume-x' : 'volume-2');
      speedText?.set(`${speed}×`);
      paintTime();
    }

    function paintTime(): void {
      const v = video;
      const dur = v && Number.isFinite(v.duration) ? v.duration : entry?.duration ?? 0;
      const t = v?.currentTime ?? 0;
      timeText?.set(`${clock(t)} / ${clock(dur)}`);
      if (fill && timeText) {
        const bw = Math.max(0.4, Math.min(W(), 1.2)), sw = bw - 0.028;
        const u = dur > 0 ? Math.min(1, t / dur) : 0;
        fill.visible = u > 0;
        fill.scale.set(Math.max(0.0005, sw * u), 0.006, 1);
        fill.position.x = -sw / 2 + (sw * u) / 2;
      }
    }

    // ---- controls -----------------------------------------------------------------------------

    function seekTo(t: number): void {
      const v = video;
      if (!v || !Number.isFinite(v.duration)) return;
      v.currentTime = Math.min(Math.max(0, t), v.duration);
      paintTime();
    }

    function click(part: string): void {
      const v = video;
      if (part === 'screen') {
        if (blocked && v) { v.muted = muted(); blocked = false; play(); return; }
        part = 'btn:play';
      }
      if (part === 'btn:slower' || part === 'btn:faster') { setSpeed(stepSpeed(speed, part === 'btn:faster' ? 1 : -1), true); return; }
      if (!v) return;
      if (part === 'btn:play') { if (v.paused || v.ended) play(); else v.pause(); }
      else if (part === 'btn:back') seekTo(v.currentTime - 10);
      else if (part === 'btn:fwd') seekTo(v.currentTime + 10);
      else if (part === 'btn:mute') {
        const m = !(v.muted || muted());
        if (!ctx.isMirror) ctx.setProps({ muted: m });
        v.muted = m || ctx.isMirror;
        blocked = false;
        if (!m && v.paused) play();
      }
      paint();
    }

    function setSpeed(x: number, persist: boolean): void {
      speed = clampSpeed(x);
      if (video) video.playbackRate = video.defaultPlaybackRate = speed;
      if (persist && !ctx.isMirror && speed !== ctx.props.speed) ctx.setProps({ speed });
      paint();
    }

    function seekFromLocal(lp: readonly number[]): void {
      const v = video;
      if (!v || !Number.isFinite(v.duration)) return;
      v3.set(lp[0], lp[1], lp[2]).applyMatrix4(barInv);
      const bw = Math.max(0.4, Math.min(W(), 1.2)), sw = bw - 0.028;
      seekTo(Math.min(1, Math.max(0, (v3.x + sw / 2) / sw)) * v.duration);
    }

    build();
    load(url);

    return {
      onProps(p, prev) {
        const v = video;
        if (v) {
          v.loop = !!p.loop;
          v.volume = Math.min(1, Math.max(0, Number(p.volume)));
          if (p.muted !== prev.muted) v.muted = muted();
        }
        if (p.speed !== prev.speed) setSpeed(Number(p.speed), false);
        if (p.width !== prev.width || p.showControls !== prev.showControls) build();
        if (p.url !== prev.url || p.prefix !== prev.prefix) load(String(p.url ?? ''));
        paint();
      },
      onInput(port, value) {
        if (port === 'url' && typeof value === 'string') load(value);
        else if (port === 'playing') { if (value && value !== 'false') play(); else video?.pause(); }
        else if (port === 'seek') { const n = toScalar(value); if (Number.isFinite(n)) seekTo(n); }
        else if (port === 'speed') { const n = toScalar(value); if (n > 0) setSpeed(n, false); }
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName ?? '';
        if (e.phase === 'start') {
          if (part === 'seek') { scrub = e.hand; seekFromLocal(e.localPoint); return; }
          if (part === 'screen' || part.startsWith('btn:')) press = { hand: e.hand, part };
          return;
        }
        if (e.phase === 'move') { if (scrub === e.hand) seekFromLocal(e.localPoint); return; }
        if (scrub === e.hand) scrub = null;
        if (press && press.hand === e.hand) {
          const p = press;
          press = null;
          if (e.phase === 'end') click(p.part);
        }
      },
      update(dt) {
        timer += dt;
        if (timer < 0.25) return;
        timer = 0;
        paintTime();
        if (video && src && !message && video.readyState >= 2 && screenMat?.map === null) paint();
      },
      dispose() {
        offMedia?.();
        if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
        texture?.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
