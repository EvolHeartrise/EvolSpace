// discord — a Discord chat card in Discord's own look (dark theme, cozy message layout): one DM,
// group DM or server channel, live, newest message at the bottom; avatars, reply previews, inline
// images. Pinch-drag the messages to scroll (smooth: follows the hand, glides after a flick —
// shared/scroll.ts). Without a channel (or after the back button) the card is a picker:
// Direct messages + servers (icons, unread pills, mention badges) → channels (unread in white).
//
// Data comes from the `discord` source (library/sources/discord, signed in with the user's account):
//   <prefix>.status    {state: 'connecting'|'ready'|'error', user?: {id, name}, error?}
//   <prefix>.channels  {dms: Entry[], guilds: [{id, name, icon?, unread?, mentions?, muted?, channels: Entry[]}]}
//                      Entry = {id, name, kind, category?, icon?, unread?, mentions?, muted?}
//   <prefix>.ch.<id>   {id, name, kind, guild?, messages: Msg[] (oldest → newest), loading?, error?}
//                      Msg = {id, author: {id, name, avatar?}, content, ts, edited?, attachments?: [{name, image?: {src, w, h}}],
//                             embeds?: [{title?, description?}], reply?: {author, content, avatar?}, mine?, pending?}
//   <prefix>.request   ← {cmd: 'open', channel} from this card (on open, then every 60 s while it shows the channel;
//                        the source marks the channel read while it is shown)
// Sending is the source's {cmd: 'send', channel, content} on <prefix>.request (Claude does it on request).
//
// Scrolling without flicker: a message keeps its slot (texts, avatar) for as long as it stays in view,
// so scrolling only moves slots; a slot that gets a new message stays hidden until troika has laid out
// its text (no stale wrapping), and measured heights replace estimates without moving what is in view.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { hexToInt } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { estimateTextBlock } from '../../shared/layout.ts';
import { dragBinding } from '../../shared/handle.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { ScrollViewport, SmoothScroll } from '../../shared/scroll.ts';

interface Props extends Record<string, unknown> {
  channelId: string;
  prefix: string;
  title: string;
  width: number;
  lines: number;
  textSize: number;
}

interface Entry { id: string; name: string; kind: string; category?: string; icon?: string; unread?: boolean; mentions?: number; muted?: boolean }
interface Guild { id: string; name: string; icon?: string; unread?: boolean; mentions?: number; muted?: boolean; channels: Entry[] }
interface Msg {
  id: string;
  author: { id: string; name: string; avatar?: string };
  content: string;
  ts: number;
  edited?: boolean;
  attachments?: Array<{ name?: string; image?: { src: string; w: number; h: number } }>;
  embeds?: Array<{ title?: string; description?: string }>;
  reply?: { author?: string; content?: string; avatar?: string };
  mine?: boolean;
  pending?: boolean;
}
interface ChannelData { id: string; name: string; kind: string; guild?: string; messages: Msg[]; loading?: boolean; error?: string }
/** A picker row: a server / the DM list (view:…), a channel or DM (its id), or a category header. */
interface PickRow { key: string; label: string; icon: string; image?: string; unread: boolean; mentions: number; muted: boolean; header?: boolean }
/** A message laid out for the chat view. */
interface Laid { id: string; body: string; ranges: Record<number, number> | null; head: boolean; reply: boolean; image: { src: string; w: number; h: number } | null; h: number }

/** Discord's dark theme. */
const DC = {
  bg: '#313338', side: '#2b2d31', dark: '#1e1f22', text: '#dbdee1', head: '#f2f3f5', muted: '#949ba4', channel: '#80848e',
  faint: '#6d6f78', link: '#00a8fc', mention: '#c9cdfb', input: '#383a40', divider: '#3f4147', spine: '#4e5058',
  green: '#23a55a', red: '#f23f43', blurple: '#5865f2', thumb: '#1a1b1e',
};
const SLOTS = 16;
/** A new author group after this gap even for the same author (Discord: 7 min). */
const GROUP_MS = 7 * 60_000;
const LEASE_S = 60;

/** The string a troika text currently holds. */
const textOf = (t: Text): string => (t as unknown as { text: string }).text;
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
      id: str(r.id), author: { id: str(a.id), name: str(a.name) || 'unknown', avatar: str(a.avatar) || undefined }, content: str(r.content), ts: Number.isFinite(ts) ? ts : 0,
      edited: r.edited === true, mine: r.mine === true, pending: r.pending === true,
      attachments: Array.isArray(r.attachments) ? (r.attachments as Msg['attachments']) : undefined,
      embeds: Array.isArray(r.embeds) ? (r.embeds as Msg['embeds']) : undefined,
      reply: r.reply && typeof r.reply === 'object' ? (r.reply as Msg['reply']) : undefined,
    });
  }
  return { id: str(o.id), name: str(o.name), kind: str(o.kind), guild: str(o.guild) || undefined, messages, loading: o.loading === true, error: str(o.error) || undefined };
}

