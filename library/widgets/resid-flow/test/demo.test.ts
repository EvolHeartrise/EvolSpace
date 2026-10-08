// Demo data: contract shapes, and the HTTP publisher/SSE control loop against
// a tiny fake server (no EvolSpace server needed).

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeTensorFrame } from '@evolspace/protocol';
import { DEMO_TOTAL, generateReadout, generateSample, isEntry, lastRealToken, runDemo } from '../demo-data.ts';
import { InterpData } from '../data.ts';

describe('demo data generator', () => {
  it('produces contract-shaped, internally consistent samples', () => {
    for (let i = 0; i < 3; i++) {
      const s = generateSample(i, { layers: 10, heads: 4 });
      const T = s.meta.tokens.length, L1 = s.meta.layers.length;
      expect(L1).toBe(11);
      expect(s.proj.shape).toEqual([L1, T, 3]);
      expect(s.norm.shape).toEqual([L1, T]);
      expect(s.mask.shape).toEqual([L1, T]);
      expect(s.mask.dtype).toBe('u8');
      expect(s.delta.shape).toEqual([L1 - 1, 2, T]);
      expect(s.attn.shape).toEqual([L1 - 1, 4, T, T]);
      // Attention rows of real queries are causal distributions.
      const a = s.attn.data as Float32Array;
      const q = lastRealToken(s);
      let sum = 0;
      for (let k = 0; k < T; k++) sum += a[q * T + k];
      expect(sum).toBeCloseTo(1, 4);
      expect(a[0 * T + 1]).toBe(0); // query 0 cannot see key 1
      const d = new InterpData();
      d.set('resid.proj', s.proj); d.set('resid.norm', s.norm); d.set('resid.mask', s.mask); d.set('resid.delta', s.delta); d.set('attn', s.attn); d.set('meta', s.meta);
      for (const k of ['resid.proj', 'resid.norm', 'resid.mask', 'resid.delta', 'attn', 'meta'] as const) expect(d.status(k)).toBe('ok');
      for (const v of s.proj.data) expect(Number.isFinite(v)).toBe(true);
    }
    expect(generateSample(1).meta.tokens.length).toBe(29); // padded
    expect(generateSample(2).meta.tokens.length).toBe(35); // shape change
    expect(generateSample(0).meta.sample.total).toBe(DEMO_TOTAL);
  });

  it('readouts sharpen with depth and are sorted', () => {
    const s = generateSample(0);
    const t = 11; // " of" → next " Paris"
    const early = generateReadout(s, 0, t), late = generateReadout(s, 10, t);
    expect(late.items[0].label).toBe(' Paris');
    expect(late.items[0].value).toBeGreaterThan(early.items.find((i) => i.label === ' Paris')?.value ?? 0);
    for (let i = 1; i < late.items.length; i++) expect(late.items[i - 1].value).toBeGreaterThanOrEqual(late.items[i].value);
    expect(late).toMatchObject({ layer: 10, token: t });
  });
});

// ---------------------------------------------------------------- fake server

