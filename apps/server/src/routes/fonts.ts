// Fallback fonts for characters the bundled fonts (Inter, JetBrains Mono) lack — Japanese/Chinese/Korean,
// Arabic, Devanagari, combining marks, … — served same-origin for troika's unicode-font-resolver.
//
//   GET /fonts/unicode/available                         {ok}: fallback fonts can be served (cached or reachable)
//   GET /fonts/unicode/codepoint-index/plane<n>/<a>-<b>.json
//   GET /fonts/unicode/font-meta/<name>.json
//   GET /fonts/unicode/font-files/<id>/<category>.<style>.<weight>.woff
//
// Each file is fetched once from the pinned unicode-font-resolver data release (Noto fonts, split by
// script) and kept in <dataDir>/fonts/unicode, so the headset never talks to a CDN and text keeps
// rendering offline once a script has been seen. The client only enables fallbacks after
// /available answers ok (otherwise uncovered characters stay mapped to □, see runtime ui/glyphs.ts).
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, type Router } from '../http/router.ts';
import type { Services } from '../services.ts';

export const UNICODE_FONTS_UPSTREAM = 'https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data';

const PATHS = [
  /^codepoint-index\/plane\d{1,2}\/[0-9a-f]{1,6}-[0-9a-f]{1,6}\.json$/,
  /^font-meta\/[A-Za-z0-9_-]{1,64}\.json$/,
  /^font-files\/[A-Za-z0-9_-]{1,64}\/[a-z-]{1,24}\.[a-z]{1,12}\.\d{3}\.woff$/,
];
export const validFontPath = (p: string): boolean => PATHS.some((re) => re.test(p));

export function fontRoutes(r: Router, s: Services, opts: { fetch?: typeof fetch; upstream?: string } = {}): void {
  const dir = path.join(s.config.dataDir, 'fonts', 'unicode');
  const upstream = opts.upstream ?? UNICODE_FONTS_UPSTREAM;
  const get = opts.fetch ?? fetch;
  const inflight = new Map<string, Promise<Buffer>>();

  /** The file from the cache, else from upstream (stored for next time). */
  async function load(rel: string): Promise<Buffer> {
    const file = path.join(dir, rel);
    try { return await fs.promises.readFile(file); } catch { /* not cached */ }
    let p = inflight.get(rel);
    if (!p) {
      p = (async () => {
        const res = await get(`${upstream}/${rel}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `fallback font ${rel}: upstream ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(`${file}.part`, buf);
        await fs.promises.rename(`${file}.part`, file);
        return buf;
      })().finally(() => inflight.delete(rel));
      inflight.set(rel, p);
    }
    return p;
  }

  const serve = (rel: string) => async ({ res }: Parameters<Parameters<Router['get']>[1]>[0]) => {
    if (!validFontPath(rel)) throw new HttpError(400, 'bad font path');
    let buf: Buffer;
    try { buf = await load(rel); } catch (e) { throw e instanceof HttpError ? e : new HttpError(503, `fallback fonts unavailable: ${(e as Error).message}`); }
    res.writeHead(200, {
      'Content-Type': rel.endsWith('.woff') ? 'font/woff' : 'application/json',
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=31536000, immutable', // pinned release: never changes
      'Access-Control-Allow-Origin': '*', // troika fetches from a worker
    });
    res.end(buf);
    return undefined;
  };

  r.get('/fonts/unicode/available', async () => {
    try { await load('codepoint-index/plane0/0-ff.json'); return { ok: true }; } catch { return { ok: false }; }
  });
  r.get('/fonts/unicode/codepoint-index/:plane/:file', (c) => serve(`codepoint-index/${c.params.plane}/${c.params.file}`)(c));
  r.get('/fonts/unicode/font-meta/:file', (c) => serve(`font-meta/${c.params.file}`)(c));
  r.get('/fonts/unicode/font-files/:id/:file', (c) => serve(`font-files/${c.params.id}/${c.params.file}`)(c));
}
