// File-system source for the file-browser widgets (fb-columns, fb-palm, fb-tunnel): directory listings and file previews.
//
//   <P>.request = {cmd: 'list', path, hidden?, reply, nonce} | {cmd: 'preview', path, reply, nonce}
//     path: absolute, or "~" / "~/…" for the home folder; reply: the channel to answer on
//     (each widget uses its own, e.g. files.view.<entityId>).
//   reply (list)    = {kind: 'list', path, display, parent, entries: [{name, type: dir|file|link, size, mtime, ext}],
//                      truncated, error?, nonce}
//   reply (preview) = {kind: 'preview', path, name, size, mtime, type: 'text'|'image'|'video'|'binary'|'denied'|'error',
//                      text?, lines?, truncated?, src? ('/media/…'), converting?, error?, nonce}
//     video: mp4/m4v/webm play directly (symlink in data/media); mov/mkv/avi/… are converted once to MP4 —
//     the first reply has converting: true and no src, a second reply with src follows on the same channel.
//   {cmd: 'tree', path, depth? (1–3, default 2), hidden?, reply, nonce}
//     → {kind: 'tree', path, display, root: Node, partial, error?, nonce}
//       Node = {name, path, type: dir|file, size (bytes, recursive for dirs), files (count), mtime, ext, children?: Node[]}
//       Sizes are totals over the whole subtree (bounded: ~60k entries / 4 s, then partial: true); children
//       are listed down to `depth`, biggest first, at most 200 per folder.
//   {cmd: 'search', path, query, limit? (default 60), hidden?, reply, nonce}
//     → {kind: 'search', path, query, results: [{name, path, display, type, size, mtime, ext, score}], scanned, partial, nonce}
//       Fuzzy name match (substring beats subsequence; shorter / shallower wins) under `path`, skipping
//       node_modules, .git, caches and simple .gitignore'd names. An empty query returns the most recently
//       modified files ("recents"). The name index of a root is cached for ~60 s, so typing is fast.
//
// Privacy: hidden entries (dot files) are listed only with hidden: true, and some paths are never
// listed or read even then (ssh/gpg keys, the EvolSpace secrets file, .env files, credential stores).
// Image previews are downscaled with ffmpeg into data/media/ (served at /media/…).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'files');
const MEDIA = path.resolve(arg('media', '../../../data/media'));
const MAX_ENTRIES = 2000;
const MAX_TEXT = 64 * 1024;
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const HOME = os.homedir();

/** Paths never listed or read, whatever the hidden flag says. */
const DENY = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.config\/evolspace\/secrets\.env$/, /(^|\/)\.env(\.[\w-]+)?$/,
  /(^|\/)\.aws(\/|$)/, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.netrc$/, /(^|\/)\.pgpass$/, /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/, /(^|\/)\.claude\/\.credentials\.json$/, /(^|\/)\.kube\/config$/, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /(^|\/)\.local\/share\/keyrings(\/|$)/, /(^|\/)\.mozilla\/firefox\/[^/]+\/(logins\.json|key4\.db|cookies\.sqlite)$/,
];
export const denied = (p) => DENY.some((re) => re.test(p));

export function resolvePath(p) {
  let s = String(p ?? '').trim() || '~';
  if (s === '~') s = HOME;
  else if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  return path.resolve(s);
}
export const displayPath = (abs) => (abs === HOME ? '~' : abs.startsWith(HOME + path.sep) ? `~/${abs.slice(HOME.length + 1)}` : abs);

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'kt', 'cs', 'rb', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql',
  'svelte', 'vue', 'gd', 'glsl', 'wgsl', 'hlsl', 'cu', 'cuh', 'tex', 'bib', 'r', 'jl', 'swift', 'dart', 'gradle', 'cmake', 'mk', 'dockerfile', 'gitignore', 'env', 'lock']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'avif', 'heic']);
