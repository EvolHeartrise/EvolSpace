// Spotify source for the spotify widget: EvolSpace's own Spotify client.
//
// The player is go-librespot (github.com/devgianlu/go-librespot — a librespot port with a local HTTP +
// WebSocket API, the approach third-party clients like spotifyd / spotify-player / ncspot build on).
// It runs as a Spotify Connect device named "EvolSpace" (it also shows up in the phone/desktop apps),
// decodes the music itself and writes raw PCM into a FIFO; this source paces that PCM in real time and
// publishes it as an audio stream that the widget plays in the headset (WebAudio).
//
// Needs Spotify Premium (all librespot clients do). Sign-in is Spotify's device pairing: the widget shows a
// code to enter at spotify.com/pair; the credentials are kept in data/spotify/config (never in channels).
// Note: like every librespot client this is unofficial and against Spotify's terms of service.
//
//   <P>.state         {auth: 'installing'|'starting'|'login'|'ready'|'error', login?: {url, code, expires},
//                      error?, device, track?: {uri, name, artists[], album, albumUri, cover, duration},
//                      position, positionAt, paused, stopped, buffering, volume (0–100), shuffle,
//                      repeatContext, repeatTrack, contextUri, contextName, liked?}
//   <P>.audio.stream  PCM chunks: i16 tensor [samples], interleaved stereo 44.1 kHz, 100 ms each, in order
//   <P>.search        {query, at, tracks[], albums[], artists[], playlists[]} (latest search; Item below)
//   <P>.request  ←    {cmd: 'play', uri, skipTo?} | resume | pause | playpause | next | prev | {cmd: 'seek', position} |
//                     {cmd: 'volume', volume} | {cmd: 'shuffle', on} | {cmd: 'repeat', mode: off|context|track} |
//                     {cmd: 'queue', uri} | {cmd: 'like', uri, liked} | {cmd: 'search', query} |
//                     {cmd: 'library', reply, nonce} | {cmd: 'tracks', uri, reply, nonce} | logout
//     replies on `reply`: {nonce, kind: 'library'|'tracks', uri?, name?, items: Item[], error?}
//     Item = {uri, name, sub, image?, duration?, kind: 'track'|'playlist'|'album'|'artist'|'collection', context?}
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'spotify');
const PORT = Number(arg('port', '3679'));
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const DATA = path.resolve(arg('data', '../../../data/spotify'));
const MEDIA = path.resolve(arg('media', '../../../data/media'));
const API = `http://127.0.0.1:${PORT}`;

// go-librespot release, pinned and checksum-verified (GitHub release asset digest).
const GLR = {
  version: 'v0.10.3',
  url: 'https://github.com/devgianlu/go-librespot/releases/download/v0.10.3/go-librespot_linux_x86_64.tar.gz',
  sha256: '8006f7f967704955c7e4f5f19bdd3cbf68c14d1ce100d9248a7db28884d61bd4',
};
const BIN_DIR = path.join(DATA, 'bin');
const BIN = path.join(BIN_DIR, 'go-librespot');
const CONFIG_DIR = path.join(DATA, 'config');
const FIFO = path.join(DATA, 'audio.fifo');

// 44.1 kHz stereo s16le: 100 ms chunks.
const RATE = 44100;
const BYTES_PER_SEC = RATE * 2 * 2;
const CHUNK = BYTES_PER_SEC / 10;
/** How far ahead of real time the stream may run (the widget's jitter buffer absorbs it). */
const LEAD_MS = 300;

// ---------------------------------------------------------------- EvolSpace channels

