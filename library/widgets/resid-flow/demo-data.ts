// Synthetic interp data for resid-flow demos (no Python needed).
//
//   npx tsx library/widgets/resid-flow/demo-data.ts [--url http://127.0.0.1:8787] [--prefix interp]
//        [--layers 10] [--heads 4] [--sample 0] [--play-ms 3000] [--once]
//
// Publishes contract-shaped channels (ARCHITECTURE.md "Interp data contract")
// to the EvolSpace server over HTTP (PUT /api/channels/:name, tensors as
// application/x-evol-tensor frames) and follows <prefix>.ctl.{layer,token,
// sample,play} over SSE: layer/token changes republish the lens readout, a
// sample change republishes everything, play=true (or a rate in Hz) auto-advances samples.
//
// The data is a small simulated transformer: tokens start scattered by group,
// attention mixes them toward attended tokens (prev-token, BOS-sink,
// same-group and entity heads), MLPs pull them toward rotating group
// attractors, norms grow with depth, BOS is a high-norm sink. Samples cycle
// through three sentences: one full, one padded (masked tail), one longer
// (different T → shape change in the widget).
//
// Pure generators are exported for tests; main() only runs when executed directly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeTensorFrame, makeTensor, type TensorValue } from '@evolspace/protocol';

export interface DemoToken {
  label: string;
  group: string;
}

export interface DemoOptions {
  /** Number of blocks L (layers = L + 1). */
  layers: number;
  heads: number;
}

export interface DemoSample {
  index: number;
  meta: {
    model: string;
    checkpoint: string;
    layers: string[];
    tokens: DemoToken[];
    d_model: number;
    sample: { index: number; total: number; label: string };
    lens: { kind: string; description: string };
  };
  proj: TensorValue;
  norm: TensorValue;
  delta: TensorValue;
  mask: TensorValue;
  attn: TensorValue;
  probes: Record<string, TensorValue>;
}

export interface Readout {
  layer: number;
  token: number;
  title: string;
  items: Array<{ label: string; value: number }>;
}

// ---------------------------------------------------------------- corpus

const G = {
  bos: 'bos', ent: 'entity', rel: 'relation', fn: 'function', loc: 'location', num: 'number', pun: 'punct', pad: 'pad',
} as const;

type Sentence = { label: string; tokens: Array<[string, string]>; padTo?: number };

const SENTENCES: Sentence[] = [
  {
    label: 'eiffel',
    tokens: [
      ['<bos>', G.bos], ['The', G.fn], [' E', G.ent], ['iff', G.ent], ['el', G.ent], [' Tower', G.ent], [' is', G.rel], [' located', G.rel],
      [' in', G.fn], [' the', G.fn], [' city', G.loc], [' of', G.fn], [' Paris', G.loc], [',', G.pun], [' which', G.fn], [' is', G.rel],
      [' the', G.fn], [' capital', G.loc], [' of', G.fn], [' France', G.loc], ['.', G.pun], [' It', G.ent], [' was', G.rel], [' built', G.rel],
      [' in', G.fn], [' 18', G.num], ['89', G.num], [' by', G.fn], [' Gustave', G.ent],
    ],
  },
  {
    label: 'colosseum (padded)',
    padTo: 29,
    tokens: [
      ['<bos>', G.bos], ['The', G.fn], [' Col', G.ent], ['os', G.ent], ['seum', G.ent], [' stands', G.rel], [' in', G.fn], [' the', G.fn],
      [' heart', G.loc], [' of', G.fn], [' Rome', G.loc], [',', G.pun], [' Italy', G.loc], ['.', G.pun], [' It', G.ent], [' opened', G.rel],
      [' in', G.fn], [' 80', G.num], [' AD', G.num], ['.', G.pun],
    ],
  },
  {
    label: 'golden gate (long)',
    tokens: [
      ['<bos>', G.bos], ['The', G.fn], [' Golden', G.ent], [' Gate', G.ent], [' Bridge', G.ent], [' spans', G.rel], [' the', G.fn], [' strait', G.loc],
      [' between', G.fn], [' San', G.loc], [' Francisco', G.loc], [' Bay', G.loc], [' and', G.fn], [' the', G.fn], [' Pacific', G.loc], [' Ocean', G.loc],
      ['.', G.pun], [' It', G.ent], [' opened', G.rel], [' in', G.fn], [' 19', G.num], ['37', G.num], [' and', G.fn], [' was', G.rel],
      [' then', G.fn], [' the', G.fn], [' longest', G.rel], [' suspension', G.ent], [' bridge', G.ent], [' in', G.fn], [' the', G.fn], [' world', G.loc],
      [',', G.pun], [' at', G.fn], [' 1', G.num],
    ],
  },
];

