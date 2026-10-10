// Discord source for the discord widget: a small user-account client (gateway + REST, no npm deps),
// modelled on open-source third-party clients (discordo / arikawa, Dissent, Abaddon).
//
// Signs in with DISCORD_USER_TOKEN (secrets.env; the supervisor passes only that name). Discord's ToS
// forbids automating user accounts: this behaves like one desktop-browser client (one gateway session,
// history fetched only for channels a widget opens, sends only on explicit request) to stay low-key.
// The token never leaves this process: not in channels, logs or errors.
//
//   <P>.status        {state: 'connecting'|'ready'|'error', user?: {id, name}, error?, at}
//   <P>.channels      {dms: Entry[], guilds: [{id, name, icon?, unread?, mentions?, channels: Entry[]}], at}
//                     Entry = {id, name, kind: 'dm'|'group'|'text'|'announcement'|'thread'|'forum', category?, icon?,
//                              unread?, mentions?, muted?}
//                     Unread = the channel's last message is newer than the account's read state (Discord's own
//                     read markers, shared with the user's other clients); mentions = Discord's mention count
//                     (every unread message in a DM). Server channels the account can't view are left out.
//                     A channel shown in a widget is marked read (acked) like the Discord client does.
//   <P>.ch.<id>       {id, name, kind, guild?, messages: Msg[] (oldest → newest, ≤ HISTORY), loading?, error?, at}
//                     Msg = {id, author: {id, name, avatar?}, content, ts, edited?,
//                            attachments?: [{name, url, type?, image?: {src, w, h}}], embeds?: [{title?, description?}],
//                            reply?: {author, content, avatar?}, mine?, pending?}
//                     avatar / icon / image.src are same-origin /media/discord-*.png files (downloaded from Discord's
//                     CDN into data/media once): the headset never talks to Discord.
//   <P>.request  ←    {cmd: 'open', channel}  start (or keep) following a channel: history + live updates.
//                     A channel no widget re-opened for LEASE_MS stops being published.
//                     {cmd: 'send', channel, content, nonce?} → <P>.sent {nonce, ok, id?, error?}
//                     {cmd: 'refresh'} republish status + channels
import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'discord');
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const API = 'https://discord.com/api/v9';
const GATEWAY = 'wss://gateway.discord.gg/?v=9&encoding=json';
const HISTORY = 60;
const LEASE_MS = 5 * 60_000;
const MAX_CONTENT = 2000;
const MEDIA = path.resolve(arg('media', '../../../data/media'));
const CDN = 'https://cdn.discordapp.com';

