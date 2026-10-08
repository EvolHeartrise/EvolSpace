import { describe, it, expect, vi } from 'vitest';
import { Resampler, floatToPcm16, PcmChunker, PreRoll } from '../src/audio/resampler.ts';
import { PushToTalk, FRAME_SAMPLES, STT_RATE } from '../src/audio/ptt.ts';
import type { MicSource, MicState } from '../src/audio/mic.ts';
import { decodeAudioFrame, isAudioFrame, type ClientMessage } from '@evolspace/protocol';

function sine(freq: number, rate: number, n: number, amp = 0.5, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * (i / rate) + phase0);
  return out;
}
const rms = (x: ArrayLike<number>, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

describe('Resampler', () => {
  for (const inRate of [48000, 44100]) {
    it(`${inRate} → 16k produces the right number of samples`, () => {
      const r = new Resampler(inRate, 16000);
      const n = inRate; // 1 s
      const out = [r.process(sine(440, inRate, n)), r.flush()];
      const total = out.reduce((a, b) => a + b.length, 0);
      expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
    });

    it(`${inRate} → 16k preserves an in-band tone and rejects an out-of-band one`, () => {
      const pass = new Resampler(inRate, 16000).process(sine(1000, inRate, inRate));
      expect(rms(pass, 200, pass.length - 200)).toBeCloseTo(0.5 / Math.SQRT2, 2);
      const stop = new Resampler(inRate, 16000).process(sine(12000, inRate, inRate)); // aliases to 4 kHz if not filtered
      expect(rms(stop, 200, stop.length - 200)).toBeLessThan(0.02);
    });
  }

  it('streaming in odd-sized chunks equals one-shot processing', () => {
    const input = sine(700, 44100, 20000, 0.8, 0.3);
    const a = new Resampler(44100);
    const one = [...a.process(input), ...a.flush()];
    const b = new Resampler(44100);
    const parts: number[] = [];
    for (let i = 0; i < input.length;) {
      const n = 1 + ((i * 7919) % 997);
      parts.push(...b.process(input.subarray(i, i + n)));
      i += n;
    }
    parts.push(...b.flush());
    expect(parts.length).toBe(one.length);
    for (let i = 0; i < one.length; i++) expect(parts[i]).toBeCloseTo(one[i], 5);
  });

  it('DC passes with unity gain', () => {
    const out = new Resampler(48000).process(new Float32Array(4800).fill(0.25));
    expect(out[out.length - 1]).toBeCloseTo(0.25, 5);
  });
});

describe('PCM16 encoding', () => {
  it('maps and clamps float samples', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -2, NaN]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
  });

  it('chunker emits fixed frames and flushes the remainder', () => {
    const frames: Int16Array[] = [];
    const c = new PcmChunker(4, (f) => frames.push(f));
    c.push(Int16Array.from([1, 2, 3]));
    c.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    c.flush();
    expect(Array.from(frames[2])).toEqual([9]);
    expect(c.pending).toBe(0);
  });

  it('pre-roll keeps only the most recent samples', () => {
    const p = new PreRoll(5);
    p.push(Float32Array.from([1, 2, 3]));
    p.push(Float32Array.from([4, 5, 6]));
    p.push(Float32Array.from([7, 8]));
    expect(Array.from(p.take())).toEqual([4, 5, 6, 7, 8]);
    expect(p.take().length).toBe(0);
  });
});

class FakeMic implements MicSource {
  state: MicState = 'cold';
  error: string | undefined;
  sampleRate = 48000;
  onBlock: ((b: Float32Array) => void) | null = null;
  constructor(private ok = true) {}
  async warmup() {
    this.state = this.ok ? 'ready' : 'denied';
    if (!this.ok) this.error = 'Microphone permission denied';
    return this.ok;
  }
  touch() {}
  emit(n: number) { this.onBlock?.(sine(300, this.sampleRate, n, 0.3)); }
}