/** A message's text (content, non-image files, embeds, "(edited)") and its color ranges. */
export function messageBody(m: Msg, maxChars: number, ints: { text: number; link: number; mention: number; faint: number } | null = null): { text: string; ranges: Record<number, number> | null } {
  const parts: Array<[string, 'text' | 'link']> = [];
  if (m.content) parts.push([m.content, 'text']);
  for (const a of m.attachments ?? []) if (!a.image) parts.push([`[file] ${a.name ?? 'attachment'}`, 'link']);
  for (const e of m.embeds ?? []) {
    const t = [e.title, e.description].filter(Boolean).join(' — ');
    if (t) parts.push([`| ${truncate(t.replace(/\s+/g, ' '), 140)}`, 'link']);
  }
  let text = '';
  const ranges: Record<number, number> = {};
  for (const [p, kind] of parts) {
    if (text) text += '\n';
    if (ints) ranges[text.length] = kind === 'link' ? ints.link : ints.text;
    if (ints && kind === 'text') {
      const re = /(^|\s)(@[^\s@]+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(p))) {
        const at = text.length + mm.index + mm[1].length;
        ranges[at] = ints.mention;
        ranges[at + mm[2].length] = ints.text;
      }
    }
    text += p;
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  if (m.edited) {
    if (ints) ranges[text.length] = ints.faint;
    text += text ? ' (edited)' : '(edited)';
  }
  return { text, ranges: ints ? ranges : null };
}

