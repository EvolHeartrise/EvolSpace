// fb-palm — "Files · Palm": a hand-held file browser. Anchor it to the LEFT hand (wrist frame); when you
// turn that palm toward your face (like holding a hand of cards) the current folder is dealt as a fan of
// small cards above the palm. The other hand picks:
//   tap (pinch or poke) a folder card  → the fan re-deals with its contents
//   tap a file card                    → a hand-held preview card opens above the fan (tap it to close)
//   pinch-HOLD a folder card (0.45 s)  → peek: its first items pop up; slide onto one and release to jump there
//   pinch-DRAG any card (or the preview) out of the fan (> 9 cm) and release → the item is PLACED in the room
//       at the release point: a request on `files.palm.place` (see PLACE CONTRACT) + a 2 s ghost card there
//   base row: up (thumb side) · recent files · deck (folder name / info) · next page · home (pinky side)
// Turning the palm away folds the fan away (nothing stays hittable around the hand). Not hand-anchored
// (studio, a desk), the fan simply stays open, facing +Z.
//
// PLACE CONTRACT — published on props.placeChannel (default `files.palm.place`) and emitted on `placed`:
//   {path: absolute, name, type: 'file'|'dir'|'link', position: [x,y,z] space coords (card center),
//    rotation: [x,y,z,w] space coords (yaw only; the card's +Z faces the user), from: entityId,
//    reply: '<prefix>.fb-palm.<entityId>.placed', nonce, t: ms}
//   A handler spawns a root entity there (e.g. `file-browser` for a dir, a preview for a file) and may ack
//   on `reply` with {nonce, ok: true, entity?} — the ghost then says "placed".
// Widgets cannot create root (world-anchored) entities: ctx.spawnChild children follow their parent, i.e.
// the hand. The ghost is drawn inside this widget, counter-transformed every frame against the hand.
//
// Data: the `files` source (<prefix>.request {cmd: list|preview|search}); replies on
// <prefix>.fb-palm.<entityId>.{list,peek,preview,recent} are matched by path (several clients share them).

import type { ChannelValue, InteractionEvent, Vec3, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';
import { baseName, CARD_H, CARD_W, cardLabel, CHIP_D, CHIP_X, fanSlots, fanTop, iconFor, joinPath, sameFile, samePath, shortAge, tierSplit, type Slot } from './layout.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  pageSize: number;
  recentsRoot: string;
  alwaysShow: boolean;
  placeChannel: string;
  prefix: string;
}

export interface Entry { name: string; path: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string }
interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Array<Omit<Entry, 'path'>>; truncated: boolean; error?: string }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }
interface SearchReply { kind: 'search'; path: string; display: string; query: string; results: Array<Entry & { display?: string }>; error?: string }

/** Pinch travel (m) below which a release is a tap. */
export const TAP_SLOP = 0.015;
/** Drag a card this far (m) from where it was pinched, then release, to place it in the room. */
export const PLACE_DIST = 0.09;
/** Hold a folder card this long (s) without moving to peek into it. */
export const HOLD_S = 0.45;
/** Palm-normal · direction-to-head thresholds: show above SHOW_AT, fold away below HIDE_AT. */
export const SHOW_AT = 0.5;
export const HIDE_AT = 0.3;
const DEAL_STAGGER = 0.022;
const DEAL_DUR = 0.16;
const GHOST_S = 2.2;
const PEEK_N = 6;
const HUB_W = 0.094;
const HUB_H = 0.046;
const PV_W = 0.23;
const PV_LINES = 12;
const PV_SIZE = 0.0058;

