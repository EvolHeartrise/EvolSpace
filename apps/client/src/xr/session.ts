// WebXR session lifecycle for the Quest 3: request immersive-vr / immersive-ar
// with hand tracking + anchors, hand the session to three.js, tune frame rate,
// foveation and framebuffer scale, and switch modes on demand.
//
// Mode switches need transient user activation (requestSession is gated by it).
// A switch requested without activation (voice command, server broadcast) is
// parked as `pendingMode` and completed on the next XR 'select' (a pinch on
// Quest) or page click, both of which grant activation.

import type * as THREE from 'three';

export type XrMode = 'vr' | 'ar';

export interface XrQuality {
  /** WebXR framebuffer scale (1 = runtime-recommended size). */
  framebufferScale: number;
  /** Fixed foveation 0..1 (higher = more aggressive, cheaper). */
  foveation: number;
  /** Preferred display refresh rate (Hz); nearest supported rate is used. */
  frameRate: number;
}

export const DEFAULT_QUALITY: XrQuality = { framebufferScale: 1.0, foveation: 0.5, frameRate: 90 };

export interface XrSessionEvents {
  onStart(session: XRSession, mode: XrMode, refSpace: XRReferenceSpace): void;
  onEnd(mode: XrMode): void;
  /** A switch is waiting for a user gesture (pinch / click). */
  onPending?(mode: XrMode | null): void;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

const SESSION_MODE: Record<XrMode, XRSessionMode> = { vr: 'immersive-vr', ar: 'immersive-ar' };

export class XrSessionManager {
  session: XRSession | null = null;
  mode: XrMode | null = null;
  refSpace: XRReferenceSpace | null = null;
  supported: Record<XrMode, boolean> = { vr: false, ar: false };
  /** Features the current session actually enabled (when the browser reports them). */
  enabledFeatures: ReadonlySet<string> = new Set();
  pendingMode: XrMode | null = null;
  quality: XrQuality;
  private busy = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly events: XrSessionEvents, quality: Partial<XrQuality> = {}) {
    this.quality = { ...DEFAULT_QUALITY, ...defined(quality) };
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    // Complete a parked switch on the next page gesture.
    window.addEventListener('pointerdown', () => { if (this.pendingMode && !this.session) void this.enter(this.pendingMode); }, true);
  }

  /** Queries navigator.xr for VR/AR support. Safe to call repeatedly (e.g. after installing IWER). */
  async detect(): Promise<Record<XrMode, boolean>> {
    const xr = navigator.xr;
    if (!xr) return (this.supported = { vr: false, ar: false });
    const [vr, ar] = await Promise.all([
      xr.isSessionSupported('immersive-vr').catch(() => false),
      xr.isSessionSupported('immersive-ar').catch(() => false),
    ]);
    return (this.supported = { vr, ar });
  }

  get active(): boolean {
    return this.session !== null;
  }

  /** Enter `mode`. Must run inside a user gesture unless an XR session is ending into it (see switchTo). */
  async enter(mode: XrMode): Promise<boolean> {
    if (this.busy) return false;
    if (this.session && this.mode === mode) return true;
    const xr = navigator.xr;
    if (!xr) { this.log('warn', 'WebXR not available'); return false; }
    this.busy = true;
    try {
      if (this.session) await this.endSession();
      const init: XRSessionInit = {
        requiredFeatures: ['local-floor'],
        // Everything else is optional so the app degrades instead of failing to start.
        optionalFeatures: ['hand-tracking', 'anchors', 'hit-test', 'plane-detection'],
      };
      const session = await xr.requestSession(SESSION_MODE[mode], init);
      this.pendingMode = null;
      this.events.onPending?.(null);
      await this.adopt(session, mode);
      return true;
    } catch (e) {
      const err = e as DOMException;
      if (err?.name === 'SecurityError' || /activation|gesture/i.test(err?.message ?? '')) {
        // No user activation: park the request until the next pinch/click.
        this.pendingMode = mode;
        this.events.onPending?.(mode);
        this.log('info', `entering ${mode.toUpperCase()} needs a gesture — pinch or click to continue`);
      } else {
        this.log('error', `requestSession(${mode}) failed: ${err?.message ?? String(e)}`);
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Switch to another mode (or toggle). If we have activation now, do it; otherwise
   * end nothing and park the switch for the next XR select / page click.
   */
  async switchTo(mode: XrMode | 'toggle'): Promise<void> {
    const target: XrMode = mode === 'toggle' ? (this.mode === 'ar' ? 'vr' : 'ar') : mode;
    if (this.session && this.mode === target) return;
    if (!this.supported[target]) { this.log('warn', `${target.toUpperCase()} is not supported on this device`); return; }
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    if (activation && !activation.isActive) {
      this.pendingMode = target;
      this.events.onPending?.(target);
      return;
    }
    await this.enter(target);
  }

  async exit(): Promise<void> {
    this.pendingMode = null;
    if (this.session) await this.endSession();
  }

  setQuality(q: Partial<XrQuality>): void {
    this.quality = { ...this.quality, ...defined(q) };
    // Framebuffer scale only applies to the next session; foveation applies live.
    if (this.session) this.renderer.xr.setFoveation(this.quality.foveation);
  }

  private async adopt(session: XRSession, mode: XrMode): Promise<void> {
    const xr = this.renderer.xr;
    xr.setFramebufferScaleFactor(this.quality.framebufferScale);
    await xr.setSession(session);
    xr.setFoveation(this.quality.foveation);
    this.session = session;
    this.mode = mode;
    this.refSpace = xr.getReferenceSpace();
    this.enabledFeatures = new Set((session as { enabledFeatures?: string[] }).enabledFeatures ?? []);
    void this.tuneFrameRate(session);

    // A pinch on Quest emits 'select' with user activation: finish parked switches there.
    session.addEventListener('select', () => {
      const m = this.pendingMode;
      if (m && m !== this.mode) void this.enter(m);
    });
    session.addEventListener('end', () => {
      if (this.session !== session) return;
      this.session = null;
      this.refSpace = null;
      const prev = this.mode!;
      this.mode = null;
      this.events.onEnd(prev);
    }, { once: true });

    this.events.onStart(session, mode, this.refSpace!);
  }

  private async tuneFrameRate(session: XRSession): Promise<void> {
    const rates = session.supportedFrameRates;
    if (!rates?.length || !session.updateTargetFrameRate) return;
    const want = this.quality.frameRate;
    const best = Array.from(rates).reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    try {
      await session.updateTargetFrameRate(best);
    } catch (e) {
      this.log('warn', `updateTargetFrameRate(${best}) failed: ${(e as Error).message}`);
    }
  }

  private async endSession(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const ended = new Promise<void>((r) => s.addEventListener('end', () => r(), { once: true }));
    try { await s.end(); } catch { /* already ending */ }
    await ended;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.events.log?.(level, message);
  }
}

/** Drops undefined fields so they don't override defaults when spread. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