/** "Today at 4:05 PM" / "Yesterday at …" / "10/09/2026 4:05 PM", like Discord. */
export function discordTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Yesterday at ${time}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()} ${time}`;
}

/** Names without emoji (the bundled fonts have none: they would show as boxes), e.g. "👋welcome" → "welcome". */
export const cleanName = (s: string): string => s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu, '').replace(/\s{2,}/g, ' ').trim() || s;
const kindIcon = (kind: string) => (kind === 'dm' ? 'at-sign' : kind === 'group' ? 'users' : 'hash');
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3) || '?';

const definition: WidgetDefinition<Props> = {
  description:
    'Discord chat card in Discord\'s look for one DM / group DM / server channel (prop channelId; empty = picker: Direct messages, servers → channels, ' +
    'with unread pills and mention badges). Live messages from the discord source (signed in as the user) with avatars, replies and inline ' +
    'images, newest at the bottom; pinch-drag to scroll, back button returns to the picker. Send with channel_set <prefix>.request ' +
    "{cmd:'send', channel: channelId, content} (only on the user's explicit request).",
  version: '2.0.0',
  props: {
    channelId: { type: 'string', default: '', description: "Discord channel id (DM, group DM or server channel); '' shows the picker." },
    prefix: { type: 'string', default: 'discord', description: 'Channel prefix of the discord source.' },
    title: { type: 'string', default: '', description: "Card title; '' = the channel's name." },
    width: { type: 'number', default: 0.5, min: 0.25, max: 1.5, step: 0.01, description: 'Card width (m).' },
    lines: { type: 'integer', default: 16, min: 6, max: 60, description: 'Height of the message area in text lines.' },
    textSize: { type: 'number', default: 0.0115, min: 0.006, max: 0.04, step: 0.0005, description: "Message text em height (m) = Discord's 16 px; the whole layout scales with it." },
  },
  inputs: { channelId: { type: 'string', description: 'Switch to this Discord channel id.' } },
  outputs: { channelId: { type: 'string', description: 'The channel now shown (on open / pick).' } },
  interactions: [dragBinding('discord-drag', 'drag')],
  size: [0.5, 0.5, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const I = {
      text: hexToInt(DC.text), head: hexToInt(DC.head), muted: hexToInt(DC.muted), faint: hexToInt(DC.faint),
      link: hexToInt(DC.link), mention: hexToInt(DC.mention),
    };
    const Z = { bg: 0.0005, content: 0.001, over: 0.002, text: 0.003 };

    // ---- state
    let status: { state: string; user?: { id?: string; name?: string }; error?: string } | null = null;
    let dms: Entry[] = [];
    let guilds: Guild[] = [];
    let chat: ChannelData | null = null;
    let pickView = ''; // '' = home, 'dms', or a guild id
    let pickStale = true;
    let pickItems: PickRow[] = [];
    const pickScroll = new SmoothScroll(); // rows
    let chatScroll = new SmoothScroll(); // meters above the newest message (0 = at the bottom)
    let laid: Laid[] = []; // oldest → newest
    let offsets: number[] = []; // bottom of each message above the newest's bottom (m)
    let total = 0;
    let dirty = true;
    let lease = 0;
    let offChat: (() => void) | null = null;
    let chatSub = '';

    // ---- textures (avatars, icons, images): same-origin /media files, cached per card
    const textures = new Map<string, THREE.Texture>();
    const canLoad = typeof document !== 'undefined';
    let placeholder: THREE.Texture | null = null;
    function placeholderTex(): THREE.Texture {
      if (!placeholder) {
        placeholder = new T.DataTexture(new Uint8Array([88, 101, 242, 255]), 1, 1); // blurple, like a default avatar
        placeholder.needsUpdate = true;
      }
      return placeholder;
    }
    /** The texture for `src` once loaded (loading starts on first ask), else null. */
    function tex(src: string | undefined): THREE.Texture | null {
      if (!src || !canLoad) return null;
      let t = textures.get(src);
      if (!t) {
        t = new T.TextureLoader().load(src, (x) => { x.userData.loaded = true; dirty = true; });
        t.colorSpace = T.SRGBColorSpace;
        textures.set(src, t);
      }
      return t.userData.loaded ? t : null;
    }
    function setMap(mat: THREE.MeshBasicMaterial, src: string | undefined): void {
      const t = tex(src) ?? placeholderTex();
      if (mat.map !== t) mat.map = t;
    }

    // ---- built parts
    interface Slot {
      g: THREE.Group; avatar: THREE.Mesh; avatarMat: THREE.MeshBasicMaterial; name: Text; time: Text; body: Text;
      reply: THREE.Group; spine: THREE.Mesh; spine2: THREE.Mesh; mini: THREE.Mesh; miniMat: THREE.MeshBasicMaterial; replyText: Text;
      img: THREE.Mesh; imgMat: THREE.MeshBasicMaterial;
      msg: string; ready: boolean; waitInfo: unknown; waitFrames: number;
    }
    interface PickSlot {
      g: THREE.Group; icon: THREE.Mesh; disc: THREE.Mesh; discMat: THREE.MeshBasicMaterial; initials: Text; label: Text; header: Text;
      pill: THREE.Mesh; badge: THREE.Mesh; badgeText: Text;
    }
    let group: THREE.Group | null = null;
    let backBtn: THREE.Mesh | null = null;
    let kindIconMesh: THREE.Mesh | null = null;
    let titleText: Text | null = null;
    let subText: Text | null = null;
    let dotMat: THREE.MeshBasicMaterial | null = null;
    let emptyText: Text | null = null;
    let bodyHit: THREE.Mesh | null = null;
    let inputBar: THREE.Group | null = null;
    let inputText: Text | null = null;
    const slots: Slot[] = [];
    const pickRows: PickSlot[] = [];
    let thumb: THREE.Mesh | null = null;
    let track: THREE.Mesh | null = null;
    let chatView: ScrollViewport | null = null;
    let pickViewport: ScrollViewport | null = null;
    const watch = new MeasureWatch();
    let L = layout();

    function layout() {
      const s = ctx.props.textSize, w = ctx.props.width;
      const P = s / 16; // one Discord CSS pixel
      const headerH = 48 * P, inputH = 44 * P, inputGap = 22 * P;
      const bodyH = ctx.props.lines * 22 * P;
      const h = headerH + bodyH + inputH + inputGap;
      const top = h / 2, bottom = -h / 2;
      const headerBottom = top - headerH;
      const inputTop = bottom + inputGap + inputH;
      const x0 = -w / 2;
      const textX = x0 + 72 * P;
      const textW = w / 2 - 22 * P - textX;
      return { s, P, w, h, top, bottom, headerH, headerBottom, inputTop, inputH, inputGap, bodyH, x0, textX, textW, rowH: 40 * P, pickN: Math.max(3, Math.floor((headerBottom - bottom - 8 * P) / (40 * P))) };
    }

    const channelId = () => ctx.props.channelId.trim();
    const prefix = () => ctx.props.prefix.trim() || 'discord';
    const plane = (color: string, w: number, h: number, x: number, y: number, z: number) => {
      const m = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, color));
      m.scale.set(w, h, 1);
      m.position.set(x, y, z);
      m.raycast = () => {};
      return m;
    };
    const disc = (d: number, x: number, y: number) => {
      const mat = new T.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex() });
      const m = new T.Mesh(sharedGeometry(T, 'disc'), mat);
      m.scale.set(d, d, 1);
      m.position.set(x, y, Z.content);
      m.raycast = () => {};
      return { m, mat };
    };

    function build(): void {
      if (group) disposeTree(group);
      slots.length = 0;
      pickRows.length = 0;
      L = layout();
      const { P } = L;
      const g = (group = new T.Group());
      g.add(ctx.ui.panel(L.w, L.h, { color: DC.bg, radius: 8 * P }));

      // header: [‹] # name  guild ·······  ●
      const hy = L.top - L.headerH / 2;
      backBtn = ctx.ui.panel(28 * P, 28 * P, { color: DC.side, radius: 6 * P });
      backBtn.position.set(L.x0 + 22 * P, hy, Z.content + 0.006); // in front of the row hit boxes
      backBtn.name = 'back';
      ctx.interactive(backBtn);
      const chev = makeIcon(ctx, 'chevron-left', { size: 18 * P, color: DC.muted });
      chev.position.z = Z.text;
      chev.raycast = () => {};
      backBtn.add(chev);
      kindIconMesh = makeIcon(ctx, 'hash', { size: 22 * P, color: DC.faint });
      kindIconMesh.raycast = () => {};
      kindIconMesh.position.set(L.x0 + 52 * P, hy, Z.text);
      titleText = makeText(ctx, '', { size: 16 * P, anchorX: 'left', anchorY: 'middle', color: DC.head, weight: 'semibold', whiteSpace: 'nowrap' });
      titleText.position.set(L.x0 + 68 * P, hy, Z.text);
      subText = makeText(ctx, '', { size: 13 * P, anchorX: 'left', anchorY: 'middle', color: DC.muted, whiteSpace: 'nowrap' });
      subText.position.set(L.x0 + 68 * P, hy, Z.text); // x set after the title is measured
      dotMat = ownMaterial(T, DC.faint);
      const dot = new T.Mesh(sharedGeometry(T, 'disc'), dotMat);
      dot.scale.setScalar(10 * P);
      dot.position.set(L.w / 2 - 18 * P, hy, Z.text);
      dot.raycast = () => {};
      g.add(backBtn, kindIconMesh, titleText, subText, dot, plane(DC.dark, L.w, 1.5 * P, 0, L.headerBottom, Z.over));

      // the message area: drag target for scrolling (chat view only)
      bodyHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      bodyHit.scale.set(L.w - 16 * P, L.headerBottom - L.inputTop, 0.01);
      bodyHit.position.set(0, (L.headerBottom + L.inputTop) / 2, 0);
      bodyHit.name = 'body';
      ctx.interactive(bodyHit);
      g.add(bodyHit);

      emptyText = makeText(ctx, '', { size: 14 * P, anchorX: 'center', anchorY: 'middle', color: DC.muted, maxWidth: L.w - 64 * P, textAlign: 'center' });
      emptyText.position.set(0, (L.headerBottom + L.inputTop) / 2, Z.text);
      g.add(emptyText);

      // the message box (read-only here: sending goes through Claude)
      inputBar = new T.Group();
      const box = ctx.ui.panel(L.w - 32 * P, L.inputH, { color: DC.input, radius: 8 * P });
      box.position.set(0, L.bottom + L.inputGap + L.inputH / 2, Z.content);
      box.raycast = () => {};
      const plus = disc(24 * P, L.x0 + 16 * P + 28 * P, box.position.y);
      plus.mat.map = null;
      plus.mat.color.set(DC.muted);
      plus.m.position.z = Z.over;
      const plusIcon = makeIcon(ctx, 'plus', { size: 16 * P, color: DC.input });
      plusIcon.position.set(plus.m.position.x, box.position.y, Z.text);
      plusIcon.raycast = () => {};
      inputText = makeText(ctx, '', { size: 16 * P, anchorX: 'left', anchorY: 'middle', color: DC.faint, whiteSpace: 'nowrap' });
      inputText.position.set(L.x0 + 60 * P, box.position.y, Z.text);
      inputBar.add(box, plus.m, plusIcon, inputText);
      g.add(inputBar);

      // message slots
      chatView = new ScrollViewport(T, g, L.inputTop, L.headerBottom);
      const watched: THREE.Object3D[] = [];
      for (let i = 0; i < SLOTS; i++) {
        const sg = new T.Group();
        const av = disc(40 * P, L.x0 + 36 * P, 0);
        const name = makeText(ctx, '', { size: 16 * P, anchorX: 'left', anchorY: 'middle', color: DC.head, weight: 'semibold', whiteSpace: 'nowrap' });
        name.position.set(L.textX, 0, Z.text);
        const time = makeText(ctx, '', { size: 12 * P, anchorX: 'left', anchorY: 'middle', color: DC.muted, whiteSpace: 'nowrap' });
        time.position.set(L.textX, 0, Z.text);
        const body = makeText(ctx, '', { size: 16 * P, anchorX: 'left', anchorY: 'top', color: DC.text, maxWidth: L.textW, lineHeight: 1.375 });
        body.position.set(L.textX, 0, Z.text);
        // reply preview: a spine from the avatar up to the quoted author's mini avatar + name + text
        const reply = new T.Group();
        const spine = plane(DC.spine, 2 * P, 10 * P, L.x0 + 36 * P, -5 * P, Z.content);
        const spine2 = plane(DC.spine, 32 * P, 2 * P, L.x0 + 52 * P, 0, Z.content);
        const mini = disc(16 * P, L.textX + 8 * P, 0);
        const replyText = makeText(ctx, '', { size: 14 * P, anchorX: 'left', anchorY: 'middle', color: DC.muted, whiteSpace: 'nowrap' });
        replyText.position.set(L.textX + 20 * P, 0, Z.text);
        reply.add(spine, spine2, mini.m, replyText);
        const imgMat = new T.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex() });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), imgMat);
        img.raycast = () => {};
        sg.add(av.m, name, time, body, reply, img);
        sg.visible = false;
        g.add(sg);
        chatView.add(sg);
        slots.push({ g: sg, avatar: av.m, avatarMat: av.mat, name, time, body, reply, spine, spine2, mini: mini.m, miniMat: mini.mat, replyText, img, imgMat, msg: '', ready: false, waitInfo: null, waitFrames: 0 });
        watched.push(body, name);
      }
      watch.reset(watched);

      // picker rows (one more than fits: while scrolling, the top and bottom rows are both partly visible)
      pickViewport = new ScrollViewport(T, g, L.bottom + 8 * P, L.headerBottom);
      for (let r = 0; r <= L.pickN; r++) {
        const rg = new T.Group();
        const pill = ctx.ui.panel(4 * P, 8 * P, { color: DC.head, radius: 2 * P });
        pill.position.set(L.x0 + 2 * P, 0, Z.content);
        pill.raycast = () => {};
        const d = disc(32 * P, L.x0 + 28 * P, 0);
        const ini = makeText(ctx, '', { size: 12 * P, anchorX: 'center', anchorY: 'middle', color: DC.head, whiteSpace: 'nowrap' });
        ini.position.set(L.x0 + 28 * P, 0, Z.text);
        const icon = makeIcon(ctx, 'hash', { size: 20 * P, color: DC.channel });
        icon.raycast = () => {};
        icon.position.set(L.x0 + 28 * P, 0, Z.text);
        const label = makeText(ctx, '', { size: 16 * P, anchorX: 'left', anchorY: 'middle', color: DC.channel, whiteSpace: 'nowrap' });
        label.position.set(L.x0 + 52 * P, 0, Z.text);
        const header = makeText(ctx, '', { size: 12 * P, anchorX: 'left', anchorY: 'middle', color: DC.muted, whiteSpace: 'nowrap', weight: 'semibold' });
        header.position.set(L.x0 + 16 * P, -4 * P, Z.text);
        const badge = ctx.ui.panel(22 * P, 16 * P, { color: DC.red, radius: 8 * P });
        badge.position.set(L.w / 2 - 30 * P, 0, Z.content);
        badge.raycast = () => {};
        const badgeText = makeText(ctx, '', { size: 12 * P, anchorX: 'center', anchorY: 'middle', color: '#ffffff', weight: 'semibold', whiteSpace: 'nowrap' });
        badgeText.position.z = Z.text - Z.content;
        badge.add(badgeText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(L.w - 16 * P, L.rowH, 0.01);
        hit.name = `pick:${r}`;
        ctx.interactive(hit);
        rg.add(pill, d.m, ini, icon, label, header, badge, hit);
        rg.visible = false;
        g.add(rg);
        pickViewport.add(rg);
        pickRows.push({ g: rg, icon, disc: d.m, discMat: d.mat, initials: ini, label, header, pill, badge, badgeText });
      }

      track = plane(DC.side, 8 * P, L.headerBottom - L.inputTop - 8 * P, L.w / 2 - 8 * P, (L.headerBottom + L.inputTop) / 2, Z.content);
      thumb = plane(DC.thumb, 8 * P, 1, L.w / 2 - 8 * P, 0, Z.over);
      g.add(track, thumb);

      ctx.root.add(g);
      chatScroll = new SmoothScroll({ unit: 44 * P });
      relayout();
      dirty = true;
    }

    // ---- chat layout (heights estimated, then replaced by troika's measurements)
    function relayout(): void {
      const msgs = chat?.messages ?? [];
      const known = new Map(laid.map((x) => [x.id, x]));
      const maxChars = Math.max(10, Math.floor(L.textW / (L.s * 0.5))) * Math.max(2, ctx.props.lines - 2);
      laid = msgs.map((m, i) => {
        const prev = msgs[i - 1];
        const head = !prev || prev.author.id !== m.author.id || m.ts - prev.ts > GROUP_MS || !!m.reply;
        const b = messageBody(m, maxChars, I);
        const im = m.attachments?.find((a) => a.image)?.image;
        const image = im ? fitImage(im) : null;
        const old = known.get(m.id);
        if (old && old.body === b.text && old.head === head && old.image?.src === image?.src) return old;
        const bh = b.text ? estimateTextBlock(b.text, L.s, L.textW, 'sans', 1.375).height : 0;
        return { id: m.id, body: b.text, ranges: b.ranges, head, reply: !!m.reply, image, h: blockH(head, !!m.reply, bh, image) };
      });
      sumOffsets();
    }

    /** An image attachment's on-card size: at most 400 × 300 Discord px and the text column's width. */
    function fitImage(im: { src: string; w: number; h: number }) {
      const { P } = L;
      const w = Math.max(1, im.w) * P, h = Math.max(1, im.h) * P;
      const k = Math.min(1, Math.min(L.textW, 400 * P) / w, (300 * P) / h);
      return { src: im.src, w: w * k, h: h * k };
    }

    /** Block height: group padding + reply line + name line + body + image + bottom padding (Discord cozy). */
    function blockH(head: boolean, reply: boolean, bodyH: number, image: { h: number } | null): number {
      const { P } = L;
      let h = (head ? 17 : 2) * P + (reply ? 22 * P : 0) + (head ? 22 * P : 0) + bodyH + (image ? image.h + (bodyH ? 6 * P : 2 * P) : 0) + 2 * P;
      if (head) h = Math.max(h, 17 * P + (reply ? 22 * P : 0) + 42 * P);
      return h;
    }

    function sumOffsets(): void {
      offsets.length = laid.length;
      let off = 0;
      for (let i = laid.length - 1; i >= 0; i--) { offsets[i] = off; off += laid[i].h; }
      total = off;
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
      laid = [];
      sumOffsets();
      for (const s of slots) { s.msg = ''; s.g.visible = false; }
      chatScroll.scrollTo(0, false);
      dirty = true;
      if (!name) return;
      requestOpen();
      offChat = ctx.channels.subscribe(name, (v: ChannelValue) => {
        if (chatSub !== name) return;
        const d = parseChannelData(v);
        if (!d) { ctx.error('discord: unexpected channel data'); return; }
        // Scrolled back: keep what the user reads still while new messages arrive below it.
        const lastId = chat?.messages.at(-1)?.id;
        const before = total;
        chat = d;
        relayout();
        if (chatScroll.pos > 0 && lastId && laid.some((x) => x.id === lastId)) chatScroll.shift(total - before);
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
        pickStale = true;
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

    function header(icon: string, title: string, sub: string): void {
      setIcon(T, kindIconMesh!, icon);
      const t = truncate(title, 40);
      titleText!.set(t);
      const tw = textSize(titleText!, { text: t, size: 16 * L.P }).width;
      subText!.position.x = titleText!.position.x + tw + 10 * L.P;
      subText!.set(truncate(sub, 48));
    }

    function render(): void {
      if (!group) return;
      dotMat!.color.set(status?.state === 'ready' ? DC.green : status?.state === 'error' ? DC.red : DC.faint);
      const id = channelId();
      backBtn!.visible = !!id || pickView !== '';
      // The message-area drag target sits in front of the picker rows: only the chat view may have it.
      bodyHit!.visible = !!id;
      inputBar!.visible = !!id;
      if (id) renderChat();
      else renderPicker();
      chatView!.update();
      pickViewport!.update();
    }

    function renderChat(): void {
      for (const r of pickRows) r.g.visible = false;
      const { P } = L;
      const c = chat;
      const entry = dms.find((e) => e.id === channelId()) ?? guilds.flatMap((x) => x.channels).find((e) => e.id === channelId());
      const kind = c?.kind || entry?.kind || 'text';
      const name = ctx.props.title || cleanName(c?.name || entry?.name || channelId());
      const guild = cleanName(c?.guild ?? guilds.find((x) => x.channels.some((e) => e.id === channelId()))?.name ?? '');
      inputText!.set(truncate(`Message ${kind === 'dm' || kind === 'group' ? '@' : '#'}${name}`, 50));

      const msgs = c?.messages ?? [];
      const note = statusLine() || c?.error || (!c || (c.loading && !msgs.length) ? 'Loading messages…' : !msgs.length ? 'No messages yet' : '');
      emptyText!.set(msgs.length ? '' : note);
      emptyText!.visible = !msgs.length;

      // Content bottom (newest message) sits just above the message box when pos = 0.
      const base = L.inputTop + 8 * P;
      const viewH = L.headerBottom - base;
      chatScroll.setMax(total - viewH);
      const pos = chatScroll.pos;

      // 1. which messages are in view (newest first)
      const inView = new Set<string>();
      const vis: number[] = [];
      for (let i = laid.length - 1; i >= 0 && vis.length < SLOTS; i--) {
        const off = offsets[i] - pos;
        if (off > viewH) break;
        if (off + laid[i].h < 0) continue;
        vis.push(i);
        inView.add(laid[i].id);
      }
      // 2. slots keep their message while it stays in view; free the others
      const bySlot = new Map<string, Slot>();
      for (const s of slots) {
        if (s.msg && inView.has(s.msg)) bySlot.set(s.msg, s);
        else if (s.msg) { s.msg = ''; s.g.visible = false; }
      }
      // 3. lay out; new messages take a free slot (hidden until troika has laid out its text)
      let remeasured = false;
      for (const i of vis) {
        const x = laid[i], m = msgs[i];
        let s = bySlot.get(x.id);
        if (!s) {
          s = slots.find((k) => !k.msg);
          if (!s) break;
          fill(s, x, m);
        } else if (textOf(s.body) !== x.body) fill(s, x, m); // edited, or a pending message confirmed
        setMap(s.avatarMat, m.author.avatar);
        if (x.reply) setMap(s.miniMat, m.reply?.avatar);
        if (x.image) setMap(s.imgMat, x.image.src);
        if (!s.ready) {
          s.waitFrames++;
          const info = (s.body as unknown as { textRenderInfo?: unknown }).textRenderInfo;
          if (info !== s.waitInfo || s.waitFrames > 6) s.ready = true;
          else { dirty = true; continue; } // laid out next frame
        }
        // the real body height replaces the estimate (compensating the scroll when it is below the view)
        if (x.body) {
          const sz = textSize(s.body, { text: x.body, size: L.s, maxWidth: L.textW, lineHeight: 1.375 });
          if (sz.measured) {
            const h = blockH(x.head, x.reply, sz.height, x.image);
            if (Math.abs(h - x.h) > 1e-4) {
              if (offsets[i] < pos) chatScroll.shift(h - x.h);
              x.h = h;
              remeasured = true;
            }
          }
        }
        place(s, x, base + offsets[i] - pos);
        s.g.visible = true;
      }
      if (remeasured) { sumOffsets(); dirty = true; }

      const below = vis.length ? laid.length - 1 - vis[0] : 0;
      header(kindIcon(kind), name, below > 0 ? `${guild ? `${guild} · ` : ''}${below} newer below` : guild);
      const over = total > viewH;
      track!.visible = thumb!.visible = over;
      if (over) {
        const trackH = L.headerBottom - L.inputTop - 8 * P;
        const th = Math.max(24 * P, trackH * (viewH / total));
        const u = chatScroll.max > 0 ? chatScroll.pos / chatScroll.max : 0;
        thumb!.scale.y = th;
        thumb!.position.y = L.inputTop + 4 * P + th / 2 + u * (trackH - th);
      }
    }

    /** Put message `x` into slot `s` (texts, colors): done once per message per slot. */
    function fill(s: Slot, x: Laid, m: Msg): void {
      s.msg = x.id;
      s.waitInfo = (s.body as unknown as { textRenderInfo?: unknown }).textRenderInfo;
      s.waitFrames = 0;
      s.ready = textOf(s.body) === x.body; // same text: nothing to lay out
      s.body.set(x.body);
      setColorRanges(s.body, x.ranges);
      (s.body as unknown as { fillOpacity?: number }).fillOpacity = m.pending ? 0.5 : 1;
      s.avatar.visible = x.head;
      s.name.visible = s.time.visible = x.head;
      if (x.head) {
        s.name.set(cleanName(m.author.name));
        s.time.set(m.pending ? 'Sending…' : discordTime(m.ts));
      }
      s.reply.visible = x.reply;
      if (x.reply) {
        const who = `@${cleanName(m.reply?.author ?? 'unknown')}`;
        s.replyText.set(`${who} ${truncate((m.reply?.content ?? '').replace(/\s+/g, ' '), 70)}`);
        setColorRanges(s.replyText, { 0: I.head, [who.length]: I.muted });
      }
      s.img.visible = !!x.image;
      if (x.image) s.img.scale.set(x.image.w, x.image.h, 1);
    }

    /** Position slot `s` with its message's bottom at `bottom` (card coordinates). */
    function place(s: Slot, x: Laid, bottom: number): void {
      const { P } = L;
      s.g.position.y = bottom + x.h;
      let y = -(x.head ? 17 : 2) * P;
      if (x.reply) {
        const ry = y - 11 * P;
        s.mini.position.y = ry;
        s.replyText.position.y = ry;
        s.spine2.position.y = ry;
        s.spine.position.y = ry - 6 * P;
        y -= 22 * P;
      }
      if (x.head) {
        const ny = y - 11 * P;
        s.name.position.y = ny;
        s.avatar.position.y = y - 20 * P;
        const nw = textSize(s.name, { text: textOf(s.name), size: 16 * P }).width;
        s.time.position.set(L.textX + nw + 8 * P, ny - 1 * P, Z.text);
        y -= 22 * P;
      }
      s.body.position.y = y;
      if (x.image) {
        const bh = x.body ? textSize(s.body, { text: x.body, size: L.s, maxWidth: L.textW, lineHeight: 1.375 }).height : 0;
        const iy = y - bh - (x.body ? 6 * P : 2 * P);
        s.img.position.set(L.textX + x.image.w / 2, iy - x.image.h / 2, Z.content);
      }
    }

    function pickList(): PickRow[] {
      const row = (e: Entry, icon: string, image?: string): PickRow => ({ key: e.id, label: cleanName(e.name), icon, image, unread: !!e.unread && !e.muted, mentions: e.mentions ?? 0, muted: !!e.muted });
      if (pickView === 'dms') return dms.map((e) => row(e, kindIcon(e.kind), e.icon ?? (e.kind === 'dm' ? '' : undefined)));
      if (pickView) {
        const gd = guilds.find((x) => x.id === pickView);
        const out: PickRow[] = [];
        let cat: string | undefined = '\0';
        for (const e of gd?.channels ?? []) {
          if (e.category !== cat) {
            cat = e.category;
            if (cat) out.push({ key: '', label: cleanName(cat).toUpperCase(), icon: '', unread: false, mentions: 0, muted: false, header: true });
          }
          out.push(row(e, kindIcon(e.kind)));
        }
        return out;
      }
      const rows: PickRow[] = [];
      if (dms.length) {
        const unread = dms.some((e) => e.unread && !e.muted);
        const mentions = dms.reduce((n, e) => n + (e.mentions ?? 0), 0);
        rows.push({ key: 'view:dms', label: 'Direct Messages', icon: 'message-square', unread, mentions, muted: false });
      }
      for (const gd of guilds) rows.push({ key: `view:${gd.id}`, label: cleanName(gd.name), icon: '', image: gd.icon ?? '', unread: !!gd.unread, mentions: gd.mentions ?? 0, muted: !!gd.muted });
      return rows;
    }

    function renderPicker(): void {
      for (const s of slots) s.g.visible = false;
      track!.visible = thumb!.visible = false;
      const { P } = L;
      const gd = pickView && pickView !== 'dms' ? guilds.find((x) => x.id === pickView) : undefined;
      header(pickView === 'dms' ? 'at-sign' : pickView ? 'users' : 'message-square',
        ctx.props.title || (pickView === 'dms' ? 'Direct Messages' : gd ? cleanName(gd.name) : 'Discord'), '');
      if (pickStale) { pickItems = pickList(); pickStale = false; }
      const note = statusLine() || (pickItems.length ? '' : 'Nothing here');
      emptyText!.set(pickItems.length ? '' : note);
      emptyText!.visible = !pickItems.length;
      const areaTop = L.headerBottom - 8 * P;
      pickScroll.setMax(pickItems.length - (areaTop - L.bottom - 8 * P) / L.rowH);
      const first = Math.floor(pickScroll.pos);
      const frac = pickScroll.pos - first;
      const chars = Math.max(8, Math.floor((L.w - 110 * P) / (16 * P * 0.5)));
      for (let r = 0; r <= L.pickN; r++) {
        const p = pickRows[r], it = pickItems[first + r];
        p.g.position.y = areaTop - (r + 0.5 - frac) * L.rowH;
        p.g.visible = !!it;
        if (!it) continue;
        p.header.visible = !!it.header;
        p.label.visible = !it.header;
        p.header.set(it.header ? truncate(it.label, chars) : '');
        if (it.header) { p.disc.visible = p.icon.visible = p.initials.visible = p.pill.visible = p.badge.visible = false; continue; }
        // icon: server / DM picture (initials on blurple until it loads, or without one), else a glyph
        const isPicture = it.image !== undefined;
        p.disc.visible = isPicture;
        p.initials.visible = isPicture && !tex(it.image);
        p.icon.visible = !isPicture;
        if (isPicture) {
          setMap(p.discMat, it.image || undefined);
          p.initials.set(initials(it.label));
        } else setIcon(T, p.icon, it.icon);
        p.label.set(truncate(it.label, chars));
        (p.label as unknown as { color: unknown }).color = it.unread || it.mentions ? DC.head : it.muted ? DC.faint : DC.channel;
        p.pill.visible = it.unread;
        p.badge.visible = it.mentions > 0;
        if (it.mentions > 0) p.badgeText.set(it.mentions > 99 ? '99+' : String(it.mentions));
      }
    }

    // ---- interaction
    let dragHand: string | null = null;
    let dragPart = '';
    let dragY0 = 0, dragMoved = false, wasGliding = false;
    const activeScroll = () => (channelId() ? chatScroll : pickScroll);

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
        pickStale = true;
        pickScroll.scrollTo(0, false);
        dirty = true;
        return;
      }
      if (part.startsWith('pick:')) {
        const it = pickItems[Math.floor(pickScroll.pos) + Number(part.slice(5))];
        if (!it || it.header) return;
        if (it.key.startsWith('view:')) { pickView = it.key.slice(5); pickStale = true; pickScroll.scrollTo(0, false); dirty = true; }
        else open(it.key);
      }
    }

    build();
    subscribeMeta();
    subscribeChat();

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.lines !== prev.lines || p.textSize !== prev.textSize) { laid = []; build(); }
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
          dragMoved = false;
          wasGliding = activeScroll().active;
          activeScroll().stop(); // a pinch on a gliding list catches it
          return;
        }
        if (e.hand !== dragHand) return;
        if (e.phase === 'move') {
          const dy = e.localPoint[1] - dragY0;
          if (!dragMoved && Math.abs(dy) > L.s * 1.2 && dragPart !== 'back') {
            dragMoved = true;
            dragY0 = e.localPoint[1]; // follow the hand from here on, without a jump
            activeScroll().dragStart();
            return;
          }
          if (!dragMoved) return;
          // Content follows the hand: pulling the messages down shows older ones (pos grows);
          // pulling the list up shows later rows.
          if (channelId()) chatScroll.dragMove(-dy);
          else pickScroll.dragMove(dy / L.rowH);
          return;
        }
        dragHand = null;
        if (dragMoved) { activeScroll().dragEnd(e.phase === 'end'); return; }
        if (e.phase === 'end' && !wasGliding) tap(dragPart);
      },
      update(dt) {
        if (channelId()) {
          lease += dt;
          if (lease > LEASE_S) requestOpen();
        }
        if (watch.changed()) dirty = true; // real glyph sizes arrived: lay out again
        if (chatScroll.step(dt)) dirty = true;
        if (pickScroll.step(dt)) dirty = true;
        if (!dirty) { chatView?.update(); pickViewport?.update(); return; } // clip planes follow the card while it moves
        dirty = false;
        render();
      },
      dispose() {
        offChat?.();
        for (const off of subs.splice(0)) off();
        if (group) disposeTree(group);
        for (const t of textures.values()) t.dispose();
        textures.clear();
        placeholder?.dispose();
      },
    };
  },
};

export default definition;