// Identity: the web client in desktop Chrome on Linux (X-Super-Properties = IDENTIFY properties, as discordo
// does). HTTP requests do NOT send a Chrome User-Agent: Discord answers a browser UA over Node's (non-Chrome)
// TLS fingerprint with 403 "internal network error" (code 40333). discordo spoofs Chrome's TLS fingerprint to
// get away with it; Node can't, so requests keep Node's default User-Agent.
const CHROME = '152';
const BROWSER_VERSION = `${CHROME}.0.0.0`;
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION} Safari/537.36`;
/** The web client's build (Oct 2026); replaced at startup by the live one from discord.com/login when possible. */
const BUILD_FALLBACK = 634304;
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

// ---------------------------------------------------------------- media (avatars, icons, image thumbnails)

/** {url, name}: a CDN image and the flat data/media file name it is cached under. */
export function avatarRef(u) {
  if (!u?.id) return null;
  if (u.avatar) return { url: `${CDN}/avatars/${u.id}/${u.avatar}.png?size=64`, name: `discord-a-${u.id}-${u.avatar}.png` };
  const legacy = u.discriminator && u.discriminator !== '0' ? Number(u.discriminator) % 5 : null;
  const n = legacy ?? Number((BigInt(u.id) >> 22n) % 6n);
  return { url: `${CDN}/embed/avatars/${n}.png`, name: `discord-d-${n}.png` };
}
export const guildIconRef = (id, icon) => (icon ? { url: `${CDN}/icons/${id}/${icon}.png?size=64`, name: `discord-g-${id}-${icon}.png` } : null);
export const groupIconRef = (id, icon) => (icon ? { url: `${CDN}/channel-icons/${id}/${icon}.png?size=64`, name: `discord-c-${id}-${icon}.png` } : null);
/** A thumbnail (≤ 400×300) of an image attachment through Discord's media proxy. */
export function attachmentRef(a) {
  if (!a?.content_type?.startsWith('image/') || !a.width || !a.height || !a.proxy_url) return null;
  const k = Math.min(1, 400 / a.width, 300 / a.height);
  const w = Math.max(1, Math.round(a.width * k)), h = Math.max(1, Math.round(a.height * k));
  const q = `${a.proxy_url.includes('?') ? '&' : '?'}width=${w}&height=${h}&format=png`;
  return { url: a.proxy_url + q, name: `discord-i-${a.id}.png`, w, h };
}
const mediaPath = (ref) => `/media/${ref.name}`;
const cached = (ref) => !!ref && fs.existsSync(path.join(MEDIA, ref.name));

const downloads = new Map(); // name → Promise<boolean>
/** Download `ref` into data/media once (concurrent callers share the promise). Resolves false on failure. */
function fetchMedia(ref) {
  if (!ref) return Promise.resolve(false);
  if (cached(ref)) return Promise.resolve(true);
  let p = downloads.get(ref.name);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(ref.url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return false;
        fs.mkdirSync(MEDIA, { recursive: true });
        const tmp = path.join(MEDIA, `${ref.name}.part`);
        fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        fs.renameSync(tmp, path.join(MEDIA, ref.name));
        return true;
      } catch { return false; } finally { downloads.delete(ref.name); }
    })();
    downloads.set(ref.name, p);
  }
  return p;
}

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
    author: { id: m.author?.id ?? '', name: m.member?.nick || userName(m.author), ...withMedia(avatarRef(m.author), 'avatar', ctx) },
    content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
    ts: m.timestamp ? Date.parse(m.timestamp) : snowflakeTime(m.id),
  };
  if (m.edited_timestamp) out.edited = true;
  if (ctx.selfId && out.author.id === ctx.selfId) out.mine = true;
  if (m.attachments?.length) {
    out.attachments = m.attachments.map((a) => {
      const ref = attachmentRef(a);
      if (ref) ctx.refs?.push(ref);
      return { name: a.filename, url: a.url, ...(a.content_type ? { type: a.content_type } : {}), ...(ref ? { image: { src: mediaPath(ref), w: ref.w, h: ref.h } } : {}) };
    });
  }
  const embeds = (m.embeds ?? []).map((e) => ({ title: e.title ?? e.author?.name, description: e.description })).filter((e) => e.title || e.description);
  if (embeds.length) out.embeds = embeds;
  if (m.sticker_items?.length) out.content = [out.content, ...m.sticker_items.map((s) => `[sticker] ${s.name}`)].filter(Boolean).join('\n');
  const ref = m.referenced_message;
  if (ref) out.reply = { author: ref.member?.nick || userName(ref.author), content: plainContent(ref.content, { channels: ctx.channelNames }), ...withMedia(avatarRef(ref.author), 'avatar', ctx) };
  // System messages (joins, pins, calls …) have no content of their own.
  if (!out.content && !out.attachments && !out.embeds && m.type !== 0 && m.type !== 19) out.content = systemText(m);
  return out;
}

/** {[key]: '/media/…'} for a ref (queued on ctx.refs for download before publishing), or {}. */
function withMedia(ref, key, ctx) {
  if (!ref) return {};
  ctx.refs?.push(ref);
  return { [key]: mediaPath(ref) };
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

const VIEW_CHANNEL = 1n << 10n, ADMINISTRATOR = 1n << 3n;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

/** Whether `member` (roles of the account in the guild) may view `channel` — Discord's permission overwrite rules. */
export function canView(guild, channel, member, userId) {
  if (!member || !guild.roles?.length) return true; // unknown: show it
  if (guild.owner_id && guild.owner_id === userId) return true;
  const roles = new Map(guild.roles.map((r) => [r.id, big(r.permissions)]));
  let perms = roles.get(guild.id) ?? 0n;
  for (const r of member.roles ?? []) perms |= roles.get(r) ?? 0n;
  if (perms & ADMINISTRATOR) return true;
  const ows = channel.permission_overwrites ?? [];
  const isRole = (o) => o.type === 0 || o.type === 'role';
  const everyone = ows.find((o) => o.id === guild.id);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);
  let allow = 0n, deny = 0n;
  for (const o of ows) if (isRole(o) && o.id !== guild.id && member.roles?.includes(o.id)) { allow |= big(o.allow); deny |= big(o.deny); }
  perms = (perms & ~deny) | allow;
  const mine = ows.find((o) => !isRole(o) && o.id === userId);
  if (mine) perms = (perms & ~big(mine.deny)) | big(mine.allow);
  return (perms & VIEW_CHANNEL) !== 0n;
}

/** READY read_state (array or versioned {entries}) → Map channelId → {last, mentions}. */
export function readStates(rs) {
  const entries = Array.isArray(rs) ? rs : rs?.entries ?? [];
  const out = new Map();
  for (const e of entries) if (!e.read_state_type) out.set(String(e.id), { last: e.last_message_id ? String(e.last_message_id) : null, mentions: e.mention_count ?? 0 });
  return out;
}

/** READY user_guild_settings (array or {entries}) → {guilds: Set, channels: Set} of muted ids (expired mutes ignored). */
export function mutedIds(ugs, now = Date.now()) {
  const entries = Array.isArray(ugs) ? ugs : ugs?.entries ?? [];
  const on = (x) => x?.muted && !(x.mute_config?.end_time && Date.parse(x.mute_config.end_time) < now);
  const guilds = new Set(), channels = new Set();
  for (const e of entries) {
    if (e.guild_id && on(e)) guilds.add(String(e.guild_id));
    for (const o of e.channel_overrides ?? []) if (on(o)) channels.add(String(o.channel_id));
  }
  return { guilds, channels };
}

/** Unread: newer than the read marker, or Discord counts mentions in it. */
export function isUnread(last, rs) {
  if (rs?.mentions > 0) return true;
  return !!(last && rs?.last && cmpSnowflake(last, rs.last) > 0);
}

/** READY (user account) → {dms, guilds, users, channelNames, lastIds}. Handles both inline recipients and recipient_ids + users. */
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
    const iconRef = kind === 'dm' ? avatarRef(recips[0]) : groupIconRef(c.id, c.icon);
    dms.push({ id: c.id, name, kind, last: c.last_message_id ?? null, ...(iconRef ? { iconRef } : {}) });
  }
  dms.sort((a, b) => cmpSnowflake(b.last, a.last));
  const lastIds = new Map(dms.map((x) => [x.id, x.last]));
  const guilds = [];
  const selfId = d.user?.id;
  for (const [gi, g0] of (d.guilds ?? []).entries()) {
    const g = g0.properties ? { ...g0.properties, ...g0, roles: g0.roles ?? g0.properties.roles } : g0;
    if (g.unavailable) continue; // GUILD_CREATE follows
    const name = g.name ?? 'Server';
    // merged_members[i] holds the account's own member in guilds[i] (roles for permissions).
    const member = (d.merged_members?.[gi] ?? []).find((m) => m.user_id === selfId) ?? g.members?.find((m) => m.user?.id === selfId) ?? null;
    const all = [...(g.channels ?? []), ...(g.threads ?? [])];
    const byId = new Map(all.map((c) => [c.id, c]));
    const cats = new Map(all.filter((c) => c.type === 4).map((c) => [c.id, c]));
    const channels = [];
    for (const c of all) {
      const kind = channelKind(c.type);
      channelNames.set(c.id, c.name);
      if (!kind || kind === 'dm' || kind === 'group') continue;
      // Threads use their parent channel's permissions.
      if (!canView(g, kind === 'thread' ? byId.get(c.parent_id) ?? c : c, member, selfId)) continue;
      if (c.last_message_id) lastIds.set(c.id, String(c.last_message_id));
      const cat = cats.get(c.parent_id);
      channels.push({ id: c.id, name: c.name, kind, ...(cat ? { category: cat.name } : {}), _pos: [cat?.position ?? -1, kind === 'thread' ? 1 : 0, c.position ?? 0] });
    }
    channels.sort((a, b) => a._pos[0] - b._pos[0] || a._pos[1] - b._pos[1] || a._pos[2] - b._pos[2]);
    for (const c of channels) delete c._pos;
    const iconRef = guildIconRef(g.id, g.icon);
    guilds.push({ id: g.id, name, channels, ...(iconRef ? { iconRef } : {}) });
  }
  // The user's folder order, when the settings carry it.
  const order = (d.user_settings?.guild_positions ?? d.user_settings?.guild_folders?.flatMap((f) => f.guild_ids ?? []) ?? []).map(String);
  if (order.length) guilds.sort((a, b) => idx(order, a.id) - idx(order, b.id));
  return { dms, guilds, users, channelNames, lastIds };
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
    this.refs = []; // media referenced by messages converted since the last publish
    this.lastIds = new Map(); // channel id → newest message id
    this.reads = new Map(); // channel id → {last, mentions} (Discord read states)
    this.muted = { guilds: new Set(), channels: new Set() };
    this.ackTimers = new Map();
    this.iconsLoading = false;
    this.fatal = null;
    this.backoff = 1000;
  }

  headers(json = false) {
    return {
      Authorization: this.token, // user tokens go raw (no "Bot " prefix)
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
      const page = await (await fetch('https://discord.com/login', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) })).text();
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
        this.lastIds = r.lastIds;
        this.reads = readStates(d.read_state);
        this.muted = mutedIds(d.user_guild_settings);
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
        for (const [k, v] of r.lastIds) this.lastIds.set(k, v);
        const i = this.guilds.findIndex((x) => x.id === g.id);
        if (i >= 0) this.guilds[i] = g; else this.guilds.push(g);
        this.publishChannelsSoon();
        break;
      }
      case 'MESSAGE_ACK': // read on another client (or by us)
        this.reads.set(d.channel_id, { last: d.message_id, mentions: 0 });
        this.publishChannelsSoon();
        break;
      case 'CHANNEL_UNREAD_UPDATE': // last message ids for guilds we aren't subscribed to
        for (const u of d.channel_unread_updates ?? []) if (u.last_message_id) this.lastIds.set(u.id, u.last_message_id);
        this.publishChannelsSoon();
        break;
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
          const iconRef = d.type === 1 ? avatarRef(d.recipients?.[0]) : groupIconRef(d.id, d.icon);
          if (!this.dms.some((x) => x.id === d.id)) { this.dms.unshift({ id: d.id, name, kind: channelKind(d.type), last: d.last_message_id ?? null, ...(iconRef ? { iconRef } : {}) }); this.publishChannels(); }
        }
        break;
    }
  }

  onMessage(m, how) {
    // Keep DM order fresh (most recent conversation first).
    const dm = this.dms.find((x) => x.id === m.channel_id);
    if (dm && how === 'create') { dm.last = m.id; this.dms.sort((a, b) => cmpSnowflake(b.last, a.last)); }
    const w = this.watched.get(m.channel_id);
    if (how === 'create') {
      this.lastIds.set(m.channel_id, m.id);
      const self = this.user?.id && m.author?.id === this.user.id;
      const rs = this.reads.get(m.channel_id) ?? { last: null, mentions: 0 };
      if (self) this.reads.set(m.channel_id, { last: m.id, mentions: 0 }); // your own messages are read
      else if (dm || m.mention_everyone || (m.mentions ?? []).some((u) => u.id === this.user?.id)) this.reads.set(m.channel_id, { ...rs, mentions: rs.mentions + 1 });
      if (!self && w && this.viewing(m.channel_id)) this.ackSoon(m.channel_id);
      this.publishChannelsSoon();
    }
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

  msgCtx() { return { selfId: this.user?.id, channelNames: this.channelNames, refs: this.refs }; }

  // ---- channels

  publishChannels() {
    clearTimeout(this.chTimer);
    this.chTimer = null;
    const missing = [];
    const icon = (ref) => { if (!ref) return {}; if (cached(ref)) return { icon: mediaPath(ref) }; missing.push(ref); return {}; };
    const unread = (id) => {
      const rs = this.reads.get(id);
      const muted = this.muted.channels.has(id);
      const u = isUnread(this.lastIds.get(id), rs);
      return { ...(u ? { unread: true } : {}), ...(rs?.mentions ? { mentions: rs.mentions } : {}), ...(muted ? { muted: true } : {}) };
    };
    const dms = this.dms.map(({ last, iconRef, ...e }) => ({ ...e, ...icon(iconRef), ...unread(e.id) }));
    const guilds = this.guilds.map(({ iconRef, ...g }) => {
      const channels = g.channels.map((c) => ({ ...c, ...unread(c.id) }));
      const gMuted = this.muted.guilds.has(g.id);
      const anyUnread = !gMuted && channels.some((c) => c.unread && !c.muted);
      const mentions = channels.reduce((n, c) => n + (c.mentions ?? 0), 0);
      return { ...g, channels, ...icon(iconRef), ...(anyUnread ? { unread: true } : {}), ...(mentions ? { mentions } : {}), ...(gMuted ? { muted: true } : {}) };
    });
    void publish(`${P}.channels`, { dms, guilds, at: Date.now() });
    if (missing.length && !this.iconsLoading) {
      // Fetch the missing icons a few at a time, then republish once with them.
      this.iconsLoading = true;
      void (async () => {
        let got = 0;
        for (let i = 0; i < missing.length; i += 4) got += (await Promise.all(missing.slice(i, i + 4).map(fetchMedia))).filter(Boolean).length;
        this.iconsLoading = false;
        if (got) this.publishChannels();
      })();
    }
  }

  publishChannelsSoon() {
    if (!this.chTimer) this.chTimer = setTimeout(() => this.publishChannels(), 3000);
  }

  info(id) {
    const dm = this.dms.find((x) => x.id === id);
    if (dm) return { name: dm.name, kind: dm.kind };
    const g = this.guilds.find((x) => x.id === this.channelGuild.get(id));
    const c = g?.channels.find((x) => x.id === id);
    return c ? { name: c.name, kind: c.kind, guild: g.name } : { name: this.channelNames.get(id) ?? id, kind: 'text' };
  }

  /** Publish a channel once the avatars / thumbnails its messages reference are on disk (≤ 4 s). */
  publishChannel(id) {
    const w = this.watched.get(id);
    if (!w) return;
    const refs = this.refs.splice(0);
    if (refs.length) {
      const pending = refs.filter((r) => !cached(r));
      if (pending.length) {
        void Promise.race([Promise.all(pending.map(fetchMedia)), sleep(4000)]).then(() => this.publishChannelNow(id));
        return;
      }
    }
    this.publishChannelNow(id);
  }

  publishChannelNow(id) {
    const w = this.watched.get(id);
    if (!w) return;
    void publish(`${P}.ch.${id}`, {
      id, ...this.info(id),
      messages: w.msgs.map(({ nonce, ...m }) => m),
      ...(w.loading ? { loading: true } : {}), ...(w.error ? { error: w.error } : {}), at: Date.now(),
    });
  }

  /** A widget showed this channel within the last two minutes (it re-opens every 60 s while shown). */
  viewing(id) {
    const w = this.watched.get(id);
    return !!w && Date.now() - w.lease < 120_000;
  }

  /** Mark the channel read up to its newest message (POST …/ack, as the client does when a channel is on screen). */
  ackSoon(id) {
    if (this.ackTimers.has(id)) return;
    this.ackTimers.set(id, setTimeout(async () => {
      this.ackTimers.delete(id);
      const last = this.lastIds.get(id) ?? this.watched.get(id)?.msgs.at(-1)?.id;
      if (!last || !isUnread(last, this.reads.get(id) ?? { last: null, mentions: 1 })) return;
      try {
        await this.rest('POST', `/channels/${id}/messages/${last}/ack`, { token: null });
        this.reads.set(id, { last, mentions: 0 });
        this.publishChannelsSoon();
      } catch (e) { console.error(`ack ${this.info(id).name}: ${e.message}`); }
    }, 1500));
  }

  open(id) {
    this.ackSoon(id);
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
