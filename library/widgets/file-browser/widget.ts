// file-browser — navigate the file system (via the `files` source). A list pane (up / home / show
// hidden, the current path, folders first with type icons, sizes and ages; pinch-drag to scroll, tap a
// folder to open it, tap a file to preview it) and a preview pane beside it (text with line numbers,
// scrollable; images; "Ask Claude" sends the file to Claude). The current folder is remembered.
//
// Requests go to <prefix>.request with this entity's reply channels (<prefix>.view.<id>,
// <prefix>.preview.<id>), so several browsers work independently.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  width: number;
  rows: number;
  prefix: string;
}

interface Entry { name: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string }
interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Entry[]; truncated: boolean; error?: string }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }

const PAD = 0.016;
const ROW = 0.034;
const HEAD = 0.05;
const PREVIEW_W = 0.56;

const ICONS: Array<[RegExp, string, string]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic)$/, 'file-image', '#7ee787'],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, 'film', '#d2a8ff'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, 'music', '#ff9bce'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, 'file-archive', '#e3b341'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml)$/, 'braces', '#79c0ff'],
  [/^(csv|tsv|xlsx?|ods|parquet)$/, 'file-spreadsheet', '#7ee787'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, 'file-terminal', '#a5d6ff'],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|cu|swift|dart|r|jl|sql)$/, 'file-code', '#79c0ff'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex)$/, 'file-text', '#c9d1d9'],
  [/^(pem|key|crt|cer|p12|pfx)$/, 'file-key', '#ffa198'],
];

/** Lucide icon + color for an entry. */
export function iconFor(e: Pick<Entry, 'type' | 'ext'>): [string, string] {
  if (e.type === 'dir') return ['folder', '#e3b341'];
  for (const [re, icon, color] of ICONS) if (re.test(e.ext)) return [icon, color];
  return ['file', '#8b949e'];
}