/** Plausible next-token candidates per group (for the synthetic logit lens). */
const VOCAB: Record<string, string[]> = {
  [G.bos]: ['The', 'In', 'A', 'It', '\n'],
  [G.ent]: [' Tower', ' Bridge', ' Eiffel', ' Gate', 'el', ' building', ' structure', ' monument'],
  [G.rel]: [' located', ' built', ' in', ' is', ' was', ' opened', ' stands', ' spans'],
  [G.fn]: [' the', ' of', ' a', ' in', ',', ' and', ' to', ' city'],
  [G.loc]: [' Paris', ' France', ' Rome', ' city', ' capital', ' Europe', ' London', ' Bay'],
  [G.num]: ['89', '37', ' 18', ' AD', ' years', '00', '.', ','],
  [G.pun]: [' It', ' The', '\n', ' This', ' In', ' and', ' which', ' a'],
  [G.pad]: ['<pad>'],
};

/** Total number of demo samples (cycled). */
export const DEMO_TOTAL = 12;

// ---------------------------------------------------------------- rng / math

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const GROUP_ORDER: string[] = [G.bos, G.ent, G.rel, G.fn, G.loc, G.num, G.pun, G.pad];

function groupAngle(g: string): number {
  return (GROUP_ORDER.indexOf(g) / (GROUP_ORDER.length - 1)) * Math.PI * 2;
}

function softmaxRow(scores: Float64Array, n: number, out: Float32Array, o: number): void {
  let m = -Infinity;
  for (let k = 0; k < n; k++) m = Math.max(m, scores[k]);
  let s = 0;
  for (let k = 0; k < n; k++) s += Math.exp(scores[k] - m);
  for (let k = 0; k < n; k++) out[o + k] = Math.exp(scores[k] - m) / s;
}

// ---------------------------------------------------------------- generators

export function layerLabels(L: number): string[] {
  return ['embed', ...Array.from({ length: L }, (_, i) => `b${i}`)];
}

