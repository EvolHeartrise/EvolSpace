// BeatSaberRL replay source for the `bsrl-replay` widget. Decodes BeatSaberRL v10 replays (format-2
// .rpl.gz, the published viewer's format, or legacy JSONL v10) and publishes them as tensors:
//
//   <P>.catalog   [{id, song, difficulty, pp, score, model}]   published replays, best pp first
//   <P>.q         f32 [T, 36]  per tick: root pos xyz, root quat wxyz, 29 joint angles (world: x right, y up, notes from +z)
//   <P>.chart     f32 [N, 12]  t x y color angle speed any kind resolveTick outcome points reason
//                              outcome 0 good 1 bad 2 miss 3 bomb -1 none; reason = EVENT_REASONS index
//   <P>.walls     f32 [W, 7]   t cx cy w h l speed
//   <P>.hud       f32 [T, 8]   score max combo mult progress misses energy maxCombo (after tick k's events)
//   <P>.torque    f32 [T]      total applied torque (N·m), the seek bar graph
//   <P>.meta      {id, song, difficulty, model, pp, score, ticks, hz, handleLen, trackAnchor, index, total, loadId}
//                 published LAST: a consistent set is present once meta.loadId changes.
//   <P>.status    short text
// Control: <P>.ctl.load = "<id>" | <index> | {id} | {index} | {path} | {cmd: "next"|"prev", nonce}
//
// Mirrors BeatSaberRL viz/app/src/lib/replay.js (decodeReplay, replayFromParts) and hud.js (the
// scoring walk). BeatSaberRL itself is never touched: replays come from replays.flee.systems
// (cached under data/bsrl-replays/) as listed by the local replays-site manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import https from 'node:https';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'replay');
const MANIFEST = arg('manifest', path.join(os.homedir(), 'beat-arena-volume-backup/replays-site/manifest.json'));
const MODEL = arg('model', '');
const BASE = arg('base', 'https://replays.flee.systems');
const CACHE = path.resolve(arg('cache', '../../../data/bsrl-replays'));
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

const EVENT_REASONS = ['ok', 'slow', 'angle', 'wrong_hand', 'miss', 'post', 'bomb', 'wall', 'wall_enter'];
const KIND_BOMB = 1, KIND_CHAIN_LINK = 3;
const KIND_MAX = [115, 0, 85, 20, 60, 115];
const TAU_MAX = [
  600.00, 239.95, 375.00,
  85.38, 85.38, 19.45, 19.13, 1.06, 1.06, 1.06,
  85.38, 85.38, 19.45, 19.13, 1.06, 1.06, 1.06,
  262.50, 75.00, 135.00, 150.00, 135.00, 37.50,
  262.50, 75.00, 135.00, 150.00, 135.00, 37.50,
];
function gearTable(n) {
  const mags = { 3: [1], 5: [1, 0.25], 7: [1, 1 / 3, 0.125] }[n] ?? [1];
  const out = [0];
  for (const m of mags) out.push(m, -m);
  return out;
}

// ---- channel I/O ---------------------------------------------------------------------------------

