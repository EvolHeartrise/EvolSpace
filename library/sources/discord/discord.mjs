// Discord source for the discord widget: a small user-account client (gateway + REST, no npm deps),
// modelled on open-source third-party clients (discordo / arikawa, Dissent, Abaddon).
//
// Signs in with DISCORD_USER_TOKEN (secrets.env; the supervisor passes only that name). Discord's ToS
// forbids automating user accounts: this behaves like one desktop-browser client (one gateway session,
// history fetched only for channels a widget opens, sends only on explicit request) to stay low-key.
// The token never leaves this process: not in channels, logs or errors.
//
//   <P>.status        {state: 'connecting'|'ready'|'error', user?: {id, name}, error?, at}
//   <P>.channels      {dms: Entry[], guilds: [{id, name, channels: Entry[]}], at}
//                     Entry = {id, name, kind: 'dm'|'group'|'text'|'announcement'|'thread'|'forum', category?, last?}
//   <P>.ch.<id>       {id, name, kind, guild?, messages: Msg[] (oldest → newest, ≤ HISTORY), loading?, error?, at}
//                     Msg = {id, author: {id, name}, content, ts, edited?, attachments?: [{name, url, type?}],
//                            embeds?: [{title?, description?}], reply?: {author, content}, mine?, pending?}
//   <P>.request  ←    {cmd: 'open', channel}  start (or keep) following a channel: history + live updates.
//                     A channel no widget re-opened for LEASE_MS stops being published.
//                     {cmd: 'send', channel, content, nonce?} → <P>.sent {nonce, ok, id?, error?}
//                     {cmd: 'refresh'} republish status + channels
import { randomInt, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'discord');
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const API = 'https://discord.com/api/v9';
const GATEWAY = 'wss://gateway.discord.gg/?v=9&encoding=json';
const HISTORY = 60;
const LEASE_MS = 5 * 60_000;
const MAX_CONTENT = 2000;

// One consistent identity: desktop Chrome on Linux using the web client. UA, browser_version and
// Sec-Ch-Ua agree, and X-Super-Properties equals the IDENTIFY properties (as discordo does).
const CHROME = '152';
const BROWSER_VERSION = `${CHROME}.0.0.0`;
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION} Safari/537.36`;
/** discordo's scraped build (2026); replaced at startup by the live one from discord.com/login when possible. */
const BUILD_FALLBACK = 630444;
const LAUNCH_ID = randomUUID();
export const superProperties = (build) => ({
  os: 'Linux', browser: 'Chrome', device: '', system_locale: 'en-US', has_client_mods: false, browser_user_agent: UA, browser_version: BROWSER_VERSION,
  os_version: '', referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
  release_channel: 'stable', client_build_number: build, client_event_source: null, client_launch_id: LAUNCH_ID,
});
/**
 * IDENTIFY capabilities: discordo's 8701 minus AUTH_TOKEN_REFRESH (256), which would have Discord hand us a
 * replacement token that we could not store back into secrets.env. Bits: lazy user notes, versioned read
 * states + guild settings, deduped user objects (DM recipient_ids + READY.users), prioritized READY,
 * guild experiment populations, non-channel read states, debounced reactions.
 */
export const CAPABILITIES = 8701 & ~256;

// ---------------------------------------------------------------- EvolSpace channels

async function publish(channel, value) {
  try {
    const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=discord`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!r.ok) console.error(`publish ${channel}: ${r.status}`);
  } catch (e) { console.error(`publish ${channel}: ${e.message}`); }
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

// ---------------------------------------------------------------- pure helpers (tested)

/** Discord snowflake → creation time (ms). */
export const snowflakeTime = (id) => Number(BigInt(id) >> 22n) + 1420070400000;

/** A Discord nonce (what clients send with a message): a snowflake for "now". */
export const makeNonce = (now = Date.now()) => String((BigInt(now - 1420070400000) << 22n) | BigInt(randomInt(0, 4194304)));

export const userName = (u) => (u ? u.global_name || u.username || 'unknown' : 'unknown');

