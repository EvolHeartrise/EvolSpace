// A <video> element + THREE.VideoTexture pair for widgets that show video (previews, players).
// Same-origin sources only (e.g. /media/… from the server): WebGL needs CORS-clean video.
// No DOM (Node tests, server evaluation) → every method is a safe no-op and `available` is false.
//
//   const vs = new VideoSurface(T, { muted: true, loop: true, onChange: () => paint() });
//   vs.load('/media/file-abc.mp4');  mesh.material.map = vs.texture;  vs.aspect, vs.time, vs.duration
//   vs.toggle(); vs.seek(12.5); vs.setMuted(false); vs.unload(); vs.dispose();

import type * as THREE from 'three';

type Three = typeof THREE;

export class VideoSurface {
  readonly available = typeof document !== 'undefined';
  video: HTMLVideoElement | null = null;
  texture: THREE.VideoTexture | null = null;
  src = '';
  /** Width / height once metadata is known (16:9 until then). */
  aspect = 16 / 9;
  /** True once the first frame can be drawn. */
  ready = false;
  /** Autoplay was refused (sound without a user gesture): the caller can show "tap to play". */
  blocked = false;
  error = '';

  constructor(private readonly T: Three, private readonly opts: { muted?: boolean; loop?: boolean; autoplay?: boolean; onChange?: () => void } = {}) {}

  private ensure(): HTMLVideoElement | null {
    if (!this.available) return null;
    if (this.video) return this.video;
    const v = (this.video = document.createElement('video'));
    v.crossOrigin = 'anonymous';
    v.playsInline = true;
    v.preload = 'auto';
    v.muted = this.opts.muted ?? true;
    v.loop = this.opts.loop ?? true;
    const changed = () => this.opts.onChange?.();
    v.addEventListener('loadedmetadata', () => {
      if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
      changed();
    });
    v.addEventListener('loadeddata', () => {
      this.ready = true;
      changed();
      if (this.opts.autoplay ?? true) this.play();
    });
    for (const ev of ['play', 'pause', 'ended', 'volumechange']) v.addEventListener(ev, changed);
    v.addEventListener('error', () => { if (this.src) { this.error = v.error?.message || 'cannot play this video'; changed(); } });
    this.texture = new this.T.VideoTexture(v);
    this.texture.colorSpace = this.T.SRGBColorSpace;
    return v;
  }

  load(src: string): void {
    if (src === this.src) return;
    const v = this.ensure();
    this.src = src;
    this.ready = false;
    this.blocked = false;
    this.error = '';
    this.aspect = 16 / 9;
    if (!v) return;
    v.src = src;
    v.load();
  }

  unload(): void {
    this.src = '';
    this.ready = false;
    this.error = '';
    const v = this.video;
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  play(): void {
    const v = this.video;
    if (!v || !this.src) return;
    v.play().then(() => { this.blocked = false; this.opts.onChange?.(); }).catch(() => {
      // autoplay with sound refused: fall back to muted playback
      if (!v.muted) { v.muted = true; v.play().catch(() => {}); }
      this.blocked = true;
      this.opts.onChange?.();
    });
  }

  pause(): void { this.video?.pause(); }
  toggle(): void { if (this.paused) this.play(); else this.pause(); }

  get paused(): boolean { return !this.video || this.video.paused || this.video.ended; }
  get muted(): boolean { return !this.video || this.video.muted; }
  get time(): number { return this.video?.currentTime ?? 0; }
  get duration(): number { const d = this.video?.duration ?? NaN; return Number.isFinite(d) ? d : 0; }

  setMuted(m: boolean): void {
    const v = this.video;
    if (!v) return;
    v.muted = m;
    if (!m) { this.blocked = false; if (v.paused) this.play(); }
  }

  seek(t: number): void {
    const v = this.video;
    if (!v || !this.duration) return;
    v.currentTime = Math.min(Math.max(0, t), this.duration);
    this.opts.onChange?.();
  }

  dispose(): void {
    this.unload();
    this.texture?.dispose();
    this.texture = null;
    this.video = null;
  }
}

/** "1:05" / "1:02:05". */
export function clockLabel(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