/** Generate sample `index` (deterministic). */
export function generateSample(index: number, opts: DemoOptions = { layers: 10, heads: 4 }): DemoSample {
  const L = Math.max(1, Math.floor(opts.layers));
  const H = Math.max(1, Math.floor(opts.heads));
  const L1 = L + 1;
  const sent = SENTENCES[((index % SENTENCES.length) + SENTENCES.length) % SENTENCES.length];
  const tokens: DemoToken[] = sent.tokens.map(([label, group]) => ({ label, group }));
  const real = tokens.length;
  while (sent.padTo && tokens.length < sent.padTo) tokens.push({ label: '<pad>', group: G.pad });
  const T = tokens.length;
  const r = rng(1000 + index * 7919);

  const proj = new Float32Array(L1 * T * 3);
  const norm = new Float32Array(L1 * T);
  const delta = new Float32Array(L * 2 * T);
  const mask = new Uint8Array(L1 * T);
  const attn = new Float32Array(L * H * T * T);
  const probe = new Float32Array(L1 * T);

  // Embeddings: scattered around group directions.
  const x = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = groupAngle(tokens[t].group) + gauss(r) * 0.5;
    const rad = 0.45 + r() * 0.35;
    x[t * 3] = Math.cos(a) * rad + gauss(r) * 0.12;
    x[t * 3 + 1] = Math.sin(a) * rad + gauss(r) * 0.12;
    x[t * 3 + 2] = gauss(r) * 0.3;
  }
  const write = (l: number) => {
    for (let t = 0; t < T; t++) {
      const i = l * T + t;
      const on = t < real;
      mask[i] = on ? 1 : 0;
      for (let c = 0; c < 3; c++) proj[i * 3 + c] = on ? x[t * 3 + c] : 0;
      const growth = 1 + 0.35 * l;
      const n3 = Math.hypot(x[t * 3], x[t * 3 + 1], x[t * 3 + 2]);
      norm[i] = on ? (4 + 6 * n3) * growth * (tokens[t].group === G.bos ? 6 : 1) : 0;
      // Probe contract (python/evolinterp): 2·P(true class) − 1 in [-1, 1], NaN = not applicable
      // (padding, and here the BOS token). Confidence grows with depth, faster for locations.
      const applies = on && tokens[t].group !== G.bos;
      const conf = Math.tanh((l / L) * 3 - 0.6) * (tokens[t].group === G.loc ? 1 : 0.7) + gauss(r) * 0.08;
      probe[i] = applies ? Math.max(-1, Math.min(1, conf)) : NaN;
    }
  };
  write(0);

  const scores = new Float64Array(T);
  const step = new Float64Array(T * 3);
  for (let b = 0; b < L; b++) {
    const depth = (b + 1) / L;
    // --- attention patterns (causal), per head.
    for (let h = 0; h < H; h++) {
      const kind = h % 4;
      for (let q = 0; q < T; q++) {
        const o = ((b * H + h) * T + q) * T;
        if (q >= real) { attn[o + q] = 1; continue; } // padded queries attend to themselves
        const n = q + 1;
        for (let k = 0; k < n; k++) {
          let s = gauss(r) * 0.3;
          if (kind === 0) s += k === q - 1 ? 4 : k === q ? 1.5 : 0;
          else if (kind === 1) s += k === 0 ? 3.5 : 0;
          else if (kind === 2) s += tokens[k].group === tokens[q].group ? 2.5 * depth + 0.5 : 0;
          else s += tokens[k].group === G.ent ? 2 + depth : tokens[k].group === G.loc ? 1.5 * depth : 0;
          scores[k] = s;
        }
        softmaxRow(scores, n, attn, o);
      }
    }
    // --- residual update: attention mixing, then MLP pull toward rotating group attractors.
    for (let t = 0; t < T; t++) {
      const i3 = t * 3;
      if (t >= real) continue;
      let ax = 0, ay = 0, az = 0;
      for (let h = 0; h < H; h++) {
        const o = ((b * H + h) * T + t) * T;
        for (let k = 0; k <= t; k++) {
          const w = attn[o + k] / H;
          ax += w * x[k * 3]; ay += w * x[k * 3 + 1]; az += w * x[k * 3 + 2];
        }
      }
      const am = 0.18;
      const dax = (ax - x[i3]) * am, day = (ay - x[i3 + 1]) * am, daz = (az - x[i3 + 2]) * am;
      const ang = groupAngle(tokens[t].group) + depth * 1.6;
      const rad = 0.55 + depth * 0.5;
      const pull = 0.12 + 0.1 * depth;
      const dmx = (Math.cos(ang) * rad - x[i3]) * pull + gauss(r) * 0.03;
      const dmy = (Math.sin(ang) * rad - x[i3 + 1]) * pull + gauss(r) * 0.03;
      const dmz = (Math.sin(depth * 3 + t * 0.3) * 0.35 - x[i3 + 2]) * pull + gauss(r) * 0.03;
      step[i3] = dax + dmx; step[i3 + 1] = day + dmy; step[i3 + 2] = daz + dmz;
      const growth = 1 + 0.35 * (b + 1);
      delta[(b * 2) * T + t] = Math.hypot(dax, day, daz) * 10 * growth + (tokens[t].group === G.bos ? 0.2 : 0);
      delta[(b * 2 + 1) * T + t] = Math.hypot(dmx, dmy, dmz) * 10 * growth * (0.6 + depth);
    }
    for (let t = 0; t < real; t++) for (let c = 0; c < 3; c++) x[t * 3 + c] += step[t * 3 + c];
    write(b + 1);
  }

  return {
    index,
    meta: {
      model: 'toy-gpt (synthetic)',
      checkpoint: 'demo',
      layers: layerLabels(L),
      tokens,
      d_model: 256,
      sample: { index, total: DEMO_TOTAL, label: sent.label },
      lens: { kind: 'logit lens', description: 'Synthetic next-token decode of the residual at the lens layer/token.' },
    },
    proj: makeTensor('f32', [L1, T, 3], proj),
    norm: makeTensor('f32', [L1, T], norm),
    delta: makeTensor('f32', [L, 2, T], delta),
    mask: makeTensor('u8', [L1, T], mask),
    attn: makeTensor('f32', [L, H, T, T], attn),
    probes: { is_location: makeTensor('f32', [L1, T], probe) },
  };
}

/** Last unmasked token of a sample. */
export function lastRealToken(s: DemoSample): number {
  for (let t = s.meta.tokens.length - 1; t >= 0; t--) if (s.meta.tokens[t].group !== G.pad) return t;
  return 0;
}