const KINDS = { 0: 'text', 1: 'dm', 3: 'group', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'thread', 15: 'forum', 16: 'forum' };
export const channelKind = (type) => KINDS[type] ?? null;

/** Message markup → plain text: mentions, channels, custom emoji, timestamps. */
export function plainContent(content, { users = new Map(), channels = new Map() } = {}) {
  return String(content ?? '')
    .replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) ?? 'user'}`)
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<#(\d+)>/g, (_, id) => `#${channels.get(id) ?? 'channel'}`)
    .replace(/<a?(:\w+:)\d+>/g, '$1')
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
}

/** Discord message object → widget Msg. */
export function toMsg(m, ctx) {
  const users = new Map((m.mentions ?? []).map((u) => [u.id, userName(u)]));
  const content = plainContent(m.content, { users, channels: ctx.channelNames });
  const out = {
    id: m.id,
    author: { id: m.author?.id ?? '', name: m.member?.nick || userName(m.author) },
    content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
    ts: m.timestamp ? Date.parse(m.timestamp) : snowflakeTime(m.id),
  };
  if (m.edited_timestamp) out.edited = true;
  if (ctx.selfId && out.author.id === ctx.selfId) out.mine = true;
  if (m.attachments?.length) out.attachments = m.attachments.map((a) => ({ name: a.filename, url: a.url, ...(a.content_type ? { type: a.content_type } : {}) }));
  const embeds = (m.embeds ?? []).map((e) => ({ title: e.title ?? e.author?.name, description: e.description })).filter((e) => e.title || e.description);
  if (embeds.length) out.embeds = embeds;
  if (m.sticker_items?.length) out.content = [out.content, ...m.sticker_items.map((s) => `[sticker] ${s.name}`)].filter(Boolean).join('\n');
  const ref = m.referenced_message;
  if (ref) out.reply = { author: ref.member?.nick || userName(ref.author), content: plainContent(ref.content, { channels: ctx.channelNames }) };
  // System messages (joins, pins, calls …) have no content of their own.
  if (!out.content && !out.attachments && !out.embeds && m.type !== 0 && m.type !== 19) out.content = systemText(m);
  return out;
}

function systemText(m) {
  switch (m.type) {
    case 1: return '(added someone to the group)';
    case 2: return '(removed someone from the group)';
    case 3: return '(started a call)';
    case 4: return '(changed the group name)';
    case 6: return '(pinned a message)';
    case 7: return '(joined the server)';
    case 8: case 9: case 10: case 11: return '(boosted the server)';
    default: return '';
  }
}

/** READY (user account) → {dms, guilds, users, channelNames}. Handles both inline recipients and recipient_ids + users. */
export function fromReady(d) {
  const users = new Map();
  for (const u of d.users ?? []) users.set(u.id, u);
  const channelNames = new Map();
  const dms = [];
  for (const c of d.private_channels ?? []) {
    const kind = channelKind(c.type);
    if (kind !== 'dm' && kind !== 'group') continue;
    const recips = c.recipients ?? (c.recipient_ids ?? []).map((id) => users.get(id)).filter(Boolean);
    for (const u of c.recipients ?? []) users.set(u.id, u);
    const name = c.name || recips.map(userName).join(', ') || 'Direct message';
    channelNames.set(c.id, name);
    dms.push({ id: c.id, name, kind, last: c.last_message_id ?? null });
  }
  dms.sort((a, b) => cmpSnowflake(b.last, a.last));
  const guilds = [];
  for (const g of d.guilds ?? []) {
    if (g.unavailable) continue; // GUILD_CREATE follows
    const name = g.properties?.name ?? g.name ?? 'Server';
    const all = [...(g.channels ?? []), ...(g.threads ?? [])];
    const cats = new Map(all.filter((c) => c.type === 4).map((c) => [c.id, c]));
    const channels = [];
    for (const c of all) {
      const kind = channelKind(c.type);
      channelNames.set(c.id, c.name);
      if (!kind || kind === 'dm' || kind === 'group') continue;
      const cat = cats.get(c.parent_id);
      channels.push({ id: c.id, name: c.name, kind, ...(cat ? { category: cat.name } : {}), _pos: [cat?.position ?? -1, kind === 'thread' ? 1 : 0, c.position ?? 0] });
    }
    channels.sort((a, b) => a._pos[0] - b._pos[0] || a._pos[1] - b._pos[1] || a._pos[2] - b._pos[2]);
    for (const c of channels) delete c._pos;
    guilds.push({ id: g.id, name, channels });
  }
  // The user's folder order, when the settings carry it.
  const order = (d.user_settings?.guild_positions ?? d.user_settings?.guild_folders?.flatMap((f) => f.guild_ids ?? []) ?? []).map(String);
  if (order.length) guilds.sort((a, b) => idx(order, a.id) - idx(order, b.id));
  return { dms, guilds, users, channelNames };
}
const idx = (arr, v) => { const i = arr.indexOf(v); return i < 0 ? Infinity : i; };
const cmpSnowflake = (a, b) => (a === b ? 0 : !a ? -1 : !b ? 1 : a.length !== b.length ? a.length - b.length : a < b ? -1 : 1);