/** "5m", "3h", "2d", or a date for older files. */
export function ageLabel(mtime: number | null, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Long paths keep their tail: "…/EvolSpace/library/widgets". */
export function shortPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(p.length - max + 1)}`;
}

const definition: WidgetDefinition<Props> = {
  description:
    "File browser (via the 'files' source): folders first with type icons, sizes and ages; up / home / show-hidden; pinch-drag to scroll, " +
    'tap a folder to open it, tap a file to preview it (text with line numbers, images) and "Ask Claude" about it. Keys/secrets are never shown.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    width: { type: 'number', default: 0.6, min: 0.35, max: 2, step: 0.01, description: 'List pane width (m); the preview opens beside it.' },
    rows: { type: 'integer', default: 14, min: 4, max: 40, description: 'Visible rows.' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    preview: { type: 'string', description: 'Preview this file (absolute or ~/ path).' },
  },
  outputs: { selected: { type: 'string', description: 'Absolute path of the file last tapped.' } },
  interactions: [dragBinding('file-browser-drag', 'drag')],
  size: [0.6, 0.6, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let listing: Listing | null = null;
    let preview: Preview | null = null;
    let current = String(ctx.props.path || '~');
    let scroll = 0;
    let textScroll = 0;
    let nonce = 0;
    let loading = true;
    let group: THREE.Group | null = null;
    let previewGroup: THREE.Group | null = null;
    let pathText: Text, countText: Text, hiddenIcon: THREE.Mesh, message: Text;
    const rows: Array<{ g: THREE.Group; icon: THREE.Mesh; name: Text; meta: Text }> = [];
    let selPlate: THREE.Mesh | null = null, track: THREE.Mesh | null = null, thumb: THREE.Mesh | null = null;
    let listTop = 0;
    let press: { hand: string; part: string; y0: number; scroll0: number; moved: boolean } | null = null;
    let imageTex: THREE.Texture | null = null;
    let dirty = true;
    const offs: Array<() => void> = [];

    const W = () => ctx.props.width;
    const N = () => ctx.props.rows;
    const listH = () => HEAD + N() * ROW + PAD * 2 + 0.006;
    const viewCh = () => `${ctx.props.prefix || 'files'}.view.${ctx.entityId}`;
    const previewCh = () => `${ctx.props.prefix || 'files'}.preview.${ctx.entityId}`;
    const shown = () => listing?.entries ?? [];

    function request(cmd: 'list' | 'preview', p: string): void {
      ctx.channels.publish(`${ctx.props.prefix || 'files'}.request`, { cmd, path: p, hidden: !!ctx.props.showHidden, reply: cmd === 'list' ? viewCh() : previewCh(), nonce: ++nonce } as never);
    }

    function open(p: string): void {
      current = p;
      loading = true;
      scroll = 0;
      request('list', p);
      dirty = true;
    }

    // ---- list pane ----------------------------------------------------------------------------

    function build(): void {
      if (group) disposeTree(group);
      rows.length = 0;
      const g = (group = new T.Group());
      const w = W(), h = listH();
      g.add(ctx.ui.panel(w, h));
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD;
      const top = h / 2 - PAD;
      const btn = (id: string, icon: string, x: number) => {
        const d = 0.03;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, top - d / 2, STYLE.zContent);
        b.name = `btn:${id}`;
        ctx.interactive(b);
        const ic = makeIcon(ctx, icon, { size: d * 0.55, color: theme.text });
        ic.position.z = STYLE.zText;
        b.add(ic);
        g.add(b);
        return ic;
      };
      btn('up', 'corner-left-up', x0 + 0.015);
      btn('home', 'house', x0 + 0.051);
      hiddenIcon = btn('hidden', ctx.props.showHidden ? 'eye' : 'eye-off', x0 + 0.087);
      const folder = makeIcon(ctx, 'folder-open', { size: 0.018, color: '#e3b341' });
      folder.position.set(x0 + 0.12, top - 0.015, STYLE.zText);
      pathText = makeText(ctx, '', { size: 0.014, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      pathText.position.set(x0 + 0.134, top - 0.015, STYLE.zText);
      countText = makeText(ctx, '', { size: 0.0105, anchorX: 'right', anchorY: 'middle', color: theme.textDim });
      countText.position.set(x1, top - 0.015, STYLE.zText);
      g.add(folder, pathText, countText);

      listTop = top - HEAD + 0.006;
      selPlate = ctx.ui.panel(w - PAD, ROW - 0.004, { color: theme.surface });
      selPlate.visible = false;
      selPlate.raycast = () => {};
      g.add(selPlate);
      for (let r = 0; r < N(); r++) {
        const rg = new T.Group();
        rg.position.set(0, listTop - (r + 0.5) * ROW, 0);
        const icon = makeIcon(ctx, 'file', { size: 0.019, color: theme.textDim });
        icon.position.set(x0 + 0.012, 0, STYLE.zText);
        const name = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        name.position.set(x0 + 0.03, 0, STYLE.zText);
        const meta = makeText(ctx, '', { size: 0.0105, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
        meta.position.set(x1 - 0.012, 0, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(w - PAD, ROW, 0.01);
        hit.name = `row:${r}`;
        ctx.interactive(hit);
        rg.add(icon, name, meta, hit);
        g.add(rg);
        rows.push({ g: rg, icon, name, meta });
      }
      const rh = N() * ROW;
      track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      track.scale.set(0.004, rh, 1);
      track.position.set(w / 2 - PAD * 0.45, listTop - rh / 2, STYLE.zContent);
      thumb = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.textDim));
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      for (const m of [track, thumb]) { m.raycast = () => {}; g.add(m); }
      message = makeText(ctx, '', { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
      message.position.set(0, listTop - rh / 2, STYLE.zText);
      g.add(message);
      ctx.root.add(g);
      dirty = true;
    }

    function render(): void {
      const list = shown();
      const first = Math.round(scroll);
      const w = W();
      const nameChars = Math.floor((w - 0.18) / (0.0135 * 0.55));
      pathText.set(shortPath(listing?.display ?? current, Math.floor((w - 0.24) / (0.014 * 0.58))));
      countText.set(loading ? 'loading…' : listing && !listing.error ? `${list.length}${listing.truncated ? '+' : ''} item${list.length === 1 ? '' : 's'}` : '');
      setIcon(T, hiddenIcon, ctx.props.showHidden ? 'eye' : 'eye-off');
      const msg = listing?.error ?? (!listing ? (loading ? 'Loading…' : "Start the 'files' source") : list.length ? '' : 'Empty folder');
      message.set(msg);
      message.visible = !!msg;
      let selRow = -1;
      for (let r = 0; r < rows.length; r++) {
        const e = list[first + r], row = rows[r];
        row.g.visible = !!e;
        if (!e) continue;
        const [icon, color] = iconFor(e);
        setIcon(T, row.icon, icon);
        (row.icon.material as THREE.MeshBasicMaterial).color.set(color);
        row.name.set(truncate(e.name, nameChars));
        row.meta.set([e.type === 'file' && e.size != null ? formatBytes(e.size) : '', ageLabel(e.mtime)].filter(Boolean).join('   '));
        if (preview && listing && preview.path === joinPath(listing.path, e.name)) selRow = r;
      }
      if (selPlate) {
        selPlate.visible = selRow >= 0;
        if (selRow >= 0) selPlate.position.set(0, rows[selRow].g.position.y, STYLE.zContent);
      }
      const over = list.length > N();
      if (track && thumb) {
        track.visible = thumb.visible = over;
        if (over) {
          const rh = N() * ROW, th = Math.max(0.02, (rh * N()) / list.length);
          thumb.scale.set(0.004, th, 1);
          thumb.position.y = listTop - th / 2 - (first / (list.length - N())) * (rh - th);
        }
      }
      renderPreview();
    }

    const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

    // ---- preview pane -------------------------------------------------------------------------

    let previewKey = '';
    /** Text lines that fit the preview body (same height as the list pane). */
    const previewLines = () => Math.max(5, Math.floor((listH() - 2 * PAD - 0.06) / (0.0105 * 1.25)));
    let previewBody: Text | null = null, previewNums: Text | null = null;
    // syntax highlighting of the previewed text: lines (tabs expanded) + token spans, per preview
    let hlLines: string[] = [];
    let hlSpans: Span[][] = [];
    let hlLang = '';
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
    function renderPreview(): void {
      const key = preview ? `${preview.path}|${preview.type}|${preview.src ?? ''}|${preview.text?.length ?? 0}` : '';
      if (key !== previewKey) {
        previewKey = key;
        if (previewGroup) disposeTree(previewGroup);
        previewGroup = null;
        previewBody = previewNums = null;
        imageTex?.dispose();
        imageTex = null;
        if (preview) buildPreview(preview);
        if (preview?.type === 'text') {
          const lang = languageFor(preview.name);
          hlLines = (preview.text ?? '').replace(/\t/g, '  ').split('\n');
          hlSpans = highlight(hlLines.join('\n'), lang);
          hlLang = lang?.id ?? '';
        } else { hlLines = []; hlSpans = []; hlLang = ''; }
      }
      if (preview?.type === 'text' && previewBody && previewNums) {
        const lines = hlLines;
        const visible = previewLines();
        const from = Math.min(Math.max(0, Math.round(textScroll)), Math.max(0, lines.length - visible));
        textScroll = from;
        const shownLines = lines.slice(from, from + visible);
        const cols = Math.floor((PREVIEW_W - 0.08) / (0.0105 * 0.6));
        const shown = shownLines.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
        previewBody.set(shown.join('\n'));
        // colors stop before a truncation ellipsis (it keeps the base color)
        const clips = shown.map((l, i) => (l.length < shownLines[i].length ? l.length - 1 : l.length));
        setColorRanges(previewBody, hlLang ? colorRanges(hlSpans.slice(from, from + visible), shown.map((l) => l.length), syntaxInts, hexToInt(theme.text), clips) : null);
        previewNums.set(shownLines.map((_, i) => String(from + i + 1)).join('\n'));
      }
    }

    function buildPreview(p: Preview): void {
      const g = (previewGroup = new T.Group());
      const w = PREVIEW_W, h = listH();
      g.position.set(W() / 2 + 0.012 + w / 2, 0, 0);
      g.add(ctx.ui.panel(w, h));
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD, top = h / 2 - PAD;
      const [icon, color] = iconFor({ type: 'file', ext: p.name.includes('.') ? p.name.split('.').pop()!.toLowerCase() : '' });
      const ic = makeIcon(ctx, icon, { size: 0.02, color });
      ic.position.set(x0 + 0.01, top - 0.013, STYLE.zText);
      const title = makeText(ctx, truncate(p.name, 44), { size: 0.0145, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.027, top - 0.013, STYLE.zText);
      const meta = makeText(ctx, [p.size != null ? formatBytes(p.size) : '', p.mtime ? `modified ${ageLabel(p.mtime)}${ageLabel(p.mtime).includes(',') ? '' : ' ago'}` : '', p.type === 'text' ? `${p.lines} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join(' · '),
        { size: 0.0105, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.027, top - 0.033, STYLE.zText);
      g.add(ic, title, meta);
      const btn = (id: string, iconName: string, x: number) => {
        const d = 0.028;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, top - 0.015, STYLE.zContent);
        b.name = `btn:${id}`;
        ctx.interactive(b);
        const bi = makeIcon(ctx, iconName, { size: d * 0.55, color: theme.text });
        bi.position.z = STYLE.zText;
        b.add(bi);
        g.add(b);
      };
      btn('close', 'x', x1 - 0.014);
      btn('ask', 'message-square', x1 - 0.05);
      const bodyTop = top - 0.055, bodyH = h - 2 * PAD - 0.055;
      if (p.type === 'text') {
        previewNums = makeText(ctx, '', { size: 0.0105, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: 1.25 });
        previewNums.position.set(x0 + 0.026, bodyTop, STYLE.zText);
        previewBody = makeText(ctx, '', { size: 0.0105, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: 1.25 });
        previewBody.position.set(x0 + 0.034, bodyTop, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(w - PAD, bodyH, 0.01);
        hit.position.set(0, bodyTop - bodyH / 2, 0.004);
        hit.name = 'preview-text';
        ctx.interactive(hit);
        g.add(previewNums, previewBody, hit);
      } else if (p.type === 'image' && p.src && typeof document !== 'undefined') {
        const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        img.raycast = () => {};
        img.visible = false;
        img.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
        g.add(img);
        imageTex = new T.TextureLoader().load(p.src, (tex) => {
          if (imageTex !== tex) return;
          tex.colorSpace = T.SRGBColorSpace;
          const im = tex.image as { width: number; height: number };
          const a = im.width / im.height, bw = w - 2 * PAD, bh = bodyH;
          const sw = a > bw / bh ? bw : bh * a, sh = a > bw / bh ? bw / a : bh;
          img.scale.set(sw, sh, 1);
          mat.map = tex;
          mat.needsUpdate = true;
          img.visible = true;
        }, undefined, () => ctx.error(`file-browser: could not load ${p.src}`));
      } else {
        const msg = p.type === 'binary' ? 'Binary file: no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
        const t = makeText(ctx, msg, { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
        t.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
        g.add(t);
      }
      ctx.root.add(g);
    }

    // ---- data ---------------------------------------------------------------------------------

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(viewCh(), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Listing).kind !== 'list') return;
        const l = v as Listing;
        // keep the one for the folder we're in (other clients may ask too; the path is the truth)
        if (listing && l.path !== listing.path && loading === false) return;
        listing = l;
        loading = false;
        const display = l.display;
        if (display && display !== ctx.props.path && !ctx.isMirror) ctx.setProps({ path: display });
        current = display || l.path;
        dirty = true;
      }));
      offs.push(ctx.channels.subscribe(previewCh(), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Preview).kind !== 'preview') return;
        const got = (v as Preview).path;
        if (!pendingPreview || (got !== pendingPreview && !(pendingPreview.startsWith('~') && got.endsWith(pendingPreview.slice(1))))) return; // stale / someone else's
        preview = v as Preview;
        textScroll = 0;
        dirty = true;
      }));
    }

    let pendingPreview = '';
    function tapRow(r: number): void {
      const e = shown()[Math.round(scroll) + r];
      if (!e || !listing) return;
      const full = joinPath(listing.path, e.name);
      if (e.type === 'dir') { preview = null; pendingPreview = ''; open(full); return; }
      ctx.emit('selected', full);
      pendingPreview = full;
      request('preview', full);
    }

    build();
    subscribe();
    open(current);

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.rows !== prev.rows) { build(); previewKey = ''; }
        if (p.prefix !== prev.prefix) { subscribe(); open(current); }
        else if (p.showHidden !== prev.showHidden) open(current);
        else if (p.path !== prev.path && p.path !== (listing?.display ?? current)) open(String(p.path || '~'));
        dirty = true;
      },
      onInput(port, v) {
        if (port === 'path' && typeof v === 'string' && v.trim()) open(v.trim());
        if (port === 'preview' && typeof v === 'string' && v.trim()) { pendingPreview = v.trim(); request('preview', pendingPreview); }
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName ?? '';
        const y = e.localPoint[1];
        if (e.phase === 'start') {
          if (press) return;
          press = { hand: e.hand, part, y0: y, scroll0: part === 'preview-text' ? textScroll : scroll, moved: false };
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          if (!press.moved && Math.abs(y - press.y0) > ROW * 0.45) press.moved = true;
          if (!press.moved) return;
          if (press.part.startsWith('row:')) {
            scroll = Math.min(Math.max(0, shown().length - N()), Math.max(0, press.scroll0 + (y - press.y0) / ROW));
          } else if (press.part === 'preview-text') {
            textScroll = Math.max(0, press.scroll0 + (y - press.y0) / (0.0105 * 1.25));
          }
          dirty = true;
          return;
        }
        const p = press;
        press = null;
        if (e.phase !== 'end' || p.moved) return;
        if (p.part.startsWith('row:')) tapRow(Number(p.part.slice(4)));
        else if (p.part === 'btn:up' && listing?.parent) { preview = null; pendingPreview = ''; open(listing.parent); }
        else if (p.part === 'btn:home') { preview = null; pendingPreview = ''; open('~'); }
        else if (p.part === 'btn:hidden') { if (!ctx.isMirror) ctx.setProps({ showHidden: !ctx.props.showHidden }); open(current); }
        else if (p.part === 'btn:close') { preview = null; pendingPreview = ''; dirty = true; }
        else if (p.part === 'btn:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
      },
      update() {
        if (!dirty) return;
        dirty = false;
        render();
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        imageTex?.dispose();
        if (previewGroup) disposeTree(previewGroup);
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
