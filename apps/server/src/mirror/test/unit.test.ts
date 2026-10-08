import { describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { SerialQueue, TimeoutError, withTimeout } from '../queue.ts';
import { decodePng, imageStats, pngFromDataUrl } from '../png.ts';
import { assertWidgetId, normalizeRequest, ScreenshotRequestError } from '../request.ts';
import { isSoftwareRenderer, launchCandidates } from '../browser.ts';
import { isNavigationError } from '../index.ts';
import type { UserPose } from '@evolspace/protocol';

/** Minimal PNG encoder for tests: RGBA8, filter per row chosen by `filter`. */
function encodePng(w: number, h: number, rgba: Uint8Array, filter = 0): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const pred = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : 0;
      raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('SerialQueue', () => {
  it('runs tasks strictly one at a time, in order, isolating failures', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, ms: number, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const a = q.run(task('a', 20));
    const b = q.run(task('b', 5, true));
    const c = q.run(task('c', 1));
    expect(q.pending).toBe(3);
    await expect(a).resolves.toBe('a');
    await expect(b).rejects.toThrow('b');
    await expect(c).resolves.toBe('c');
    await q.idle();
    expect(q.pending).toBe(0);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
});

describe('withTimeout', () => {
  it('rejects with TimeoutError and runs onTimeout', async () => {
    let killed = false;
    const p = withTimeout(new Promise(() => {}), 20, 'thing', () => { killed = true; });
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    expect(killed).toBe(true);
  });
  it('passes through results', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
  });
});

describe('png', () => {
  const w = 7, h = 5;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([(i * 37) & 255, (i * 11) & 255, (i * 5) & 255, i % 3 ? 255 : 128], i * 4);
  for (const filter of [0, 1, 2, 3]) {
    it(`decodes filter ${filter}`, () => {
      const img = decodePng(encodePng(w, h, rgba, filter));
      expect(img.width).toBe(w);
      expect(img.height).toBe(h);
      expect(Buffer.from(img.data).equals(Buffer.from(rgba))).toBe(true);
    });
  }
  it('computes stats; uniform images have zero variance', () => {
    const flat = new Uint8Array(16 * 16 * 4).fill(200);
    const s = imageStats(encodePng(16, 16, flat));
    expect(s.variance).toBeCloseTo(0, 6);
    expect(s.distinctColors).toBe(1);
    const v = imageStats(encodePng(w, h, rgba));
    expect(v.variance).toBeGreaterThan(10);
    expect(v.transparentFraction).toBeGreaterThan(0.2);
  });
  it('parses data URLs and rejects garbage', () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    expect(pngFromDataUrl(`data:image/png;base64,${png.toString('base64')}`).equals(png)).toBe(true);
    expect(() => pngFromDataUrl('data:image/jpeg;base64,AAAA')).toThrow(/PNG data URL/);
  });
});

describe('normalizeRequest', () => {
  const pose: UserPose = { t: 0, mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {}, fov: 100, aspect: 0.9 };
  it('fills defaults', () => {
    const r = normalizeRequest({ view: { kind: 'camera', position: [0, 1, 2] } }, null);
    expect(r).toMatchObject({ width: 1024, height: 768, hands: false, labels: false });
  });
  it("follows the headset aspect for 'user' and defaults hands on", () => {
    const r = normalizeRequest({ view: { kind: 'user' } }, pose);
    expect(r.width).toBe(1024);
    expect(r.height).toBe(Math.round(1024 / 0.9));
    expect(r.hands).toBe(true);
    expect(normalizeRequest({ view: { kind: 'user' }, height: 900 }, pose).width).toBe(810);
  });
  it("errors on 'user' without a pose", () => {
    expect(() => normalizeRequest({ view: { kind: 'user' } }, null)).toThrow(/no user pose/);
  });
  it('validates views and sizes with descriptive errors', () => {
    expect(() => normalizeRequest({ view: { kind: 'nope' } as never }, null)).toThrow(/unknown view kind/);
    expect(() => normalizeRequest({ view: { kind: 'camera', position: [0, 1] as never } }, null)).toThrow(/position/);
    expect(() => normalizeRequest({ view: { kind: 'entity', entity: '' } }, null)).toThrow(/entity/);
    expect(() => normalizeRequest({ view: { kind: 'widget', widget: 'box' }, width: 99999 }, null)).toThrow(ScreenshotRequestError);
  });
  it('rejects path-traversing widget ids', () => {
    expect(() => assertWidgetId('../etc')).toThrow();
    expect(() => assertWidgetId('a/b')).toThrow();
    expect(() => assertWidgetId('resid-flow')).not.toThrow();
  });
});

describe('browser launch config', () => {
  it('orders GPU candidates before software in auto mode', () => {
    const c = launchCandidates('auto', 'win32');
    expect(c[0].options.args).toContain('--use-angle=d3d11');
    expect(c.at(-1)!.name).toBe('swiftshader');
    expect(launchCandidates('software', 'win32')).toHaveLength(1);
    expect(launchCandidates('gpu', 'win32').some((x) => x.name === 'swiftshader')).toBe(false);
  });
  it('detects software renderers', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
  });
});

describe('isNavigationError', () => {
  it('recognizes Playwright navigation errors (page reload mid-capture)', () => {
    expect(isNavigationError('mirror: Execution context was destroyed, most likely because of a navigation.')).toBe(true);
    expect(isNavigationError('page.evaluate: Frame was detached')).toBe(true);
    expect(isNavigationError('mirror: unknown entity "x"')).toBe(false);
    expect(isNavigationError('mirror: WebGL context lost')).toBe(false);
  });
});
