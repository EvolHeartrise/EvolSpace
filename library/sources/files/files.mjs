// File-system source for the `file-browser` widget: directory listings and file previews.
//
//   <P>.request = {cmd: 'list', path, hidden?, reply, nonce} | {cmd: 'preview', path, reply, nonce}
//     path: absolute, or "~" / "~/…" for the home folder; reply: the channel to answer on
//     (each widget uses its own, e.g. files.view.<entityId>).
//   reply (list)    = {kind: 'list', path, display, parent, entries: [{name, type: dir|file|link, size, mtime, ext}],
//                      truncated, error?, nonce}
//   reply (preview) = {kind: 'preview', path, name, size, mtime, type: 'text'|'image'|'binary'|'denied'|'error',
//                      text?, lines?, truncated?, src? ('/media/preview-….jpg'), error?, nonce}
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

export async function preview(p) {
  const abs = resolvePath(p);
  const name = path.basename(abs);
  const base = { kind: 'preview', path: abs, name };
  if (denied(abs)) return { ...base, type: 'denied', error: 'This file is private and never shown.' };
  let st;
  try { st = await fs.promises.stat(abs); } catch (e) { return { ...base, type: 'error', error: e.code === 'ENOENT' ? 'No such file' : String(e.message) }; }
  const meta = { ...base, size: st.size, mtime: Math.round(st.mtimeMs) };
  if (!st.isFile()) return { ...meta, type: 'error', error: 'Not a file' };
  const ext = extOf(name);
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

async function publish(channel, value) {
  try {
    const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=files`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) console.error(`publish ${channel}: ${r.status}`);
  } catch (e) { console.error(String(e)); }
}

async function handle(req) {
  if (!req || typeof req !== 'object' || typeof req.reply !== 'string' || !req.reply.startsWith(`${P}.`)) return;
  const out = req.cmd === 'preview' ? await preview(req.path) : await list(req.path, !!req.hidden);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await follow(`${P}.request`, handle);
  console.log(`files: listening on ${P}.request (home ${HOME})`);
}
