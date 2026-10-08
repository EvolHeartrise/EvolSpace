// Push-to-talk: the 'voice.ptt' command (start/end phases) streams microphone
// audio to the server as 16 kHz PCM16 AudioFrames (~100 ms each) between
// voice.begin and voice.end. Deictic context (focus/gaze/selection) is captured
// at the moment PTT starts so "make *this* bigger" refers to what the user was
// pointing at when they began speaking.

import { encodeAudioFrame, type ClientMessage, type VoiceContext } from '@evolspace/protocol';
import { Resampler, floatToPcm16, PcmChunker, PreRoll } from './resampler.ts';
import type { MicSource } from './mic.ts';

export const STT_RATE = 16000;
/** 100 ms frames at 16 kHz. */
export const FRAME_SAMPLES = 1600;

export type VoiceUiState = 'idle' | 'listening' | 'error';

export interface PttDeps {
  net: { send(m: ClientMessage): void; sendBinary(b: Uint8Array): void };
  mic: MicSource;
  /** Deictic context snapshot at PTT start. */
  context(): VoiceContext;
  /** Reflect state in the HUD (listening indicator / error toast). */
  ui(state: VoiceUiState, detail?: string): void;
  /** Input level 0..1 per captured block while listening (HUD meter). */
  level?(v: number): void;
  /** Whether the server connection is up (audio is dropped while offline). Default: always true. */
  connected?(): boolean;
  newId?(): string;
  now?(): number;
}

export interface PttOptions {
  /** Audio kept from before the PTT gesture (ms). Default 250. */
  prerollMs?: number;
  /** Utterances shorter than this are sent as cancelled (accidental pinches). Default 200. */
  minMs?: number;
  /** Safety cap; PTT auto-ends after this long. Default 60 s. */
  maxMs?: number;
}

type Phase = 'idle' | 'starting' | 'capturing';

export class PushToTalk {
  private phase: Phase = 'idle';
  private utteranceId = '';
  private startedAt = 0;
  private endRequested = false;
  private resampler: Resampler | null = null;
  private chunker: PcmChunker | null = null;
  private preroll: PreRoll;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<PttOptions>;
  /** Count of frames sent in the current utterance (diagnostics/tests). */
  framesSent = 0;

  constructor(private readonly deps: PttDeps, opts: PttOptions = {}) {
    this.opts = { prerollMs: 250, minMs: 200, maxMs: 60_000, ...opts };
    this.preroll = new PreRoll(0);
    deps.mic.onBlock = (b) => this.onBlock(b);
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  get currentUtterance(): string | null {
    return this.phase === 'idle' ? null : this.utteranceId;
  }

  /** Acquire the mic early (call from a user gesture) so the first PTT is instant. */
  warmup(): Promise<boolean> {
    return this.deps.mic.warmup().then((ok) => {
      const size = Math.round((this.deps.mic.sampleRate * this.opts.prerollMs) / 1000);
      // Keep the existing buffer (and its audio) unless the rate changed.
      if (ok && this.preroll.maxSamples !== size) this.preroll = new PreRoll(size);
      return ok;
    });
  }

  /** Command handler: 'voice.ptt' with phase start|end. */
  handle(phase: 'start' | 'end'): void {
    if (phase === 'start') void this.start();
    else this.end(false);
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'starting';
    this.endRequested = false;
    const context = this.deps.context();
    const ok = await this.warmup();
    if (!ok) {
      this.phase = 'idle';
      this.deps.ui('error', this.deps.mic.error ?? 'Microphone unavailable');
      return;
    }
    if (this.endRequested) {
      // Released before the mic came up (e.g. while the permission prompt was open).
      this.phase = 'idle';
      this.preroll.clear();
      this.deps.ui('idle');
      return;
    }
    if (this.deps.connected && !this.deps.connected()) {
      // Audio and voice.* are not queued while offline: don't pretend to listen.
      this.phase = 'idle';
      this.preroll.clear();
      this.deps.ui('error', 'Not connected to the EvolSpace server — voice is unavailable');
      return;
    }
    this.utteranceId = this.deps.newId?.() ?? newUtteranceId();
    this.startedAt = this.now();
    this.framesSent = 0;
    this.resampler = new Resampler(this.deps.mic.sampleRate, STT_RATE);
    this.chunker = new PcmChunker(FRAME_SAMPLES, (pcm) => this.sendFrame(pcm));
    this.deps.net.send({ type: 'voice.begin', utteranceId: this.utteranceId, sampleRate: STT_RATE, context });
    this.phase = 'capturing';
    this.deps.ui('listening');
    const pre = this.preroll.take();
    if (pre.length) this.feed(pre);
    this.maxTimer = setTimeout(() => this.end(false), this.opts.maxMs);
  }

  /** Ends the utterance. `cancel` discards it on the server. */
  end(cancel: boolean): void {
    if (this.phase === 'starting') { this.endRequested = true; return; }
    if (this.phase !== 'capturing') return;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    const tooShort = this.now() - this.startedAt < this.opts.minMs;
    const cancelled = cancel || tooShort;
    if (!cancelled && this.resampler && this.chunker) {
      this.chunker.push(floatToPcm16(this.resampler.flush()));
      this.chunker.flush();
    }
    this.deps.net.send(cancelled
      ? { type: 'voice.end', utteranceId: this.utteranceId, cancelled: true }
      : { type: 'voice.end', utteranceId: this.utteranceId });
    this.resampler = null;
    this.chunker = null;
    this.phase = 'idle';
    this.deps.mic.touch();
    this.deps.ui('idle', cancelled ? 'cancelled' : undefined);
  }

  /**
   * Abandon the current utterance because of a failure (e.g. the connection
   * dropped): tells the server to discard it (best effort) and reports `reason`.
   * A press still waiting for the mic is cancelled too.
   */
  abort(reason: string): void {
    if (this.phase === 'starting') { this.endRequested = true; return; }
    if (this.phase !== 'capturing') return;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.deps.net.send({ type: 'voice.end', utteranceId: this.utteranceId, cancelled: true });
    this.resampler = null;
    this.chunker = null;
    this.phase = 'idle';
    this.deps.mic.touch();
    this.deps.ui('error', reason);
  }

  private onBlock(block: Float32Array): void {
    if (this.phase === 'capturing') this.feed(block);
    else this.preroll.push(block);
  }

  private feed(block: Float32Array): void {
    if (this.deps.level) {
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      // RMS → rough perceptual 0..1 (speech RMS ≈ 0.02–0.2).
      this.deps.level(Math.min(1, Math.sqrt(sum / Math.max(1, block.length)) * 6));
    }
    const out = this.resampler!.process(block);
    if (out.length) this.chunker!.push(floatToPcm16(out));
  }

  private sendFrame(pcm: Int16Array): void {
    this.deps.net.sendBinary(encodeAudioFrame(this.utteranceId, pcm));
    this.framesSent++;
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }
}

/** 36-char id (fits the AudioFrame's 36-byte utterance field). */
export function newUtteranceId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