async function publish(channel, value) {
  try {
    const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=spotify`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) console.error(`publish ${channel}: ${r.status}`);
  } catch (e) { console.error(`publish ${channel}: ${e.message}`); }
}

let pcmChain = Promise.resolve();
/** Publish one PCM chunk (in order: chained). */
function publishPcm(buf) {
  pcmChain = pcmChain.then(async () => {
    try {
      await fetch(`${EVOL}/api/channels/${encodeURIComponent(`${P}.audio.stream`)}?producer=spotify`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Dtype': 'i16', 'X-Shape': String(buf.length / 2) }, body: buf,
      });
    } catch { /* server restarting: drop */ }
  });
}

/** New values only (by seq), so a restart doesn't replay old requests. */
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
          try { void Promise.resolve(cb(JSON.parse(data))).catch((e) => console.error(`${channel}: ${e.message}`)); } catch { /* ignore */ }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

// ---------------------------------------------------------------- media (album art)

/** Album art → a same-origin /media file (downloaded once), or undefined while it downloads. */
const art = new Map(); // url → '/media/…' | Promise
export function artName(url) {
  const id = String(url).split('/').pop()?.replace(/[^A-Za-z0-9]/g, '').slice(-40) || createHash('sha1').update(String(url)).digest('hex');
  return `spotify-${id}.jpg`;
}
function cover(url, onReady) {
  if (!url) return undefined;
  const v = art.get(url);
  if (typeof v === 'string') return v;
  const name = artName(url);
  const file = path.join(MEDIA, name);
  if (fs.existsSync(file)) { art.set(url, `/media/${name}`); return `/media/${name}`; }
  if (!v) {
    art.set(url, limited(async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.mkdirSync(MEDIA, { recursive: true });
        fs.writeFileSync(`${file}.part`, Buffer.from(await r.arrayBuffer()));
        fs.renameSync(`${file}.part`, file);
        art.set(url, `/media/${name}`);
        onReady?.();
      } catch { art.delete(url); }
    }));
  }
  return undefined;
}

/** At most 4 art downloads at a time (a long list must not open hundreds of requests). */
let active = 0;
const waiting = [];
function limited(job) {
  return new Promise((resolve) => {
    const run = () => { active++; job().finally(() => { active--; waiting.shift()?.(); resolve(); }); };
    if (active < 4) run(); else waiting.push(run);
  });
}

// ---------------------------------------------------------------- go-librespot

async function ensureBinary() {
  const stamp = path.join(BIN_DIR, 'VERSION');
  if (fs.existsSync(BIN) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === GLR.version) return;
  setState({ auth: 'installing' });
  console.log(`installing go-librespot ${GLR.version}`);
  const r = await fetch(GLR.url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const tgz = Buffer.from(await r.arrayBuffer());
  const sum = createHash('sha256').update(tgz).digest('hex');
  if (sum !== GLR.sha256) throw new Error(`go-librespot download checksum mismatch (${sum})`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const archive = path.join(BIN_DIR, 'go-librespot.tar.gz');
  fs.writeFileSync(archive, tgz);
  const x = spawnSync('tar', ['-xzf', archive, '-C', BIN_DIR], { encoding: 'utf8' });
  fs.rmSync(archive, { force: true });
  if (x.status !== 0 || !fs.existsSync(BIN)) throw new Error(`could not unpack go-librespot: ${x.stderr || x.status}`);
  fs.chmodSync(BIN, 0o755);
  fs.writeFileSync(stamp, GLR.version);
}

export function configYaml() {
  return [
    'device_name: EvolSpace',
    'device_type: computer',
    'audio_backend: pipe',
    `audio_output_pipe: ${JSON.stringify(FIFO)}`,
    'audio_output_pipe_format: s16le',
    'audio_output_pipe_wait_for_reader: true',
    'bitrate: 320',
    'volume_steps: 100',
    'initial_volume: 60',
    'zeroconf_enabled: false',
    'credentials:',
    '  type: device_auth',
    'server:',
    '  enabled: true',
    '  address: localhost',
    `  port: ${PORT}`,
    '  image_size: large',
    'metadata:',
    '  enabled: true',
    '  max_tracks: 2000', // long Liked Songs
    'cache:',
    '  enabled: true',
    `  dir: ${JSON.stringify(path.join(DATA, 'cache'))}`,
    '  size_limit: 1GB',
    '',
  ].join('\n');
}

let child = null;
let stopping = false;
function startPlayer() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.yml'), configYaml());
  if (!fs.existsSync(FIFO)) {
    const m = spawnSync('mkfifo', [FIFO]);
    if (m.status !== 0) throw new Error('mkfifo failed');
  }
  child = spawn(BIN, ['--config_dir', CONFIG_DIR], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.log(`[go-librespot] ${redact(l)}`); };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    console.log(`go-librespot exited (${code}); restarting in 3 s`);
    setState({ auth: 'starting' });
    setTimeout(startPlayer, 3000);
  });
}
/** Never echo tokens / codes into logs. */
const redact = (l) => l.replace(/(token|code|access_token)([=: "]+)[\w.-]{12,}/gi, '$1$2…');

async function api(method, p, body) {
  const r = await fetch(`${API}${p}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) throw new Error(text.trim() || `HTTP ${r.status}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// ---------------------------------------------------------------- audio: FIFO → paced 100 ms chunks

function readAudio() {
  // Opening a FIFO for reading blocks until the player opens it for writing (on first play).
  const stream = fs.createReadStream(FIFO, { highWaterMark: CHUNK });
  let pending = Buffer.alloc(0);
  let t0 = 0; // wall clock of the stream's sample 0 (re-anchored after gaps)
  let sent = 0; // bytes sent since t0
  let resumeTimer = null;
  stream.on('data', (data) => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    const now = Date.now();
    // A gap (pause, track loading): start a new real-time anchor.
    if (!t0 || now - (t0 + (sent / BYTES_PER_SEC) * 1000) > 250) { t0 = now; sent = 0; }
    while (pending.length >= CHUNK) {
      publishPcm(pending.subarray(0, CHUNK));
      pending = pending.subarray(CHUNK);
      sent += CHUNK;
    }
    // Pace: don't read further ahead of real time than LEAD_MS (the player blocks on the full pipe,
    // which keeps its position honest).
    const ahead = t0 + (sent / BYTES_PER_SEC) * 1000 - Date.now();
    if (ahead > LEAD_MS) {
      stream.pause();
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => stream.resume(), ahead - LEAD_MS / 2);
    }
  });
  const reopen = () => { clearTimeout(resumeTimer); setTimeout(readAudio, 200); };
  stream.on('end', reopen);
  stream.on('error', (e) => { console.error(`audio pipe: ${e.message}`); setTimeout(readAudio, 2000); });
}

// ---------------------------------------------------------------- state

let state = { auth: 'starting', device: 'EvolSpace' };
let stateTimer = null;
function setState(patch) {
  state = { ...state, ...patch };
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => void publish(`${P}.state`, state), 30);
}

let refreshing = null;
let refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = (async () => {
    try {
      const s = await api('GET', '/status');
      if (!s) {
        // No session yet: device pairing (spotify.com/pair + code).
        const c = await api('GET', '/auth/code').catch(() => null);
        setState({ auth: 'login', login: c ? { url: c.url ?? 'https://www.spotify.com/pair', code: c.code, expires: c.expires_at ?? null } : null, track: undefined });
        return;
      }
      const t = s.track;
      const steps = s.volume_steps || 100;
      setState({
        auth: 'ready', login: undefined, error: undefined, user: s.username, device: s.device_name || 'EvolSpace',
        track: t ? {
          uri: t.uri, name: t.name, artists: t.artist_names ?? [], album: t.album_name ?? '', albumUri: t.album_uri ?? '',
          cover: cover(t.album_cover_url, () => void refresh()), duration: t.duration ?? 0,
        } : undefined,
        position: t?.position ?? 0, positionAt: Date.now(),
        paused: !!s.paused, stopped: !!s.stopped, buffering: !!s.buffering,
        volume: Math.round(((s.volume ?? 0) / steps) * 100),
        shuffle: !!s.shuffle_context, repeatContext: !!s.repeat_context, repeatTrack: !!s.repeat_track,
        contextUri: s.context_uri ?? '', contextName: s.context_name ?? '',
      });
    } catch (e) {
      setState({ auth: child ? 'starting' : 'error', error: child ? undefined : e.message });
    } finally {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  })();
  await refreshing;
}

function listenEvents() {
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`); } catch { setTimeout(listenEvents, 2000); return; }
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(String(ev.data)); } catch { /* ignore */ }
    if (m?.type === 'playback_error') setState({ error: m.data?.message || m.data?.kind || 'playback error' });
    void refresh();
  };
  ws.onopen = () => void refresh();
  ws.onclose = () => setTimeout(listenEvents, 2000);
  ws.onerror = () => { /* onclose follows */ };
}

