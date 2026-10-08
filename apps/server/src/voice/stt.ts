// HTTP client for python/stt (faster-whisper service, default http://127.0.0.1:8790).
//   POST /transcribe?sample_rate=16000&prompt=...  body: PCM s16le mono
//   → { text, language, duration, segments, latency_ms, ... }

export interface SttSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

export interface SttResult {
  text: string;
  language?: string;
  /** Audio duration (s). */
  duration: number;
  /** Speech left after VAD (s), if the service reports it. */
  speech_duration?: number;
  segments: SttSegment[];
  /** Service-side processing time. */
  latency_ms: number;
  model?: string | null;
  device?: string | null;
}

export type SttErrorKind = 'unavailable' | 'loading' | 'timeout' | 'failed';

export class SttError extends Error {
  constructor(public readonly kind: SttErrorKind, message: string) {
    super(message);
    this.name = 'SttError';
  }
}

export interface SttClientOptions {
  url: string;
  timeoutMs?: number;
}

export class SttClient {
  constructor(private readonly o: SttClientOptions) {}

  get url(): string { return this.o.url; }

  async transcribe(pcm: Int16Array, sampleRate: number, prompt?: string): Promise<SttResult> {
    const q = new URLSearchParams({ sample_rate: String(sampleRate) });
    if (prompt) q.set('prompt', prompt);
    const body = new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength);
    let res: Response;
    try {
      res = await fetch(`${this.o.url.replace(/\/$/, '')}/transcribe?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new SttError('timeout', `speech recognition timed out after ${this.o.timeoutMs ?? 15_000} ms`);
      throw new SttError('unavailable', `speech recognition service unreachable at ${this.o.url} (${err.cause?.code ?? err.message})`);
    }
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (res.status === 503) throw new SttError('loading', (json as { error?: string } | undefined)?.error ?? 'speech model is still loading');
    if (!res.ok) throw new SttError('failed', `STT HTTP ${res.status}: ${(json as { error?: string } | undefined)?.error ?? text.slice(0, 200)}`);
    const r = json as Partial<SttResult> | undefined;
    if (!r || typeof r.text !== 'string') throw new SttError('failed', 'STT returned a malformed response');
    return {
      text: r.text,
      duration: typeof r.duration === 'number' ? r.duration : pcm.length / sampleRate,
      segments: Array.isArray(r.segments) ? r.segments : [],
      latency_ms: typeof r.latency_ms === 'number' ? r.latency_ms : 0,
      ...(r.language ? { language: r.language } : {}),
      ...(typeof r.speech_duration === 'number' ? { speech_duration: r.speech_duration } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.device !== undefined ? { device: r.device } : {}),
    };
  }

  async health(): Promise<{ ok: boolean; ready?: boolean; model?: string | null; error?: string } | null> {
    try {
      const res = await fetch(`${this.o.url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000) });
      return (await res.json()) as { ok: boolean; ready?: boolean };
    } catch {
      return null;
    }
  }
}

/**
 * Build Whisper's conditioning prompt from vocabulary words. Whisper uses the
 * prompt as "previous text", so a short natural sentence listing the words works
 * best; it only keeps the last ~224 tokens, so cap the length (most important
 * words first: the base list, then the dynamic vocabulary).
 */
export function buildPrompt(vocabulary: readonly string[], base: readonly string[] = BASE_VOCABULARY, maxChars = 600): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of [...base, ...vocabulary]) {
    const t = w.replace(/[\r\n]+/g, ' ').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k) || t.length > 40) continue;
    seen.add(k);
    words.push(t);
  }
  let out = 'Voice commands for EvolSpace and Claude:';
  for (const w of words) {
    const next = `${out} ${w},`;
    if (next.length > maxChars) break;
    out = next;
  }
  return out.replace(/,$/, '.');
}

/** Always-relevant words (the system's own names + fast-path vocabulary). */
export const BASE_VOCABULARY = [
  'Claude', 'EvolSpace', 'widget', 'passthrough', 'AR', 'VR', 'undo', 'redo', 'duplicate', 'workspace', 'recalibrate', 'agent panel',
];
