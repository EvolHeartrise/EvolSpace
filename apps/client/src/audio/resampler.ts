// Streaming mono resampler + PCM16 encoding + fixed-size frame chunking for
// push-to-talk audio. Pure TS (no Web Audio) so it is unit-testable.
//
// The microphone runs at the AudioContext rate (48 kHz on Quest, sometimes
// 44.1 kHz on desktop); speech-to-text wants 16 kHz PCM16. We use a
// windowed-sinc (Blackman) low-pass interpolator evaluated at fractional input
// positions: it anti-aliases (cutoff just under the output Nyquist) and handles
// non-integer ratios (44.1k → 16k) with continuous state across chunks, so
// chunk boundaries are seamless.

export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Input samples advanced per output sample. */
  private readonly step: number;
  /** Half-width of the kernel, in input samples. */
  private readonly half: number;
  /** Cutoff as a fraction of the input rate (cycles/sample). */
  private readonly fc: number;
  /** Ring of recent input history (kernel support). */
  private hist: Float32Array;
  /** Number of valid samples in hist (all samples since construction, capped by hist length). */
  private histLen = 0;
  /** Absolute index of hist[0] in the input stream. */
  private histStart = 0;
  /** Absolute (fractional) input position of the next output sample. */
  private pos = 0;
  /** Total input samples consumed. */
  private consumed = 0;

  /**
   * @param taps kernel half-width in *output* samples (quality vs CPU). 8 → ~24 input taps at 48k.
   */
  constructor(inRate: number, outRate = 16000, taps = 8) {
    if (!(inRate > 0 && outRate > 0)) throw new Error(`invalid rates ${inRate} → ${outRate}`);
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    // Downsampling: cutoff at 0.9 × output Nyquist; upsampling: input Nyquist.
    this.fc = (0.5 * Math.min(1, outRate / inRate)) * (inRate > outRate ? 0.9 : 1);
    this.half = Math.ceil(taps * Math.max(1, this.step));
    this.hist = new Float32Array(this.half * 4 + 4096);
    // Center the first output on input sample 0; the kernel's left half sees zeros (silence).
    this.pos = 0;
  }

  /** Latency in input samples before an output at position p can be produced. */
  private get lookahead(): number {
    return this.half;
  }

  /**
   * Feed input samples; returns the output samples that became computable.
   * Allocates the returned array; callers convert to PCM16 immediately.
   */
  process(input: Float32Array): Float32Array {
    this.append(input);
    return this.drain();
  }

  /** Emit the remaining tail (zero-padded) at end of stream. Call reset() before reusing. */
  flush(): Float32Array {
    const end = this.consumed;
    // Pad with silence so the last real samples are fully convolved.
    this.append(new Float32Array(this.half + 1));
    return this.drain(end);
  }

  /** Reset to a fresh stream (keeps rates). */
  reset(): void {
    this.histLen = 0;
    this.histStart = 0;
    this.pos = 0;
    this.consumed = 0;
  }

  private append(input: Float32Array): void {
    // Drop history no longer needed by any future output (pos - half).
    const keepFrom = Math.max(0, Math.floor(this.pos) - this.half - 1);
    const drop = keepFrom - this.histStart;
    if (drop > 0) {
      this.hist.copyWithin(0, drop, this.histLen);
      this.histLen -= drop;
      this.histStart += drop;
    }
    if (this.histLen + input.length > this.hist.length) {
      const bigger = new Float32Array(Math.max(this.hist.length * 2, this.histLen + input.length));
      bigger.set(this.hist.subarray(0, this.histLen));
      this.hist = bigger;
    }
    this.hist.set(input, this.histLen);
    this.histLen += input.length;
    this.consumed += input.length;
  }

  /** @param limit only produce outputs whose center is < limit (absolute input index) */
  private drain(limit = Infinity): Float32Array {
    const avail = this.histStart + this.histLen; // absolute index one past the last sample
    const outs: number[] = [];
    const half = this.half, fc = this.fc, hist = this.hist, hs = this.histStart;
    while (this.pos + this.lookahead < avail && this.pos < limit) {
      const center = this.pos;
      const k0 = Math.ceil(center - half), k1 = Math.floor(center + half);
      let acc = 0, wsum = 0;
      for (let k = k0; k <= k1; k++) {
        const x = k - center; // distance in input samples
        // windowed sinc low-pass at fc (cycles/sample), Blackman window over [-half, half]
        const s = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const wn = 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half);
        const h = s * wn;
        wsum += h;
        const idx = k - hs;
        if (idx >= 0 && idx < this.histLen) acc += hist[idx] * h;
        // samples before the stream start (k < 0) are silence
      }
      // Normalize DC gain to exactly 1.
      outs.push(wsum !== 0 ? acc / wsum : 0);
      this.pos += this.step;
    }
    return Float32Array.from(outs);
  }
}

/** Float [-1, 1] → signed 16-bit PCM (clamped, asymmetric scaling so ±1 map to the extremes). */
export function floatToPcm16(input: Float32Array, out: Int16Array = new Int16Array(input.length)): Int16Array {
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (!(s === s)) s = 0; // NaN guard
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Accumulates PCM16 samples into fixed-size frames (e.g. 1600 samples = 100 ms
 * at 16 kHz) and hands each full frame to `emit`. `flush()` emits the partial
 * remainder (if any).
 */
export class PcmChunker {
  private buf: Int16Array;
  private len = 0;

  constructor(readonly frameSamples: number, private readonly emit: (pcm: Int16Array) => void) {
    if (!(frameSamples > 0)) throw new Error('frameSamples must be > 0');
    this.buf = new Int16Array(frameSamples);
  }

  push(pcm: Int16Array): void {
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(this.frameSamples - this.len, pcm.length - i);
      this.buf.set(pcm.subarray(i, i + n), this.len);
      this.len += n;
      i += n;
      if (this.len === this.frameSamples) {
        this.emit(this.buf);
        this.buf = new Int16Array(this.frameSamples); // emitted frames are owned by the consumer
        this.len = 0;
      }
    }
  }

  flush(): void {
    if (this.len > 0) {
      this.emit(this.buf.slice(0, this.len));
      this.len = 0;
    }
  }

  get pending(): number {
    return this.len;
  }
}

/**
 * Bounded FIFO of recent float blocks (pre-roll): keeps the last `maxSamples`
 * of microphone audio while idle so the start of an utterance isn't clipped by
 * the push-to-talk gesture latency.
 */
export class PreRoll {
  private blocks: Float32Array[] = [];
  private total = 0;
  constructor(readonly maxSamples: number) {}

  push(block: Float32Array): void {
    if (this.maxSamples <= 0) return;
    this.blocks.push(block);
    this.total += block.length;
    while (this.blocks.length > 1 && this.total - this.blocks[0].length >= this.maxSamples) {
      this.total -= this.blocks.shift()!.length;
    }
  }

  /** Returns and clears the buffered audio (most recent ≤ maxSamples, concatenated). */
  take(): Float32Array {
    const all = new Float32Array(this.total);
    let o = 0;
    for (const b of this.blocks) { all.set(b, o); o += b.length; }
    this.clear();
    return all.length > this.maxSamples ? all.subarray(all.length - this.maxSamples) : all;
  }

  clear(): void {
    this.blocks = [];
    this.total = 0;
  }
}
