// Microphone capture: getUserMedia → AudioWorklet (ScriptProcessor fallback)
// → Float32 blocks on the main thread at the AudioContext's native rate.
//
// The graph is "warmed up" on the first user gesture (permission prompt + audio
// context start), then kept alive so push-to-talk starts instantly and a short
// pre-roll can be prepended. After `idleReleaseMs` without use the mic is
// released (the browser's mic indicator turns off); the next PTT re-acquires it.

export type MicState = 'cold' | 'requesting' | 'ready' | 'denied' | 'unsupported' | 'error';

/** Minimal surface PushToTalk needs (lets tests substitute a fake). */
export interface MicSource {
  readonly state: MicState;
  readonly error: string | undefined;
  /** Native sample rate of delivered blocks (valid once ready). */
  readonly sampleRate: number;
  /** Acquire the mic if needed. Resolves true when blocks are flowing. */
  warmup(): Promise<boolean>;
  /** Called for every captured block while ready. */
  onBlock: ((block: Float32Array) => void) | null;
  /** Mark activity (defers idle release). */
  touch(): void;
}

const WORKLET_NAME = 'evol-capture';
const BLOCK = 1024; // samples per posted block (~21 ms at 48 kHz)
/** Max wait for AudioContext.resume() before carrying on (see acquire()). */
const RESUME_WAIT_MS = 1000;

// Plain JS (runs in AudioWorkletGlobalScope); loaded from a Blob URL so it works
// identically in Vite dev, Vite middleware mode and production builds.
const WORKLET_SOURCE = `
class EvolCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${BLOCK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const k = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k; i += k;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(${BLOCK});
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', EvolCapture);
`;

export interface MicOptions {
  /** Release the device after this long without touch(). 0 = never. Default 5 min. */
  idleReleaseMs?: number;
}

export class MicCapture implements MicSource {
  state: MicState = 'cold';
  error: string | undefined;
  onBlock: ((block: Float32Array) => void) | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private pending: Promise<boolean> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleReleaseMs: number;

  constructor(opts: MicOptions = {}) {
    this.idleReleaseMs = opts.idleReleaseMs ?? 5 * 60_000;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.state = 'unsupported';
      this.error = (globalThis as { isSecureContext?: boolean }).isSecureContext === false
        ? 'Microphone needs a secure context (https or localhost)'
        : 'getUserMedia is not available in this browser';
    }
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.idleReleaseMs > 0 && this.state === 'ready') {
      this.idleTimer = setTimeout(() => this.release(), this.idleReleaseMs);
    }
  }

  warmup(): Promise<boolean> {
    if (this.state === 'unsupported') return Promise.resolve(false);
    if (this.state === 'ready' && this.ctx) {
      // A context can be suspended by the browser (e.g. tab hidden); resume is cheap.
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
      this.touch();
      return Promise.resolve(true);
    }
    if (this.pending) return this.pending;
    this.pending = this.acquire().finally(() => { this.pending = null; });
    return this.pending;
  }

  private resumeOnNextGesture(ctx: AudioContext): void {
    const events = ['pointerdown', 'keydown'] as const;
    const resume = () => {
      for (const e of events) window.removeEventListener(e, resume, true);
      if (this.ctx === ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
    };
    for (const e of events) window.addEventListener(e, resume, true);
  }

  /** Stops the device and tears down the audio graph. */
  release(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    if (this.state === 'ready') this.state = 'cold';
  }

  private async acquire(): Promise<boolean> {
    this.state = 'requesting';
    this.error = undefined;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const name = (e as DOMException)?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.state = 'denied';
        this.error = 'Microphone permission denied — allow the mic for this site in the browser settings';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.state = 'error';
        this.error = 'No microphone found';
      } else {
        this.state = 'error';
        this.error = `Microphone error: ${(e as Error)?.message ?? String(e)}`;
      }
      return false;
    }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      if (ctx.state !== 'running') {
        // Without user activation resume() may stay pending until the next
        // gesture; never block push-to-talk on it. Blocks start flowing once the
        // context runs (the next click / key / pinch resumes it).
        await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
        // (re-read: the state changes asynchronously; TS keeps the earlier narrowing)
        if ((ctx.state as AudioContextState) !== 'running') this.resumeOnNextGesture(ctx);
      }
      const src = ctx.createMediaStreamSource(this.stream);
      const sink = ctx.createGain();
      sink.gain.value = 0; // keep the graph pulled without making sound
      sink.connect(ctx.destination);
      this.nodes = [src, sink];
      if (ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onBlock?.(ev.data);
        src.connect(node).connect(sink);
        this.nodes.push(node);
      } else {
        // Insecure-context / legacy fallback.
        const sp = ctx.createScriptProcessor(BLOCK, 1, 1);
        sp.onaudioprocess = (ev) => this.onBlock?.(new Float32Array(ev.inputBuffer.getChannelData(0)));
        src.connect(sp).connect(sink);
        this.nodes.push(sp);
      }
      // Device unplugged / permission revoked: drop the dead graph so the next
      // push-to-talk re-acquires instead of silently capturing nothing.
      const stream = this.stream;
      for (const t of stream.getAudioTracks()) {
        t.addEventListener('ended', () => { if (this.stream === stream) this.release(); }, { once: true });
      }
      this.state = 'ready';
      this.touch();
      return true;
    } catch (e) {
      this.state = 'error';
      this.error = `Audio pipeline failed: ${(e as Error)?.message ?? String(e)}`;
      this.release();
      this.state = 'error';
      return false;
    }
  }
}