describe('PushToTalk', () => {
  function setup(ok = true, online = { v: true }) {
    const sent: ClientMessage[] = [];
    const bins: Uint8Array[] = [];
    const ui: string[] = [];
    let now = 0;
    const mic = new FakeMic(ok);
    const ptt = new PushToTalk({
      net: { send: (m) => sent.push(m), sendBinary: (b) => bins.push(b) },
      mic,
      context: () => ({ selected: 'e1', gaze: null }),
      ui: (s, d) => ui.push(d ? `${s}:${d}` : s),
      connected: () => online.v,
      newId: () => 'utt-0000-0000-0000-0000-000000000001',
      now: () => now,
    });
    return { sent, bins, ui, mic, ptt, online, advance: (ms: number) => { now += ms; } };
  }

  it('streams 100 ms 16 kHz frames between voice.begin and voice.end', async () => {
    const t = setup();
    await t.ptt.warmup();
    t.mic.emit(4800); // 100 ms pre-roll (250 ms max kept)
    await t.ptt.start();
    expect(t.sent[0]).toMatchObject({ type: 'voice.begin', sampleRate: STT_RATE, context: { selected: 'e1' } });
    expect(t.ui).toContain('listening');
    for (let i = 0; i < 10; i++) t.mic.emit(4800); // +1 s
    t.advance(1100);
    t.ptt.end(false);
    expect(t.sent.at(-1)).toEqual({ type: 'voice.end', utteranceId: 'utt-0000-0000-0000-0000-000000000001' });
    expect(t.bins.every(isAudioFrame)).toBe(true);
    const decoded = t.bins.map(decodeAudioFrame);
    expect(decoded[0].utteranceId).toBe('utt-0000-0000-0000-0000-000000000001');
    const total = decoded.reduce((a, d) => a + d.pcm.length, 0);
    expect(Math.abs(total - 17600)).toBeLessThanOrEqual(2); // 1.1 s incl. pre-roll
    expect(decoded.slice(0, -1).every((d) => d.pcm.length === FRAME_SAMPLES)).toBe(true);
    expect(t.ui.at(-1)).toBe('idle');
  });

  it('very short presses are cancelled', async () => {
    const t = setup();
    await t.ptt.start();
    t.advance(50);
    t.ptt.end(false);
    expect(t.sent.at(-1)).toMatchObject({ type: 'voice.end', cancelled: true });
  });

  it('release during mic acquisition sends nothing', async () => {
    const t = setup();
    const p = t.ptt.start();
    t.ptt.end(false);
    await p;
    expect(t.sent).toEqual([]);
    expect(t.ptt.active).toBe(false);
  });

  it('permission errors surface in the UI and send nothing', async () => {
    const t = setup(false);
    await t.ptt.start();
    expect(t.sent).toEqual([]);
    expect(t.ui).toEqual(['error:Microphone permission denied']);
  });

  it('refuses to listen while offline', async () => {
    const t = setup(true, { v: false });
    await t.ptt.start();
    expect(t.sent).toEqual([]);
    expect(t.ptt.active).toBe(false);
    expect(t.ui.at(-1)).toMatch(/^error:Not connected/);
  });

  it('abort() discards the utterance (e.g. connection lost) and reports why', async () => {
    const t = setup();
    await t.ptt.start();
    t.mic.emit(4800);
    t.advance(500);
    t.ptt.abort('Connection lost');
    expect(t.sent.at(-1)).toEqual({ type: 'voice.end', utteranceId: 'utt-0000-0000-0000-0000-000000000001', cancelled: true });
    expect(t.ui.at(-1)).toBe('error:Connection lost');
    expect(t.ptt.active).toBe(false);
    const n = t.bins.length;
    t.mic.emit(4800); // later audio goes to the pre-roll, not the wire
    t.ptt.end(false); // the release that follows is a no-op
    expect(t.bins.length).toBe(n);
    expect(t.sent.filter((m) => m.type === 'voice.end')).toHaveLength(1);
  });

  it('abort() during mic acquisition cancels the pending press', async () => {
    const t = setup();
    const p = t.ptt.start();
    t.ptt.abort('Connection lost');
    await p;
    expect(t.sent).toEqual([]);
    expect(t.ptt.active).toBe(false);
  });

  it('auto-ends at maxMs', async () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const ptt = new PushToTalk({ net: { send: (m) => sent.push(m), sendBinary: () => {} }, mic: new FakeMic(), context: () => ({}), ui: () => {}, now: () => 0 }, { maxMs: 1000, minMs: 0 });
      await ptt.start();
      vi.advanceTimersByTime(1001);
      expect(sent.at(-1)?.type).toBe('voice.end');
      expect(ptt.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
