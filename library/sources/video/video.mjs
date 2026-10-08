// Video fetcher for the `video` widget. WebGL needs same-origin (CORS-clean) media and the headset
// only reaches us over HTTPS, so remote videos — YouTube and anything else yt-dlp understands,
// including plain .mp4/.webm links — are downloaded into data/media/ and played from the server's
// GET /media/<file> route.
//
//   video.request = {url, nonce}            a widget asks for a URL (repeat requests are cheap)
//   video.media   = {"<url>": {status: 'queued'|'downloading'|'ready'|'error', progress (0..1),
//                    src ('/media/<key>.mp4'), title, duration (s), error?}}
// Downloads are cached by URL (data/media/index.json) and run one at a time (yt-dlp via uvx, latest). Format: best ≤1080p
// H.264 + AAC merged to MP4 (what the Quest browser decodes reliably), else the best single file.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PREFIX = arg('prefix', 'video');
const DIR = path.resolve(arg('dir', '../../../data/media'));
const MAX_H = Number(arg('max-height', '1080'));
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const INDEX = path.join(DIR, 'index.json');
// yt-dlp: the latest release via uvx (YouTube breaks old versions within weeks), with this Node as
// its JavaScript runtime for YouTube's player challenges. --ytdlp "<path>" uses a fixed binary.
const UVX = [path.join(os.homedir(), '.local/bin/uvx'), '/usr/local/bin/uvx', '/usr/bin/uvx'].find((p) => fs.existsSync(p)) ?? 'uvx';
const YTDLP = arg('ytdlp', '') ? [arg('ytdlp', '')] : [UVX, '--from', 'yt-dlp[default]@latest', 'yt-dlp'];
const ytdlp = (args, onLine) => run(YTDLP[0], [...YTDLP.slice(1), '--js-runtimes', `node:${process.execPath}`, ...args], onLine);

fs.mkdirSync(DIR, { recursive: true });
/** url → entry (persisted for ready ones). */
const media = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    for (const [u, e] of Object.entries(saved)) if (e.status !== 'ready' || !fs.existsSync(path.join(DIR, path.basename(e.src)))) delete saved[u];
    return saved;
  } catch { return {}; }
})();

const keyOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

let publishTimer = null;
function publish(now = false) {
  if (publishTimer && !now) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    publishTimer = null;
    try {
      const r = await fetch(`${EVOL}/api/channels/${PREFIX}.media?producer=video`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(media) });
      if (!r.ok) console.error(`publish: ${r.status}`);
    } catch (e) { console.error(String(e)); }
  }, now ? 0 : 400); // progress updates coalesced
}
const save = () => {
  const ready = Object.fromEntries(Object.entries(media).filter(([, e]) => e.status === 'ready'));
  fs.writeFileSync(INDEX, JSON.stringify(ready, null, 1));
};

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    p.stdout.on('data', (d) => {
      out += d;
      buf += d;
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) { onLine?.(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} exited ${code}`))));
  });
}

const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  const url = queue.shift();
  if (!url) return;
  busy = true;
  const e = media[url];
  const key = keyOf(url);
  try {
    e.status = 'downloading';
    publish(true);
    const info = JSON.parse(await ytdlp(['-J', '--no-playlist', '--no-warnings', url]));
    e.title = info.title ?? url;
    e.duration = info.duration ?? null;
    publish(true);
    const fmt = `bv*[height<=${MAX_H}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${MAX_H}][ext=mp4]/bv*[height<=${MAX_H}]+ba/b`;
    await ytdlp([
      '-f', fmt, '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-playlist', '--no-warnings', '--newline',
      '--postprocessor-args', 'ffmpeg:-movflags +faststart',
      '-o', path.join(DIR, `${key}.%(ext)s`), url,
    ], (line) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) { e.progress = Math.min(1, Number(m[1]) / 100); publish(); }
    });
    const file = fs.readdirSync(DIR).find((f) => f.startsWith(`${key}.`) && !/\.(part|ytdl|json)$/.test(f) && !/\.f\d+\./.test(f));
    if (!file) throw new Error('download finished but no file was produced');
    Object.assign(e, { status: 'ready', progress: 1, src: `/media/${file}` });
    save();
    console.log(`ready: ${e.title} → ${file}`);
  } catch (err) {
    Object.assign(e, { status: 'error', error: String(err.message ?? err).replace(/^ERROR:\s*/, '').slice(0, 300) });
    console.error(`failed: ${url}: ${e.error}`);
  }
  publish(true);
  busy = false;
  void pump();
}

function request(v) {
  const url = typeof v === 'string' ? v : v && typeof v === 'object' ? v.url : null;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return;
  const u = url.trim();
  const e = media[u];
  if (e && (e.status === 'ready' || e.status === 'downloading' || e.status === 'queued')) { publish(true); return; }
  media[u] = { status: 'queued', progress: 0, src: '', title: '', duration: null };
  queue.push(u);
  publish(true);
  void pump();
}

/** Follow the request channel over SSE (only values published after we connect). */
function follow(channel) {
  const url = new URL(`${EVOL}/api/channels/${encodeURIComponent(channel)}/events`);
  const connect = () => {
    const req = (url.protocol === 'https:' ? https : http).get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          // the value already on the channel when we connect is a past request: still serve it (cheap if cached)
          try { request(JSON.parse(data)); } catch { /* ignore */ }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

publish(true);
follow(`${PREFIX}.request`);
console.log(`video: ${Object.keys(media).length} cached, serving ${DIR}`);
