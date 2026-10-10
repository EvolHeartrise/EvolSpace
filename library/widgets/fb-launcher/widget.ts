// fb-launcher — "Files · Launcher": a search-first file finder (Spotlight / command-palette style) for the
// `files` source. A query field + scope chip + ranked, numbered results (1–9 openable by voice); an empty
// query shows Pinned + Recent files. Below, a tilted "speed keyboard" deck: completion / recent-query
// chips, a 4×10 key grid (digits, letters, . - _ and ⌫ — hold ⌫ to delete words) whose likely next keys
// glow, and type-filter chips (code · docs · images · media · folders). Pinch a file → preview card
// (syntax-highlighted text or image) beside the list; pinch a folder → it becomes the search scope.
//
// Requests: <prefix>.request {cmd: 'search'|'preview', path, query?, limit?, hidden?, reply, nonce} with
// reply channels <prefix>.fb-launcher.<entityId>.search|preview. Control channel (prop `control`,
// default files.launcher.ctl): {cmd:'query',text} | {cmd:'open',index} | {cmd:'clear'} | … (see model.ts
// parseCtl); the value already on it at subscribe time is ignored.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import {
  ageLabel, completions, extOf, FILTERS, highlightRanges, iconFor, isFilter, KEY_ROWS, matchIndices, nextKeys, normQuery, normScope,
  parentOf, parseCtl, passes, pinToHit, readHistory, readPins, relFolder, tail, type Filter, type Hit, type Pin,
} from './model.ts';

interface Props extends Record<string, unknown> {
  scope: string;
  filter: Filter;
  pins: unknown;
  history: unknown;
  rows: number;
  keyboard: boolean;
  tilt: number;
  showHidden: boolean;
  prefix: string;
  control: string;
}

interface SearchReply { kind: 'search'; path: string; display: string; query: string; results: Hit[]; scanned?: number; partial?: boolean; error?: string; nonce?: number }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }
type Row = { kind: 'head'; label: string } | { kind: 'item'; hit: Hit; n: number; pinned: boolean };

// ---- layout (meters) --------------------------------------------------------------------------------
const W = 0.6;
const PAD = 0.016;
const FIELD_H = 0.058;
const SCOPE_H = 0.044;
const ROW = 0.046;
const NAME_DY = 0.0085;
const SUB_DY = -0.0105;
const NAME_SIZE = 0.0165;
const SUB_SIZE = 0.0105;
const NUM_SIZE = 0.0135;
const AGE_SIZE = 0.0115;
const PREVIEW_W = 0.58;
const PV_SIZE = 0.0105;
// keyboard deck
const PITCH = 0.054;            // key pitch; key labels are one mono text per row: 3 chars (0.6 em) per key
const KEY_FONT = PITCH / 1.8;
const KEY_W = 0.048;
const KEY_H = 0.044;
const KROW = 0.05;
const STRIP_H = 0.042;
const FILTER_H = 0.042;
const DPAD = 0.014;
const DECK_GAP = 0.02;
const COLS = 10;
const BKSP = KEY_ROWS.findIndex((r) => r.includes('\b')) * COLS + KEY_ROWS.find((r) => r.includes('\b'))!.indexOf('\b');
const CHIPS = 4;

const DEFAULT_SCOPE = '~/git projects';