/** Yaw-only rotation (space coords) whose +Z faces from `p` toward `head`. */
export function facingYaw(p: Vec3, head: Vec3): [number, number, number, number] {
  const dx = head[0] - p[0], dz = head[2] - p[2];
  const yaw = Math.abs(dx) + Math.abs(dz) < 1e-6 ? 0 : Math.atan2(dx, dz);
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

const definition: WidgetDefinition<Props> = {
  description:
    "Hand-held file browser ('files' source). Anchor to the left hand: palm toward your face deals the folder as a fan of cards above the palm. " +
    'Other hand: tap folder = open, tap file = preview card, hold folder = peek (slide + release to jump), drag a card out = place it in the room ' +
    '(publishes {path,type,position,rotation} on placeChannel). Base row: up, recent, page, home. Props: path, pageSize, recentsRoot, alwaysShow.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    pageSize: { type: 'integer', default: 10, min: 4, max: 12, description: 'Cards per fan page (4–12).' },
    recentsRoot: { type: 'string', default: '~', description: 'Folder whose most recently modified files the clock chip shows.' },
    alwaysShow: { type: 'boolean', default: false, description: 'Keep the fan open even when the palm is turned away.' },
    placeChannel: { type: 'string', default: 'files.palm.place', description: 'Channel that receives "place this item here" requests.' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    preview: { type: 'string', description: 'Open this file (absolute or ~/ path) in the hand-held preview card.' },
  },
  outputs: {
    selected: { type: 'string', description: 'Absolute path of the file last opened in the preview card.' },
    folder: { type: 'string', description: 'The folder shown (display form, e.g. "~/src").' },
    placed: { type: 'json', description: 'Every place request ({path, type, position, rotation, …}).' },
  },
  interactions: [dragBinding('fb-palm-drag', 'drag')],
  // no `size`: while the fan is folded away the widget is empty, and must not be hittable around the hand
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const P = ctx.props;
    const prefix = () => String(P.prefix || 'files');
    const ch = (purpose: string) => `${prefix()}.fb-palm.${ctx.entityId}.${purpose}`;
    const pageSize = () => Math.max(4, Math.min(12, Math.round(Number(P.pageSize) || 10)));
    const noRay = () => {};

    // ---- state ---------------------------------------------------------------------------------
    let mode: 'folder' | 'recent' = 'folder';
    let want = String(P.path || '~');
    let listing: Listing | null = null;
    let folderEntries: Entry[] = [];
    let loading = true;
    let recents: Entry[] | null = null;
    let recentsAt = -Infinity;
    let recentsLoading = false;
    let recentsError = '';
    let page = 0;
    let cameFrom = '';
    const pageMem = new Map<string, number>();
    const cache = new Map<string, Listing>();
    let nonce = 0;
    let now = 0;
    let dirty = true;
    let moving = true;
    let hovered = '';
    let thumbSign = -1;
    let lastFolder = '';

    // hand frames (resolved from the scene graph: ctx.root → entity node → anchor frame → space root)
    let anchorObj: THREE.Object3D | null = null;
    let spaceObj: THREE.Object3D | null = null;
    let anchorHand: 'left' | 'right' | null = null;
    let shown = true;
    let vis = 1;

    interface Press {
      hand: string; handler: string; part: string; kind: 'card' | 'btn' | 'preview' | 'other'; idx: number;
      start: Vec3; last: Vec3; t0: number; moved: boolean; mode: 'idle' | 'carry' | 'peek'; far: boolean;
    }
    let press: Press | null = null;

    // ---- scene ---------------------------------------------------------------------------------
    const fan = new T.Group();
    fan.name = 'fan';
    ctx.root.add(fan);

    // hub ("the deck"): folder name + info line; not interactive, so pinching it grabs (re-offsets) the fan
    const hub = new T.Group();
    hub.add(ctx.ui.panel(HUB_W, HUB_H, { radius: 0.01 }));
    const hubTitle = makeText(ctx, '', { size: 0.0082, anchorX: 'center', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    hubTitle.position.set(0, 0.008, STYLE.zText);
    const hubMeta = makeText(ctx, '', { size: 0.0062, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
    hubMeta.position.set(0, -0.0105, STYLE.zText);
    hub.add(hubTitle, hubMeta);
    fan.add(hub);

    interface Chip { g: THREE.Group; icon: THREE.Mesh; id: string }
    const chips: Record<string, Chip> = {};
    for (const [id, icon] of [['up', 'corner-left-up'], ['recent', 'clock'], ['page', 'chevrons-right'], ['home', 'house']] as const) {
      const g = new T.Group();
      const plate = ctx.ui.panel(CHIP_D, CHIP_D, { color: theme.surface, radius: CHIP_D / 2 });
      plate.raycast = noRay;
      const ic = makeIcon(ctx, icon, { size: CHIP_D * 0.52, color: theme.text });
      ic.position.z = STYLE.zText;
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(CHIP_D + 0.006, CHIP_D + 0.006, 0.016);
      hit.name = `btn:${id}`;
      ctx.interactive(hit);
      g.add(plate, ic, hit);
      fan.add(g);
      chips[id] = { g, icon: ic, id };
    }
    function layoutChips(): void {
      const s = thumbSign;
      chips.up.g.position.set(s * CHIP_X[0], 0, 0);
      chips.recent.g.position.set(s * CHIP_X[1], 0, 0);
      chips.page.g.position.set(-s * CHIP_X[0], 0, 0);
      chips.home.g.position.set(-s * CHIP_X[1], 0, 0);
    }
    layoutChips();

    interface Card {
      g: THREE.Group; glow: THREE.Mesh; glowMat: THREE.MeshBasicMaterial; stripeMat: THREE.MeshBasicMaterial;
      icon: THREE.Mesh; label: Text; entry: Entry | null; slot: Slot; t0: number; lift: number;
    }
    let cards: Card[] = [];
    let cardGroup: THREE.Group | null = null;
    function buildCards(): void {
      if (cardGroup) disposeTree(cardGroup);
      cardGroup = new T.Group();
      cards = [];
      for (let i = 0; i < pageSize(); i++) {
        const g = new T.Group();
        const glowMat = ownMaterial(T, theme.accent);
        const glow = new T.Mesh(sharedGeometry(T, 'plane'), glowMat);
        glow.scale.set(CARD_W + 0.007, CARD_H + 0.007, 1);
        glow.position.z = -0.0008;
        glow.visible = false;
        glow.raycast = noRay;
        const plate = ctx.ui.panel(CARD_W, CARD_H, { color: theme.surface, radius: 0.006 });
        plate.raycast = noRay;
        const stripeMat = ownMaterial(T, theme.textDim);
        const stripe = new T.Mesh(sharedGeometry(T, 'plane'), stripeMat);
        stripe.scale.set(CARD_W - 0.014, 0.0028, 1);
        stripe.position.set(0, CARD_H / 2 - 0.0055, STYLE.zContent);
        stripe.raycast = noRay;
        const icon = makeIcon(ctx, 'file', { size: 0.019, color: theme.textDim });
        icon.position.set(0, 0.0115, STYLE.zText);
        const label = makeText(ctx, '', { size: 0.0071, anchorX: 'center', anchorY: 'top', textAlign: 'center', color: theme.text, whiteSpace: 'nowrap', lineHeight: 1.15 });
        label.position.set(0, -0.0035, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(CARD_W + 0.004, CARD_H + 0.004, 0.016);
        hit.name = `card:${i}`;
        ctx.interactive(hit);
        g.add(glow, plate, stripe, icon, label, hit);
        g.visible = false;
        cardGroup.add(g);
        cards.push({ g, glow, glowMat, stripeMat, icon, label, entry: null, slot: { x: 0, y: 0, rot: 0, angle: 0, tier: 0 }, t0: 0, lift: 0 });
      }
      fan.add(cardGroup);
    }
    buildCards();

    // peek: a pop-up grid of a held folder's first items
    const PEEK_W = 0.128, PEEK_H = 0.112;
    const peek = new T.Group();
    peek.name = 'peek';
    peek.visible = false;
    const peekPlate = ctx.ui.panel(PEEK_W, PEEK_H, { radius: 0.008 });
    peekPlate.raycast = noRay;
    const peekHead = makeText(ctx, '', { size: 0.0066, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
    peekHead.position.set(0, PEEK_H / 2 - 0.011, STYLE.zText);
    peek.add(peekPlate, peekHead);
    interface Mini { g: THREE.Group; glow: THREE.Mesh; icon: THREE.Mesh; label: Text }
    const minis: Mini[] = [];
    for (let i = 0; i < PEEK_N; i++) {
      const g = new T.Group();
      g.name = `mini:${i}`;
      g.position.set((i % 2 ? 1 : -1) * 0.031, 0.02 - Math.floor(i / 2) * 0.029, STYLE.zContent);
      const glow = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent));
      glow.scale.set(0.062, 0.03, 1);
      glow.position.z = -0.0005;
      glow.visible = false;
      glow.raycast = noRay;
      const plate = ctx.ui.panel(0.058, 0.026, { color: theme.surface, radius: 0.005 });
      plate.raycast = noRay;
      const icon = makeIcon(ctx, 'file', { size: 0.013, color: theme.textDim });
      icon.position.set(-0.0195, 0, STYLE.zText);
      const label = makeText(ctx, '', { size: 0.0066, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      label.position.set(-0.0105, 0, STYLE.zText);
      g.add(glow, plate, icon, label);
      peek.add(g);
      minis.push({ g, glow, icon, label });
    }
    fan.add(peek);
    let peekCard = -1;
    let peekPath = '';
    let peekListing: Listing | null = null;
    let peekSel = -1;
    const peekEntries = (): Entry[] => (peekListing && !peekListing.error ? peekListing.entries.slice(0, PEEK_N).map((e) => ({ ...e, path: joinPath(peekListing!.path, e.name) })) : []);

    // preview card (hand-held, above the fan)
    let pvGroup: THREE.Group | null = null;
    let pvEntry: Entry | null = null;
    let pvData: Preview | null = null;
    let pvTex: THREE.Texture | null = null;
    let pvHome = new T.Vector3();
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;

    // ghost: world-fixed confirmation card at a drop point (counter-transformed every frame)
    let ghost: THREE.Group | null = null;
    let ghostText: Text | null = null;
    let ghostT0 = 0;
    let ghostNonce = -1;
    let ghostName = '';
    const ghostPos = new T.Vector3();
    const ghostQuat = new T.Quaternion();

    // scratch (no per-frame allocation)
    const _v = new T.Vector3(), _w = new T.Vector3(), _p = new T.Vector3(), _s = new T.Vector3();
    const _x = new T.Vector3(), _y = new T.Vector3(), _z = new T.Vector3();
    const _q = new T.Quaternion(), _q2 = new T.Quaternion();
    const _m = new T.Matrix4(), _m2 = new T.Matrix4();

    // ---- data ------------------------------------------------------------------------------------
    function request(cmd: string, path: string, reply: string, extra: Record<string, unknown> = {}): void {
      ctx.channels.publish(`${prefix()}.request`, { cmd, path, reply, nonce: ++nonce, hidden: !!P.showHidden, ...extra } as never);
    }

    const entries = (): Entry[] => (mode === 'recent' ? recents ?? [] : folderEntries);
    const pages = () => Math.max(1, Math.ceil(entries().length / pageSize()));

    function remember(l: Listing): void {
      cache.delete(l.path);
      cache.set(l.path, l);
      if (cache.size > 16) cache.delete(cache.keys().next().value as string);
    }
    function cached(p: string): Listing | null {
      for (const l of cache.values()) if (samePath(p, l)) return l;
      return null;
    }

    function open(p: string, from = ''): void {
      if (listing) pageMem.set(listing.path, page);
      if (pageMem.size > 64) pageMem.delete(pageMem.keys().next().value as string);
      mode = 'folder';
      want = p;
      cameFrom = from;
      loading = true;
      closePeek();
      const c = cached(p);
      if (c) accept(c, true);
      request('list', p, ch('list'));
      dirty = true;
    }

    function accept(l: Listing, fromCache = false): void {
      const changed = !listing || listing.path !== l.path || listing.entries.length !== l.entries.length || !!listing.error !== !!l.error;
      const newFolder = !listing || listing.path !== l.path;
      listing = l;
      if (!fromCache) loading = false;
      folderEntries = (l.entries ?? []).map((e) => ({ ...e, path: joinPath(l.path, e.name) }));
      if (!l.error) remember(l);
      if (newFolder) {
        const i = cameFrom ? folderEntries.findIndex((e) => e.name === cameFrom) : -1;
        page = i >= 0 ? Math.floor(i / pageSize()) : pageMem.get(l.path) ?? 0;
      }
      page = Math.min(page, pages() - 1);
      if (mode === 'folder') deal(changed);
      const display = l.display || l.path;
      if (!fromCache && display !== P.path && !ctx.isMirror) ctx.setProps({ path: display });
      if (!fromCache && display !== lastFolder) { lastFolder = display; ctx.emit('folder', display); }
      dirty = true;
    }

    const offs: Array<() => void> = [];
    function subscribe(): void {
      for (const off of offs.splice(0)) off();
      offs.push(ctx.channels.subscribe(ch('list'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Listing).kind !== 'list' || typeof (v as Listing).path !== 'string') return;
        const l = v as Listing;
        if (!Array.isArray(l.entries)) return ctx.error('fb-palm: listing without entries');
        if (samePath(want, l)) accept(l);
        else if (!l.error) remember(l); // someone else's (another client) — keep it for later
      }));
      offs.push(ctx.channels.subscribe(ch('peek'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Listing).kind !== 'list' || !Array.isArray((v as Listing).entries)) return;
        const l = v as Listing;
        if (!l.error) remember(l);
        if (peekPath && samePath(peekPath, l)) { peekListing = l; dirty = true; }
      }));
      offs.push(ctx.channels.subscribe(ch('preview'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Preview).kind !== 'preview') return;
        if (!pvEntry || !sameFile(pvEntry.path, (v as Preview).path)) return; // stale / someone else's
        pvData = v as Preview;
        buildPreview();
      }));
      offs.push(ctx.channels.subscribe(ch('recent'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as SearchReply).kind !== 'search') return;
        const r = v as SearchReply;
        if (r.query !== '' || !samePath(String(P.recentsRoot || '~'), r)) return;
        recentsLoading = false;
        recentsError = r.error ?? '';
        recents = (Array.isArray(r.results) ? r.results : []).filter((e) => e && typeof e.path === 'string')
          .map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size ?? null, mtime: e.mtime ?? null, ext: e.ext ?? '' }));
        recentsAt = now;
        if (mode === 'recent') { page = Math.min(page, pages() - 1); deal(true); }
        dirty = true;
      }));
      offs.push(ctx.channels.subscribe(ch('placed'), (v: ChannelValue) => {
        const a = v as { nonce?: unknown; ok?: unknown } | null;
        if (a && typeof a === 'object' && a.nonce === ghostNonce && ghostText) ghostText.set(`${truncate(ghostName, 22)}\n${a.ok === false ? 'could not place' : 'placed'}`);
      }));
    }

    // ---- fan -----------------------------------------------------------------------------------
    /** Put the current page on the cards; `animate` re-deals them from the deck. */
    function deal(animate: boolean): void {
      const list = entries();
      const n = pageSize();
      const shownList = list.slice(page * n, page * n + n);
      const slots = fanSlots(shownList.length);
      const twoTiers = tierSplit(shownList.length).length > 1;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const e = shownList[i] ?? null;
        c.entry = e;
        c.g.visible = !!e;
        if (!e) continue;
        c.slot = slots[i];
        if (!twoTiers) c.slot.tier = 1; // single arc sits in the back layer
        if (animate) c.t0 = now + i * DEAL_STAGGER;
        const [icon, color] = iconFor(e);
        setIcon(T, c.icon, icon);
        (c.icon.material as THREE.MeshBasicMaterial).color.set(color);
        c.stripeMat.color.set(e.type === 'dir' ? color : theme.border);
        c.label.set(cardLabel(e.name));
        (c.label as unknown as { color: unknown }).color = e.name.startsWith('.') ? theme.textDim : theme.text;
      }
      moving = true;
      dirty = true;
    }

    const ease = (p: number) => 1 - (1 - p) ** 3;
    const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

    /** Root-local point → fan coords. */
    function toFan(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
      fan.updateMatrix();
      _m2.copy(fan.matrix).invert();
      return out.set(p[0], p[1], p[2]).applyMatrix4(_m2);
    }

    /** Pose every card (deal animation, hover lift, carry). Returns true while something still moves. */
    function poseCards(dt: number): boolean {
      let busy = false;
      const k = 1 - Math.exp(-dt * 18);
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (!c.g.visible) continue;
        const carried = press && press.kind === 'card' && press.idx === i && press.mode === 'carry';
        if (carried) {
          toFan(press!.last, _v);
          c.g.position.set(_v.x, _v.y, _v.z + 0.012);
          c.g.rotation.z = 0;
          c.g.scale.setScalar(press!.far ? 1.35 : 1.12);
          busy = true;
          continue;
        }
        const target = hovered === `card:${i}` || (press && press.kind === 'card' && press.idx === i) || peekCard === i ? 1 : 0;
        c.lift += (target - c.lift) * k;
        if (Math.abs(target - c.lift) < 0.002) c.lift = target;
        else busy = true;
        const p = clamp01((now - c.t0) / DEAL_DUR);
        if (p < 1) busy = true;
        const e = ease(p);
        const s = c.slot;
        c.g.position.set(s.x * e, s.y * e, (s.tier === 0 ? 0.004 : 0) + c.lift * 0.014);
        c.g.rotation.z = s.rot * e;
        c.g.scale.setScalar((0.35 + 0.65 * e) * (1 + 0.08 * c.lift));
      }
      if (pvGroup) {
        if (press && press.kind === 'preview' && press.mode === 'carry') {
          toFan(press.last, _v);
          pvGroup.position.set(_v.x, _v.y, _v.z + 0.015);
          pvGroup.scale.setScalar(press.far ? 0.55 : 0.75);
          busy = true;
        } else {
          pvGroup.position.copy(pvHome);
          pvGroup.scale.setScalar(1);
        }
      }
      return busy;
    }

    // ---- peek ----------------------------------------------------------------------------------
    function openPeek(i: number): void {
      const e = cards[i]?.entry;
      if (!e || e.type !== 'dir') return;
      peekCard = i;
      peekPath = e.path;
      peekSel = -1;
      peekListing = cached(e.path);
      request('list', e.path, ch('peek'));
      const s = cards[i].slot;
      const r = CARD_H / 2 + PEEK_H / 2 + 0.004;
      peek.position.set(s.x + Math.sin(s.angle) * r, s.y + Math.cos(s.angle) * r, 0.03);
      peek.visible = true;
      dirty = true;
    }
    function closePeek(): void {
      peek.visible = false;
      peekCard = -1;
      peekPath = '';
      peekSel = -1;
    }
    function updatePeekSel(at: Vec3): void {
      toFan(at, _v);
      let sel = -1;
      const list = peekEntries();
      for (let i = 0; i < list.length; i++) {
        const g = minis[i].g;
        if (Math.abs(_v.x - (peek.position.x + g.position.x)) < 0.037 && Math.abs(_v.y - (peek.position.y + g.position.y)) < 0.019) { sel = i; break; }
      }
      if (sel !== peekSel) { peekSel = sel; dirty = true; }
    }

    // ---- preview -------------------------------------------------------------------------------
    function inspect(e: Entry, toggle = true): void {
      if (pvEntry && pvEntry.path === e.path) { if (toggle) closePreview(); return; }
      pvEntry = e;
      pvData = null;
      ctx.emit('selected', e.path);
      request('preview', e.path, ch('preview'));
      buildPreview();
    }
    function closePreview(): void {
      pvEntry = null;
      pvData = null;
      buildPreview();
    }
    function buildPreview(): void {
      if (pvGroup) disposeTree(pvGroup);
      pvGroup = null;
      pvTex?.dispose();
      pvTex = null;
      dirty = true;
      const e = pvEntry;
      if (!e) return;
      const d = pvData;
      const g = (pvGroup = new T.Group());
      const lineH = PV_SIZE * 1.25;
      const h = 0.036 + PV_LINES * lineH + 0.012;
      const w = PV_W;
      g.add(ctx.ui.panel(w, h, { radius: 0.008 }));
      const x0 = -w / 2 + 0.012, top = h / 2 - 0.012;
      const [icon, color] = iconFor(e);
      const ic = makeIcon(ctx, icon, { size: 0.016, color });
      ic.position.set(x0 + 0.008, top - 0.006, STYLE.zText);
      const title = makeText(ctx, truncate(e.name, 40), { size: 0.0085, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.021, top - 0.002, STYLE.zText);
      const size = d?.size ?? e.size;
      const meta = makeText(ctx, [!d ? 'loading…' : '', size != null ? formatBytes(size) : '', shortAge(d?.mtime ?? e.mtime), d?.type === 'text' ? `${d.lines} lines` : '', 'drag out to place · tap to close'].filter(Boolean).join(' · '),
        { size: 0.0056, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.021, top - 0.0135, STYLE.zText);
      g.add(ic, title, meta);
      const bodyTop = top - 0.024, bodyH = PV_LINES * lineH;
      if (d?.type === 'text') {
        const lines = (d.text ?? '').replace(/\t/g, '  ').split('\n');
        const lang = languageFor(e.name);
        const cols = Math.floor((w - 0.024) / (PV_SIZE * 0.6));
        const raw = lines.slice(0, PV_LINES);
        const shownLines = raw.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
        const body = makeText(ctx, shownLines.join('\n'), { size: PV_SIZE, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: 1.25 });
        body.position.set(x0, bodyTop, STYLE.zText);
        if (lang) {
          const spans = highlight(raw.join('\n'), lang);
          const clips = shownLines.map((l, i) => (l.length < raw[i].length ? l.length - 1 : l.length));
          setColorRanges(body, colorRanges(spans, shownLines.map((l) => l.length), syntaxInts, hexToInt(theme.text), clips));
        }
        g.add(body);
      } else if (d?.type === 'image' && d.src && typeof document !== 'undefined') {
        const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        img.raycast = noRay;
        img.visible = false;
        img.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
        g.add(img);
        pvTex = new T.TextureLoader().load(d.src, (tex) => {
          if (pvTex !== tex) return;
          tex.colorSpace = T.SRGBColorSpace;
          const im = tex.image as { width: number; height: number };
          const a = im.width / im.height, bw = w - 0.024, bh = bodyH;
          img.scale.set(a > bw / bh ? bw : bh * a, a > bw / bh ? bw / a : bh, 1);
          mat.map = tex;
          mat.needsUpdate = true;
          img.visible = true;
        }, undefined, () => ctx.error(`fb-palm: could not load ${d.src}`));
      } else if (d) {
        const msg = d.type === 'binary' ? 'Binary file: no preview' : d.type === 'denied' ? (d.error ?? 'Private file') : d.type === 'image' ? 'Image preview appears in the headset' : (d.error ?? 'No preview');
        const t = makeText(ctx, msg, { size: 0.0075, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.03, textAlign: 'center' });
        t.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
        g.add(t);
      }
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(w, h, 0.012);
      hit.name = 'preview';
      ctx.interactive(hit);
      g.add(hit);
      const n = Math.min(pageSize(), Math.max(1, entries().length - page * pageSize()));
      pvHome.set(0, fanTop(n) + 0.012 + h / 2, 0.006);
      g.position.copy(pvHome);
      fan.add(g);
      moving = true;
    }

    // ---- placing -------------------------------------------------------------------------------
    function place(e: Entry, point: Vec3): void {
      const head = ctx.user?.head?.position ?? [0, 1.6, 0];
      const rotation = facingYaw(point, head as Vec3);
      const req = {
        path: e.path, name: e.name, type: e.type, position: [point[0], point[1], point[2]] as Vec3, rotation,
        from: ctx.entityId, reply: ch('placed'), nonce: ++nonce, t: Date.now(),
      };
      if (!ctx.isMirror) {
        ctx.channels.publish(String(P.placeChannel || 'files.palm.place'), req as never);
        ctx.event('place', { path: e.path, type: e.type, position: req.position });
      }
      ctx.emit('placed', req);
      showGhost(e, point, rotation, req.nonce);
    }

    function showGhost(e: Entry, point: Vec3, rot: [number, number, number, number], n: number): void {
      if (ghost) disposeTree(ghost);
      const g = (ghost = new T.Group());
      g.name = 'ghost';
      g.matrixAutoUpdate = false;
      const w = 0.15, h = 0.056;
      const plate = ctx.ui.panel(w, h, { radius: 0.008 });
      plate.raycast = noRay;
      const outline = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent, { opacity: 0.35 }));
      outline.scale.set(w + 0.008, h + 0.008, 1);
      outline.position.z = -0.001;
      outline.raycast = noRay;
      const [icon, color] = iconFor(e);
      const ic = makeIcon(ctx, icon, { size: 0.026, color });
      ic.position.set(-w / 2 + 0.024, 0, STYLE.zText);
      ghostName = e.name;
      ghostText = makeText(ctx, `${truncate(e.name, 22)}\nplacing…`, { size: 0.0095, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap', lineHeight: 1.3 });
      ghostText.position.set(-w / 2 + 0.044, 0, STYLE.zText);
      g.add(outline, plate, ic, ghostText);
      ghostPos.set(point[0], point[1], point[2]);
      ghostQuat.set(rot[0], rot[1], rot[2], rot[3]);
      ghostT0 = now;
      ghostNonce = n;
      ctx.root.add(g);
      poseGhost();
    }

    /** Ghost matrix = root⁻¹ · space · place(pos, rot, pop/fade scale): fixed in the room while the hand moves. */
    function poseGhost(): void {
      if (!ghost) return;
      const age = now - ghostT0;
      if (age > GHOST_S) { disposeTree(ghost); ghost = null; ghostText = null; ghostNonce = -1; return; }
      const sc = age < 0.12 ? 0.6 + 0.4 * ease(age / 0.12) : age > GHOST_S - 0.3 ? Math.max(0.05, (GHOST_S - age) / 0.3) : 1;
      ctx.root.updateWorldMatrix(true, false);
      _m.copy(ctx.root.matrixWorld).invert();
      if (spaceObj) _m.multiply(spaceObj.matrixWorld);
      _m2.compose(ghostPos, ghostQuat, _s.set(sc, sc, sc));
      ghost.matrix.multiplyMatrices(_m, _m2);
      ghost.matrixWorldNeedsUpdate = true;
    }

    // ---- hand frames ---------------------------------------------------------------------------
    function resolveFrames(): void {
      anchorObj = spaceObj = null;
      anchorHand = null;
      let sawEntity = false;
      for (let o = ctx.root.parent; o; o = o.parent) {
        const n = o.name || '';
        if (n.startsWith('anchor:')) {
          if (n.startsWith('anchor:left:')) { anchorObj = o; anchorHand = 'left'; }
          else if (n.startsWith('anchor:right:')) { anchorObj = o; anchorHand = 'right'; }
          continue;
        }
        if (n.startsWith('entity:')) { sawEntity = true; continue; }
        if (sawEntity) { spaceObj = o; break; }
      }
    }

    /** Head position (world) into _w; returns false if unknown. */
    function headWorld(): boolean {
      const hp = ctx.user?.head?.position;
      if (!hp) return false;
      _w.set(hp[0], hp[1], hp[2]);
      if (spaceObj) _w.applyMatrix4(spaceObj.matrixWorld);
      return true;
    }

    /** Palm normal (out of the palm = wrist -Y) · direction wrist→head. */
    function palmFacing(): number {
      if (!anchorObj || !headWorld()) return 1;
      anchorObj.matrixWorld.decompose(_p, _q, _s);
      _v.set(0, -1, 0).applyQuaternion(_q);
      _z.subVectors(_w, _p);
      const len = _z.length();
      return len < 1e-4 ? 1 : _v.dot(_z) / len;
    }

    /** Rotate the fan to face the head (screen-aligned via the head's up), in root-local terms. */
    function orientFan(snap: boolean, dt: number): void {
      if (!headWorld()) return;
      _p.setFromMatrixPosition(ctx.root.matrixWorld);
      _z.subVectors(_w, _p);
      if (_z.lengthSq() < 1e-8) return;
      _z.normalize();
      const hq = ctx.user.head.rotation;
      _y.set(0, 1, 0).applyQuaternion(_q2.set(hq[0], hq[1], hq[2], hq[3]));
      if (spaceObj) { spaceObj.matrixWorld.decompose(_v, _q, _s); _y.applyQuaternion(_q); }
      _y.addScaledVector(_z, -_y.dot(_z));
      if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
      _y.normalize();
      _x.crossVectors(_y, _z).normalize();
      _m.makeBasis(_x, _y, _z);
      _q.setFromRotationMatrix(_m);
      ctx.root.matrixWorld.decompose(_v, _q2, _s);
      _q2.invert().multiply(_q);
      if (snap) fan.quaternion.copy(_q2);
      else fan.quaternion.slerp(_q2, 1 - Math.exp(-dt * 14));
    }

    // ---- render (texts, glows) -----------------------------------------------------------------
    function render(): void {
      const list = entries();
      const nPages = pages();
      // hub
      let title: string, meta: string;
      const hoverCard = hovered.startsWith('card:') ? cards[Number(hovered.slice(5))]?.entry ?? null : null;
      if (press?.mode === 'carry') {
        const e = press.kind === 'preview' ? pvEntry : cards[press.idx]?.entry;
        title = truncate(e?.name ?? '', 19);
        meta = press.far ? 'release to place' : 'drag out to place';
      } else if (press?.mode === 'peek') {
        title = truncate(baseName(peekPath), 19);
        meta = 'slide onto an item, release';
      } else if (hoverCard) {
        title = truncate(hoverCard.name, 19);
        meta = hoverCard.type === 'dir' ? 'folder · hold to peek' : [formatBytes(hoverCard.size ?? NaN), shortAge(hoverCard.mtime)].filter(Boolean).join(' · ') || 'file';
      } else if (hovered.startsWith('btn:')) {
        const b = hovered.slice(4);
        title = mode === 'recent' ? 'Recent' : truncate(baseName(listing?.display ?? want), 19);
        meta = b === 'up' ? (mode === 'recent' ? 'back to folder' : 'up a folder') : b === 'recent' ? (mode === 'recent' ? 'back to folder' : 'recent files') : b === 'page' ? 'next page' : 'home';
      } else if (mode === 'recent') {
        title = 'Recent';
        meta = recentsError || (recentsLoading && !recents ? 'loading…' : `${list.length} files${nPages > 1 ? ` · ${page + 1}/${nPages}` : ''}`);
      } else {
        title = truncate(baseName(listing?.display ?? want), 19);
        meta = listing?.error ?? (loading && !listing ? 'loading…' : !list.length ? (loading ? 'loading…' : 'empty folder') : `${list.length}${listing?.truncated ? '+' : ''} items${nPages > 1 ? ` · ${page + 1}/${nPages}` : ''}`);
      }
      hubTitle.set(title);
      hubMeta.set(meta);
      // chips
      chips.page.g.visible = nPages > 1;
      const upOk = mode === 'recent' || !!listing?.parent;
      (chips.up.icon.material as THREE.MeshBasicMaterial).color.set(upOk ? theme.text : theme.border);
      (chips.recent.icon.material as THREE.MeshBasicMaterial).color.set(mode === 'recent' ? theme.accent : theme.text);
      for (const c of Object.values(chips)) c.g.scale.setScalar(hovered === `btn:${c.id}` || press?.part === `btn:${c.id}` ? 1.12 : 1);
      // card glows
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (!c.entry) { c.glow.visible = false; continue; }
        const carried = press?.kind === 'card' && press.idx === i && press.mode === 'carry';
        const active = hovered === `card:${i}` || (press?.kind === 'card' && press.idx === i) || peekCard === i;
        const came = mode === 'folder' && cameFrom && c.entry.name === cameFrom;
        const open = pvEntry?.path === c.entry.path;
        c.glow.visible = carried || active || !!came || open;
        c.glowMat.color.set(carried && press!.far ? theme.positive : active ? theme.accent : open ? theme.accent : theme.accent2);
      }
      // peek
      if (peek.visible) {
        const pl = peekListing;
        const list2 = peekEntries();
        const total = pl?.entries.length ?? 0;
        peekHead.set(!pl ? `${truncate(baseName(peekPath), 18)} · loading…` : pl.error ? truncate(pl.error, 30) : total ? `${truncate(baseName(peekPath), 18)} · ${total}${total > PEEK_N ? ` (+${total - PEEK_N})` : ''}` : `${truncate(baseName(peekPath), 18)} · empty`);
        for (let i = 0; i < PEEK_N; i++) {
          const m = minis[i], e = list2[i];
          m.g.visible = !!e;
          if (!e) continue;
          const [icon, color] = iconFor(e);
          setIcon(T, m.icon, icon);
          (m.icon.material as THREE.MeshBasicMaterial).color.set(color);
          m.label.set(truncate(e.name, 10));
          m.glow.visible = peekSel === i;
        }
      }
      moving = true;
    }

    // ---- actions -------------------------------------------------------------------------------
    function act(e: Entry): void {
      if (e.type === 'dir') { closePreview(); open(e.path); }
      else inspect(e);
    }
    function goUp(): void {
      if (mode === 'recent') { toggleRecents(); return; }
      if (listing?.parent) open(listing.parent, baseName(listing.path));
    }
    function toggleRecents(): void {
      closePeek();
      if (mode === 'recent') {
        mode = 'folder';
        page = listing ? pageMem.get(listing.path) ?? 0 : 0;
        page = Math.min(page, pages() - 1);
        deal(true);
        return;
      }
      if (listing) pageMem.set(listing.path, page);
      mode = 'recent';
      page = 0;
      if (!recents || now - recentsAt > 30) {
        recentsLoading = true;
        request('search', String(P.recentsRoot || '~'), ch('recent'), { query: '', limit: 48 });
      }
      deal(true);
    }
    function tap(p: Press): void {
      if (p.kind === 'card') { const e = cards[p.idx]?.entry; if (e) act(e); return; }
      if (p.kind === 'preview') { closePreview(); return; }
      switch (p.part) {
        case 'btn:up': goUp(); break;
        case 'btn:recent': toggleRecents(); break;
        case 'btn:page': if (pages() > 1) { page = (page + 1) % pages(); deal(true); if (pvGroup) buildPreview(); } break;
        case 'btn:home': closePreview(); open('~'); break;
      }
    }

    // ---- boot ----------------------------------------------------------------------------------
    resolveFrames();
    if (anchorObj && !P.alwaysShow) { shown = false; vis = 0; fan.visible = false; fan.scale.setScalar(0.001); }
    thumbSign = anchorHand === 'right' ? 1 : -1;
    layoutChips();
    subscribe();
    open(want);

    return {
      onProps(p, prev) {
        if (p.pageSize !== prev.pageSize) { buildCards(); page = 0; deal(true); }
        if (p.prefix !== prev.prefix) { cache.clear(); recents = null; subscribe(); open(listing?.path ?? want); }
        else if (p.showHidden !== prev.showHidden) { cache.clear(); recents = null; open(listing?.path ?? want); }
        else if (p.path !== prev.path && p.path !== (listing?.display ?? want)) open(String(p.path || '~'));
        if (p.recentsRoot !== prev.recentsRoot) { recents = null; if (mode === 'recent') { mode = 'folder'; toggleRecents(); } }
        dirty = true;
      },
      onInput(port, v) {
        if (port === 'path' && typeof v === 'string' && v.trim()) open(v.trim());
        if (port === 'preview' && typeof v === 'string' && v.trim()) {
          const path = v.trim(), name = baseName(path);
          inspect({ name, path, type: 'file', size: null, mtime: null, ext: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '' }, false);
        }
      },
      onInteraction(e: InteractionEvent) {
        if (anchorHand && e.hand === anchorHand) return; // the holding hand never operates its own fan
        const part = e.objectName ?? '';
        if (e.handler === 'hover') {
          const next = e.phase === 'end' ? (hovered === part ? '' : hovered) : part;
          if (next !== hovered) { hovered = next; dirty = true; }
          return;
        }
        const lp = (e.localPoint ?? [0, 0, 0]) as Vec3;
        if (e.phase === 'start') {
          if (press || !fan.visible) return;
          const kind: Press['kind'] = part.startsWith('card:') ? 'card' : part.startsWith('btn:') ? 'btn' : part === 'preview' ? 'preview' : 'other';
          press = { hand: e.hand, handler: e.handler, part, kind, idx: kind === 'card' ? Number(part.slice(5)) : -1, start: [lp[0], lp[1], lp[2]], last: [lp[0], lp[1], lp[2]], t0: now, moved: false, mode: 'idle', far: false };
          dirty = true;
          return;
        }
        if (!press || e.hand !== press.hand || e.handler !== press.handler) return;
        const p = press;
        p.last = [lp[0], lp[1], lp[2]];
        const d = Math.hypot(lp[0] - p.start[0], lp[1] - p.start[1], lp[2] - p.start[2]);
        if (e.phase === 'move') {
          if (!p.moved && d > TAP_SLOP) {
            p.moved = true;
            const carriable = (p.kind === 'card' && !!cards[p.idx]?.entry) || (p.kind === 'preview' && !!pvEntry);
            if (p.mode === 'idle' && carriable) p.mode = 'carry';
          }
          if (p.mode === 'peek') updatePeekSel(lp);
          if (p.mode === 'carry') { const far = d > PLACE_DIST; if (far !== p.far) { p.far = far; dirty = true; } moving = true; }
          return;
        }
        press = null;
        dirty = true;
        moving = true;
        if (e.phase !== 'end') { // cancelled: never act; the card returns to the deck
          if (p.kind === 'card' && cards[p.idx]) cards[p.idx].t0 = now;
          closePeek();
          return;
        }
        if (p.mode === 'carry') {
          const item = p.kind === 'preview' ? pvEntry : cards[p.idx]?.entry;
          if (item && d > PLACE_DIST) place(item, (e.point ?? lp) as Vec3);
          if (p.kind === 'card' && cards[p.idx]) cards[p.idx].t0 = now; // back to the deck
          return;
        }
        if (p.mode === 'peek') {
          const sel = peekSel >= 0 ? peekEntries()[peekSel] : null;
          closePeek();
          if (sel) act(sel);
          return;
        }
        if (!p.moved) tap(p);
      },
      update(dt, t) {
        now = t;
        resolveFrames();
        const ts = anchorHand === 'right' ? 1 : -1;
        if (ts !== thumbSign) { thumbSign = ts; layoutChips(); }
        // show while the palm faces the head (hysteresis); never fold mid-gesture
        if (anchorObj && !P.alwaysShow) {
          ctx.root.updateWorldMatrix(true, false);
          const f = palmFacing();
          shown = shown ? f > HIDE_AT : f > SHOW_AT;
          if (press) shown = true;
        } else shown = true;
        const target = shown ? 1 : 0;
        const wasVisible = fan.visible;
        if (vis !== target) {
          vis += Math.sign(target - vis) * Math.min(Math.abs(target - vis), dt * 8);
          fan.scale.setScalar(Math.max(0.001, ease(vis)));
          fan.visible = vis > 0.001;
          if (!fan.visible) { hovered = ''; closePeek(); }
        }
        if (anchorObj) {
          if (fan.visible) { ctx.root.updateWorldMatrix(true, false); orientFan(!wasVisible, dt); }
        } else if (fan.quaternion.w !== 1) fan.quaternion.identity();
        // hold-to-peek
        if (press && press.kind === 'card' && press.mode === 'idle' && !press.moved && now - press.t0 >= HOLD_S && cards[press.idx]?.entry?.type === 'dir') {
          press.mode = 'peek';
          openPeek(press.idx);
        }
        if (dirty) { dirty = false; render(); }
        if (moving && fan.visible) moving = poseCards(dt);
        if (ghost) poseGhost();
      },
      dispose() {
        for (const off of offs.splice(0)) off();
        pvTex?.dispose();
        if (ghost) disposeTree(ghost);
        if (pvGroup) disposeTree(pvGroup);
        disposeTree(fan);
      },
    };
  },
};

export default definition;