interface Fake {
  url: string;
  puts: Array<{ name: string; type: string; value: unknown }>;
  /** Send a value on an SSE channel. */
  send(name: string, v: unknown): void;
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

async function fakeServer(opts: { putDelayMs?: number } = {}): Promise<Fake> {
  const puts: Fake['puts'] = [];
  const streams = new Map<string, Set<http.ServerResponse>>();
  const server = http.createServer((req, res) => {
    const m = /^\/api\/channels\/([^/]+)(\/events)?$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    const name = decodeURIComponent(m[1]);
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const type = String(req.headers['content-type']);
        const value = type.startsWith('application/x-evol-tensor') ? decodeTensorFrame(new Uint8Array(body)).tensor : JSON.parse(body.toString('utf8'));
        const done = () => {
          puts.push({ name, type, value });
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        };
        if (opts.putDelayMs) setTimeout(done, opts.putDelayMs); else done();
      });
      return;
    }
    if (m[2]) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      let set = streams.get(name);
      if (!set) streams.set(name, (set = new Set()));
      set.add(res);
      req.on('close', () => set!.delete(res));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    puts,
    send(name, v) {
      for (const res of streams.get(name) ?? []) res.write(`data: ${JSON.stringify(v)}\n\n`);
    },
    async waitFor(pred, ms = 5000) {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async close() {
      for (const set of streams.values()) for (const r of set) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
    // expose for SSE readiness checks
    ...{ streams },
  } as Fake & { streams: typeof streams };
}

describe('demo publisher', () => {
  let fake: (Fake & { streams?: Map<string, Set<http.ServerResponse>> }) | null = null;
  const ac = new AbortController();
  afterEach(async () => {
    ac.abort();
    await fake?.close();
    fake = null;
  });

  it('publishes a sample over HTTP and follows ctl channels over SSE', async () => {
    fake = await fakeServer();
    const f = fake;
    const done = runDemo({ url: f.url, prefix: 'demo', layers: 4, heads: 2, sample: 0, playMs: 300, log: () => {} }, ac.signal);
    await f.waitFor(() => f.puts.some((p) => p.name === 'demo.lens.readout'));
    const names = new Set(f.puts.map((p) => p.name));
    for (const n of ['demo.meta', 'demo.resid.proj', 'demo.resid.norm', 'demo.resid.delta', 'demo.resid.mask', 'demo.attn', 'demo.probe.is_location', 'demo.probe.index']) {
      expect(names.has(n)).toBe(true);
    }
    const proj = f.puts.find((p) => p.name === 'demo.resid.proj')!.value as { shape: number[] };
    expect(proj.shape).toEqual([5, 29, 3]);
    const first = f.puts.filter((p) => p.name === 'demo.lens.readout').at(-1)!.value as { layer: number; token: number };
    expect(first).toMatchObject({ layer: 4, token: 28 });

    // Wait until the SSE followers are connected, then drive the controls.
    const streams = (f as { streams: Map<string, Set<unknown>> }).streams;
    await f.waitFor(() => ['demo.ctl.layer', 'demo.ctl.token', 'demo.ctl.sample', 'demo.ctl.play'].every((n) => (streams.get(n)?.size ?? 0) > 0));
    f.send('demo.ctl.layer', 2);
    await f.waitFor(() => f.puts.some((p) => p.name === 'demo.lens.readout' && (p.value as { layer: number }).layer === 2));
    f.send('demo.ctl.token', 5);
    await f.waitFor(() => f.puts.some((p) => p.name === 'demo.lens.readout' && (p.value as { token: number }).token === 5));
    const metaCount = () => f.puts.filter((p) => p.name === 'demo.meta').length;
    const before = metaCount();
    f.send('demo.ctl.sample', 2);
    await f.waitFor(() => metaCount() > before);
    const meta = f.puts.filter((p) => p.name === 'demo.meta').at(-1)!.value as { sample: { index: number }; tokens: unknown[] };
    expect(meta.sample.index).toBe(2);
    expect(meta.tokens.length).toBe(35);
    // play auto-advances
    const n0 = metaCount();
    f.send('demo.ctl.play', true);
    await f.waitFor(() => metaCount() >= n0 + 1, 3000);
    f.send('demo.ctl.play', false);
    ac.abort();
    await done;
  }, 20000);
});

describe('demo publisher hardening', () => {
  let fake: (Fake & { streams?: Map<string, Set<http.ServerResponse>> }) | null = null;
  const ac = new AbortController();
  afterEach(async () => {
    ac.abort();
    await fake?.close();
    fake = null;
  });

  it('never drops a sample change when other controls arrive while publishing', async () => {
    fake = await fakeServer({ putDelayMs: 60 });
    const f = fake;
    const done = runDemo({ url: f.url, prefix: 'demo', layers: 3, heads: 2, sample: 0, playMs: 1000, log: () => {} }, ac.signal);
    const streams = (f as { streams: Map<string, Set<unknown>> }).streams;
    await f.waitFor(() => ['demo.ctl.layer', 'demo.ctl.token', 'demo.ctl.sample'].every((n) => (streams.get(n)?.size ?? 0) > 0));
    await f.waitFor(() => f.puts.some((p) => p.name === 'demo.lens.readout'));
    // A readout publish is in flight, then a sample change and a token change queue up behind it.
    f.send('demo.ctl.layer', 1);
    await new Promise((r) => setTimeout(r, 15));
    f.send('demo.ctl.sample', 2);
    await new Promise((r) => setTimeout(r, 15));
    f.send('demo.ctl.token', 5);
    const metaOf = (i: number) => f.puts.some((p) => p.name === 'demo.meta' && (p.value as { sample: { index: number } }).sample.index === i);
    await f.waitFor(() => metaOf(2) && f.puts.some((p) => p.name === 'demo.lens.readout' && (p.value as { token: number }).token === 5), 8000);
    const proj = f.puts.filter((p) => p.name === 'demo.resid.proj').at(-1)!.value as { shape: number[] };
    expect(proj.shape).toEqual([4, 35, 3]); // sample 2 is the long one
    ac.abort();
    await done;
  }, 20000);

  it.skipIf(process.platform !== 'win32')('detects the entry script with Windows drive-letter case differences', () => {
    expect(isEntry(String.raw`D:\Git\x\demo-data.ts`, 'file:///d:/Git/x/demo-data.ts', 'win32')).toBe(true);
    expect(isEntry(String.raw`D:\Git\x\other.ts`, 'file:///D:/Git/x/demo-data.ts', 'win32')).toBe(false);
    expect(isEntry(undefined, 'file:///D:/Git/x/demo-data.ts', 'win32')).toBe(false);
  });
});
