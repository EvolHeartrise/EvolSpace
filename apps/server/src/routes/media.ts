// Media files for widgets (the `video` widget): GET /media/:file serves <dataDir>/media/<file>
// same-origin (WebGL textures need CORS-clean media, and the headset only talks HTTPS to us) with
// HTTP Range support so <video> can seek. Files land there via the `video` source (yt-dlp) or by
// hand. Flat directory, names [A-Za-z0-9._-] only.
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from '../http/router.ts';
import { HttpError } from '../http/router.ts';
import type { Services } from '../services.ts';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

/** Parse a single "bytes=a-b" range against `size`; null = whole file, 'bad' = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number, end: number;
  if (m[1] === '') { // suffix: last N bytes
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

export function mediaRoutes(r: Router, s: Services): void {
  const dir = path.join(s.config.dataDir, 'media');
  const serve = (head: boolean) => ({ params, req, res }: Parameters<Parameters<Router['get']>[1]>[0]) => {
    const name = params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new HttpError(400, 'bad media name');
    const file = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { throw new HttpError(404, `no media '${name}'`); }
    if (!st.isFile()) throw new HttpError(404, `no media '${name}'`);
    const type = TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    const range = parseRange(req.headers.range, st.size);
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Last-Modified': st.mtime.toUTCString() };
    if (range === 'bad') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      res.end();
      return undefined;
    }
    const { start, end } = range ?? { start: 0, end: st.size - 1 };
    res.writeHead(range ? 206 : 200, {
      ...base,
      'Content-Length': String(st.size ? end - start + 1 : 0),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
    });
    if (head || st.size === 0) { res.end(); return undefined; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return undefined;
  };
  r.get('/media/:file', serve(false));
  r.add('HEAD', '/media/:file', serve(true));
}