/** Synthetic logit-lens readout: the true next token gains probability with depth. */
export function generateReadout(s: DemoSample, layer: number, token: number): Readout {
  const L1 = s.meta.layers.length;
  const T = s.meta.tokens.length;
  const l = Math.min(L1 - 1, Math.max(0, Math.round(layer)));
  const t = Math.min(T - 1, Math.max(0, Math.round(token)));
  const tok = s.meta.tokens[t];
  const next = s.meta.tokens[t + 1];
  const truth = next && next.group !== G.pad ? next.label : '.';
  const r = rng(77 + s.index * 131 + l * 17 + t * 7);
  const depth = L1 > 1 ? l / (L1 - 1) : 1;
  const cands = new Map<string, number>();
  const pool = [...(VOCAB[next?.group ?? G.pun] ?? []), ...(VOCAB[tok.group] ?? [])];
  for (const w of pool) cands.set(w, (cands.get(w) ?? 0) + r() * (1 - depth * 0.6));
  cands.set(truth, (cands.get(truth) ?? 0) + 0.15 + 3.2 * depth * depth);
  // Early layers echo the current token (a classic logit-lens effect).
  cands.set(tok.label, (cands.get(tok.label) ?? 0) + 1.6 * (1 - depth));
  let z = 0;
  const e = [...cands].map(([label, v]) => [label, Math.exp(v * 2.2)] as const);
  for (const [, v] of e) z += v;
  const items = e.map(([label, v]) => ({ label, value: v / (z * 1.15) }));
  items.sort((a, b) => b.value - a.value);
  return {
    layer: l,
    token: t,
    title: `logit lens · ${s.meta.layers[l]} · ${JSON.stringify(tok.label)}`,
    items: items.slice(0, 8).map((it) => ({ label: it.label, value: Math.round(it.value * 1e4) / 1e4 })),
  };
}

// ---------------------------------------------------------------- publishing

export class DemoPublisher {
  constructor(readonly baseUrl: string, readonly prefix = 'interp', private producer = 'resid-demo') {}

