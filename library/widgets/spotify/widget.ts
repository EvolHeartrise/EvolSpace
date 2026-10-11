// spotify — EvolSpace's own Spotify client, in Spotify's look: now playing (album art, title, artists,
// like, seekable progress, shuffle / previous / play-pause / next / repeat, volume) beside Your Library
// (Playlists, Liked Songs, Search results; open one to see its tracks, tap a track to play it in that
// context). The music itself plays in this client: the `spotify` source (go-librespot, Spotify Connect
// device "EvolSpace") streams PCM on <prefix>.audio.stream and the widget plays it with WebAudio.
//
// One EvolSpace client plays the audio at a time: <prefix>.output = {client} names it. The first client
// to show the widget claims it; touching the widget in another client (headset vs desktop) moves it there.
//
// Data (from the spotify source):
//   <prefix>.state         sign-in (pairing code), now playing, position, volume, shuffle/repeat
//   <prefix>.search        latest search results (search by voice through Claude: {cmd:'search', query})
//   <prefix>.request  ←    controls / {cmd:'library'|'tracks', reply: <prefix>.view.<entity>, nonce}
//   <prefix>.audio.stream  PCM i16 interleaved stereo 44.1 kHz, 100 ms chunks

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { hexToInt } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { ScrollViewport, SmoothScroll, TextSync } from '../../shared/scroll.ts';

interface Props extends Record<string, unknown> {
  prefix: string;
  width: number;
  textSize: number;
  tab: string;
}

interface Track { uri: string; name: string; artists: string[]; album: string; albumUri: string; cover?: string; duration: number }
interface State {
  auth: string; login?: { url?: string; code?: string } | null; error?: string; device?: string;
  track?: Track; position?: number; positionAt?: number; paused?: boolean; stopped?: boolean; buffering?: boolean;
  volume?: number; shuffle?: boolean; repeatContext?: boolean; repeatTrack?: boolean; contextUri?: string; contextName?: string;
  /** The current track is in Liked Songs. */
  liked?: boolean;
  /** The upcoming track and the one before (for an instant next / previous). */
  next?: Track; prev?: Track;
}
interface Item { uri: string; kind: string; name: string; sub: string; image?: string; duration?: number; context?: string }

/** Spotify's dark UI. */
const SP = {
  base: '#121212', card: '#181818', raised: '#282828', hover: '#2a2a2a', green: '#1ed760', text: '#ffffff', sub: '#b3b3b3',
  faint: '#6a6a6a', track: '#4d4d4d', black: '#000000', chip: '#2a2a2a',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const textOf = (t: Text): string => (t as unknown as { text: string }).text;

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Current playback position: interpolated from the last state while playing. */
export function positionNow(st: State | null, now = Date.now()): number {
  if (!st?.track) return 0;
  const p = st.position ?? 0;
  if (st.paused || st.stopped || st.buffering || !st.positionAt) return p;
  return Math.min(st.track.duration || Infinity, p + (now - st.positionAt));
}

/** Interleaved i16 PCM → WebAudio, scheduled back to back with a small jitter buffer. */
class PcmPlayer {
  private ctx: AudioContext;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private gain: GainNode;
  constructor() {
    const AC = (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }
  wake(): void { if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {}); }
  push(pcm: Int16Array): void {
    const ctx = this.ctx;
    this.wake();
    const n = pcm.length >> 1;
    if (!n) return;
    const now = ctx.currentTime;
    if (this.next < now + 0.03) this.next = now + 0.2; // (re)start or underrun: rebuffer
    if (this.next > now + 1.2) return; // hopelessly behind: drop instead of growing latency
    const buf = ctx.createBuffer(2, n, 44100);
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { l[i] = pcm[2 * i] / 32768; r[i] = pcm[2 * i + 1] / 32768; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.onended = () => this.sources.delete(src);
    src.start(this.next);
    this.sources.add(src);
    this.next += buf.duration;
  }
  /** Drop everything scheduled (pause, skip, seek: the new audio starts at once). */
  flush(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* already done */ } }
    this.sources.clear();
    this.next = 0;
  }
  close(): void { this.flush(); void this.ctx.close().catch(() => {}); }
}

const PCM_MAGIC = 0x5350;

/** A stream chunk: [PCM_MAGIC, generation, …interleaved PCM] (see the spotify source). */
export function chunkOf(v: ChannelValue): { gen: number; pcm: Int16Array } | null {
  const t = v as { $tensor?: boolean; dtype?: string; data?: unknown };
  if (!t || !t.$tensor || t.dtype !== 'i16') return null;
  const d = t.data;
  const a = d instanceof Int16Array ? d : d instanceof Uint8Array ? new Int16Array(d.buffer, d.byteOffset, d.byteLength >> 1) : d instanceof ArrayBuffer ? new Int16Array(d) : null;
  if (!a || a.length < 2 || a[0] !== PCM_MAGIC) return null;
  return { gen: a[1], pcm: a.subarray(2) };
}

