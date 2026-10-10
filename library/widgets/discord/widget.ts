// discord — a Discord chat card: one DM, group DM or server channel, live, newest message at the
// bottom (pinch-drag the messages to scroll back). Without a channel (or after the back button) the
// card is a picker: Direct messages / servers → channels; pinch a row to open it.
//
// Data comes from the `discord` source (library/sources/discord, signed in with the user's account):
//   <prefix>.status    {state: 'connecting'|'ready'|'error', user?: {id, name}, error?}
//   <prefix>.channels  {dms: Entry[], guilds: [{id, name, channels: Entry[]}]}
//                      Entry = {id, name, kind: 'dm'|'group'|'text'|'announcement'|'thread'|'forum', category?}
//   <prefix>.ch.<id>   {id, name, kind, guild?, messages: Msg[] (oldest → newest), loading?, error?}
//                      Msg = {id, author: {id, name}, content, ts, edited?, attachments?: [{name}], embeds?: [{title?, description?}],
//                             reply?: {author, content}, mine?, pending?}
//   <prefix>.request   ← {cmd: 'open', channel} from this card (on open, then every 60 s while it shows the channel)
// Sending is the source's {cmd: 'send', channel, content} on <prefix>.request (Claude does it on request).

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { hexToInt, resolveColor } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  channelId: string;
  prefix: string;
  title: string;
  width: number;
  lines: number;
  textSize: number;
}

interface Entry { id: string; name: string; kind: string; category?: string }
interface Guild { id: string; name: string; channels: Entry[] }
interface Msg {
  id: string;
  author: { id: string; name: string };
  content: string;
  ts: number;
  edited?: boolean;
  attachments?: Array<{ name?: string }>;
  embeds?: Array<{ title?: string; description?: string }>;
  reply?: { author?: string; content?: string };
  mine?: boolean;
  pending?: boolean;
}
interface ChannelData { id: string; name: string; kind: string; guild?: string; messages: Msg[]; loading?: boolean; error?: string }
interface PickRow { key: string; label: string; meta: string; icon: string }

const PAD = 0.016;
/** Message slots (a message = author line + wrapped body); more than ever fit the body. */
const SLOTS = 14;
/** A new author line after this gap even for the same author. */
const GROUP_MS = 7 * 60_000;
const LEASE_S = 60;

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export function parseChannelData(v: unknown): ChannelData | null {
  if (!v || typeof v !== 'object' || !Array.isArray((v as { messages?: unknown }).messages)) return null;
  const o = v as Record<string, unknown>;
  const messages: Msg[] = [];
  for (const m of o.messages as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const a = (r.author && typeof r.author === 'object' ? r.author : {}) as Record<string, unknown>;
    const ts = typeof r.ts === 'number' ? r.ts : new Date(str(r.ts)).getTime();
    messages.push({
      id: str(r.id), author: { id: str(a.id), name: str(a.name) || 'unknown' }, content: str(r.content), ts: Number.isFinite(ts) ? ts : 0,
      edited: r.edited === true, mine: r.mine === true, pending: r.pending === true,
      attachments: Array.isArray(r.attachments) ? (r.attachments as Array<{ name?: string }>) : undefined,
      embeds: Array.isArray(r.embeds) ? (r.embeds as Array<{ title?: string; description?: string }>) : undefined,
      reply: r.reply && typeof r.reply === 'object' ? (r.reply as { author?: string; content?: string }) : undefined,
    });
  }
  return { id: str(o.id), name: str(o.name), kind: str(o.kind), guild: str(o.guild) || undefined, messages, loading: o.loading === true, error: str(o.error) || undefined };
}