// ---------------------------------------------------------------- library, search

const kindOf = (uri) => String(uri).split(':')[1] ?? '';

export function trackItem(t, image) {
  return {
    uri: t.uri, kind: 'track', name: t.name ?? '', sub: (t.artist_names ?? t.artists?.map((a) => a.name) ?? []).join(', '),
    ...(t.duration ?? t.duration_ms ? { duration: t.duration ?? t.duration_ms } : {}),
    ...(image ? { image } : {}),
  };
}

async function library() {
  const r = await api('GET', '/library/playlists?offset=0&limit=200');
  const lists = Array.isArray(r) ? r : r?.playlists ?? r?.items ?? [];
  const items = [{ uri: 'spotify:collection:tracks', kind: 'collection', name: 'Liked Songs', sub: 'Playlist' }];
  for (const p of lists) {
    if (!p?.uri) continue;
    items.push({ uri: p.uri, kind: 'playlist', name: p.name ?? 'Playlist', sub: [p.owner_username ? `By ${p.owner_username}` : '', p.length ? `${p.length} songs` : ''].filter(Boolean).join(' · '), ...(p.image_url ? { image: cover(p.image_url) ?? undefined } : {}), imageUrl: p.image_url });
  }
  return items;
}

/** Liked Songs: the widget asks for spotify:collection:tracks, go-librespot knows it as the user's collection. */
const contextUri = (uri) => (uri === 'spotify:collection:tracks' && state.user ? `spotify:user:${state.user}:collection` : uri);