  private url(name: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/api/channels/${encodeURIComponent(`${this.prefix}.${name}`)}`;
  }

  async putJson(name: string, value: unknown): Promise<void> {
    const res = await fetch(this.url(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Producer': this.producer },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`PUT ${name}: ${res.status} ${await res.text()}`);
  }

  async putTensor(name: string, t: TensorValue): Promise<void> {
    const frame = encodeTensorFrame({ channel: `${this.prefix}.${name}`, producer: this.producer, dtype: t.dtype, shape: t.shape }, t);
    const res = await fetch(this.url(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-evol-tensor', 'X-Producer': this.producer },
      body: frame as unknown as BodyInit, // ArrayBuffer-backed (fresh allocation)
    });
    if (!res.ok) throw new Error(`PUT ${name}: ${res.status} ${await res.text()}`);
  }

  /** Publish every data channel of a sample (meta last, so consumers see a consistent set when it lands). */
  async publishSample(s: DemoSample): Promise<void> {
    await Promise.all([
      this.putTensor('resid.proj', s.proj),
      this.putTensor('resid.norm', s.norm),
      this.putTensor('resid.delta', s.delta),
      this.putTensor('resid.mask', s.mask),
      this.putTensor('attn', s.attn),
      ...Object.entries(s.probes).map(([k, v]) => this.putTensor(`probe.${k}`, v)),
    ]);
    await this.putJson('probe.index', Object.keys(s.probes));
    await this.putJson('meta', s.meta);
  }

  async publishReadout(r: Readout): Promise<void> {
    await this.putJson('lens.readout', r);
  }
}

/**
 * Follow a channel over SSE (GET /api/channels/:name/events). Reconnects with
 * a short backoff until `signal` aborts. Each event's JSON value goes to `cb`.
 */
export async function followChannel(baseUrl: string, channel: string, cb: (v: unknown) => void, signal: AbortSignal): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/channels/${encodeURIComponent(channel)}/events`;
  while (!signal.aborted) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`SSE ${channel}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = block.split('\n').filter((ln) => ln.startsWith('data:')).map((ln) => ln.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { cb(JSON.parse(data)); } catch { /* malformed event: skip */ }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      if ((e as Error).name !== 'AbortError') console.warn(`[demo] ${channel}: ${(e as Error).message}; retrying`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

export interface DemoRunOptions extends DemoOptions {
  url: string;
  prefix: string;
  sample: number;
  playMs: number;
  log?: (msg: string) => void;
}

/**
 * Run the interactive demo: publish, then react to <prefix>.ctl.*. Resolves
 * when `signal` aborts. Control handling is serialized (latest wins).
 */
export async function runDemo(o: DemoRunOptions, signal: AbortSignal): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(`[demo] ${m}`));
  const pub = new DemoPublisher(o.url, o.prefix);
  let sample = generateSample(o.sample, o);
  let layer = sample.meta.layers.length - 1;
  let token = lastRealToken(sample);
  let play: ReturnType<typeof setInterval> | null = null;
  let playPeriod = 0;

  // Serialize publishes and coalesce bursts (a slider scrub) into the latest
  // state. Work is tracked as dirty flags, not queued jobs, so a readout
  // request arriving during a sample publish can never drop that sample.
  let busy = false;
  let needSample = false, needReadout = false;
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while ((needSample || needReadout) && !signal.aborted) {
        const s = sample;
        const doSample = needSample;
        needSample = needReadout = false;
        try {
          if (doSample) await pub.publishSample(s);
          await pub.publishReadout(generateReadout(s, layer, token));
        } catch (e) {
          log(`publish failed: ${(e as Error).message}`);
          if (doSample && s === sample) needSample = true; // retry on the next request
          break;
        }
      }
    } finally {
      busy = false;
    }
  };
  const readout = () => { needReadout = true; return pump(); };
  const setSample = (i: number) => {
    const idx = ((Math.round(i) % DEMO_TOTAL) + DEMO_TOTAL) % DEMO_TOTAL;
    sample = generateSample(idx, o);
    layer = Math.min(Math.max(0, Math.round(layer)), sample.meta.layers.length - 1);
    token = Math.min(Math.max(0, Math.round(token)), sample.meta.tokens.length - 1);
    log(`sample ${idx} (${sample.meta.sample.label}, T=${sample.meta.tokens.length})`);
    needSample = true;
    return pump();
  };

  await setSample(o.sample);
  log(`published to ${o.url} with prefix '${o.prefix}'`);
  const P = o.prefix;
  const follows = [
    followChannel(o.url, `${P}.ctl.layer`, (v) => { if (typeof v === 'number' && v !== layer) { layer = v; void readout(); } }, signal),
    followChannel(o.url, `${P}.ctl.token`, (v) => { if (typeof v === 'number' && v !== token) { token = v; void readout(); } }, signal),
    followChannel(o.url, `${P}.ctl.sample`, (v) => { if (typeof v === 'number' && v !== sample.index) void setSample(v); }, signal),
    // ctl.play: true = advance every --play-ms; a positive number = rate in Hz (python/evolinterp convention).
    followChannel(o.url, `${P}.ctl.play`, (v) => {
      const ms = v === true ? o.playMs : typeof v === 'number' && Number.isFinite(v) && v > 0 ? 1000 / v : 0;
      const period = ms > 0 ? Math.max(250, ms) : 0;
      if (period === playPeriod) return;
      if (play) clearInterval(play);
      play = null;
      playPeriod = period;
      if (period > 0) {
        play = setInterval(() => void setSample(sample.index + 1), period);
        log(`play (every ${Math.round(period)} ms)`);
      } else {
        log('pause');
      }
    }, signal),
  ];
  signal.addEventListener('abort', () => { if (play) clearInterval(play); }, { once: true });
  await Promise.all(follows);
}

function parseArgs(argv: string[]): DemoRunOptions & { once: boolean } {
  const get = (name: string, d: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  return {
    url: get('url', process.env.EVOL_URL ?? 'http://127.0.0.1:8787'),
    prefix: get('prefix', 'interp'),
    layers: Number(get('layers', '10')),
    heads: Number(get('heads', '4')),
    sample: Number(get('sample', '0')),
    playMs: Number(get('play-ms', '3000')),
    once: argv.includes('--once'),
  };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.once) {
    const s = generateSample(o.sample, o);
    const pub = new DemoPublisher(o.url, o.prefix);
    await pub.publishSample(s);
    await pub.publishReadout(generateReadout(s, s.meta.layers.length - 1, lastRealToken(s)));
    console.log(`[demo] published sample ${o.sample} to ${o.url} (prefix '${o.prefix}')`);
    return;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await runDemo(o, ac.signal);
}

/** True when this file is the entry script. Paths compare case-insensitively on Windows (drive letter case varies by shell). */
export function isEntry(argv1: string | undefined, moduleUrl: string, platform: string = process.platform): boolean {
  if (!argv1 || !moduleUrl.startsWith('file:')) return false;
  let a: string, b: string;
  try {
    a = path.resolve(argv1);
    b = path.resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const isMain = isEntry(process.argv[1], import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[demo] ${(e as Error).message}`);
    process.exit(1);
  });
}