/** Everything shown for a message body, one string (attachments, embeds, a reply quote). */
export function messageBody(m: Msg, maxChars: number): string {
  const parts: string[] = [];
  if (m.reply && (m.reply.author || m.reply.content)) parts.push(`> ${m.reply.author ?? ''}: ${truncate((m.reply.content ?? '').replace(/\s+/g, ' '), 60)}`);
  if (m.content) parts.push(m.content);
  for (const a of m.attachments ?? []) parts.push(`[file] ${a.name ?? 'attachment'}`);
  for (const e of m.embeds ?? []) {
    const t = [e.title, e.description].filter(Boolean).join(' — ');
    if (t) parts.push(`| ${truncate(t.replace(/\s+/g, ' '), 140)}`);
  }
  let s = parts.join('\n') || ' ';
  if (m.edited) s += ' (edited)';
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

function clock(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hm;
  return `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${hm}`;
}

const kindIcon = (kind: string) => (kind === 'dm' ? 'at-sign' : kind === 'group' ? 'users' : 'hash');

const definition: WidgetDefinition<Props> = {
  description:
    'Discord chat card for one DM / group DM / server channel (prop channelId; empty = picker: Direct messages, servers → channels). ' +
    'Live messages from the discord source (signed in as the user), newest at the bottom; pinch-drag to scroll back, back button returns to ' +
    "the picker. Send with channel_set <prefix>.request {cmd:'send', channel: channelId, content} (only on the user's explicit request).",
  version: '1.0.0',
  props: {
    channelId: { type: 'string', default: '', description: "Discord channel id (DM, group DM or server channel); '' shows the picker." },
    prefix: { type: 'string', default: 'discord', description: 'Channel prefix of the discord source.' },
    title: { type: 'string', default: '', description: "Card title; '' = the channel's name." },
    width: { type: 'number', default: 0.5, min: 0.25, max: 1.5, step: 0.01, description: 'Card width (m).' },
    lines: { type: 'integer', default: 18, min: 6, max: 60, description: 'Height of the message area in text lines.' },
    textSize: { type: 'number', default: 0.0115, min: 0.006, max: 0.04, step: 0.0005, description: 'Message text em height (m); the layout scales with it.' },
  },
  inputs: { channelId: { type: 'string', description: 'Switch to this Discord channel id.' } },
  outputs: { channelId: { type: 'string', description: 'The channel now shown (on open / pick).' } },
  interactions: [dragBinding('discord-drag', 'drag')],
  size: [0.5, 0.5, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const textInt = hexToInt(resolveColor(theme, 'text'));
    const dimInt = hexToInt(resolveColor(theme, 'textDim'));

    // ---- state
    let status: { state: string; user?: { id?: string; name?: string }; error?: string } | null = null;
    let dms: Entry[] = [];
    let guilds: Guild[] = [];
    let chat: ChannelData | null = null;
    let pickView = ''; // '' = home, 'dms', or a guild id
    let pickScroll = 0;
    let scroll = 0; // chat: newest messages skipped
    let dirty = true;
    let lease = 0;
    let offChat: (() => void) | null = null;
    let chatSub = '';

    // ---- built parts
    let group: THREE.Group | null = null;
    let backBtn: THREE.Mesh | null = null;
    let kindIconMesh: THREE.Mesh | null = null;
    let titleText: Text | null = null;
    let subText: Text | null = null;
    let dotMat: THREE.MeshBasicMaterial | null = null;
    let emptyText: Text | null = null;
    let bodyHit: THREE.Mesh | null = null;
    const slots: Array<{ g: THREE.Group; head: Text; body: Text }> = [];
    const pickRows: Array<{ g: THREE.Group; icon: THREE.Mesh; label: Text; meta: Text }> = [];
    let pickItems: PickRow[] = [];
    let thumb: THREE.Mesh | null = null;
    let track: THREE.Mesh | null = null;
    const watch = new MeasureWatch();
    let L = layout();

    function layout() {
      const s = ctx.props.textSize, w = ctx.props.width;
      const lineH = s * 1.25;
      const headerH = s * 3;
      const bodyH = ctx.props.lines * lineH;
      const h = PAD + headerH + bodyH + PAD;
      const top = h / 2 - PAD;
      const bodyTop = top - headerH, bodyBottom = -h / 2 + PAD;
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD - s * 0.6;
      const rowH = s * 2.7;
      return { s, w, h, lineH, headerH, bodyH, top, bodyTop, bodyBottom, x0, x1, textW: x1 - x0, rowH, pickN: Math.max(3, Math.floor(bodyH / rowH)) };
    }

    const channelId = () => ctx.props.channelId.trim();
    const prefix = () => ctx.props.prefix.trim() || 'discord';
    const authorColor = (m: Msg) => {
      if (m.mine) return resolveColor(theme, 'accent');
      let h = 0;
      for (let i = 0; i < m.author.id.length; i++) h = (h * 31 + m.author.id.charCodeAt(i)) | 0;
      return theme.palette[Math.abs(h) % theme.palette.length] ?? theme.accent;
    };

    function build(): void {
      if (group) disposeTree(group);
      slots.length = 0;
      pickRows.length = 0;
      L = layout();
      const g = (group = new T.Group());
      g.add(ctx.ui.panel(L.w, L.h));

      const hy = L.top - L.headerH / 2 + L.s * 0.2;
      backBtn = ctx.ui.panel(L.s * 2.2, L.s * 2.2, { color: theme.surface });
      backBtn.position.set(L.x0 + L.s * 1.1, hy, STYLE.zContent);
      backBtn.name = 'back';
      ctx.interactive(backBtn);
      const chev = makeIcon(ctx, 'chevron-left', { size: L.s * 1.4, color: resolveColor(theme, 'text') });
      chev.position.z = STYLE.zText;
      chev.raycast = () => {};
      backBtn.add(chev);
      kindIconMesh = makeIcon(ctx, 'hash', { size: L.s * 1.3, color: resolveColor(theme, 'textDim') });
      kindIconMesh.raycast = () => {};
      kindIconMesh.position.set(L.x0 + L.s * 3.3, hy, STYLE.zText);
      titleText = makeText(ctx, '', { size: L.s * 1.35, anchorX: 'left', anchorY: 'bottom', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      titleText.position.set(L.x0 + L.s * 4.3, hy - L.s * 0.1, STYLE.zText);
      subText = makeText(ctx, '', { size: L.s * 0.8, anchorX: 'left', anchorY: 'top', color: theme.textDim, whiteSpace: 'nowrap' });
      subText.position.set(L.x0 + L.s * 4.3, hy - L.s * 0.25, STYLE.zText);
      dotMat = ownMaterial(T, theme.textDim);
      const dot = new T.Mesh(sharedGeometry(T, 'disc'), dotMat);
      dot.scale.setScalar(L.s * 0.45);
      dot.position.set(L.w / 2 - PAD - L.s * 0.45, hy, STYLE.zText);
      dot.raycast = () => {};
      const rule = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      rule.scale.set(L.w - 2 * PAD, 0.0008, 1);
      rule.position.set(0, L.bodyTop + L.s * 0.3, STYLE.zContent);
      rule.raycast = () => {};
      g.add(backBtn, kindIconMesh, titleText, subText, dot, rule);

      // Whole message area: a drag target (scroll) that leaves the card's padding grabbable.
      bodyHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      bodyHit.scale.set(L.w - 2 * PAD, L.bodyH, 0.01);
      bodyHit.position.set(0, (L.bodyTop + L.bodyBottom) / 2, 0);
      bodyHit.name = 'body';
      ctx.interactive(bodyHit);
      g.add(bodyHit);

      emptyText = makeText(ctx, '', { size: L.s, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: L.w - 4 * PAD, textAlign: 'center' });
      emptyText.position.set(0, (L.bodyTop + L.bodyBottom) / 2, STYLE.zText);
      g.add(emptyText);

      const watched: THREE.Object3D[] = [];
      for (let i = 0; i < SLOTS; i++) {
        const sg = new T.Group();
        const head = makeText(ctx, '', { size: L.s * 0.9, anchorX: 'left', anchorY: 'top', color: theme.textDim, whiteSpace: 'nowrap', weight: 'semibold' });
        const body = makeText(ctx, '', { size: L.s, anchorX: 'left', anchorY: 'top', color: theme.text, maxWidth: L.textW, lineHeight: 1.25 });
        head.position.set(L.x0, 0, STYLE.zText);
        body.position.set(L.x0, 0, STYLE.zText);
        sg.add(head, body);
        sg.visible = false;
        g.add(sg);
        slots.push({ g: sg, head, body });
        watched.push(body);
      }
      watch.reset(watched);

      for (let r = 0; r < L.pickN; r++) {
        const rg = new T.Group();
        rg.position.set(0, L.bodyTop - (r + 0.5) * L.rowH, 0);
        const icon = makeIcon(ctx, 'hash', { size: L.s * 1.2, color: resolveColor(theme, 'textDim') });
        icon.raycast = () => {};
        icon.position.set(L.x0 + L.s * 0.7, 0, STYLE.zText);
        const label = makeText(ctx, '', { size: L.s * 1.05, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        label.position.set(L.x0 + L.s * 2, L.s * 0.1, STYLE.zText);
        const meta = makeText(ctx, '', { size: L.s * 0.8, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
        meta.position.set(L.x1, L.s * 0.1, STYLE.zText);
        const plate = ctx.ui.panel(L.w - 2 * PAD, L.rowH - L.s * 0.35, { color: theme.surface, opacity: 0.55 });
        plate.position.z = STYLE.zContent;
        plate.name = `pick:${r}`;
        ctx.interactive(plate);
        rg.add(plate, icon, label, meta);
        rg.visible = false;
        g.add(rg);
        pickRows.push({ g: rg, icon, label, meta });
      }

      track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      track.scale.set(L.s * 0.16, L.bodyH, 1);
      track.position.set(L.w / 2 - PAD * 0.55, (L.bodyTop + L.bodyBottom) / 2, STYLE.zContent);
      thumb = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.textDim));
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      for (const m of [track, thumb]) { m.raycast = () => {}; g.add(m); }

      ctx.root.add(g);
      dirty = true;
    }

    // ---- data
    function subscribeChat(): void {
      const id = channelId();
      const name = id ? `${prefix()}.ch.${id}` : '';
      if (name === chatSub) return;
      offChat?.();
      offChat = null;
      chatSub = name;
      chat = null;
      scroll = 0;
      dirty = true;
      if (!name) return;
      requestOpen();
      offChat = ctx.channels.subscribe(name, (v: ChannelValue) => {
        if (chatSub !== name) return;
        const d = parseChannelData(v);
        if (!d) { ctx.error('discord: unexpected channel data'); return; }
        // Keep the view anchored while scrolled back and new messages arrive.
        if (chat && scroll > 0 && d.messages.length > chat.messages.length) {
          const lastId = chat.messages.at(-1)?.id;
          const idx = d.messages.findIndex((m) => m.id === lastId);
          if (idx >= 0) scroll += d.messages.length - 1 - idx;
        }
        chat = d;
        dirty = true;
      });
    }

    function requestOpen(): void {
      lease = 0;
      const id = channelId();
      if (id && !ctx.isMirror) ctx.channels.publish(`${prefix()}.request`, { cmd: 'open', channel: id });
    }

    const subs: Array<() => void> = [];
    function subscribeMeta(): void {
      for (const off of subs.splice(0)) off();
      subs.push(ctx.channels.subscribe(`${prefix()}.status`, (v) => {
        status = v && typeof v === 'object' ? (v as typeof status) : null;
        dirty = true;
      }));
      subs.push(ctx.channels.subscribe(`${prefix()}.channels`, (v) => {
        const o = (v && typeof v === 'object' ? v : {}) as { dms?: unknown; guilds?: unknown };
        dms = Array.isArray(o.dms) ? (o.dms as Entry[]).filter((e) => e && str(e.id)) : [];
        guilds = Array.isArray(o.guilds) ? (o.guilds as Guild[]).filter((x) => x && str(x.id) && Array.isArray(x.channels)) : [];
        dirty = true;
      }));
    }

    function open(id: string): void {
      ctx.setProps({ channelId: id });
      ctx.emit('channelId', id);
      subscribeChat();
    }

    // ---- render
    function statusLine(): string {
      if (!status) return 'Waiting for the discord source (needs DISCORD_USER_TOKEN in ~/.config/evolspace/secrets.env)';
      if (status.state === 'error') return `Discord: ${status.error ?? 'error'}`;
      if (status.state !== 'ready') return 'Connecting to Discord…';
      return '';
    }

    function render(): void {
      if (!group) return;
      dotMat!.color.set(status?.state === 'ready' ? theme.positive : status?.state === 'error' ? theme.negative : theme.textDim);
      const id = channelId();
      backBtn!.visible = !!id || pickView !== '';
      // The message-area drag target sits in front of the picker rows: only the chat view may have it.
      bodyHit!.visible = !!id;
      if (id) renderChat();
      else renderPicker();
    }

    function renderChat(): void {
      for (const r of pickRows) r.g.visible = false;
      const c = chat;
      const entry = dms.find((e) => e.id === channelId()) ?? guilds.flatMap((x) => x.channels).find((e) => e.id === channelId());
      const kind = c?.kind || entry?.kind || 'text';
      setIcon(T, kindIconMesh!, kindIcon(kind));
      titleText!.set(truncate(ctx.props.title || c?.name || entry?.name || channelId(), 40));
      const sub = c?.guild ?? guilds.find((x) => x.channels.some((e) => e.id === channelId()))?.name ?? (kind === 'dm' ? 'Direct message' : kind === 'group' ? 'Group DM' : '');
      subText!.set(truncate([sub, scroll > 0 ? `${Math.round(scroll)} newer below` : ''].filter(Boolean).join(' · '), 60));

      const msgs = c?.messages ?? [];
      const note = statusLine() || c?.error || (c?.loading && !msgs.length ? 'Loading messages…' : !c ? 'Loading messages…' : !msgs.length ? 'No messages yet' : '');
      emptyText!.set(msgs.length ? '' : note);
      emptyText!.visible = !msgs.length;

      scroll = Math.max(0, Math.min(scroll, Math.max(0, msgs.length - 1)));
      const charsPerLine = Math.max(10, Math.floor(L.textW / (L.s * 0.5)));
      const maxChars = charsPerLine * Math.max(2, ctx.props.lines - 2);
      let y = L.bodyBottom + L.s * 0.2;
      let used = 0;
      let i = msgs.length - 1 - Math.round(scroll);
      for (; used < SLOTS && i >= 0; i--) {
        const m = msgs[i], prev = msgs[i - 1];
        const showHead = !prev || prev.author.id !== m.author.id || m.ts - prev.ts > GROUP_MS;
        const slot = slots[used];
        const bodyStr = messageBody(m, maxChars);
        slot.body.set(bodyStr);
        (slot.body as unknown as { fillOpacity?: number }).fillOpacity = m.pending ? 0.55 : 1;
        const bh = textSize(slot.body, { text: bodyStr, size: L.s, maxWidth: L.textW, lineHeight: 1.25 }).height;
        const hh = showHead ? L.s * 1.35 : 0;
        const gap = showHead ? L.s * 0.55 : L.s * 0.2;
        const h = hh + bh + gap;
        if (used > 0 && y + h > L.bodyTop) break; // the newest one always shows (clipped content)
        slot.g.visible = true;
        slot.head.visible = showHead;
        if (showHead) {
          const name = m.author.name;
          slot.head.set(`${name}  ${clock(m.ts)}${m.pending ? '  sending…' : ''}`);
          setColorRanges(slot.head, { 0: hexToInt(authorColor(m)), [name.length]: dimInt });
        }
        const top = y + h - gap * 0.5;
        slot.head.position.y = top;
        slot.body.position.y = top - hh;
        y += h;
        used++;
      }
      for (let k = used; k < SLOTS; k++) slots[k].g.visible = false;
      const over = msgs.length > used;
      track!.visible = thumb!.visible = over;
      if (over) {
        const frac = used / msgs.length;
        const th = Math.max(L.s * 1.5, L.bodyH * frac);
        const u = msgs.length - used > 0 ? Math.min(1, scroll / Math.max(1, msgs.length - used)) : 0;
        thumb!.scale.set(L.s * 0.16, th, 1);
        thumb!.position.y = L.bodyBottom + th / 2 + u * (L.bodyH - th);
      }
    }

    function pickList(): PickRow[] {
      if (pickView === 'dms') return dms.map((e) => ({ key: e.id, label: e.name, meta: e.kind === 'group' ? 'group' : '', icon: kindIcon(e.kind) }));
      if (pickView) {
        const gd = guilds.find((x) => x.id === pickView);
        return (gd?.channels ?? []).map((e) => ({ key: e.id, label: e.name, meta: e.category ?? '', icon: kindIcon(e.kind) }));
      }
      const rows: PickRow[] = [];
      if (dms.length) rows.push({ key: 'view:dms', label: 'Direct messages', meta: `${dms.length}`, icon: 'at-sign' });
      for (const gd of guilds) rows.push({ key: `view:${gd.id}`, label: gd.name, meta: `${gd.channels.length}`, icon: 'users' });
      return rows;
    }

    function renderPicker(): void {
      for (const s of slots) s.g.visible = false;
      setIcon(T, kindIconMesh!, pickView === 'dms' ? 'at-sign' : pickView ? 'users' : 'message-square');
      const gd = pickView && pickView !== 'dms' ? guilds.find((x) => x.id === pickView) : undefined;
      titleText!.set(ctx.props.title || (pickView === 'dms' ? 'Direct messages' : gd ? truncate(gd.name, 40) : 'Discord'));
      subText!.set(status?.state === 'ready' && status.user?.name ? `Signed in as ${status.user.name}` : '');
      pickItems = pickList();
      const note = statusLine() || (pickItems.length ? '' : 'Nothing here');
      emptyText!.set(pickItems.length ? '' : note);
      emptyText!.visible = !pickItems.length;
      pickScroll = Math.max(0, Math.min(pickScroll, Math.max(0, pickItems.length - L.pickN)));
      const first = Math.round(pickScroll);
      const chars = Math.max(8, Math.floor((L.textW - L.s * 7) / (L.s * 1.05 * 0.52)));
      for (let r = 0; r < L.pickN; r++) {
        const p = pickRows[r], it = pickItems[first + r];
        p.g.visible = !!it;
        if (!it) continue;
        setIcon(T, p.icon, it.icon);
        p.label.set(truncate(it.label, chars));
        p.meta.set(truncate(it.meta, 18));
      }
      const over = pickItems.length > L.pickN;
      track!.visible = thumb!.visible = over;
      if (over) {
        const th = Math.max(L.s * 1.5, (L.bodyH * L.pickN) / pickItems.length);
        const u = first / (pickItems.length - L.pickN);
        thumb!.scale.set(L.s * 0.16, th, 1);
        thumb!.position.y = L.bodyTop - th / 2 - u * (L.bodyH - th);
      }
    }

    // ---- interaction
    let dragHand: string | null = null;
    let dragPart = '';
    let dragY0 = 0, scroll0 = 0, dragMoved = false;

    function tap(part: string): void {
      if (part === 'back') {
        if (channelId()) {
          // Back to the list this channel came from.
          const id = channelId();
          pickView = dms.some((e) => e.id === id) ? 'dms' : guilds.find((x) => x.channels.some((e) => e.id === id))?.id ?? '';
          ctx.setProps({ channelId: '' });
          subscribeChat();
        } else {
          pickView = '';
        }
        pickScroll = 0;
        dirty = true;
        return;
      }
      if (part.startsWith('pick:')) {
        const it = pickItems[Math.round(pickScroll) + Number(part.slice(5))];
        if (!it) return;
        if (it.key.startsWith('view:')) { pickView = it.key.slice(5); pickScroll = 0; dirty = true; }
        else open(it.key);
      }
    }

    build();
    subscribeMeta();
    subscribeChat();

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.lines !== prev.lines || p.textSize !== prev.textSize) build();
        if (p.prefix !== prev.prefix) { subscribeMeta(); chatSub = ''; }
        if (p.channelId !== prev.channelId || p.prefix !== prev.prefix) subscribeChat();
        dirty = true;
      },
      onInput(port, v) {
        if (port !== 'channelId') return;
        const id = str(v).trim();
        if (/^\d{5,25}$/.test(id) && id !== channelId()) open(id);
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') return;
        if (e.phase === 'start') {
          if (dragHand) return;
          dragHand = e.hand;
          dragPart = part;
          dragY0 = e.localPoint[1];
          scroll0 = channelId() ? scroll : pickScroll;
          dragMoved = false;
          return;
        }
        if (e.hand !== dragHand) return;
        if (e.phase === 'move') {
          const dy = e.localPoint[1] - dragY0;
          if (!dragMoved && Math.abs(dy) > L.s * 1.2 && dragPart !== 'back') dragMoved = true;
          if (!dragMoved) return;
          if (channelId()) {
            // Pull the messages down to read older ones (about two lines per message).
            const max = Math.max(0, (chat?.messages.length ?? 1) - 1);
            const s = Math.min(max, Math.max(0, scroll0 - dy / (L.lineH * 2.5)));
            if (Math.round(s) !== Math.round(scroll)) dirty = true;
            scroll = s;
          } else {
            const max = Math.max(0, pickItems.length - L.pickN);
            const s = Math.min(max, Math.max(0, scroll0 + dy / L.rowH));
            if (Math.round(s) !== Math.round(pickScroll)) dirty = true;
            pickScroll = s;
          }
          return;
        }
        dragHand = null;
        if (e.phase === 'end' && !dragMoved) tap(dragPart);
      },
      update(dt) {
        if (channelId()) {
          lease += dt;
          if (lease > LEASE_S) requestOpen();
        }
        if (watch.changed()) dirty = true; // real glyph heights arrived: lay out again
        if (!dirty) return;
        dirty = false;
        render();
      },
      dispose() {
        offChat?.();
        for (const off of subs.splice(0)) off();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