/** Videos the headset browser plays as they are (served through a symlink in data/media). */
const VIDEO_DIRECT = new Set(['mp4', 'm4v', 'webm']);
/** Videos converted once to H.264/AAC MP4 (cached in data/media) before they can play. */
const VIDEO_CONVERT = new Set(['mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv']);
const converting = new Map(); // output file → Promise
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export async function list(p, hidden = false) {
  const abs = resolvePath(p);
  const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
  const base = { kind: 'list', path: abs, display: displayPath(abs), parent };
  if (denied(abs)) return { ...base, entries: [], truncated: false, error: 'This folder is private and never shown.' };
  let dirents;
  try { dirents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) {
    return { ...base, entries: [], truncated: false, error: e.code === 'EACCES' ? 'Permission denied' : e.code === 'ENOENT' ? 'No such folder' : e.code === 'ENOTDIR' ? 'Not a folder' : String(e.message) };
  }
  const entries = [];
  for (const d of dirents) {
    if (!hidden && d.name.startsWith('.')) continue;
    const full = path.join(abs, d.name);
    if (denied(full)) continue;
    let st = null;
    try { st = await fs.promises.stat(full); } catch { /* dangling link */ }
    const type = st?.isDirectory() ? 'dir' : d.isSymbolicLink() && !st ? 'link' : 'file';
    entries.push({ name: d.name, type, size: st?.isFile() ? st.size : null, mtime: st ? Math.round(st.mtimeMs) : null, ext: type === 'dir' ? '' : extOf(d.name) });
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || collator.compare(a.name, b.name));
  return { ...base, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

function ffmpegThumb(src, dst) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', "scale='min(900,iw)':-2", '-q:v', '4', dst], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${c}`))));
  });
}

/**
 * Video previews: direct formats get a symlink in data/media (instant); others are converted once with
 * ffmpeg (≤1280 px, H.264 + AAC, faststart) — the first reply says {converting: true} and, if `onLater`
 * is given, a second reply with `src` follows when the conversion is done.
 */