const definition: WidgetDefinition<Props> = {
  description:
    "Files · Launcher — search-first file finder (via the 'files' source), like Spotlight: a query field, a scope chip (pop to the parent), " +
    'ranked numbered results with the matched letters highlighted (folder + age), or Pinned + Recent files when the query is empty. ' +
    'A tilted speed keyboard (completions / recent queries, 4×10 keys with predicted next keys glowing, hold ⌫ to delete words, ' +
    'type filters code·docs·images·media·folders). Pinch a file → syntax-highlighted / image preview; pinch a folder → new scope; pin results. ' +
    'Voice/agent control on channel `control` (files.launcher.ctl): {cmd:"query",text} {cmd:"open",index} {cmd:"clear"} {cmd:"pin",index} ' +
    '{cmd:"scope",path} {cmd:"pop"} {cmd:"filter",filter} {cmd:"close"} {cmd:"scroll",by} {cmd:"append",text} {cmd:"backspace"} {cmd:"ask"}.',
  version: '1.0.0',
  props: {
    scope: { type: 'string', default: DEFAULT_SCOPE, description: 'Folder searched (≈ "~/…"); updated when you open a folder or pop.' },
    filter: { type: 'enum', options: ['all', 'code', 'docs', 'images', 'media', 'folders'], default: 'all', description: 'Type filter.' },
    pins: { type: 'json', default: [], description: 'Pinned items [{path, display, name, type}] (shown first when the query is empty).' },
    history: { type: 'json', default: [], description: 'Recent queries (newest first, ≤ 8) offered as chips.' },
    rows: { type: 'integer', default: 9, min: 4, max: 14, description: 'Visible result rows.' },
    keyboard: { type: 'boolean', default: true, description: 'Show the speed-keyboard deck (off = voice-only).' },
    tilt: { type: 'number', default: 22, min: 0, max: 60, step: 1, description: 'Keyboard deck tilt toward the user (degrees).' },
    showHidden: { type: 'boolean', default: false, description: 'Include dot files (secrets stay hidden regardless).' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
    control: { type: 'string', default: 'files.launcher.ctl', description: 'Control channel ({cmd, …}; a bare string = query).' },
  },
  inputs: {
    query: { type: 'string', description: 'Set the query.' },
    scope: { type: 'string', description: 'Set the search scope folder.' },
  },
  outputs: {
    selected: { type: 'string', description: 'Absolute path of the file last opened.' },
    query: { type: 'string', description: 'The current query (on change).' },
  },
  interactions: [dragBinding('fb-launcher-drag', 'drag')],
  size: [0.6, 0.9, 0.02],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const hex = { text: hexToInt(theme.text), accent: hexToInt(theme.accent), dim: hexToInt(theme.textDim) };
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
    const ctlName = () => String(ctx.props.control || 'files.launcher.ctl');
    const pre = () => String(ctx.props.prefix || 'files');
    const replyCh = (what: string) => `${pre()}.fb-launcher.${ctx.entityId}.${what}`;

    // ---- state ----------------------------------------------------------------------------------------
    let query = '';
    let scope = normScope(ctx.props.scope);
    let filter: Filter = isFilter(ctx.props.filter) ? ctx.props.filter : 'all';
    const scopeStack: string[] = [];
    let results: Hit[] = [];
    let recents: { scope: string; hits: Hit[] } = { scope: '', hits: [] };
    let resultsQuery = '';
    let resultsPartial = false;
    let resultsError = '';
    let haveResults = false;
    let list: Row[] = [];
    let items: Hit[] = [];
    let suggestions: Array<{ label: string; value: string; icon: string }> = [];
    let predicted = new Set<string>();
    let scroll = 0;
    let nonce = 0;
    let lastNonce = -1;
    let sentKey = '';
    let sentAt = 0;
    let firstSentAt = 0;
    let retries = 0;
    let waiting = false;
    let dueAt = 0; // send the first request on the first frame
    let now = 0;
    let preview: Preview | null = null;
    let pendingPreview = '';
    let textScroll = 0;
    let hoverPart = '';
    let hoverKey = -1;
    let pressedKey = -1;
    let dirty = true;
    let keysDirty = true;
    let caretOn = true;
    let waitPhase = -1;
    let press: { hand: string; part: string; x0: number; y0: number; scroll0: number; moved: boolean; key: number; t0: number; repeats: number } | null = null;
    const offs: Array<() => void> = [];

    // ---- scene objects ---------------------------------------------------------------------------------
    let group: THREE.Group | null = null;
    let previewGroup: THREE.Group | null = null;
    let deck: THREE.Group | null = null;
    let queryText!: Text, statusText!: Text, scopeText!: Text, message!: Text, numCol!: Text, ageCol!: Text, stripHint!: Text;
    let caret!: THREE.Mesh, scopeIcon!: THREE.Mesh, selPlate!: THREE.Mesh, hoverPlate!: THREE.Mesh, track!: THREE.Mesh, thumb!: THREE.Mesh, filterPlate!: THREE.Mesh;
    const rows: Array<{ g: THREE.Group; icon: THREE.Mesh; name: Text; sub: Text; pin: THREE.Mesh; pinMat: THREE.MeshBasicMaterial }> = [];
    const heads: Text[] = [];
    const chips: Array<{ g: THREE.Group; icon: THREE.Mesh; label: Text }> = [];
    const plates = new Map<string, THREE.Object3D>(); // part name → object scaled as press feedback
    let caps: FittedInstances | null = null;
    let listTop = 0, numX = 0, queryX = 0, cardH = 0;
    const deckInv = new T.Matrix4();
    const tmpV = new T.Vector3();
    const tmpM = new T.Matrix4();
    const cBase = new T.Color(theme.surface);
    const cDigit = new T.Color(mixHex(theme.surface, theme.background, 0.45));
    const cSpecial = new T.Color(mixHex(theme.surface, theme.accent2, 0.28));
    const cPred = new T.Color(mixHex(theme.surface, theme.accent, 0.38));
    const cHover = new T.Color(mixHex(theme.surface, theme.text, 0.2));
    const cPress = new T.Color(theme.accent);
    const watch = new MeasureWatch();

    const N = () => Math.max(4, Math.min(14, Math.round(Number(ctx.props.rows) || 9)));
    const persist = (patch: Record<string, unknown>) => { if (!ctx.isMirror) ctx.setProps(patch as Partial<Props>); else Object.assign(ctx.props, patch); };

    // ---- requests --------------------------------------------------------------------------------------
    const limit = () => (filter === 'all' ? 60 : 200);
    const keyOf = () => `${scope}|${query}|${limit()}|${!!ctx.props.showHidden}`;
    function schedule(delay: number): void { dueAt = now + delay; }
    function sendSearch(): void {
      dueAt = -1;
      const key = keyOf();
      if (key === sentKey && (waiting || haveResults)) return;
      sentKey = key;
      lastNonce = ++nonce;
      sentAt = now;
      firstSentAt = now;
      retries = 0;
      waiting = true;
      ctx.channels.publish(`${pre()}.request`, { cmd: 'search', path: scope, query, limit: limit(), hidden: !!ctx.props.showHidden, reply: replyCh('search'), nonce: lastNonce } as never);
      dirty = true;
    }
    function resend(): void {
      retries++;
      sentAt = now;
      lastNonce = ++nonce;
      ctx.channels.publish(`${pre()}.request`, { cmd: 'search', path: scope, query, limit: limit(), hidden: !!ctx.props.showHidden, reply: replyCh('search'), nonce: lastNonce } as never);
    }
    function requestPreview(path: string): void {
      pendingPreview = path;
      ctx.channels.publish(`${pre()}.request`, { cmd: 'preview', path, reply: replyCh('preview'), nonce: ++nonce } as never);
    }

    // ---- model → rows ----------------------------------------------------------------------------------
    function rebuildList(): void {
      const pins = readPins(ctx.props.pins);
      const pinned = new Set(pins.map((p) => p.path));
      list = [];
      items = [];
      const add = (hit: Hit, isPin: boolean) => { items.push(hit); list.push({ kind: 'item', hit, n: items.length, pinned: isPin }); };
      if (!query) {
        const ps = pins.map(pinToHit).filter((h) => passes(h, filter));
        if (ps.length) { list.push({ kind: 'head', label: `PINNED` }); for (const h of ps) add(h, true); }
        // recents: the latest reply, or the cached recents of this scope while a fresh reply is on its way
        const src = resultsQuery === '' && haveResults ? results : recents.scope === scope ? recents.hits : [];
        const rec = src.filter((h) => !pinned.has(h.path) && passes(h, filter));
        if (rec.length) { list.push({ kind: 'head', label: `RECENT` }); for (const h of rec) add(h, false); }
      } else {
        // Live narrowing: until the reply for this query arrives, keep the previous results that still match it.
        const narrowing = resultsQuery !== query;
        for (const h of results) {
          if (!passes(h, filter)) continue;
          if (narrowing && !matchIndices(h.name, query).length) continue;
          add(h, pinned.has(h.path));
        }
      }
      scroll = Math.min(Math.max(0, list.length - N()), Math.max(0, scroll));
      const names = items.map((h) => h.name);
      const hist = readHistory(ctx.props.history);
      if (query) {
        suggestions = completions(names, query, CHIPS).map((s) => ({ label: s, value: s, icon: 'sparkles' }));
        predicted = new Set(nextKeys(names, query));
      } else {
        suggestions = hist.slice(0, CHIPS).map((s) => ({ label: s, value: s, icon: 'clock' }));
        predicted = new Set();
      }
      keysDirty = true;
      dirty = true;
    }

    // ---- actions -----------------------------------------------------------------------------------------
    function setQuery(q: string, delay = 0.15): void {
      q = q.slice(0, 64);
      if (q === query) return;
      query = q;
      scroll = 0;
      ctx.emit('query', q);
      schedule(q ? delay : 0);
      rebuildList();
    }
    function setScope(p: string): void {
      p = normScope(p);
      if (p === scope) return;
      scope = p;
      scroll = 0;
      results = [];
      resultsQuery = '';
      haveResults = false;
      resultsError = '';
      persist({ scope: p });
      schedule(0);
      rebuildList();
    }
    function pushScope(p: string): void {
      if (normScope(p) === scope) return;
      scopeStack.push(scope);
      if (scopeStack.length > 20) scopeStack.shift();
      query = '';
      ctx.emit('query', '');
      setScope(p);
    }
    function popScope(): void { setScope(scopeStack.pop() ?? parentOf(scope)); }
    function setFilter(f: Filter): void {
      if (f === filter) return;
      filter = f;
      persist({ filter: f });
      scroll = 0;
      schedule(0);
      rebuildList();
    }
    function rememberQuery(): void {
      if (!query) return;
      const hist = readHistory(ctx.props.history).filter((s) => s !== query);
      persist({ history: [query, ...hist].slice(0, 8) });
    }
    function closePreview(): void {
      preview = null;
      pendingPreview = '';
      dirty = true;
    }
    function openHit(hit: Hit, toggle: boolean): void {
      rememberQuery();
      if (hit.type === 'dir') { pushScope(hit.display || hit.path); return; }
      if (toggle && (pendingPreview === hit.path || preview?.path === hit.path)) { closePreview(); return; }
      ctx.emit('selected', hit.path);
      requestPreview(hit.path);
      dirty = true;
    }
    function openIndex(n: number): void {
      const hit = items[n - 1];
      if (hit) openHit(hit, false);
    }
    function togglePin(hit: Hit): void {
      const pins = readPins(ctx.props.pins);
      const i = pins.findIndex((p) => p.path === hit.path);
      if (i >= 0) pins.splice(i, 1);
      else pins.unshift({ path: hit.path, display: hit.display || hit.path, name: hit.name, type: hit.type === 'dir' ? 'dir' : 'file' } satisfies Pin);
      persist({ pins: pins.slice(0, 24) });
      rebuildList();
    }
    function deleteWord(): void {
      const m = /[^a-z0-9]*[a-z0-9]*$/.exec(query);
      setQuery(query.slice(0, query.length - Math.max(1, m ? m[0].length : 1)));
    }
    function scrollBy(by: number): void {
      scroll = Math.min(Math.max(0, list.length - N()), Math.max(0, Math.round(scroll + by)));
      dirty = true;
    }

    // ---- build -------------------------------------------------------------------------------------------
    function roundButton(g: THREE.Object3D, name: string, icon: string, x: number, y: number, d: number, color = theme.surface): THREE.Mesh {
      const b = ctx.ui.panel(d, d, { color, radius: d / 2 });
      b.position.set(x, y, STYLE.zContent);
      b.name = name;
      ctx.interactive(b);
      const ic = makeIcon(ctx, icon, { size: d * 0.5, color: theme.text });
      ic.position.z = STYLE.zText;
      b.add(ic);
      g.add(b);
      plates.set(name, b);
      return ic;
    }

    function build(): void {
      if (group) disposeTree(group);
      rows.length = 0;
      heads.length = 0;
      chips.length = 0;
      plates.clear();
      caps = null;
      deck = null;
      const g = (group = new T.Group());
      const n = N();
      const h = (cardH = PAD + FIELD_H + SCOPE_H + n * ROW + PAD);
      g.add(ctx.ui.panel(W, h));
      const x0 = -W / 2 + PAD, x1 = W / 2 - PAD;
      const top = h / 2 - PAD;

      // field: [search] query|caret …………… [x]
      const fy = top - FIELD_H / 2;
      const field = ctx.ui.panel(W - 2 * PAD, FIELD_H - 0.008, { color: theme.surface, radius: 0.02 });
      field.position.set(0, fy, STYLE.zContent);
      g.add(field);
      const sIcon = makeIcon(ctx, 'search', { size: 0.024, color: theme.accent });
      sIcon.position.set(x0 + 0.024, fy, STYLE.zText);
      g.add(sIcon);
      queryX = x0 + 0.046;
      queryText = makeText(ctx, '', { size: 0.024, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      queryText.position.set(queryX, fy, STYLE.zText);
      caret = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent));
      caret.scale.set(0.0022, 0.028, 1);
      caret.position.set(queryX, fy, STYLE.zText);
      caret.raycast = () => {};
      g.add(queryText, caret);
      roundButton(g, 'btn:clear', 'x', x1 - 0.026, fy, 0.036, theme.background);

      // scope row: [folder · scope ↰] ………… status
      const sy = top - FIELD_H - SCOPE_H / 2;
      const chipW = 0.34;
      const chip = ctx.ui.panel(chipW, SCOPE_H - 0.01, { color: theme.surface, radius: (SCOPE_H - 0.01) / 2 });
      chip.position.set(x0 + chipW / 2, sy, STYLE.zContent);
      chip.name = 'btn:pop';
      ctx.interactive(chip);
      plates.set('btn:pop', chip);
      const popIcon = makeIcon(ctx, 'corner-left-up', { size: 0.018, color: theme.textDim });
      popIcon.position.set(-chipW / 2 + 0.02, 0, STYLE.zText - STYLE.zContent);
      scopeIcon = makeIcon(ctx, 'folder-search', { size: 0.018, color: '#e3b341' });
      scopeIcon.position.set(-chipW / 2 + 0.043, 0, STYLE.zText - STYLE.zContent);
      scopeText = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      scopeText.position.set(-chipW / 2 + 0.058, 0, STYLE.zText - STYLE.zContent);
      chip.add(popIcon, scopeIcon, scopeText);
      g.add(chip);
      statusText = makeText(ctx, '', { size: 0.012, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      statusText.position.set(x1 - 0.006, sy, STYLE.zText);
      g.add(statusText);

      // results
      listTop = top - FIELD_H - SCOPE_H - 0.002;
      selPlate = ctx.ui.panel(W - 2 * PAD + 0.004, ROW - 0.004, { color: mixHex(theme.surface, theme.accent, 0.18), radius: 0.012 });
      hoverPlate = ctx.ui.panel(W - 2 * PAD + 0.004, ROW - 0.004, { color: theme.surface, radius: 0.012 });
      for (const p of [selPlate, hoverPlate]) { p.visible = false; p.raycast = () => {}; g.add(p); }
      numX = x0 + 0.013;
      numCol = makeText(ctx, '', { size: NUM_SIZE, anchorX: 'center', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: ROW / NUM_SIZE });
      numCol.position.set(numX, listTop, STYLE.zText);
      ageCol = makeText(ctx, '', { size: AGE_SIZE, anchorX: 'right', anchorY: 'top', color: theme.textDim, lineHeight: ROW / AGE_SIZE, textAlign: 'right' });
      ageCol.position.set(x1 - 0.046, listTop + NAME_DY, STYLE.zText);
      g.add(numCol, ageCol);
      for (let r = 0; r < n; r++) {
        const rg = new T.Group();
        rg.position.set(0, listTop - (r + 0.5) * ROW, 0);
        const icon = makeIcon(ctx, 'file', { size: 0.022, color: theme.textDim });
        icon.position.set(x0 + 0.044, 0, STYLE.zText);
        const name = makeText(ctx, '', { size: NAME_SIZE, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        name.position.set(x0 + 0.064, NAME_DY, STYLE.zText);
        const sub = makeText(ctx, '', { size: SUB_SIZE, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
        sub.position.set(x0 + 0.064, SUB_DY, STYLE.zText);
        const pin = makeIcon(ctx, 'pin', { size: 0.018, color: theme.textDim });
        pin.position.set(x1 - 0.018, 0, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(W - 2 * PAD - 0.04, ROW, 0.01);
        hit.position.set(-0.02, 0, 0.004);
        hit.name = `row:${r}`;
        ctx.interactive(hit);
        const pinHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        pinHit.scale.set(0.04, ROW, 0.01);
        pinHit.position.set(x1 - 0.018, 0, 0.004);
        pinHit.name = `pin:${r}`;
        ctx.interactive(pinHit);
        rg.add(icon, name, sub, pin, hit, pinHit);
        g.add(rg);
        rows.push({ g: rg, icon, name, sub, pin, pinMat: pin.material as THREE.MeshBasicMaterial });
      }
      for (let i = 0; i < 2; i++) {
        const t = makeText(ctx, '', { size: 0.0115, anchorX: 'left', anchorY: 'middle', color: theme.accent2, weight: 'semibold', whiteSpace: 'nowrap' });
        t.visible = false;
        g.add(t);
        heads.push(t);
      }
      const rh = n * ROW;
      track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      track.scale.set(0.003, rh - 0.01, 1);
      track.position.set(W / 2 - PAD * 0.5, listTop - rh / 2, STYLE.zContent);
      thumb = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.textDim));
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      for (const m of [track, thumb]) { m.raycast = () => {}; g.add(m); }
      message = makeText(ctx, '', { size: 0.014, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: W - 0.1, textAlign: 'center' });
      message.position.set(0, listTop - Math.min(rh / 2, 2.5 * ROW), STYLE.zText);
      g.add(message);

      if (ctx.props.keyboard !== false) buildDeck(g, h);
      watch.reset([queryText]);
      ctx.root.add(g);
      dirty = true;
      keysDirty = true;
    }

    function buildDeck(g: THREE.Group, h: number): void {
      const keysW = COLS * PITCH;
      const deckH = DPAD + STRIP_H + 0.006 + KEY_ROWS.length * KROW + 0.006 + FILTER_H + DPAD;
      const d = (deck = new T.Group());
      d.position.set(0, -h / 2 - DECK_GAP, 0.004);
      d.rotation.x = -(Math.min(60, Math.max(0, Number(ctx.props.tilt) || 0)) * Math.PI) / 180;
      d.updateMatrix();
      deckInv.copy(d.matrix).invert();
      const panel = ctx.ui.panel(W, deckH);
      panel.position.set(0, -deckH / 2, 0);
      d.add(panel);
      const x0 = -keysW / 2;

      // suggestion strip: completions (sparkles) or recent queries (clock)
      const sy = -DPAD - STRIP_H / 2;
      const cw = (keysW - (CHIPS - 1) * 0.006) / CHIPS;
      for (let i = 0; i < CHIPS; i++) {
        const cg = new T.Group();
        cg.position.set(x0 + cw / 2 + i * (cw + 0.006), sy, 0);
        const plate = ctx.ui.panel(cw, STRIP_H - 0.006, { color: theme.surface, radius: 0.016 });
        plate.position.z = STYLE.zContent;
        plate.name = `chip:${i}`;
        ctx.interactive(plate);
        plates.set(plate.name, plate);
        const icon = makeIcon(ctx, 'clock', { size: 0.015, color: theme.textDim });
        icon.position.set(-cw / 2 + 0.018, 0, STYLE.zText);
        const label = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        label.position.set(-cw / 2 + 0.032, 0, STYLE.zText);
        cg.add(plate, icon, label);
        d.add(cg);
        chips.push({ g: cg, icon, label });
      }
      stripHint = makeText(ctx, '', { size: 0.0125, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      stripHint.position.set(0, sy, STYLE.zText);
      d.add(stripHint);

      // keys: instanced rounded caps (one draw call) + one mono label text per row
      const kTop = -DPAD - STRIP_H - 0.006;
      const capGeo = ctx.ui.panel(1, 1, { radius: 0.2, border: false } as { radius: number }).geometry // border: runtime option (no outline needed);
      caps = new FittedInstances(T, capGeo, ownMaterial(T, '#ffffff'), KEY_ROWS.length * COLS);
      caps.mesh.raycast = () => {};
      d.add(caps.mesh);
      KEY_ROWS.forEach((row, r) => {
        const label = row.split('').map((c) => (c === '\b' ? ' ' : c.toUpperCase())).join('  ').trimEnd();
        const t = makeText(ctx, label, { size: KEY_FONT, anchorX: 'left', anchorY: 'middle', color: r === 0 ? theme.textDim : theme.text, font: 'mono', whiteSpace: 'nowrap' });
        t.position.set(x0 + PITCH / 2 - 0.3 * KEY_FONT, kTop - (r + 0.5) * KROW + 0.001, STYLE.zText);
        d.add(t);
      });
      const br = Math.floor(BKSP / COLS), bc = BKSP % COLS;
      const bk = makeIcon(ctx, 'arrow-left', { size: 0.026, color: theme.text });
      bk.position.set(x0 + (bc + 0.5) * PITCH, kTop - (br + 0.5) * KROW, STYLE.zText);
      d.add(bk);
      const kb = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      kb.scale.set(keysW, KEY_ROWS.length * KROW, 0.01);
      kb.position.set(0, kTop - (KEY_ROWS.length * KROW) / 2, 0.004);
      kb.name = 'kb';
      ctx.interactive(kb);
      d.add(kb);

      // type filters
      const fy = kTop - KEY_ROWS.length * KROW - 0.006 - FILTER_H / 2;
      const fw = (keysW - (FILTERS.length - 1) * 0.006) / FILTERS.length;
      filterPlate = ctx.ui.panel(fw, FILTER_H - 0.006, { color: mixHex(theme.surface, theme.accent, 0.45), radius: 0.016 });
      filterPlate.raycast = () => {};
      filterPlate.position.set(0, fy, STYLE.zOverlay);
      d.add(filterPlate);
      FILTERS.forEach((f, i) => {
        const x = x0 + fw / 2 + i * (fw + 0.006);
        const plate = ctx.ui.panel(fw, FILTER_H - 0.006, { color: theme.surface, radius: 0.016 });
        plate.position.set(x, fy, STYLE.zContent);
        plate.name = `filter:${f.id}`;
        ctx.interactive(plate);
        plates.set(plate.name, plate);
        const icon = makeIcon(ctx, f.icon, { size: 0.016, color: f.id === 'folders' ? '#e3b341' : theme.text });
        const label = makeText(ctx, f.label, { size: 0.0125, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        const lw = f.label.length * 0.0125 * 0.55;
        const total = 0.016 + 0.006 + lw;
        icon.position.set(x - total / 2 + 0.008, fy, STYLE.zText);
        label.position.set(x - total / 2 + 0.022, fy, STYLE.zText);
        d.add(plate, icon, label);
      });
      g.add(d);
    }

    // ---- keyboard ----------------------------------------------------------------------------------------
    const kTopY = () => -DPAD - STRIP_H - 0.006;
    /** Key index under a point in ctx.root coords (−1 = none); `slack` grows each key's box. */
    function keyAt(lp: ArrayLike<number>, slack = 0, only = -1): number {
      if (!deck) return -1;
      tmpV.set(lp[0], lp[1], lp[2]).applyMatrix4(deckInv);
      const fx = (tmpV.x + (COLS * PITCH) / 2) / PITCH;
      const fy = (kTopY() - tmpV.y) / KROW;
      if (only >= 0) {
        const r = Math.floor(only / COLS), c = only % COLS;
        return Math.abs(fx - (c + 0.5)) <= 0.5 + slack && Math.abs(fy - (r + 0.5)) <= 0.5 + slack ? only : -1;
      }
      const c = Math.floor(fx), r = Math.floor(fy);
      if (c < 0 || c >= COLS || r < 0 || r >= KEY_ROWS.length) return -1;
      return KEY_ROWS[r][c] ? r * COLS + c : -1;
    }
    function typeKey(idx: number): void {
      const ch = KEY_ROWS[Math.floor(idx / COLS)]?.[idx % COLS];
      if (!ch) return;
      if (ch === '\b') setQuery(query.slice(0, -1));
      else setQuery(query + ch);
    }
    function refreshKeys(): void {
      keysDirty = false;
      if (!caps) return;
      const keysW = COLS * PITCH, kTop = kTopY();
      caps.fit(-keysW / 2, kTop - KEY_ROWS.length * KROW, STYLE.zContent - 0.0005, keysW / 2, kTop, STYLE.zContent + 0.0005);
      for (let r = 0; r < KEY_ROWS.length; r++) {
        for (let c = 0; c < COLS; c++) {
          const idx = r * COLS + c, ch = KEY_ROWS[r][c];
          const s = idx === pressedKey ? 0.88 : 1;
          tmpM.makeScale(KEY_W * s, KEY_H * s, 1).setPosition(-keysW / 2 + (c + 0.5) * PITCH, kTop - (r + 0.5) * KROW, STYLE.zContent);
          caps.setMatrixAt(idx, tmpM);
          caps.setColorAt(idx, idx === pressedKey ? cPress : idx === hoverKey ? cHover : predicted.has(ch) ? cPred : ch === '\b' ? cSpecial : r === 0 ? cDigit : cBase);
        }
      }
      caps.commit(KEY_ROWS.length * COLS);
    }

    // ---- render ------------------------------------------------------------------------------------------
    function scopeLabel(): string {
      return tail(scope, 34);
    }
    function render(): void {
      const n = N();
      const first = Math.round(scroll);
      // field
      queryText.set(query ? tail(query, 34) : 'Type or say “find …”');
      (queryText as unknown as { color: string }).color = query ? theme.text : theme.textDim;
      layoutCaret();
      scopeText.set(scopeLabel());
      const waitedLong = waiting && now - firstSentAt > 0.7;
      statusText.set(waiting ? (items.length ? 'updating…' : waitedLong ? 'indexing…' : 'searching…')
        : resultsError ? '' : query ? `${items.length}${resultsPartial ? '+' : ''} match${items.length === 1 ? '' : 'es'}` : haveResults ? `${items.length} item${items.length === 1 ? '' : 's'}` : '');
      // message
      let msg = '';
      if (resultsError) msg = resultsError;
      else if (!items.length) {
        if (waiting && now - firstSentAt > 12) msg = "No reply from the 'files' source — is it running?";
        else if (waiting || !haveResults) msg = waitedLong ? `Indexing ${tail(scope, 30)} …\nthe first search of a big folder takes a few seconds` : '';
        else if (query) msg = `No ${filter === 'all' ? '' : `${filter} `}matches for “${truncate(query, 24)}”`;
        else msg = filter === 'folders' ? 'No pinned folders — type to search folders' : 'No recent files here';
      }
      message.set(msg);
      message.visible = !!msg;
      // rows
      const nameChars = Math.floor((W - 2 * PAD - 0.064 - 0.1) / (NAME_SIZE * 0.55));
      const subChars = Math.floor((W - 2 * PAD - 0.064 - 0.05) / (SUB_SIZE * 0.55));
      let nums = '', ages = '', head = 0, selRow = -1, hovRow = -1;
      const shownPath = pendingPreview || preview?.path || '';
      for (const t of heads) t.visible = false;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r], e = list[first + r];
        if (r) { nums += '\n'; ages += '\n'; }
        row.g.visible = !!e && e.kind === 'item';
        if (!e) continue;
        if (e.kind === 'head') {
          const t = heads[head++];
          if (t) {
            t.set(e.label);
            t.position.set(-W / 2 + PAD + 0.006, listTop - (r + 0.5) * ROW - 0.004, STYLE.zText);
            t.visible = true;
          }
          continue;
        }
        const hit = e.hit;
        const [icon, color] = iconFor(hit);
        setIcon(T, row.icon, icon);
        (row.icon.material as THREE.MeshBasicMaterial).color.set(color);
        const shown = truncate(hit.name, nameChars);
        row.name.set(shown);
        setColorRanges(row.name, query ? highlightRanges(matchIndices(hit.name, query), hex.text, hex.accent, shown.length < hit.name.length ? shown.length - 1 : Infinity) : null);
        const folder = relFolder(hit.display || hit.path, scope);
        row.sub.set(tail(folder ? `${folder}/` : `${scope.split('/').pop() || scope}/`, subChars));
        nums += String(e.n);
        ages += hit.type === 'dir' ? 'folder' : ageLabel(hit.mtime);
        const hovered = hoverPart === `row:${r}` || hoverPart === `pin:${r}`;
        row.pin.visible = e.pinned || hovered;
        row.pinMat.color.set(e.pinned ? theme.accent2 : hoverPart === `pin:${r}` ? theme.text : theme.textDim);
        if (shownPath && hit.path === shownPath) selRow = r;
        if (hovered) hovRow = r;
      }
      numCol.set(nums);
      ageCol.set(ages);
      selPlate.visible = selRow >= 0;
      if (selRow >= 0) selPlate.position.set(0, listTop - (selRow + 0.5) * ROW, STYLE.zContent);
      hoverPlate.visible = hovRow >= 0 && hovRow !== selRow;
      if (hovRow >= 0) hoverPlate.position.set(0, listTop - (hovRow + 0.5) * ROW, STYLE.zContent);
      const over = list.length > n;
      track.visible = thumb.visible = over;
      if (over) {
        const rh = n * ROW - 0.01, th = Math.max(0.02, (rh * n) / list.length);
        thumb.scale.set(0.003, th, 1);
        thumb.position.y = listTop - 0.005 - th / 2 - (first / (list.length - n)) * (rh - th);
      }
      // deck
      if (deck) {
        for (let i = 0; i < chips.length; i++) {
          const s = suggestions[i];
          chips[i].g.visible = !!s;
          if (!s) continue;
          chips[i].label.set(truncate(s.label, 15));
          setIcon(T, chips[i].icon, s.icon);
        }
        stripHint.set(suggestions.length ? '' : query ? '' : 'recent searches appear here · pinch a result to open');
        stripHint.visible = !suggestions.length;
        const fi = FILTERS.findIndex((f) => f.id === filter);
        const fp = plates.get(`filter:${filter}`);
        filterPlate.visible = fi >= 0 && !!fp;
        if (fp) filterPlate.position.set(fp.position.x, fp.position.y, STYLE.zOverlay);
      }
      renderPreview();
    }

    function layoutCaret(): void {
      const shown = query ? tail(query, 34) : '';
      const w = shown ? textSize(queryText, { text: shown, size: 0.024 }).width : 0;
      caret.position.x = shown ? queryX + w + 0.004 : queryX - 0.005;
    }

    // ---- preview -----------------------------------------------------------------------------------------
    let previewKey = '';
    let previewBody: Text | null = null, previewNums: Text | null = null, previewPin: THREE.Mesh | null = null;
    let hlLines: string[] = [], hlSpans: Span[][] = [], hlLang = '';
    let imageTex: THREE.Texture | null = null;
    const previewLines = () => Math.max(5, Math.floor((cardH - 2 * PAD - 0.062) / (PV_SIZE * 1.25)));
    function renderPreview(): void {
      const key = preview ? `${preview.path}|${preview.type}|${preview.src ?? ''}|${preview.text?.length ?? 0}|${cardH}` : '';
      if (key !== previewKey) {
        previewKey = key;
        if (previewGroup) disposeTree(previewGroup);
        previewGroup = null;
        previewBody = previewNums = previewPin = null;
        imageTex?.dispose();
        imageTex = null;
        if (preview?.type === 'text') {
          const lang = languageFor(preview.name);
          hlLines = (preview.text ?? '').replace(/\t/g, '  ').split('\n');
          hlSpans = highlight(hlLines.join('\n'), lang);
          hlLang = lang?.id ?? '';
        } else { hlLines = []; hlSpans = []; hlLang = ''; }
        if (preview) buildPreview(preview);
      }
      if (!preview) return;
      if (previewPin) {
        const pinned = readPins(ctx.props.pins).some((p) => p.path === preview!.path);
        (previewPin.material as THREE.MeshBasicMaterial).color.set(pinned ? theme.accent2 : theme.text);
      }
      if (preview.type === 'text' && previewBody && previewNums) {
        const visible = previewLines();
        const from = Math.min(Math.max(0, Math.round(textScroll)), Math.max(0, hlLines.length - visible));
        textScroll = from;
        const lines = hlLines.slice(from, from + visible);
        const cols = Math.floor((PREVIEW_W - 0.07) / (PV_SIZE * 0.6));
        const shown = lines.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
        previewBody.set(shown.join('\n'));
        const clips = shown.map((l, i) => (l.length < lines[i].length ? l.length - 1 : l.length));
        setColorRanges(previewBody, hlLang ? colorRanges(hlSpans.slice(from, from + visible), shown.map((l) => l.length), syntaxInts, hex.text, clips) : null);
        previewNums.set(lines.map((_, i) => String(from + i + 1)).join('\n'));
      }
    }

    function buildPreview(p: Preview): void {
      const g = (previewGroup = new T.Group());
      const w = PREVIEW_W, h = cardH;
      g.position.set(W / 2 + 0.014 + w / 2, 0, 0);
      g.add(ctx.ui.panel(w, h));
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD, top = h / 2 - PAD;
      const [icon, color] = iconFor({ type: 'file', ext: extOf(p.name) });
      const ic = makeIcon(ctx, icon, { size: 0.024, color });
      ic.position.set(x0 + 0.014, top - 0.02, STYLE.zText);
      const title = makeText(ctx, truncate(p.name, 36), { size: 0.017, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.034, top - 0.012, STYLE.zText);
      const age = ageLabel(p.mtime ?? null);
      const metaStr = [p.size != null ? formatBytes(p.size) : '', age ? (age === 'now' ? 'modified just now' : /^\d+[mhd]$/.test(age) ? `modified ${age} ago` : `modified ${age}`) : '',
        p.type === 'text' ? `${p.lines ?? hlLines.length} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join(' · ');
      const meta = makeText(ctx, metaStr, { size: 0.011, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.034, top - 0.033, STYLE.zText);
      g.add(ic, title, meta);
      roundButton(g, 'btn:close', 'x', x1 - 0.018, top - 0.02, 0.036);
      roundButton(g, 'btn:ask', 'message-square', x1 - 0.06, top - 0.02, 0.036);
      previewPin = roundButton(g, 'btn:pinpreview', 'pin', x1 - 0.102, top - 0.02, 0.036);
      const bodyTop = top - 0.056, bodyH = h - 2 * PAD - 0.056;
      const rule = new T.Mesh(sharedGeometry(T, 'plane'), ctx.ui.material(theme.border));
      rule.scale.set(w - 2 * PAD, 0.0012, 1);
      rule.position.set(0, bodyTop + 0.007, STYLE.zContent);
      rule.raycast = () => {};
      g.add(rule);
      if (p.type === 'text') {
        previewNums = makeText(ctx, '', { size: PV_SIZE, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: 1.25 });
        previewNums.position.set(x0 + 0.026, bodyTop, STYLE.zText);
        previewBody = makeText(ctx, '', { size: PV_SIZE, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: 1.25 });
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
        }, undefined, () => ctx.error(`fb-launcher: could not load ${p.src}`));
      } else {
        const msg = p.type === 'binary' ? 'Binary file — no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
        const t = makeText(ctx, msg, { size: 0.014, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
        t.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
        g.add(t);
      }
      ctx.root.add(g);
    }

    // ---- data ----------------------------------------------------------------------------------------------
    function validHit(h: unknown): h is Hit {
      if (!h || typeof h !== 'object') return false;
      const o = h as Record<string, unknown>;
      if (typeof o.name !== 'string' || typeof o.path !== 'string') return false;
      if (typeof o.display !== 'string') o.display = o.path;
      if (typeof o.ext !== 'string') o.ext = extOf(o.name);
      if (o.type !== 'dir' && o.type !== 'link') o.type = 'file';
      return true;
    }

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(replyCh('search'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as SearchReply).kind !== 'search') return;
        const r = v as SearchReply;
        if (String(r.query ?? '') !== query.trim().toLowerCase()) return; // stale (an older keystroke)
        const mine = r.nonce === lastNonce;
        if (!mine && r.display !== scope && r.path !== scope) return; // another scope
        if (!Array.isArray(r.results) && !r.error) { ctx.error('fb-launcher: malformed search reply (no results array)'); return; }
        results = (Array.isArray(r.results) ? r.results : []).filter(validHit).slice(0, 500);
        resultsQuery = query;
        if (!query) recents = { scope: normScope(r.display || scope), hits: results };
        resultsPartial = !!r.partial;
        resultsError = typeof r.error === 'string' ? r.error : '';
        haveResults = true;
        waiting = false; // same scope + query: as good as our own reply (another client may have asked)
        if (typeof r.display === 'string' && r.display && r.display !== scope && mine) {
          scope = normScope(r.display); // adopt the source's canonical "~/…" form
          persist({ scope });
          sentKey = keyOf();
        }
        rebuildList();
      }));
      offs.push(ctx.channels.subscribe(replyCh('preview'), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as Preview).kind !== 'preview') return;
        const got = String((v as Preview).path ?? '');
        if (!pendingPreview || (got !== pendingPreview && !(pendingPreview.startsWith('~') && got.endsWith(pendingPreview.slice(1))))) return;
        preview = v as Preview;
        textScroll = 0;
        dirty = true;
      }));
      // control channel: ignore whatever it already holds (delivered synchronously inside subscribe)
      let primed = false;
      offs.push(ctx.channels.subscribe(ctlName(), (v: ChannelValue) => { if (primed) onCtl(v); }));
      primed = true;
    }

    function onCtl(v: unknown): void {
      const c = parseCtl(v);
      if (!c) return;
      if (c.entity && c.entity !== ctx.entityId) return;
      switch (c.cmd) {
        case 'query': setQuery(c.text, 0); break;
        case 'append': setQuery(query + c.text, 0); break;
        case 'backspace': setQuery(query.slice(0, -1)); break;
        case 'clear': setQuery(''); closePreview(); break;
        case 'open': openIndex(c.index); break;
        case 'pin': { const h = items[c.index - 1]; if (h) togglePin(h); break; }
        case 'scope': pushScope(c.path); break;
        case 'pop': popScope(); break;
        case 'filter': setFilter(c.filter); break;
        case 'close': closePreview(); break;
        case 'scroll': scrollBy(c.by); break;
        case 'ask': if (preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`); break;
      }
    }

    // ---- interaction -------------------------------------------------------------------------------------
    function setPressVis(part: string, on: boolean): void {
      const p = plates.get(part);
      if (p) p.scale.setScalar(on ? 0.92 : 1);
    }

    function tap(part: string): void {
      if (part.startsWith('row:')) {
        const e = list[Math.round(scroll) + Number(part.slice(4))];
        if (e?.kind === 'item') openHit(e.hit, true);
      } else if (part.startsWith('pin:')) {
        const e = list[Math.round(scroll) + Number(part.slice(4))];
        if (e?.kind === 'item') togglePin(e.hit);
      } else if (part.startsWith('chip:')) {
        const s = suggestions[Number(part.slice(5))];
        if (s) setQuery(s.value, 0);
      } else if (part.startsWith('filter:')) {
        const f = part.slice(7);
        if (isFilter(f)) setFilter(f === filter && f !== 'all' ? 'all' : f);
      } else if (part === 'btn:clear') { setQuery(''); }
      else if (part === 'btn:pop') popScope();
      else if (part === 'btn:close') closePreview();
      else if (part === 'btn:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
      else if (part === 'btn:pinpreview' && preview) {
        const p = preview;
        togglePin({ name: p.name, path: p.path, display: items.find((h) => h.path === p.path)?.display ?? p.path, type: 'file', size: null, mtime: null, ext: extOf(p.name) });
      }
    }

    function onHover(e: InteractionEvent): void {
      const part = e.objectName ?? '';
      if (e.phase === 'end') {
        if (part === hoverPart || !part) { hoverPart = ''; dirty = true; }
        if (hoverKey >= 0 && (part === 'kb' || !part)) { hoverKey = -1; keysDirty = true; }
        return;
      }
      if (part !== hoverPart) { hoverPart = part; dirty = true; }
      const k = part === 'kb' ? keyAt(e.localPoint) : -1;
      if (k !== hoverKey) { hoverKey = k; keysDirty = true; }
    }

    build();
    subscribe();
    rebuildList();

    return {
      onProps(p, prev) {
        if (p.rows !== prev.rows || p.keyboard !== prev.keyboard || p.tilt !== prev.tilt) { build(); previewKey = ''; }
        if (p.prefix !== prev.prefix || p.control !== prev.control) { subscribe(); sentKey = ''; schedule(0); }
        if (p.scope !== prev.scope && normScope(p.scope) !== scope) setScope(String(p.scope));
        if (p.filter !== prev.filter && isFilter(p.filter)) setFilter(p.filter);
        if (p.showHidden !== prev.showHidden) schedule(0);
        rebuildList();
      },
      onInput(port, v) {
        if (port === 'query' && (typeof v === 'string' || typeof v === 'number')) setQuery(normQuery(v, true), 0);
        else if (port === 'scope' && typeof v === 'string' && v.trim()) pushScope(v);
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') { onHover(e); return; }
        const lp = e.localPoint;
        const part = e.objectName ?? '';
        if (e.phase === 'start') {
          if (press && press.hand !== e.hand) return; // one press at a time (a same-hand start replaces a lost one)
          press = { hand: e.hand, part, x0: lp[0], y0: lp[1], scroll0: part === 'preview-text' ? textScroll : scroll, moved: false, key: -1, t0: now, repeats: 0 };
          if (part === 'kb') { press.key = keyAt(lp); pressedKey = press.key; keysDirty = true; }
          else setPressVis(part, true);
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          if (press.part === 'kb') {
            // sliding off the key cancels it (like a touchscreen keyboard)
            if (press.key >= 0 && keyAt(lp, 0.3, press.key) < 0) { press.key = -1; pressedKey = -1; keysDirty = true; }
            return;
          }
          const dy = lp[1] - press.y0;
          if (!press.moved && Math.hypot(lp[0] - press.x0, dy) > 0.018) { press.moved = true; setPressVis(press.part, false); }
          if (!press.moved) return;
          if (press.part.startsWith('row:') || press.part.startsWith('pin:')) {
            scroll = Math.min(Math.max(0, list.length - N()), Math.max(0, press.scroll0 + dy / ROW));
            dirty = true;
          } else if (press.part === 'preview-text') {
            textScroll = Math.max(0, press.scroll0 + dy / (PV_SIZE * 1.25));
            dirty = true;
          }
          return;
        }
        const p = press;
        press = null;
        setPressVis(p.part, false);
        if (p.part === 'kb') {
          pressedKey = -1;
          keysDirty = true;
          if (e.phase === 'end' && p.key >= 0 && p.repeats === 0) typeKey(p.key);
          return;
        }
        if (e.phase !== 'end' || p.moved) return; // cancelled presses and drags never act
        tap(p.part);
      },
      update(_dt, t) {
        now = t;
        if (dueAt >= 0 && t >= dueAt) sendSearch();
        // requests can get lost (busy shared request channel, source restart): re-ask after 3 s, 8 s, then every 10 s
        if (waiting && t - sentAt > (retries === 0 ? 3 : retries === 1 ? 8 : 10)) resend();
        const phase = waiting ? (t - firstSentAt > 12 ? 2 : t - firstSentAt > 0.7 ? 1 : 0) : -1;
        if (phase !== waitPhase) { waitPhase = phase; dirty = true; } // status: searching → indexing → offline
        if (press?.part === 'kb' && press.key === BKSP && t - press.t0 > 0.5 + press.repeats * 0.25) {
          press.repeats++;
          deleteWord();
        }
        const on = !query || Math.floor(t * 1.8) % 2 === 0;
        if (on !== caretOn) { caretOn = on; caret.visible = on; }
        if (watch.changed()) layoutCaret();
        if (keysDirty) refreshKeys();
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