// ---------------------------------------------------------------- client

class DiscordClient {
  constructor(token) {
    this.token = token;
    this.build = BUILD_FALLBACK;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.hbTimer = null;
    this.acked = true;
    this.user = null;
    this.dms = [];
    this.guilds = [];
    this.channelNames = new Map();
    this.channelGuild = new Map(); // channel id → guild id
    this.watched = new Map(); // channel id → {lease, msgs: Msg[], loading, error}
    this.fatal = null;
    this.backoff = 1000;
  }

  headers(json = false) {
    return {
      Authorization: this.token, // user tokens go raw (no "Bot " prefix)
      'User-Agent': UA,
      'X-Super-Properties': Buffer.from(JSON.stringify(superProperties(this.build))).toString('base64'),
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'X-Debug-Options': 'bugReporterEnabled',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Ch-Ua': `"Chromium";v="${CHROME}", "Not-A.Brand";v="24", "Google Chrome";v="${CHROME}"`,
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** REST with 429 handling (waits retry_after, a couple of times). Errors never include the token. */
  async rest(method, path, body) {
    if (this.fatal) throw new Error('not signed in');
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${API}${path}`, { method, headers: this.headers(!!body), ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        await sleep(Math.min(30, Number(j.retry_after) || Number(r.headers.get('retry-after')) || 2) * 1000 + 250);
        continue;
      }
      if (r.status === 401) { this.fail('The Discord token was rejected (DISCORD_USER_TOKEN in secrets.env). Update it and restart the source.'); throw new Error('unauthorized'); }
      const text = await r.text();
      const j = text ? safeJson(text) : null;
      if (!r.ok) throw new Error(j?.message ? `${j.message} (${r.status})` : `HTTP ${r.status}`);
      return j;
    }
    throw new Error('rate limited');
  }

  /** The web client's current build number, scraped from the login page like discordo (fallback: BUILD_FALLBACK). */
  async fetchBuild() {
    try {
      const page = await (await fetch('https://discord.com/login', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) })).text();
      const m = /"BUILD_NUMBER":\s*"(\d+)"/.exec(page);
      if (m) this.build = Number(m[1]);
    } catch { /* keep the fallback */ }
  }

  /** Unrecoverable (bad token): stay down instead of hammering the login, and say why. */
  fail(msg) {
    if (this.fatal) return;
    this.fatal = msg;
    status('error', msg);
    this.ws?.close(4000, 'stopping');
  }

  // ---- gateway

  connect() {
    if (this.fatal) return;
    const url = this.resumeUrl && this.sessionId ? `${this.resumeUrl}/?v=9&encoding=json` : GATEWAY;
    status('connecting');
    const ws = (this.ws = new WebSocket(url));
    ws.onmessage = (ev) => this.onPayload(safeJson(typeof ev.data === 'string' ? ev.data : ''));
    ws.onclose = (ev) => this.onClose(ev.code, ev.reason);
    ws.onerror = () => { /* onclose follows */ };
  }

  send(op, d) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  onPayload(p) {
    if (!p) return;
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: { // HELLO
        const every = p.d.heartbeat_interval;
        clearInterval(this.hbTimer);
        this.acked = true;
        setTimeout(() => this.heartbeat(), Math.random() * every);
        this.hbTimer = setInterval(() => this.heartbeat(), every);
        if (this.sessionId && this.seq != null) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.identify();
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.heartbeat(true); break;
      case 7: this.ws?.close(4000, 'reconnect requested'); break; // RECONNECT → resume
      case 9: // INVALID_SESSION: resumable or not
        if (!p.d) { this.sessionId = null; this.seq = null; this.resumeUrl = null; }
        setTimeout(() => this.ws?.close(4000, 'invalid session'), 1000 + Math.random() * 4000);
        break;
      case 0: this.onDispatch(p.t, p.d); break;
    }
  }

  heartbeat(force = false) {
    if (!force && !this.acked) { this.ws?.close(4000, 'heartbeat not acked'); return; } // zombie connection
    this.acked = false;
    this.send(1, this.seq);
  }

  identify() {
    // No intents (user accounts must omit them), no presence: like discordo, the session doesn't change the user's status.
    this.send(2, { token: this.token, capabilities: CAPABILITIES, properties: superProperties(this.build), compress: false });
  }

  onClose(code, reason) {
    clearInterval(this.hbTimer);
    this.ws = null;
    // Fatal: bad token (4004), invalid intents/version (4012-4014): stay down, don't hammer the login.
    if (this.fatal) return;
    if (code === 4004 || (code >= 4010 && code <= 4014)) {
      this.fail(code === 4004 ? 'The Discord token was rejected (DISCORD_USER_TOKEN in secrets.env). Update it and restart the source.' : `Gateway closed: ${reason || code}`);
      return;
    }
    if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; this.resumeUrl = null; }
    const wait = this.backoff;
    this.backoff = Math.min(60_000, this.backoff * 2);
    console.log(`gateway closed (${code}${reason ? ` ${reason}` : ''}); reconnecting in ${Math.round(wait / 1000)} s`);
    setTimeout(() => this.connect(), wait);
  }

  onDispatch(t, d) {
    switch (t) {
      case 'READY': {
        this.backoff = 1000;
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.user = d.user;
        const r = fromReady(d);
        this.dms = r.dms;
        this.guilds = r.guilds;
        this.channelNames = r.channelNames;
        this.channelGuild.clear();
        for (const g of r.guilds) for (const c of g.channels) this.channelGuild.set(c.id, g.id);
        status('ready');
        this.publishChannels();
        // Watched channels may have missed messages while disconnected: refetch.
        for (const id of this.watched.keys()) void this.loadHistory(id);
        console.log(`ready as ${userName(d.user)}: ${r.dms.length} DMs, ${r.guilds.length} servers`);
        break;
      }
      case 'GUILD_CREATE': { // a guild that was unavailable in READY, or one just joined
        const r = fromReady({ guilds: [d] });
        const g = r.guilds[0];
        if (!g) break;
        for (const [k, v] of r.channelNames) this.channelNames.set(k, v);
        for (const c of g.channels) this.channelGuild.set(c.id, g.id);
        const i = this.guilds.findIndex((x) => x.id === g.id);
        if (i >= 0) this.guilds[i] = g; else this.guilds.push(g);
        this.publishChannelsSoon();
        break;
      }
      case 'GUILD_DELETE':
        if (!d.unavailable) { this.guilds = this.guilds.filter((x) => x.id !== d.id); this.publishChannelsSoon(); }
        break;
      case 'RESUMED':
        this.backoff = 1000;
        status('ready');
        break;
      case 'MESSAGE_CREATE': this.onMessage(d, 'create'); break;
      case 'MESSAGE_UPDATE': this.onMessage(d, 'update'); break;
      case 'MESSAGE_DELETE': this.onDelete(d.channel_id, [d.id]); break;
      case 'MESSAGE_DELETE_BULK': this.onDelete(d.channel_id, d.ids ?? []); break;
      case 'CHANNEL_CREATE':
        if (d.type === 1 || d.type === 3) {
          const name = d.name || (d.recipients ?? []).map(userName).join(', ') || 'Direct message';
          this.channelNames.set(d.id, name);
          if (!this.dms.some((x) => x.id === d.id)) { this.dms.unshift({ id: d.id, name, kind: channelKind(d.type), last: d.last_message_id ?? null }); this.publishChannels(); }
        }
        break;
    }
  }

  onMessage(m, how) {
    // Keep DM order fresh (most recent conversation first).
    const dm = this.dms.find((x) => x.id === m.channel_id);
    if (dm && how === 'create') { dm.last = m.id; this.dms.sort((a, b) => cmpSnowflake(b.last, a.last)); this.publishChannelsSoon(); }
    const w = this.watched.get(m.channel_id);
    if (!w || w.loading) return;
    const i = w.msgs.findIndex((x) => x.id === m.id || (m.nonce && x.nonce === m.nonce));
    if (how === 'update') {
      if (i < 0 || !m.author) return; // partial update (embeds resolved) of a message we don't have: ignore
      w.msgs[i] = toMsg(m, this.msgCtx());
    } else {
      const msg = toMsg(m, this.msgCtx());
      if (i >= 0) w.msgs[i] = msg; // our own pending message came back
      else w.msgs.push(msg);
      if (w.msgs.length > HISTORY) w.msgs.splice(0, w.msgs.length - HISTORY);
    }
    this.publishChannel(m.channel_id);
  }

  onDelete(channelId, ids) {
    const w = this.watched.get(channelId);
    if (!w) return;
    const n = w.msgs.length;
    w.msgs = w.msgs.filter((x) => !ids.includes(x.id));
    if (w.msgs.length !== n) this.publishChannel(channelId);
  }

  msgCtx() { return { selfId: this.user?.id, channelNames: this.channelNames }; }

  // ---- channels

  publishChannels() {
    clearTimeout(this.chTimer);
    this.chTimer = null;
    void publish(`${P}.channels`, { dms: this.dms.map(({ last, ...e }) => e), guilds: this.guilds, at: Date.now() });
  }

  publishChannelsSoon() {
    if (!this.chTimer) this.chTimer = setTimeout(() => this.publishChannels(), 2000);
  }

  info(id) {
    const dm = this.dms.find((x) => x.id === id);
    if (dm) return { name: dm.name, kind: dm.kind };
    const g = this.guilds.find((x) => x.id === this.channelGuild.get(id));
    const c = g?.channels.find((x) => x.id === id);
    return c ? { name: c.name, kind: c.kind, guild: g.name } : { name: this.channelNames.get(id) ?? id, kind: 'text' };
  }

  publishChannel(id) {
    const w = this.watched.get(id);
    if (!w) return;
    void publish(`${P}.ch.${id}`, {
      id, ...this.info(id),
      messages: w.msgs.map(({ nonce, ...m }) => m),
      ...(w.loading ? { loading: true } : {}), ...(w.error ? { error: w.error } : {}), at: Date.now(),
    });
  }

  open(id) {
    const w = this.watched.get(id);
    if (w) { w.lease = Date.now(); if (!w.loading) this.publishChannel(id); return; }
    this.watched.set(id, { lease: Date.now(), msgs: [], loading: true, error: null });
    this.subscribeGuildChannel(id);
    void this.loadHistory(id);
  }

  async loadHistory(id) {
    const w = this.watched.get(id);
    if (!w) return;
    w.loading = true;
    this.publishChannel(id);
    try {
      const list = await this.rest('GET', `/channels/${id}/messages?limit=50`);
      const ctx = this.msgCtx();
      const fetched = (Array.isArray(list) ? list : []).reverse().map((m) => toMsg(m, ctx));
      // Keep anything pending/newer that arrived while fetching.
      const newest = fetched.at(-1)?.id;
      const extra = w.msgs.filter((m) => m.pending || (newest && cmpSnowflake(m.id, newest) > 0));
      w.msgs = [...fetched, ...extra].slice(-HISTORY);
      w.error = null;
    } catch (e) {
      w.error = `Couldn't load messages: ${e.message}`;
    }
    w.loading = false;
    this.publishChannel(id);
  }

  /**
   * Guild channels: user sessions only get MESSAGE_CREATE for guild channels they are
   * subscribed to (op 37, as the web client does when a channel is opened).
   */
  subscribeGuildChannel(id) {
    const gid = this.channelGuild.get(id);
    if (!gid) return;
    const chans = [...this.watched.keys()].filter((c) => this.channelGuild.get(c) === gid);
    this.send(37, { subscriptions: { [gid]: { typing: true, activities: false, threads: true, channels: Object.fromEntries(chans.map((c) => [c, [[0, 99]]])) } } });
  }

  expire() {
    const now = Date.now();
    for (const [id, w] of this.watched) if (now - w.lease > LEASE_MS) this.watched.delete(id);
  }

  async sendMessage(req) {
    const channel = String(req.channel ?? '');
    const content = String(req.content ?? '').trim();
    const reply = (v) => publish(`${P}.sent`, { nonce: req.nonce ?? null, channel, ...v });
    if (!/^\d{5,25}$/.test(channel)) return reply({ ok: false, error: 'channel must be a Discord channel id' });
    if (!content) return reply({ ok: false, error: 'empty message' });
    if (content.length > MAX_CONTENT) return reply({ ok: false, error: `longer than ${MAX_CONTENT} characters` });
    const nonce = makeNonce();
    const w = this.watched.get(channel);
    if (w) {
      w.msgs.push({ id: nonce, nonce, author: { id: this.user?.id ?? '', name: userName(this.user) }, content, ts: Date.now(), mine: true, pending: true });
      this.publishChannel(channel);
    }
    try {
      const m = await this.rest('POST', `/channels/${channel}/messages`, { content, nonce, tts: false, flags: 0, mobile_network_type: 'unknown' });
      if (w) {
        const i = w.msgs.findIndex((x) => x.nonce === nonce || x.id === m.id);
        if (i >= 0) w.msgs[i] = toMsg(m, this.msgCtx());
        this.publishChannel(channel);
      }
      console.log(`sent a message to ${this.info(channel).name}`);
      return reply({ ok: true, id: m.id });
    } catch (e) {
      if (w) { w.msgs = w.msgs.filter((x) => x.nonce !== nonce); this.publishChannel(channel); }
      return reply({ ok: false, error: e.message });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

let client = null;
function status(state, error) {
  const user = client?.user ? { id: client.user.id, name: userName(client.user) } : undefined;
  void publish(`${P}.status`, { state, ...(user ? { user } : {}), ...(error ? { error } : {}), at: Date.now() });
}

async function onRequest(req) {
  if (!req || typeof req !== 'object' || !client) return;
  if (req.cmd === 'open' && /^\d{5,25}$/.test(String(req.channel ?? ''))) client.open(String(req.channel));
  else if (req.cmd === 'send') await client.sendMessage(req);
  else if (req.cmd === 'refresh') { status(client.fatal ? 'error' : client.user ? 'ready' : 'connecting', client.fatal ?? undefined); client.publishChannels(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = (process.env.DISCORD_USER_TOKEN ?? '').trim().replace(/^"|"$/g, '');
  if (!token) {
    void publish(`${P}.status`, { state: 'error', error: 'DISCORD_USER_TOKEN is not set in ~/.config/evolspace/secrets.env', at: Date.now() });
    console.error('DISCORD_USER_TOKEN missing');
  } else {
    client = new DiscordClient(token);
    await client.fetchBuild();
    console.log(`discord: client build ${client.build}`);
    client.connect();
    setInterval(() => client.expire(), 60_000).unref();
    await follow(`${P}.request`, onRequest);
  }
}