async function videoPreview(abs, st, ext, meta, onLater) {
  fs.mkdirSync(MEDIA, { recursive: true });
  const key = createHash('sha1').update(`${abs}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16);
  if (VIDEO_DIRECT.has(ext)) {
    const link = path.join(MEDIA, `file-${key}.${ext}`);
    try { if (!fs.existsSync(link)) fs.symlinkSync(abs, link); } catch (e) { return { ...meta, type: 'error', error: `Can't serve this video: ${e.message}` }; }
    return { ...meta, type: 'video', src: `/media/${path.basename(link)}` };
  }
  const out = path.join(MEDIA, `video-${key}.mp4`);
  if (fs.existsSync(out)) return { ...meta, type: 'video', src: `/media/${path.basename(out)}` };
  if (!converting.has(out)) {
    const tmp = `${out}.part.mp4`;
    converting.set(out, new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-i', abs, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (c) => {
        if (c === 0) { fs.renameSync(tmp, out); resolve(); }
        else { fs.rmSync(tmp, { force: true }); reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${c}`)); }
      });
    }).finally(() => converting.delete(out)));
  }
  converting.get(out).then(
    () => onLater?.({ ...meta, type: 'video', src: `/media/${path.basename(out)}` }),
    (e) => onLater?.({ ...meta, type: 'error', error: `Can't convert this video: ${String(e.message).slice(0, 120)}` }),
  );
  return { ...meta, type: 'video', converting: true };
}

export async function preview(p, onLater = null) {
  const abs = resolvePath(p);
  const name = path.basename(abs);
  const base = { kind: 'preview', path: abs, name };
  if (denied(abs)) return { ...base, type: 'denied', error: 'This file is private and never shown.' };
  let st;
  try { st = await fs.promises.stat(abs); } catch (e) { return { ...base, type: 'error', error: e.code === 'ENOENT' ? 'No such file' : String(e.message) }; }
  const meta = { ...base, size: st.size, mtime: Math.round(st.mtimeMs) };
  if (!st.isFile()) return { ...meta, type: 'error', error: 'Not a file' };
  const ext = extOf(name);
  if (VIDEO_DIRECT.has(ext) || VIDEO_CONVERT.has(ext)) return videoPreview(abs, st, ext, meta, onLater);
  if (IMAGE_EXT.has(ext)) {
    try {
      fs.mkdirSync(MEDIA, { recursive: true });
      const key = createHash('sha1').update(`${abs}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16);
      const out = path.join(MEDIA, `preview-${key}.jpg`);
      if (!fs.existsSync(out)) await ffmpegThumb(abs, out);
      return { ...meta, type: 'image', src: `/media/${path.basename(out)}` };
    } catch (e) {
      return { ...meta, type: 'error', error: `Can't preview this image: ${String(e.message).slice(0, 120)}` };
    }
  }
  // text: by extension, or by content (no NUL bytes in the first 8 KB)
  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(Math.min(MAX_TEXT, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    const binary = head.subarray(0, 8192).includes(0);
    if (binary && !TEXT_EXT.has(ext)) return { ...meta, type: 'binary' };
    const text = head.toString('utf8').replace(/\r\n?/g, '\n');
    return { ...meta, type: 'text', text, lines: text.split('\n').length, truncated: st.size > bytesRead };
  } catch (e) {
    return { ...meta, type: 'error', error: e.code === 'EACCES' ? 'Permission denied' : String(e.message) };
  } finally {
    await fh?.close();
  }
}

// ---- tree (recursive sizes) -------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.next', 'dist', 'build', 'target', '.npm', '.cargo', '.rustup', 'proc', 'sys']);

export async function tree(p, depth = 2, hidden = false) {
  const abs = resolvePath(p);
  const base = { kind: 'tree', path: abs, display: displayPath(abs) };
  if (denied(abs)) return { ...base, root: null, partial: false, error: 'This folder is private and never shown.' };
  const budget = { entries: 60000, until: Date.now() + 4000, partial: false };
  depth = Math.max(1, Math.min(3, Number(depth) || 2));
  async function walk(dir, name, level) {
    const node = { name, path: dir, type: 'dir', size: 0, files: 0, mtime: null, ext: '', children: level < depth ? [] : undefined };
    if (budget.entries <= 0 || Date.now() > budget.until) { budget.partial = true; return node; }
    let ds;
    try { ds = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return node; }
    for (const d of ds) {
      if (--budget.entries <= 0 || Date.now() > budget.until) { budget.partial = true; break; }
      if (!hidden && d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (denied(full) || d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        const child = SKIP_DIRS.has(d.name) && level > 0 ? { name: d.name, path: full, type: 'dir', size: 0, files: 0, mtime: null, ext: '', skipped: true } : await walk(full, d.name, level + 1);
        node.size += child.size; node.files += child.files;
        node.children?.push(child);
      } else if (d.isFile()) {
        let st = null;
        try { st = await fs.promises.stat(full); } catch { /* gone */ }
        const size = st?.size ?? 0;
        node.size += size; node.files += 1;
        node.children?.push({ name: d.name, path: full, type: 'file', size, files: 1, mtime: st ? Math.round(st.mtimeMs) : null, ext: extOf(d.name) });
      }
    }
    if (node.children) { node.children.sort((a, b) => b.size - a.size); node.children = node.children.slice(0, 200); }
    return node;
  }
  const root = await walk(abs, path.basename(abs) || abs, 0);
  return { ...base, root, partial: budget.partial };
}

// ---- search / recents --------------------------------------------------------------------------

/** Fuzzy score of `name` for `q` (lowercase); 0 = no match. */
export function fuzzyScore(name, q) {
  const n = name.toLowerCase();
  if (!q) return 1;
  const i = n.indexOf(q);
  if (i >= 0) return 1000 - i * 2 - (n.length - q.length) + (i === 0 ? 200 : 0) + (n === q ? 500 : 0);
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < n.length && j < q.length; k++) if (n[k] === q[j]) { if (last >= 0) gaps += k - last - 1; last = k; j++; }
  return j === q.length ? Math.max(1, 300 - gaps * 5 - (n.length - q.length)) : 0;
}

/** Simple .gitignore names (no globs / negation) to skip below that folder: "data/", "node_modules", "*.log" is ignored. */
async function ignoredNames(dir) {
  try {
    const txt = await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8');
    return new Set(txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && !/[*?[\]]/.test(l))
      .map((l) => l.replace(/^\//, '').replace(/\/$/, '')).filter((l) => l && !l.includes('/')));
  } catch { return null; }
}

/** Name index of everything under a root (cached ~60 s; built breadth-first within a budget). */
const indexes = new Map();
const building = new Map(); // key → Promise: concurrent searches of one root share a single build
function indexOf(abs, hidden) {
  const key = `${abs}|${hidden}`;
  const cached = indexes.get(key);
  if (cached && Date.now() - cached.at < 60000) return Promise.resolve(cached);
  if (!building.has(key)) building.set(key, buildIndex(abs, hidden, key).finally(() => building.delete(key)));
  return building.get(key);
}
async function buildIndex(abs, hidden, key) {
  const entries = [];
  const until = Date.now() + 8000;
  let partial = false;
  const queue = [[abs, 0, null]];
  while (queue.length) {
    const [dir, level, inherited] = queue.shift();
    if (Date.now() > until || entries.length > 250000) { partial = true; break; }
    let ds;
    try { ds = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const own = await ignoredNames(dir);
    const ignore = own ? new Set([...(inherited ?? []), ...own]) : inherited;
    for (const d of ds) {
      if (!hidden && d.name.startsWith('.')) continue;
      if (ignore?.has(d.name) || d.isSymbolicLink()) continue;
      const full = path.join(dir, d.name);
      if (denied(full)) continue;
      const isDir = d.isDirectory();
      if (isDir && (SKIP_DIRS.has(d.name) || d.name === 'browser-profile')) continue;
      entries.push({ name: d.name, path: full, type: isDir ? 'dir' : 'file', level, mtime: undefined });
      if (isDir && level < 10) queue.push([full, level + 1, ignore]);
    }
  }
  const idx = { at: Date.now(), entries, partial };
  indexes.set(key, idx);
  if (indexes.size > 8) indexes.delete(indexes.keys().next().value);
  return idx;
}

async function statInto(e) {
  if (e.mtime !== undefined) return e;
  try { const st = await fs.promises.stat(e.path); e.mtime = Math.round(st.mtimeMs); e.size = e.type === 'file' ? st.size : null; } catch { e.mtime = null; e.size = null; }
  return e;
}

export async function search(p, query, limit = 60, hidden = false) {
  const abs = resolvePath(p);
  const q = String(query ?? '').trim().toLowerCase();
  const base = { kind: 'search', path: abs, display: displayPath(abs), query: q };
  if (denied(abs)) return { ...base, results: [], scanned: 0, partial: false, error: 'This folder is private and never shown.' };
  limit = Math.max(1, Math.min(500, Number(limit) || 60));
  const idx = await indexOf(abs, hidden);
  let picked;
  if (q) {
    const scored = [];
    for (const e of idx.entries) { const sc = fuzzyScore(e.name, q); if (sc > 0) scored.push([sc - e.level * 10, e]); }
    scored.sort((a, b) => b[0] - a[0]);
    picked = scored.slice(0, limit).map(([sc, e]) => ({ e, score: sc }));
  } else {
    // recents: stat files (bounded), newest first
    const files = idx.entries.filter((e) => e.type === 'file').slice(0, 60000);
    for (let i = 0; i < files.length; i += 500) await Promise.all(files.slice(i, i + 500).map(statInto));
    files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    picked = files.slice(0, limit).map((e) => ({ e, score: 0 }));
  }
  const results = [];
  for (const { e, score } of picked) {
    await statInto(e);
    results.push({ name: e.name, path: e.path, display: displayPath(e.path), type: e.type, size: e.size ?? null, mtime: e.mtime ?? null, ext: e.type === 'file' ? extOf(e.name) : '', score });
  }
  return { ...base, results, scanned: idx.entries.length, partial: idx.partial };
}

async function publish(channel, value) {
  try {
    const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=files`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) console.error(`publish ${channel}: ${r.status}`);
  } catch (e) { console.error(String(e)); }
}

async function handle(req) {
  if (!req || typeof req !== 'object' || typeof req.reply !== 'string' || !req.reply.startsWith(`${P}.`)) return;
  const later = (v) => publish(req.reply, { ...v, nonce: req.nonce ?? null });
  const out = req.cmd === 'preview' ? await preview(req.path, later)
    : req.cmd === 'tree' ? await tree(req.path, req.depth, !!req.hidden)
      : req.cmd === 'search' ? await search(req.path, req.query, req.limit, !!req.hidden)
        : await list(req.path, !!req.hidden);
  await publish(req.reply, { ...out, nonce: req.nonce ?? null });
}

/** New requests only (by seq), so a restart doesn't replay old ones. */
async function follow(channel, cb) {
  let lastSeq = 0;
  try { const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}`); if (r.ok) lastSeq = Number(r.headers.get('x-seq')) || 0; } catch { /* none yet */ }
  const url = new URL(`${EVOL}/api/channels/${encodeURIComponent(channel)}/events`);
  const connect = () => {
    const req = (url.protocol === 'https:' ? https : http).get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const lines = buf.slice(0, i).split('\n');
          buf = buf.slice(i + 2);
          const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          const seq = Number(lines.find((l) => l.startsWith('id: '))?.slice(4));
          if (!data || !Number.isFinite(seq)) continue;
          if (seq < lastSeq) { lastSeq = seq; continue; }
          if (seq === lastSeq) continue;
          lastSeq = seq;
          try { void cb(JSON.parse(data)); } catch { /* ignore */ }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

/**
 * Place a file / folder in the room (the palm browser's drag-out): spawn an `fb-columns` root entity at the
 * drop point — on the folder, or on a file's folder with that file previewed.
 *   <P>.palm.place = {path, type: 'file'|'dir'|'link', name?, position: [x,y,z], rotation?: [x,y,z,w], reply?, nonce?}
 *   reply ← {nonce, ok, entity?, error?}
 */
async function place(req) {
  if (!req || typeof req !== 'object' || typeof req.path !== 'string' || !Array.isArray(req.position) || req.position.length !== 3 || !req.position.every(Number.isFinite)) return;
  const abs = resolvePath(req.path);
  const answer = (v) => (typeof req.reply === 'string' && req.reply.startsWith(`${P}.`) ? publish(req.reply, { nonce: req.nonce ?? null, ...v }) : null);
  if (denied(abs)) return answer({ ok: false, error: 'private path' });
  const isDir = req.type === 'dir';
  const rot = Array.isArray(req.rotation) && req.rotation.length === 4 && req.rotation.every(Number.isFinite) ? req.rotation : [0, 0, 0, 1];
  const entity = {
    widget: 'fb-columns', name: `Files · ${path.basename(abs) || abs}`,
    props: isDir ? { path: displayPath(abs) } : { path: displayPath(path.dirname(abs)), file: abs },
    transform: { position: req.position, rotation: rot, scale: [1, 1, 1] },
  };
  try {
    const r = await fetch(`${EVOL}/api/scene/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'user', ops: [{ op: 'add', entity }] }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error ?? `HTTP ${r.status}`);
    await answer({ ok: true, entity: out.ids?.[0] ?? null });
  } catch (e) {
    console.error(`place ${abs}: ${e.message ?? e}`);
    await answer({ ok: false, error: String(e.message ?? e) });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await follow(`${P}.request`, handle);
  await follow(`${P}.palm.place`, place);
  console.log(`files: listening on ${P}.request (home ${HOME})`);
}