const definition: WidgetDefinition<Props> = {
  description:
    "Spotify player in Spotify's look (EvolSpace's own Spotify client: the spotify source runs go-librespot as Connect device 'EvolSpace' and the " +
    'music plays in this client). Now playing with album art, like, seek, shuffle/prev/play/next/repeat, volume; Your Library: playlists, Liked ' +
    "Songs, search results (search: channel_set spotify.request {cmd:'search', query}); tap to open / play. Shows the spotify.com/pair code to sign in.",
  version: '1.0.0',
  props: {
    prefix: { type: 'string', default: 'spotify', description: 'Channel prefix of the spotify source.' },
    width: { type: 'number', default: 0.66, min: 0.4, max: 2, step: 0.01, description: 'Card width (m).' },
    textSize: { type: 'number', default: 0.011, min: 0.006, max: 0.03, step: 0.0005, description: "Text em height (m) = Spotify's 14 px; the layout scales with it." },
    tab: { type: 'enum', options: ['playlists', 'liked', 'search'], default: 'playlists', description: 'Library tab.' },
  },
  outputs: { playing: { type: 'json', description: 'The track now playing ({uri, name, artists, album}) when it changes.' } },
  interactions: [dragBinding('spotify-drag', 'drag')],
  size: [0.66, 0.42, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const Z = { content: 0.001, over: 0.002, text: 0.003 };
    const subInt = hexToInt(SP.sub), greenInt = hexToInt(SP.green);

    // ---- state
    let st: State | null = null;
    let lastTrack = '';
    let lastPaused: boolean | undefined;
    let search: { query: string; at: number; tracks: Item[]; albums: Item[]; artists: Item[]; playlists: Item[] } | null = null;
    let seenSearchAt = 0;
    let lib: Item[] = [];
    let open: { uri: string; name: string; items: Item[] | null; error?: string } | null = null; // a playlist/album opened from the list
    let liked: Item[] | null = null;
    let loading = false;
    let nonce = 0;
    let pendingNonce = 0;
    let dirty = true;
    let progressDirty = true;
    let clock = 0;
    let lastProgress = -1;
    let dragSeek: number | null = null; // ms while dragging the progress bar
    let dragVol: number | null = null;
    let optimisticPaused: { v: boolean; until: number } | null = null;
    /** Generation of the last chunk played, and (after this client jumped) the one to wait past. */
    let lastGen = -1;
    let awaitGen: { from: number; until: number } | null = null;
    /** A skip / play / seek from here: silence at once and ignore the old position's audio still in flight. */
    function jumped(): void {
      player?.flush();
      if (lastGen >= 0) awaitGen = { from: lastGen, until: Date.now() + 8000 }; // the source sends nothing until the new track plays
    }
    /** Where the user just seeked/skipped to, shown until the source reports the new position. */
    let optimisticPos: { pos: number; at: number; uri: string } | null = null;
    function shownPosition(): number {
      if (optimisticPos) {
        const expected = optimisticPos.pos + (pausedNow() ? 0 : Date.now() - optimisticPos.at);
        // Confirmed once a state newer than the seek reports (about) the new position — a refresh that
        // raced the seek and still shows the old position doesn't count.
        const confirmed = !!st?.positionAt && st.positionAt >= optimisticPos.at && st.track?.uri === optimisticPos.uri
          && Math.abs(positionNow(st) - expected) < 2500;
        if (confirmed || Date.now() - optimisticPos.at > 4000) optimisticPos = null;
        else return expected;
      }
      return positionNow(st);
    }
    /** The track the user just switched to, shown until the source reports it (or a little while passes). */
    let optimisticTrack: { track: Track; at: number } | null = null;
    /** The last track shown: kept while the player loads the next one (instead of "Nothing playing"). */
    let lastShown: Track | null = null;
    function shownTrack(): Track | undefined {
      if (optimisticTrack) {
        if (st?.track?.uri === optimisticTrack.track.uri || Date.now() - optimisticTrack.at > 8000) optimisticTrack = null;
        else return optimisticTrack.track;
      }
      if (st?.track) lastShown = st.track;
      else if (st?.stopped) lastShown = null;
      return st?.track ?? lastShown ?? undefined;
    }
    /** Switch the player display to `track` right away (position 0). */
    function switchTo(track: Track | undefined): void {
      if (!track) return;
      optimisticTrack = { track, at: Date.now() };
      optimisticPos = { pos: 0, at: Date.now(), uri: track.uri };
      dirty = true;
      progressDirty = true;
    }
    let optimisticLiked: { uri: string; v: boolean; until: number } | null = null;
    const listScroll = new SmoothScroll();

    // ---- audio output: one client plays
    let output = '';
    let player: PcmPlayer | null = null;
    let offAudio: (() => void) | null = null;
    const canPlay = !ctx.isMirror && typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function';
    const me = () => ctx.client.id;
    /** Paused as far as this widget knows: the user's own tap counts before the source confirms it. */
    function pausedNow(): boolean {
      if (optimisticPaused && optimisticPaused.until > Date.now()) return optimisticPaused.v;
      return !!(st?.paused || st?.stopped);
    }
    /** The like button's state: the user's own tap counts until the source confirms it. */
    function likedNow(): boolean {
      const uri = st?.track?.uri;
      if (optimisticLiked && optimisticLiked.uri === uri && optimisticLiked.until > Date.now()) return optimisticLiked.v;
      return !!st?.liked;
    }
    function claimOutput(): void {
      if (ctx.isMirror || !me() || output === me()) return;
      output = me()!;
      ctx.channels.publish(`${prefix()}.output`, { client: output, at: Date.now() });
      syncAudio();
    }
    function syncAudio(): void {
      const want = canPlay && !!me() && output === me();
      if (want && !offAudio) {
        player ??= new PcmPlayer();
        let initial = true; // the channel's cached last chunk arrives synchronously: stale
        offAudio = ctx.channels.subscribe(`${prefix()}.audio.stream`, (v) => {
          // Chunks still in flight when playback pauses must not play after the pause.
          if (initial || pausedNow()) return;
          const c = chunkOf(v);
          if (!c) return;
          // After a skip / seek: drop audio from before the jump until the new generation arrives.
          if (awaitGen && Date.now() < awaitGen.until) {
            if (c.gen === awaitGen.from) return;
            awaitGen = null;
          }
          lastGen = c.gen;
          player?.push(c.pcm);
        });
        initial = false;
      } else if (!want && offAudio) {
        offAudio();
        offAudio = null;
        player?.flush();
      }
      dirty = true;
    }

    // ---- textures (album art)
    const textures = new Map<string, THREE.Texture>();
    const canLoad = typeof document !== 'undefined';
    let placeholder: THREE.Texture | null = null;
    function placeholderTex(): THREE.Texture {
      if (!placeholder) {
        placeholder = new T.DataTexture(new Uint8Array([40, 40, 40, 255]), 1, 1);
        placeholder.needsUpdate = true;
      }
      return placeholder;
    }
    function tex(src: string | undefined): THREE.Texture | null {
      if (!src || !canLoad) return null;
      let t = textures.get(src);
      if (!t) {
        t = new T.TextureLoader().load(src, (x) => { x.userData.loaded = true; dirty = true; });
        t.colorSpace = T.SRGBColorSpace;
        textures.set(src, t);
      }
      return t.userData.loaded ? t : null;
    }
    function setMap(mat: THREE.MeshBasicMaterial, src: string | undefined): void {
      const t = tex(src) ?? placeholderTex();
      if (mat.map !== t) mat.map = t;
    }

    // ---- built parts
    /** Pooled list rows; item i always uses slot i % slots, so it keeps its texts while in view (no re-layout flicker). */
    interface Row { g: THREE.Group; art: THREE.Mesh; artMat: THREE.MeshBasicMaterial; icon: THREE.Mesh; name: Text; sub: Text; dur: Text; idx: number; key: string; sync: TextSync; hold: boolean }
    let group: THREE.Group | null = null;
    const N: Record<string, THREE.Object3D> = {};
    let artMat: THREE.MeshBasicMaterial | null = null;
    let title: Text | null = null, artists: Text | null = null, tCur: Text | null = null, tDur: Text | null = null, outText: Text | null = null;
    let barFill: THREE.Mesh | null = null, knob: THREE.Mesh | null = null, volFill: THREE.Mesh | null = null, volKnob: THREE.Mesh | null = null;
    let likeFill: THREE.Mesh | null = null;
    let playIcon: THREE.Mesh | null = null, shuffleIcon: THREE.Mesh | null = null, repeatIcon: THREE.Mesh | null = null, likeIcon: THREE.Mesh | null = null;
    let libTitle: Text | null = null, libBack: THREE.Mesh | null = null, libPlay: THREE.Mesh | null = null, libEmpty: Text | null = null;
    const chips: Array<{ key: string; plate: THREE.Mesh; mat: THREE.MeshBasicMaterial; text: Text }> = [];
    const rows: Row[] = [];
    let loginGroup: THREE.Group | null = null, loginCode: Text | null = null, loginHint: Text | null = null;
    let view: ScrollViewport | null = null;
    let main: THREE.Group | null = null; // everything but the sign-in overlay
    let L = layout();

    function layout() {
      const s = ctx.props.textSize, P = s / 14, w = ctx.props.width;
      const pad = 16 * P;
      const leftW = 268 * P; // now playing column
      const artS = leftW - 2 * pad;
      const h = pad + artS + 14 * P + 22 * P + 20 * P + 18 * P + 4 * P + 18 * P + 10 * P + 40 * P + 12 * P + 16 * P + 20 * P + pad;
      const top = h / 2, x0 = -w / 2;
      const libX0 = x0 + leftW + 8 * P, libX1 = w / 2 - 8 * P;
      const rowH = 56 * P;
      const listTop = top - 8 * P - 44 * P - 40 * P; // under the library header + chips
      const listBottom = -h / 2 + 8 * P;
      return { s, P, w, h, top, x0, pad, leftW, artS, libX0, libX1, rowH, listTop, listBottom, n: Math.max(3, Math.floor((listTop - listBottom) / rowH)) };
    }

    const prefix = () => ctx.props.prefix.trim() || 'spotify';
    const plane = (color: string, w: number, h: number, x: number, y: number, z: number) => {
      const m = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, color));
      m.scale.set(w, h, 1);
      m.position.set(x, y, z);
      m.raycast = () => {};
      return m;
    };
    const hit = (name: string, w: number, h: number, x: number, y: number) => {
      const m = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      m.scale.set(w, h, 0.01);
      m.position.set(x, y, 0.004);
      m.name = name;
      ctx.interactive(m);
      main!.add(m);
      N[name] = m;
      return m;
    };
    const icon = (name: string, size: number, color: string, x: number, y: number) => {
      const m = makeIcon(ctx, name, { size, color });
      m.position.set(x, y, Z.text);
      m.raycast = () => {};
      return m;
    };

    function build(): void {
      if (group) disposeTree(group);
      rows.length = 0;
      chips.length = 0;
      L = layout();
      const { P, pad } = L;
      const root = (group = new T.Group());
      root.add(ctx.ui.panel(L.w, L.h, { color: SP.black, radius: 10 * P }));
      const g = (main = new T.Group());
      root.add(g);

      // ---------- now playing (left)
      const cx = L.x0 + L.leftW / 2;
      const left = ctx.ui.panel(L.leftW - 8 * P, L.h - 16 * P, { color: SP.base, radius: 8 * P });
      left.position.set(L.x0 + 4 * P + (L.leftW - 8 * P) / 2, 0, Z.content * 0.5);
      left.raycast = () => {};
      g.add(left);
      let y = L.top - pad;
      artMat = new T.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex() });
      const art = new T.Mesh(sharedGeometry(T, 'plane'), artMat);
      art.scale.set(L.artS, L.artS, 1);
      art.position.set(cx, y - L.artS / 2, Z.content);
      art.raycast = () => {};
      g.add(art);
      y -= L.artS + 14 * P;
      const tx = L.x0 + pad;
      title = makeText(ctx, '', { size: 18 * P, anchorX: 'left', anchorY: 'top', color: SP.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(tx, y, Z.text);
      likeIcon = icon('heart', 18 * P, SP.sub, L.x0 + L.leftW - pad - 9 * P, y - 11 * P);
      // Spotify's liked heart is filled: a heart shape under the outline icon, shown when liked.
      const hs = new T.Shape();
      hs.moveTo(0, -0.42);
      hs.bezierCurveTo(-0.08, -0.34, -0.5, -0.06, -0.5, 0.16);
      hs.bezierCurveTo(-0.5, 0.38, -0.3, 0.46, -0.18, 0.46);
      hs.bezierCurveTo(-0.08, 0.46, -0.02, 0.4, 0, 0.32);
      hs.bezierCurveTo(0.02, 0.4, 0.08, 0.46, 0.18, 0.46);
      hs.bezierCurveTo(0.3, 0.46, 0.5, 0.38, 0.5, 0.16);
      hs.bezierCurveTo(0.5, -0.06, 0.08, -0.34, 0, -0.42);
      likeFill = new T.Mesh(new T.ShapeGeometry(hs, 12), ownMaterial(T, SP.green));
      likeFill.scale.setScalar(17 * P);
      likeFill.position.set(likeIcon.position.x, likeIcon.position.y - 0.4 * P, Z.over);
      likeFill.raycast = () => {};
      likeFill.visible = false;
      g.add(likeFill);
      hit('like', 28 * P, 28 * P, likeIcon.position.x, likeIcon.position.y);
      y -= 22 * P + 2 * P;
      artists = makeText(ctx, '', { size: 14 * P, anchorX: 'left', anchorY: 'top', color: SP.sub, whiteSpace: 'nowrap' });
      artists.position.set(tx, y, Z.text);
      g.add(title, artists, likeIcon);
      y -= 20 * P + 14 * P;
      // progress
      const barW = L.artS;
      g.add(plane(SP.track, barW, 4 * P, cx, y, Z.content));
      barFill = plane(SP.text, 0.0001, 4 * P, tx, y, Z.over);
      knob = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, SP.text));
      knob.scale.setScalar(12 * P);
      knob.position.set(tx, y, Z.text);
      knob.raycast = () => {};
      g.add(barFill, knob);
      hit('progress', barW + 12 * P, 20 * P, cx, y);
      y -= 14 * P;
      tCur = makeText(ctx, '0:00', { size: 11 * P, anchorX: 'left', anchorY: 'middle', color: SP.sub });
      tCur.position.set(tx, y, Z.text);
      tDur = makeText(ctx, '0:00', { size: 11 * P, anchorX: 'right', anchorY: 'middle', color: SP.sub });
      tDur.position.set(tx + barW, y, Z.text);
      g.add(tCur, tDur);
      y -= 10 * P + 20 * P;
      // controls
      const gap = 48 * P;
      shuffleIcon = icon('shuffle', 18 * P, SP.sub, cx - 2 * gap, y);
      g.add(shuffleIcon, icon('skip-back', 20 * P, SP.sub, cx - gap, y));
      const playDisc = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, SP.text));
      playDisc.scale.setScalar(40 * P);
      playDisc.position.set(cx, y, Z.content);
      playDisc.raycast = () => {};
      playIcon = icon('play', 18 * P, SP.black, cx, y);
      repeatIcon = icon('repeat', 18 * P, SP.sub, cx + 2 * gap, y);
      g.add(playDisc, playIcon, icon('skip-forward', 20 * P, SP.sub, cx + gap, y), repeatIcon);
      hit('shuffle', 36 * P, 36 * P, cx - 2 * gap, y);
      hit('prev', 36 * P, 36 * P, cx - gap, y);
      hit('play', 44 * P, 44 * P, cx, y);
      hit('next', 36 * P, 36 * P, cx + gap, y);
      hit('repeat', 36 * P, 36 * P, cx + 2 * gap, y);
      y -= 20 * P + 12 * P + 8 * P;
      // volume + output
      g.add(icon('volume-2', 16 * P, SP.sub, tx + 8 * P, y));
      const vx0 = tx + 26 * P, vw = 110 * P;
      g.add(plane(SP.track, vw, 4 * P, vx0 + vw / 2, y, Z.content));
      volFill = plane(SP.text, 0.0001, 4 * P, vx0, y, Z.over);
      volKnob = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, SP.text));
      volKnob.scale.setScalar(10 * P);
      volKnob.position.set(vx0, y, Z.text);
      volKnob.raycast = () => {};
      g.add(volFill, volKnob);
      hit('volume', vw + 10 * P, 20 * P, vx0 + vw / 2, y);
      N.volume.userData = { x0: vx0, w: vw };
      N.progress.userData = { x0: tx, w: barW };
      outText = makeText(ctx, '', { size: 11 * P, anchorX: 'right', anchorY: 'middle', color: SP.sub, whiteSpace: 'nowrap' });
      outText.position.set(L.x0 + L.leftW - pad, y, Z.text);
      g.add(outText);

      // ---------- your library (right)
      const right = ctx.ui.panel(L.libX1 - L.libX0, L.h - 16 * P, { color: SP.base, radius: 8 * P });
      right.position.set((L.libX0 + L.libX1) / 2, 0, Z.content * 0.5);
      right.raycast = () => {};
      g.add(right);
      const hy = L.top - 8 * P - 22 * P;
      libBack = ctx.ui.panel(28 * P, 28 * P, { color: SP.raised, radius: 14 * P });
      libBack.position.set(L.libX0 + 16 * P + 14 * P, hy, Z.content);
      libBack.raycast = () => {};
      const chev = icon('chevron-left', 16 * P, SP.text, 0, 0);
      chev.position.z = Z.text - Z.content;
      libBack.add(chev);
      g.add(libBack);
      hit('back', 32 * P, 32 * P, libBack.position.x, hy);
      libTitle = makeText(ctx, 'Your Library', { size: 16 * P, anchorX: 'left', anchorY: 'middle', color: SP.text, weight: 'semibold', whiteSpace: 'nowrap' });
      libTitle.position.set(L.libX0 + 16 * P, hy, Z.text);
      g.add(libTitle);
      // green play button for an opened playlist / album
      const pd = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, SP.green));
      pd.scale.setScalar(36 * P);
      pd.raycast = () => {};
      libPlay = new T.Mesh(); // container
      libPlay.add(pd, icon('play', 16 * P, SP.black, 0, 0));
      libPlay.position.set(L.libX1 - 16 * P - 18 * P, hy, Z.content);
      g.add(libPlay);
      hit('playctx', 40 * P, 40 * P, libPlay.position.x, hy);
      // chips
      let chipX = L.libX0 + 16 * P;
      const cy = L.top - 8 * P - 44 * P - 16 * P;
      for (const [key, label] of [['playlists', 'Playlists'], ['liked', 'Liked Songs'], ['search', 'Search']] as const) {
        const w = (label.length * 7.4 + 24) * P;
        const mat = ownMaterial(T, SP.chip);
        const plate = ctx.ui.panel(w, 32 * P, { color: SP.chip, radius: 16 * P });
        plate.material = mat; // own: recolored when selected
        plate.position.set(chipX + w / 2, cy, Z.content);
        plate.raycast = () => {};
        const text = makeText(ctx, label, { size: 13 * P, anchorX: 'center', anchorY: 'middle', color: SP.text, whiteSpace: 'nowrap' });
        text.position.set(chipX + w / 2, cy, Z.text);
        g.add(plate, text);
        hit(`tab:${key}`, w, 32 * P, chipX + w / 2, cy);
        chips.push({ key, plate, mat, text });
        chipX += w + 8 * P;
      }
      libEmpty = makeText(ctx, '', { size: 13 * P, anchorX: 'center', anchorY: 'middle', color: SP.sub, maxWidth: L.libX1 - L.libX0 - 48 * P, textAlign: 'center' });
      libEmpty.position.set((L.libX0 + L.libX1) / 2, (L.listTop + L.listBottom) / 2, Z.text);
      g.add(libEmpty);
      // list rows (+1 spare: partial rows while scrolling)
      view = new ScrollViewport(T, g, L.listBottom, L.listTop);
      const rx = L.libX0 + 12 * P;
      for (let r = 0; r <= L.n; r++) {
        const rg = new T.Group();
        const am = new T.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex() });
        const a = new T.Mesh(sharedGeometry(T, 'plane'), am);
        a.scale.set(44 * P, 44 * P, 1);
        a.position.set(rx + 22 * P, 0, Z.content);
        a.raycast = () => {};
        const ic = icon('music', 18 * P, SP.sub, rx + 22 * P, 0);
        const name = makeText(ctx, '', { size: 15 * P, anchorX: 'left', anchorY: 'bottom', color: SP.text, whiteSpace: 'nowrap' });
        name.position.set(rx + 56 * P, 1 * P, Z.text);
        const sub = makeText(ctx, '', { size: 13 * P, anchorX: 'left', anchorY: 'top', color: SP.sub, whiteSpace: 'nowrap' });
        sub.position.set(rx + 56 * P, -3 * P, Z.text);
        const dur = makeText(ctx, '', { size: 13 * P, anchorX: 'right', anchorY: 'middle', color: SP.sub, whiteSpace: 'nowrap' });
        dur.position.set(L.libX1 - 20 * P, 0, Z.text);
        const h = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        h.scale.set(L.libX1 - L.libX0 - 16 * P, L.rowH, 0.01);
        h.position.set((L.libX0 + L.libX1) / 2, 0, 0.004);
        h.name = `row:${r}`;
        ctx.interactive(h);
        rg.add(a, ic, name, sub, dur, h);
        rg.visible = false;
        g.add(rg);
        view.add(rg);
        rows.push({ g: rg, art: a, artMat: am, icon: ic, name, sub, dur, idx: -1, key: '', sync: new TextSync(), hold: false });
      }

      // ---------- sign-in overlay
      loginGroup = new T.Group();
      const ov = ctx.ui.panel(L.w, L.h, { color: SP.base, radius: 10 * P });
      ov.position.z = 0.006;
      ov.raycast = () => {};
      const head = makeText(ctx, 'Link Spotify to EvolSpace', { size: 22 * P, anchorX: 'center', anchorY: 'middle', color: SP.text, weight: 'semibold' });
      head.position.set(0, 70 * P, 0.007);
      loginHint = makeText(ctx, '', { size: 14 * P, anchorX: 'center', anchorY: 'middle', color: SP.sub, maxWidth: L.w * 0.8, textAlign: 'center' });
      loginHint.position.set(0, 30 * P, 0.007);
      loginCode = makeText(ctx, '', { size: 40 * P, anchorX: 'center', anchorY: 'middle', color: SP.green, weight: 'semibold', font: 'mono' });
      loginCode.position.set(0, -30 * P, 0.007);
      loginGroup.add(ov, head, loginHint, loginCode);
      loginGroup.visible = false;
      root.add(loginGroup);

      ctx.root.add(root);
      dirty = true;
      progressDirty = true;
    }

    // ---- data
    const replyChannel = () => `${prefix()}.view.${ctx.entityId}`;
    function request(v: Record<string, unknown>): void {
      if (!ctx.isMirror) ctx.channels.publish(`${prefix()}.request`, v);
    }
    function loadLibrary(): void {
      if (st?.auth !== 'ready') return;
      pendingNonce = ++nonce;
      loading = true;
      request({ cmd: 'library', reply: replyChannel(), nonce: pendingNonce });
    }
    function loadTracks(uri: string): void {
      pendingNonce = ++nonce;
      loading = true;
      request({ cmd: 'tracks', uri, reply: replyChannel(), nonce: pendingNonce });
    }

    const subs: Array<() => void> = [];
    function subscribe(): void {
      for (const off of subs.splice(0)) off();
      subs.push(ctx.channels.subscribe(`${prefix()}.state`, (v) => {
        const was = st?.auth;
        st = v && typeof v === 'object' ? (v as State) : null;
        if (st?.auth === 'ready' && was !== 'ready' && !lib.length) loadLibrary();
        const uri = st?.track?.uri ?? '';
        // Paused or another track: drop the buffered audio so the change is heard at once.
        if (player && (uri !== lastTrack || (st?.paused && !lastPaused))) player.flush();
        if (uri !== lastTrack && st?.track) ctx.emit('playing', { uri, name: st.track.name, artists: st.track.artists, album: st.track.album });
        lastTrack = uri;
        lastPaused = st?.paused;
        // The source caught up with the tap (a stale state from before it must not undo it).
        if (optimisticPaused && !!(st?.paused || st?.stopped) === optimisticPaused.v) optimisticPaused = null;
        dirty = true;
        progressDirty = true;
      }));
      subs.push(ctx.channels.subscribe(`${prefix()}.search`, (v) => {
        const o = v && typeof v === 'object' ? (v as NonNullable<typeof search>) : null;
        if (!o) return;
        search = o;
        if (o.at > seenSearchAt) {
          seenSearchAt = o.at;
          if (ctx.props.tab !== 'search') { ctx.setProps({ tab: 'search' }); open = null; listScroll.scrollTo(0, false); }
        }
        dirty = true;
      }));
      subs.push(ctx.channels.subscribe(replyChannel(), (v) => {
        const o = (v && typeof v === 'object' ? v : {}) as { nonce?: number; kind?: string; uri?: string; name?: string; items?: Item[]; error?: string };
        if (o.nonce !== pendingNonce) return;
        loading = false;
        const items = Array.isArray(o.items) ? o.items : [];
        if (o.kind === 'library') lib = items;
        else if (o.kind === 'tracks') {
          if (o.uri === 'spotify:collection:tracks') liked = items;
          else if (open && open.uri === o.uri) open = { ...open, name: o.name || open.name, items, error: o.error };
        }
        if (o.error && open) open = { ...open, items: [], error: o.error };
        dirty = true;
      }));
      subs.push(ctx.channels.subscribe(`${prefix()}.output`, (v) => {
        const c = str((v as { client?: unknown } | null)?.client);
        if (c && c !== output) { output = c; syncAudio(); }
      }));
    }

    // ---- render
    function list(): { items: Item[]; empty: string } {
      if (open) return { items: open.items ?? [], empty: open.error ?? (open.items ? 'Nothing here' : 'Loading…') };
      if (ctx.props.tab === 'liked') return { items: liked ?? [], empty: liked ? 'No liked songs yet' : 'Loading…' };
      if (ctx.props.tab === 'search') {
        if (!search) return { items: [], empty: 'Ask Claude to search Spotify, e.g. "search Spotify for Daft Punk"' };
        return { items: [...search.tracks.slice(0, 6), ...search.artists.slice(0, 3), ...search.albums.slice(0, 4), ...search.playlists.slice(0, 4)], empty: 'No results' };
      }
      return { items: lib, empty: loading ? 'Loading…' : st?.auth === 'ready' ? 'No playlists' : '' };
    }

    function render(): void {
      if (!group) return;
      const { P } = L;
      const auth = st?.auth ?? '';
      loginGroup!.visible = auth !== 'ready';
      main!.visible = auth === 'ready';
      if (auth !== 'ready') {
        if (auth === 'login') {
          loginHint!.set('On your phone or computer, go to spotify.com/pair and enter this code (Spotify Premium):');
          loginCode!.set(st?.login?.code ?? '…');
        } else {
          loginHint!.set(!st ? 'Waiting for the spotify source…' : auth === 'installing' ? 'Installing the Spotify player…' : auth === 'error' ? `Spotify: ${st.error ?? 'error'}` : 'Starting Spotify…');
          loginCode!.set('');
        }
        return;
      }
      // now playing
      const t = shownTrack();
      setMap(artMat!, t?.cover);
      title!.set(truncate(t?.name ?? 'Nothing playing', 22));
      artists!.set(truncate(t ? t.artists.join(', ') : st?.contextName || 'Pick something from your library', 34));
      const paused = optimisticPaused && optimisticPaused.until > Date.now() ? optimisticPaused.v : !!(st?.paused || st?.stopped || !t);
      setIcon(T, playIcon!, paused ? 'play' : 'pause');
      (likeIcon!.material as THREE.MeshBasicMaterial).color.set(likedNow() ? SP.green : SP.sub);
      likeFill!.visible = likedNow();
      (shuffleIcon!.material as THREE.MeshBasicMaterial).color.set(st?.shuffle ? SP.green : SP.sub);
      setIcon(T, repeatIcon!, st?.repeatTrack ? 'repeat-1' : 'repeat');
      (repeatIcon!.material as THREE.MeshBasicMaterial).color.set(st?.repeatContext || st?.repeatTrack ? SP.green : SP.sub);
      const vol = dragVol ?? st?.volume ?? 0;
      const vd = N.volume.userData as { x0: number; w: number };
      const vf = Math.max(0.0001, (vd.w * vol) / 100);
      volFill!.scale.x = vf;
      volFill!.position.x = vd.x0 + vf / 2;
      volKnob!.position.x = vd.x0 + (vd.w * vol) / 100;
      outText!.set(!canPlay ? '' : output === me() ? 'Playing here' : 'Tap to play here');
      (outText as unknown as { color: unknown }).color = output === me() ? SP.green : SP.sub;

      // library header + chips
      libBack!.visible = !!open;
      (N.back as THREE.Mesh).visible = !!open;
      libTitle!.position.x = L.libX0 + (open ? 52 : 16) * P;
      libTitle!.set(truncate(open ? open.name || 'Playlist' : 'Your Library', 34));
      libPlay!.visible = !!open || ctx.props.tab === 'liked';
      (N.playctx as THREE.Mesh).visible = libPlay!.visible;
      for (const c of chips) {
        const on = !open && c.key === ctx.props.tab;
        c.mat.color.set(on ? SP.text : SP.chip);
        (c.text as unknown as { color: unknown }).color = on ? SP.black : SP.text;
        c.plate.visible = c.text.visible = !open;
        (N[`tab:${c.key}`] as THREE.Mesh).visible = !open;
      }

      // rows
      const { items, empty } = list();
      libEmpty!.set(items.length ? '' : empty);
      libEmpty!.visible = !items.length;
      listScroll.setMax(items.length - (L.listTop - L.listBottom) / L.rowH);
      const first = Math.floor(listScroll.pos);
      const last = Math.min(items.length - 1, first + L.n);
      const listKey = open ? `o:${open.uri}` : `t:${ctx.props.tab}`;
      for (const row of rows) if (row.idx < first || row.idx > last || !row.key.startsWith(listKey + ':')) { row.g.visible = false; row.idx = -1; row.key = ''; }
      for (let i = first; i <= last; i++) {
        const row = rows[i % rows.length], it = items[i];
        row.g.position.y = L.listTop - (i - listScroll.pos + 0.5) * L.rowH;
        const key = `${listKey}:${i}:${it.uri}`;
        if (row.key !== key) row.hold = true; // entering: hidden until its texts are laid out
        row.idx = i;
        row.key = key;
        row.art.visible = !!it.image;
        row.icon.visible = !row.art.visible;
        if (row.art.visible) setMap(row.artMat, it.image);
        else setIcon(T, row.icon, it.kind === 'collection' ? 'heart' : it.kind === 'artist' ? 'users' : it.kind === 'album' ? 'disc-3' : it.kind === 'playlist' ? 'library' : 'music');
        const playing = !!t && (it.uri === t.uri || it.uri === st?.contextUri);
        row.sync.set(row.name, truncate(it.name, 38));
        (row.name as unknown as { color: unknown }).color = playing ? SP.green : SP.text;
        row.sync.set(row.sub, truncate(it.sub, 46));
        row.sync.set(row.dur, it.duration ? fmtTime(it.duration) : '');
        // A row taking a new item shows once its text is laid out (never the previous item's words).
        if (row.sync.ready()) row.hold = false;
        else dirty = true;
        row.g.visible = !row.hold;
      }
      view!.update();
      progressDirty = true;
    }

    function renderProgress(): void {
      if (!group || st?.auth !== 'ready') return;
      const t = shownTrack();
      const d = N.progress.userData as { x0: number; w: number };
      const dur = t?.duration ?? 0;
      const pos = dragSeek ?? shownPosition();
      const f = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
      barFill!.scale.x = Math.max(0.0001, d.w * f);
      barFill!.position.x = d.x0 + (d.w * f) / 2;
      knob!.position.x = d.x0 + d.w * f;
      tCur!.set(fmtTime(pos));
      tDur!.set(fmtTime(dur));
    }

    // ---- interaction
    let drag: { hand: string; part: string; y0: number; x0: number; moved: boolean; gliding: boolean } | null = null;
    const along = (part: string, x: number) => {
      const d = N[part].userData as { x0: number; w: number };
      return Math.max(0, Math.min(1, (x - d.x0) / d.w));
    };

    function tap(part: string): void {
      const t = shownTrack();
      switch (part) {
        case 'play': {
          const paused = !!(st?.paused || st?.stopped);
          optimisticPaused = { v: !paused, until: Date.now() + 1500 };
          request({ cmd: paused ? 'resume' : 'pause' });
          if (!paused) player?.flush();
          break;
        }
        case 'prev':
          // Spotify: "previous" restarts the song unless it just started
          if (shownPosition() > 3000) { if (t) switchTo(t); } else switchTo(st?.prev);
          request({ cmd: 'prev' });
          jumped();
          break;
        case 'next': switchTo(st?.next); request({ cmd: 'next' }); jumped(); break;
        case 'shuffle': request({ cmd: 'shuffle', on: !st?.shuffle }); break;
        case 'repeat': request({ cmd: 'repeat', mode: st?.repeatTrack ? 'off' : st?.repeatContext ? 'track' : 'context' }); break;
        case 'like':
          if (t) {
            const liked = !likedNow();
            optimisticLiked = { uri: t.uri, v: liked, until: Date.now() + 3000 };
            request({ cmd: 'like', uri: t.uri, liked });
          }
          break;
        case 'back': open = null; listScroll.scrollTo(0, false); break;
        case 'playctx': {
          const uri = open?.uri ?? (ctx.props.tab === 'liked' ? 'spotify:collection:tracks' : '');
          if (uri) { request({ cmd: 'play', uri }); jumped(); }
          break;
        }
        default:
          if (part.startsWith('tab:')) {
            const tab = part.slice(4);
            open = null;
            if (tab !== ctx.props.tab) ctx.setProps({ tab });
            listScroll.scrollTo(0, false);
            if (tab === 'liked' && !liked) loadTracks('spotify:collection:tracks');
            if (tab === 'playlists' && !lib.length) loadLibrary();
          } else if (part.startsWith('row:')) {
            const slot = rows[Number(part.slice(4))];
            const it = slot && slot.idx >= 0 ? list().items[slot.idx] : undefined;
            if (!it) break;
            if (it.kind === 'track') {
              // play it within what it was listed in (playlist / album / liked), else its album
              const context = open?.uri ?? (ctx.props.tab === 'liked' ? 'spotify:collection:tracks' : it.context);
              request(context ? { cmd: 'play', uri: context, skipTo: it.uri } : { cmd: 'play', uri: it.uri });
              switchTo({ uri: it.uri, name: it.name, artists: it.sub ? [it.sub] : [], album: '', albumUri: '', cover: it.image, duration: it.duration ?? 0 });
              jumped();
            } else if (it.kind === 'collection') {
              ctx.setProps({ tab: 'liked' });
              if (!liked) loadTracks('spotify:collection:tracks');
              listScroll.scrollTo(0, false);
            } else if (it.kind === 'artist') {
              request({ cmd: 'play', uri: it.uri });
              jumped();
            } else {
              open = { uri: it.uri, name: it.name, items: null };
              listScroll.scrollTo(0, false);
              loadTracks(it.uri);
            }
          }
      }
      dirty = true;
    }

    build();
    subscribe();
    // No client plays yet (first widget anywhere): this one does.
    setTimeout(() => { if (!output) claimOutput(); }, 1500);

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.textSize !== prev.textSize) build();
        if (p.prefix !== prev.prefix) { subscribe(); offAudio?.(); offAudio = null; syncAudio(); }
        dirty = true;
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') return;
        if (e.phase === 'start') {
          if (drag) return;
          claimOutput(); // the client you use plays the audio
          player?.wake();
          drag = { hand: e.hand, part, y0: e.localPoint[1], x0: e.localPoint[0], moved: false, gliding: listScroll.active };
          listScroll.stop();
          if (part === 'progress') { dragSeek = along('progress', e.localPoint[0]) * (st?.track?.duration ?? 0); progressDirty = true; }
          if (part === 'volume') { dragVol = Math.round(along('volume', e.localPoint[0]) * 100); dirty = true; }
          return;
        }
        if (!drag || e.hand !== drag.hand) return;
        if (e.phase === 'move') {
          if (drag.part === 'progress') { dragSeek = along('progress', e.localPoint[0]) * (st?.track?.duration ?? 0); progressDirty = true; return; }
          if (drag.part === 'volume') { dragVol = Math.round(along('volume', e.localPoint[0]) * 100); dirty = true; return; }
          const dy = e.localPoint[1] - drag.y0;
          if (!drag.moved && drag.part.startsWith('row:') && Math.abs(dy) > L.rowH * 0.3) {
            drag.moved = true;
            drag.y0 = e.localPoint[1];
            listScroll.dragStart();
          } else if (drag.moved) listScroll.dragMove(dy / L.rowH);
          return;
        }
        const d = drag;
        drag = null;
        if (d.part === 'progress') {
          if (e.phase === 'end' && dragSeek !== null) {
            request({ cmd: 'seek', position: dragSeek });
            jumped();
            optimisticPos = { pos: dragSeek, at: Date.now(), uri: st?.track?.uri ?? '' };
          }
          dragSeek = null;
          progressDirty = true;
          return;
        }
        if (d.part === 'volume') {
          if (e.phase === 'end' && dragVol !== null) request({ cmd: 'volume', volume: dragVol });
          dragVol = null;
          dirty = true;
          return;
        }
        if (d.moved) { listScroll.dragEnd(e.phase === 'end'); return; }
        if (e.phase === 'end' && !d.gliding) tap(d.part);
      },
      update(dt) {
        clock += dt;
        if (listScroll.step(dt)) dirty = true;
        if (dirty) { dirty = false; render(); }
        else view?.update();
        // progress: a few times a second while playing (and at once after changes)
        if (progressDirty || (st && !st.paused && clock - lastProgress > 0.25)) { progressDirty = false; lastProgress = clock; renderProgress(); }
      },
      dispose() {
        for (const off of subs.splice(0)) off();
        offAudio?.();
        player?.close();
        if (group) disposeTree(group);
        for (const t of textures.values()) t.dispose();
        textures.clear();
        placeholder?.dispose();
      },
    };
  },
};

export default definition;