async function put(channel, body, headers) {
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=bsrl-replay`, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`publish ${channel}: ${r.status} ${await r.text()}`);
}
const publishJson = (ch, v) => put(ch, JSON.stringify(v), { 'Content-Type': 'application/json' });
const publishF32 = (ch, data, shape) =>
  put(ch, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    'Content-Type': 'application/octet-stream', 'X-Dtype': 'f32', 'X-Shape': shape.join(','),
  });
const status = (s) => { console.log(s); return publishJson(`${P}.status`, s).catch(() => {}); };

/** Follow a channel over SSE (reconnects); cb(value, seq) for each value, the current one first. */
function follow(channel, cb) {
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
          const lines = block.split('\n');
          const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          const seq = Number(lines.find((l) => l.startsWith('id: '))?.slice(4) ?? NaN);
          if (data) { try { cb(JSON.parse(data), seq); } catch (e) { console.error('ctl:', String(e)); } }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

// ---- catalog -------------------------------------------------------------------------------------

function loadCatalog() {
  let m;
  try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {
    console.error(`no replay manifest at ${MANIFEST}: ${e}`);
    return [];
  }
  const models = Object.keys(m.models ?? {});
  const model = MODEL || models[models.length - 1];
  const entry = m.models?.[model];
  if (!entry) { console.error(`model ${model} not in manifest (have ${models.join(', ')})`); return []; }
  const rows = Object.entries(entry.replays).map(([id, r]) => {
    const pps = Object.values(r.pp ?? {}).filter(Number.isFinite);
    return { id, song: r.song ?? id, difficulty: r.difficulty ?? '', pp: pps.length ? Math.max(...pps) : 0, score: r.score ?? 0, model, file: r.file };
  });
  rows.sort((a, b) => b.pp - a.pp || a.song.localeCompare(b.song));
  return rows;
}

async function fetchReplay(row) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${row.id}.rpl.gz`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const r = await fetch(`${BASE}/${row.file ?? `r/${row.id}.rpl.gz`}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`download ${row.id}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

// ---- decoding: both formats -> {header, T, hz, q (Float32Array T*36), events[k][], torque (Float32Array T)} ----

function decodeFormat2(bytes) {
  if (bytes.subarray(0, 8).toString('latin1') !== 'BARPLAY2') throw new Error('not a beat-arena replay');
  const n = bytes.readUInt32LE(8);
  const meta = JSON.parse(bytes.subarray(12, 12 + n).toString('utf8'));
  const header = meta.header, T = meta.ticks;
  if (header.format !== 2) throw new Error(`replay format ${header.format}; this reads format 2`);
  const hz = Number(header.tick_hz) > 0 ? Number(header.tick_hz) : 30;
  const blocks = {};
  let off = 12 + n;
  off += (8 - (off % 8)) % 8;
  for (const ent of meta.blocks) {
    const len = ent.rows * ent.len;
    const size = ent.dtype === 'u8' ? len : 4 * len;
    if (off + size > bytes.length) throw new Error('the replay file is truncated');
    let v;
    if (ent.dtype === 'u8') v = bytes.subarray(off, off + len);
    else {
      v = new Float64Array(len);
      const p1 = off + len, p2 = off + 2 * len, p3 = off + 3 * len;
      for (let i = 0; i < len; i++) {
        const z = (bytes[off + i] | (bytes[p1 + i] << 8) | (bytes[p2 + i] << 16) | (bytes[p3 + i] << 24)) >>> 0;
        v[i] = z & 1 ? -(z + 1) / 2 : z / 2;
      }
    }
    off += size + (8 - (size % 8)) % 8;
    blocks[ent.name] = { ent, v };
  }
  const need = (name) => { const b = blocks[name]; if (!b) throw new Error(`the replay has no ${name} block`); return b; };
  const om = need('omega'), qb = need('q');
  const Q = Float64Array.from(qb.v);
  if (qb.ent.pred === 'omega') {
    const c = qb.ent.scale / om.ent.scale;
    for (let r = 7; r < 36; r++) {
      const o = (r - 7) * T;
      for (let k = 1; k < T; k++) Q[r * T + k] += Math.floor((c * (om.v[o + k] + om.v[o + k - 1]) + hz) / (2 * hz));
    }
  }
  if (qb.ent.delta) for (let r = 0; r < 36; r++) for (let k = 1; k < T; k++) Q[r * T + k] += Q[r * T + k - 1];
  const q = new Float32Array(T * 36);
  for (let k = 0; k < T; k++) for (let r = 0; r < 36; r++) q[k * 36 + r] = Q[r * T + k] / qb.ent.scale;

  // torque: the recorded column when present, else gear fraction x tau_max from the header body
  const torque = new Float32Array(T);
  const trq = blocks.torque;
  if (trq) for (let k = 0; k < T; k++) torque[k] = trq.v[k] / trq.ent.scale;
  else {
    const ac = need('action'), body = header.body, table = gearTable(header.config?.gears ?? 5);
    for (let k = 0; k < T; k++) {
      let s = 0;
      for (let j = 0; j < 29; j++) {
        const a = ac.v[j * T + k];
        s += Math.abs(body?.gear_frac?.[j] ? (body.gear_frac[j][a] ?? 0) * body.tau_max[j] : (table[a] ?? 0) * TAU_MAX[j]);
      }
      torque[k] = s;
    }
  }

  const en = need('event_n').v, ecode = need('event_code').v, enote = need('event_note'), ev = need('event_val');
  const nE = ecode.length, s = ev.ent.scale;
  const events = new Array(T);
  let ei = 0;
  for (let k = 0; k < T; k++) {
    const list = [];
    for (const end = ei + en[k]; ei < end; ei++) {
      const code = ecode[ei], note = enote.v[ei], points = ev.v[ei] / s;
      list.push(code === 4 ? { miss: { note } }
        : code === 5 ? { post: { note, points } }
        : code === 6 ? { bomb: { note } }
        : code === 7 ? { wall: {} }
        : code === 8 ? { wall_enter: {} }
        : { cut: { note, good: code === 0, reason: EVENT_REASONS[code], points, pre: ev.v[nE + ei] / s, acc: ev.v[2 * nE + ei] / s } });
    }
    events[k] = list;
  }
  return { header, T, hz, q, events, torque };
}

function decodeJsonl(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = JSON.parse(lines[0]).header;
  if (!header) throw new Error('not a beat-arena replay');
  const ticks = lines.slice(1).map((l) => JSON.parse(l));
  const T = ticks.length, hz = Number(header.tick_hz) > 0 ? Number(header.tick_hz) : 30;
  const q = new Float32Array(T * 36), torque = new Float32Array(T);
  const table = gearTable(header.config?.gears ?? 5);
  ticks.forEach((t, k) => {
    q.set(t.q.slice(0, 36), k * 36);
    if (Array.isArray(t.torque)) torque[k] = t.torque[0];
    else if (Array.isArray(t.action)) torque[k] = t.action.reduce((a, g, j) => a + Math.abs((table[g] ?? 0) * TAU_MAX[j]), 0);
  });
  return { header, T, hz, q, events: ticks.map((t) => t.events ?? []), torque };
}

function decode(bytes, name = '') {
  let b = bytes;
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  if (b.subarray(0, 8).toString('latin1') === 'BARPLAY2') return decodeFormat2(b);
  if (b[0] === 0x7b) return decodeJsonl(b.toString('utf8'));
  throw new Error(`unrecognized replay file ${name}`);
}

// ---- outcomes + the HUD walk (hud.js build) -------------------------------------------------------

function analyze(rep) {
  const { header, T, hz, events } = rep;
  const chart = header.chart ?? [];
  const N = chart.length;
  const C = 12;
  const out = new Float32Array(N * C);
  const postsLeft = new Int32Array(N);
  const postPts = new Float32Array(N);
  for (let k = 0; k < T; k++) for (const e of events[k]) if (e.post && e.post.note < N) { postsLeft[e.post.note]++; postPts[e.post.note] += e.post.points; }
  chart.forEach((n, i) => {
    const o = i * C;
    out[o] = n.t; out[o + 1] = n.x; out[o + 2] = n.y; out[o + 3] = n.color ?? 0; out[o + 4] = n.angle ?? 0;
    out[o + 5] = n.speed ?? 18; out[o + 6] = n.any ? 1 : 0; out[o + 7] = n.kind ?? 0;
    out[o + 8] = -1; out[o + 9] = -1; out[o + 10] = 0; out[o + 11] = -1;
  });
  const setOutcome = (i, k, outcome, points, reason) => {
    if (!(i >= 0 && i < N)) return;
    const o = i * C;
    out[o + 8] = k; out[o + 9] = outcome; out[o + 10] = points; out[o + 11] = reason;
  };

  const hud = new Float32Array(T * 8);
  const MULTS = [1, 2, 4, 8], NEED = [2, 4, 8, Infinity];
  const kind = (i) => chart[i]?.kind;
  const isLink = (i) => kind(i) === KIND_CHAIN_LINK;
  const pending = Int32Array.from(postsLeft);
  const noteMult = new Map(), notePts = new Map(), noteMax = new Map();
  let mi = 0, prog = 0, combo = 0, maxCombo = 0, misses = 0, mmi = 0, mprog = 0, score = 0, max = 0, energy = 0.5;
  const clampE = (e) => Math.min(Math.max(e, 0.001), 1);
  const brk = () => { combo = 0; misses++; if (mi > 0) mi--; prog = 0; };
  const advance = () => { if (mi < 3 && ++prog >= NEED[mi]) { mi++; prog = 0; } };
  const maxShare = (i) => { if (mmi < 3 && ++mprog >= NEED[mmi]) { mmi++; mprog = 0; } return (KIND_MAX[kind(i)] ?? 0) * MULTS[mmi]; };
  const finish = (i) => { score += notePts.get(i) * noteMult.get(i); max += noteMax.get(i); notePts.delete(i); noteMax.delete(i); };

  for (let k = 0; k < T; k++) {
    for (const e of events[k]) {
      if (e.cut) {
        const i = e.cut.note;
        setOutcome(i, k, e.cut.good ? 0 : 1, (e.cut.points || 0) + (e.cut.good ? postPts[i] : 0), Math.max(0, EVENT_REASONS.indexOf(e.cut.reason)));
        const share = maxShare(i);
        if (e.cut.good) {
          combo++;
          if (combo > maxCombo) maxCombo = combo;
          advance();
          noteMult.set(i, MULTS[mi]); notePts.set(i, e.cut.points || 0); noteMax.set(i, share);
          energy = clampE(energy + (isLink(i) ? 0.002 : 0.01));
          if (!(pending[i] > 0)) finish(i);
        } else {
          max += share; brk();
          energy = clampE(energy - (isLink(i) ? 0.025 : 0.1));
        }
      } else if (e.post) {
        const i = e.post.note;
        if (notePts.has(i)) { notePts.set(i, notePts.get(i) + e.post.points); if (--pending[i] <= 0) finish(i); }
        else score += e.post.points * (noteMult.get(i) ?? MULTS[mi]);
      } else if (e.miss !== undefined) {
        const i = e.miss.note;
        setOutcome(i, k, 2, 0, 4);
        if (kind(i) !== KIND_BOMB) max += maxShare(i);
        brk();
        energy = clampE(energy - (isLink(i) ? 0.03 : 0.15));
      } else if (e.bomb !== undefined) {
        setOutcome(e.bomb.note, k, 3, 0, 6);
        brk(); energy = clampE(energy - 0.15);
      } else if (e.wall_enter !== undefined) brk();
      else if (e.wall !== undefined) energy = clampE(energy - 1.3 / hz);
    }
    const o = k * 8;
    hud[o] = score; hud[o + 1] = max; hud[o + 2] = combo; hud[o + 3] = MULTS[mi];
    hud[o + 4] = prog; hud[o + 5] = misses; hud[o + 6] = energy; hud[o + 7] = maxCombo;
  }
  return { chart: out, N, hud };
}

// ---- load + publish ------------------------------------------------------------------------------

const catalog = loadCatalog();
let current = -1;
let loadId = 0;
let busy = Promise.resolve();
let requested = false;

async function load(target) {
  let row = null, bytes, idx = -1;
  if (target.path) {
    bytes = fs.readFileSync(target.path);
    row = { id: path.basename(target.path), song: path.basename(target.path), difficulty: '', pp: 0, score: 0, model: 'local' };
  } else {
    idx = target.index ?? catalog.findIndex((r) => r.id === target.id);
    if (!(idx >= 0 && idx < catalog.length)) throw new Error(`no replay ${JSON.stringify(target)} (catalog has ${catalog.length})`);
    row = catalog[idx];
    await status(`Loading ${row.song}…`);
    bytes = await fetchReplay(row);
  }
  const rep = decode(bytes, row.id);
  if (rep.header.version !== 'v10') throw new Error(`replay version ${rep.header.version}; this reads v10`);
  const { chart, N, hud } = analyze(rep);
  const walls = rep.header.walls ?? [];
  const wt = new Float32Array(walls.length * 7);
  walls.forEach((w, i) => wt.set([w.t, w.cx, w.cy, w.w, w.h, w.l, w.speed], i * 7));
  await publishF32(`${P}.q`, rep.q, [rep.T, 36]);
  await publishF32(`${P}.chart`, chart, [N, 12]);
  await publishF32(`${P}.walls`, wt, [walls.length, 7]);
  await publishF32(`${P}.hud`, hud, [rep.T, 8]);
  await publishF32(`${P}.torque`, rep.torque, [rep.T]);
  const map = rep.header.map ?? {};
  current = idx;
  await publishJson(`${P}.meta`, {
    id: row.id, song: map.song ?? row.song, difficulty: map.difficulty ?? row.difficulty,
    model: rep.header.model ?? row.model, pp: row.pp, score: row.score,
    ticks: rep.T, hz: rep.hz, handleLen: rep.header.config?.handle_len ?? 0,
    trackAnchor: rep.header.track_anchor ?? null, notes: N, walls: walls.length,
    index: idx, total: catalog.length, loadId: `${process.pid}-${++loadId}`,
  });
  await status(`${map.song ?? row.song} · ${rep.T} ticks · ${N} notes`);
}

function request(v) {
  let target;
  if (typeof v === 'string' && v) target = { id: v };
  else if (typeof v === 'number') target = { index: v };
  else if (v && typeof v === 'object') {
    if (v.cmd === 'next' || v.cmd === 'prev') {
      const n = catalog.length;
      if (!n) return;
      target = { index: ((current < 0 ? 0 : current) + (v.cmd === 'next' ? 1 : -1) + n) % n };
    } else if (typeof v.id === 'string') target = { id: v.id };
    else if (Number.isInteger(v.index)) target = { index: v.index };
    else if (typeof v.path === 'string') target = { path: v.path };
  }
  if (!target) return;
  requested = true;
  busy = busy.then(() => load(target)).catch((e) => status(`Error: ${e.message ?? e}`));
}

async function main() {
  await publishJson(`${P}.catalog`, catalog.map(({ id, song, difficulty, pp, score, model }) => ({ id, song, difficulty, pp, score, model })));
  // The value already on the control channel when we start: honour an absolute pick, never replay
  // a relative one (next/prev). Later values (by seq) are requests.
  let lastSeq = 0;
  try {
    const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(`${P}.ctl.load`)}`);
    if (r.ok) {
      lastSeq = Number(r.headers.get('x-seq')) || 0;
      const v = await r.json();
      if (!(v && typeof v === 'object' && v.cmd)) request(v);
    }
  } catch { /* no value yet */ }
  follow(`${P}.ctl.load`, (v, seq) => {
    if (Number.isFinite(seq)) {
      if (seq < lastSeq) { lastSeq = seq; return; } // the server restarted: this is just its current value
      if (seq === lastSeq) return;
      lastSeq = seq;
    }
    request(v);
  });
  // Nothing requested yet: the best-pp replay.
  setTimeout(() => { if (!requested && catalog.length) request({ index: 0 }); }, 1500);
}
main().catch((e) => { console.error(e); process.exit(1); });