async function contextTracks(uri) {
  // go-librespot resolves contexts lazily: poll until ready.
  for (let i = 0; i < 20; i++) {
    const r = await api('GET', `/context/tracks?uri=${encodeURIComponent(contextUri(uri))}`);
    // Entries are {track: {...}} (go-librespot v0.10); older/other shapes are the track itself.
    const tracks = (r?.tracks ?? r?.items ?? []).map((e) => e?.track ?? e).filter((t) => t?.uri);
    const done = !r || (r.ready !== false && (r.cached == null || r.length == null || r.cached >= r.length));
    if (done) return { name: r?.name ?? '', items: tracks.map((t) => trackItem(t, cover(t.album_cover_url ?? t.image_url, () => republishTracks(uri)))) };
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('timed out loading tracks');
}

/** Album art finished downloading for a list somebody is looking at: resend it (throttled per list). */
const lastTracksReply = new Map(); // context uri → reply fn
const artTimers = new Map();
function republishTracks(uri) {
  if (artTimers.has(uri) || !lastTracksReply.has(uri)) return;
  artTimers.set(uri, setTimeout(async () => {
    artTimers.delete(uri);
    const send = lastTracksReply.get(uri);
    try { const r = await contextTracks(uri); send?.({ kind: 'tracks', uri, name: r.name, items: r.items }); } catch { /* next time */ }
  }, 1500));
}

let token = null;
async function webToken() {
  if (token && token.until > Date.now()) return token.value;
  const r = await api('POST', '/token');
  const value = r?.token ?? r?.access_token;
  if (!value) throw new Error('no Web API token');
  token = { value, until: Date.now() + 30 * 60_000 };
  return value;
}

async function search(query) {
  const q = String(query ?? '').trim();
  if (!q) return;
  const tok = await webToken();
  const r = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track,album,artist,playlist', limit: '10' })}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 401) token = null;
  if (!r.ok) throw new Error(`search failed: HTTP ${r.status}`);
  const j = await r.json();
  const img = (images) => {
    const list = (images ?? []).filter(Boolean).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const pick = list.find((i) => (i.width ?? 0) >= 160) ?? list.at(-1);
    return pick?.url ? cover(pick.url, () => void publishSearchSoon()) : undefined;
  };
  lastSearch = {
    query: q, at: Date.now(),
    tracks: (j.tracks?.items ?? []).filter(Boolean).map((t) => ({ uri: t.uri, kind: 'track', name: t.name, sub: t.artists.map((a) => a.name).join(', '), duration: t.duration_ms, image: img(t.album?.images), imageUrls: t.album?.images, context: t.album?.uri })),
    albums: (j.albums?.items ?? []).filter(Boolean).map((a) => ({ uri: a.uri, kind: 'album', name: a.name, sub: `Album · ${a.artists.map((x) => x.name).join(', ')}`, image: img(a.images), imageUrls: a.images })),
    artists: (j.artists?.items ?? []).filter(Boolean).map((a) => ({ uri: a.uri, kind: 'artist', name: a.name, sub: 'Artist', image: img(a.images), imageUrls: a.images })),
    playlists: (j.playlists?.items ?? []).filter(Boolean).map((p) => ({ uri: p.uri, kind: 'playlist', name: p.name, sub: `Playlist · ${p.owner?.display_name ?? ''}`, image: img(p.images), imageUrls: p.images })),
  };
  publishSearch();
}
let lastSearch = null;
let searchTimer = null;
function publishSearch() {
  if (!lastSearch) return;
  // Fill in art downloaded since.
  const fix = (it) => {
    if (it.image || !it.imageUrls) return strip(it);
    const list = it.imageUrls.filter(Boolean).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const pick = list.find((i) => (i.width ?? 0) >= 160) ?? list.at(-1);
    const image = pick?.url ? cover(pick.url) : undefined;
    return strip(image ? { ...it, image } : it);
  };
  const strip = ({ imageUrls, ...it }) => it;
  void publish(`${P}.search`, { ...lastSearch, tracks: lastSearch.tracks.map(fix), albums: lastSearch.albums.map(fix), artists: lastSearch.artists.map(fix), playlists: lastSearch.playlists.map(fix) });
}
function publishSearchSoon() {
  if (!searchTimer) searchTimer = setTimeout(() => { searchTimer = null; publishSearch(); }, 500);
}

// ---------------------------------------------------------------- requests

async function onRequest(req) {
  if (!req || typeof req !== 'object') return;
  const reply = typeof req.reply === 'string' && req.reply.startsWith(`${P}.`) ? (v) => publish(req.reply, { nonce: req.nonce ?? null, ...v }) : null;
  try {
    switch (req.cmd) {
      case 'play': {
        if (!/^spotify:/.test(String(req.uri ?? ''))) throw new Error('play needs a spotify: uri');
        await api('POST', '/player/play', { uri: contextUri(req.uri), ...(req.skipTo ? { skip_to_uri: req.skipTo } : {}) });
        break;
      }
      case 'resume': case 'pause': case 'playpause': case 'next': case 'prev':
        await api('POST', `/player/${req.cmd}`, {});
        break;
      case 'seek': await api('POST', '/player/seek', { position: Math.max(0, Math.round(Number(req.position) || 0)) }); break;
      case 'volume': await api('POST', '/player/volume', { volume: Math.max(0, Math.min(100, Math.round(Number(req.volume) || 0))) }); break;
      case 'shuffle': await api('POST', '/player/shuffle_context', { shuffle_context: !!req.on }); break;
      case 'repeat':
        await api('POST', '/player/repeat_context', { repeat_context: req.mode === 'context' || req.mode === 'track' });
        await api('POST', '/player/repeat_track', { repeat_track: req.mode === 'track' });
        break;
      case 'queue': await api('POST', '/player/add_to_queue', { uri: String(req.uri) }); break;
      case 'like': await api('POST', '/library/liked', { uris: [String(req.uri)], liked: req.liked !== false }); break;
      case 'search': await search(req.query); break;
      case 'library': reply?.({ kind: 'library', items: await library() }); break;
      case 'tracks': {
        const uri = String(req.uri);
        if (reply) lastTracksReply.set(uri, reply);
        const r = await contextTracks(uri);
        reply?.({ kind: 'tracks', uri, name: r.name, items: r.items });
        break;
      }
      case 'refresh': await refresh(); break;
      default: return;
    }
    if (['play', 'resume', 'pause', 'playpause', 'next', 'prev', 'seek', 'volume', 'shuffle', 'repeat'].includes(req.cmd)) void refresh();
  } catch (e) {
    console.error(`${req.cmd}: ${e.message}`);
    if (reply) reply({ kind: req.cmd, error: e.message, items: [] });
    else setState({ error: `${req.cmd}: ${e.message}` });
  }
}

// ---------------------------------------------------------------- main

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGTERM', () => { stopping = true; child?.kill(); process.exit(0); });
  process.on('SIGINT', () => { stopping = true; child?.kill(); process.exit(0); });
  try {
    await ensureBinary();
    startPlayer();
    readAudio();
    setTimeout(listenEvents, 1500);
    setInterval(() => void refresh(), 15_000).unref(); // position drift, login code refresh
    await follow(`${P}.request`, onRequest);
    console.log(`spotify: go-librespot ${GLR.version} on ${API}, streaming ${P}.audio.stream`);
  } catch (e) {
    console.error(e.message);
    setState({ auth: 'error', error: e.message });
    await new Promise((r) => setTimeout(r, 1000));
    process.exit(1);
  }
}
