// Screenshots panel: mirror renders (POST /api/screenshot) of
//   user   — what the headset user sees (needs a primary xr client)
//   camera — the CURRENT desktop camera pose + FOV of the 3D view
//   entity — one entity (selection or picked) from a direction preset
//   widget — a widget alone in a studio scene, with props JSON
// plus size presets, hands / labels / background options, and widget
// thumbnails (POST /api/widgets/:id/thumbnail). Results go to an in-memory
// gallery (newest first): caption, time, open full size (lightbox, ←/→/Esc),
// download, copy the request. The toolbar's 'screenshot.myView' action
// captures the desktop camera view and opens this panel.

import { signal } from '@preact/signals';
import type { ScreenshotRequest } from '@evolspace/protocol';
import { useEffect } from 'preact/hooks';
import { definePanel, registerToolbarAction } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel } from '../entity.ts';
import { ColorField, JsonField, NumberField, SelectField, Switch } from '../ui/fields.tsx';
import { fmtBytes, fmtTime, prettyJson } from '../ui/format.ts';
import { copyText } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Button, Empty, IconButton, PanelBar, Row, Scroll } from '../ui/kit.tsx';
import { ensureCss } from './events/css.ts';
import {
  DEFAULT_FORM, DIRECTIONS, SIZES, buildRequest, cameraViewOf, captionOf, toSpace, type BuildEnv, type ShotForm, type ShotKind,
} from './screenshots/request.ts';
import { SHOTS_CSS } from './screenshots/styles.ts';

export interface Shot {
  id: string;
  ts: number;
  url: string;
  bytes: number;
  width?: number;
  height?: number;
  caption: string;
  kind: ShotKind | 'thumbnail' | 'my view';
  req?: ScreenshotRequest;
  ms: number;
}

const MAX_SHOTS = 60;
const form = signal<ShotForm>(DEFAULT_FORM);
const gallery = signal<Shot[]>([]);
const pending = signal<Array<{ id: string; label: string; since: number }>>([]);
const lightbox = signal<string | null>(null);
const lastNew = signal<string | null>(null);
let seq = 0;

const setForm = (patch: Partial<ShotForm>) => { form.value = { ...form.value, ...patch }; };

function addShot(s: Shot) {
  const next = [s, ...gallery.value];
  for (const old of next.splice(MAX_SHOTS)) URL.revokeObjectURL(old.url);
  gallery.value = next;
  lastNew.value = s.id;
}

function removeShot(id: string) {
  const s = gallery.value.find((x) => x.id === id);
  if (s) URL.revokeObjectURL(s.url);
  gallery.value = gallery.value.filter((x) => x.id !== id);
  if (lightbox.value === id) lightbox.value = null;
}

export function envOf(ctx: DebugContext): BuildEnv {
  const THREE = ctx.THREE;
  return {
    camera: cameraViewOf(ctx.camera, ctx.runtime.root),
    selection: ctx.store.selection.peek(),
    entityCenter: (id) => {
      const box = ctx.runtime.frameEntity(id);
      return box && !box.isEmpty() ? toSpace(box.getCenter(new THREE.Vector3()), ctx.runtime.root) : null;
    },
    viewport: ctx.client.viewportSize(),
  };
}

async function run(ctx: DebugContext, label: string, kind: Shot['kind'], fn: () => Promise<Blob>, meta: { caption: string; req?: ScreenshotRequest; width?: number; height?: number }): Promise<boolean> {
  const id = `shot-${++seq}`;
  const t0 = performance.now();
  pending.value = [{ id, label, since: Date.now() }, ...pending.value];
  try {
    const blob = await fn();
    addShot({ id, ts: Date.now(), url: URL.createObjectURL(blob), bytes: blob.size, kind, ms: Math.round(performance.now() - t0), ...meta });
    return true;
  } catch (e) {
    ctx.toast(`${label} failed: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    pending.value = pending.value.filter((p) => p.id !== id);
  }
}

export function capture(ctx: DebugContext, req: ScreenshotRequest, kind: Shot['kind'] = req.view.kind): Promise<boolean> {
  return run(ctx, `${kind} screenshot`, kind, () => ctx.api.screenshot(req), { caption: captionOf(req), req, width: req.width, height: req.height });
}

/** The toolbar action: the desktop camera's current view, through the mirror. */
export async function captureMyView(ctx: DebugContext): Promise<boolean> {
  const req = buildRequest({ ...DEFAULT_FORM, kind: 'camera', size: 'viewport', hands: false, labels: false, background: 'scene' }, envOf(ctx));
  if ('error' in req) { ctx.toast(req.error, 'error'); return false; }
  return capture(ctx, req, 'my view');
}

function thumbnail(ctx: DebugContext, widget: string, props: Record<string, unknown> | null) {
  return run(ctx, `${widget} thumbnail`, 'thumbnail', () => ctx.api.widgetThumbnail(widget, props ?? undefined),
    { caption: `thumbnail · ${widget} → library/widgets/${widget}/thumbnail.png` });
}

function download(s: Shot) {
  const a = document.createElement('a');
  const t = new Date(s.ts);
  const p = (x: number) => String(x).padStart(2, '0');
  a.href = s.url;
  a.download = `evolspace-${s.kind.replace(/\s+/g, '-')}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ form

const KINDS: Array<{ id: ShotKind; label: string; title: string }> = [
  { id: 'user', label: 'User', title: "The headset user's view (primary xr client pose + FOV)" },
  { id: 'camera', label: 'Camera', title: "The 3D view's current camera pose + FOV (space coordinates)" },
  { id: 'entity', label: 'Entity', title: 'Auto-framed view of one entity (and its children)' },
  { id: 'widget', label: 'Widget', title: 'A widget rendered alone in a neutral studio scene' },
];

function ShotFormView({ ctx }: { ctx: DebugContext }) {
  const f = form.value;
  const sel = ctx.store.selectedEntity.value;
  const ents = Object.values(ctx.store.scene.value.entities);
  const catalog = Object.values(ctx.store.catalog.value).filter((m) => !m.error).map((m) => m.id).sort();
  const headset = ctx.store.headset.value.connected;
  const busy = pending.value.length > 0;
  const go = () => {
    const req = buildRequest(f, envOf(ctx));
    if ('error' in req) { ctx.toast(req.error, 'warn'); return; }
    void capture(ctx, req);
  };
  const copyReq = () => {
    const req = buildRequest(f, envOf(ctx));
    void copyText(prettyJson(req)).then((ok) => ctx.toast(ok ? 'Request JSON copied' : 'Clipboard unavailable', ok ? 'info' : 'warn'));
  };
  const entityId = f.entity ?? sel?.id ?? null;
  return (
    <div class="dbg-shot-form">
      <Scroll>
        <Row label="View">
          <div class="dbg-seg">
            {KINDS.map((k) => (
              <button key={k.id} type="button" class={f.kind === k.id ? 'on' : ''} title={k.title}
                onClick={() => setForm({ kind: k.id, hands: k.id === 'user' ? true : k.id === 'widget' ? false : f.hands })}>{k.label}</button>
            ))}
          </div>
        </Row>
        {f.kind === 'user' && !headset ? <div class="hint warn">No headset connected — the server answers 409 without a user pose.</div> : null}
        {f.kind === 'camera' ? <div class="hint">Uses the 3D view's current camera pose and FOV. Fly there first (RMB + WASD).</div> : null}
        {f.kind === 'entity' ? (
          <Row label="Entity">
            <SelectField value={f.entity ?? '__sel'} title="Subject"
              options={[{ value: '__sel', label: sel ? `selection · ${entityLabel(sel)} (${sel.id})` : 'selection (none)' },
                ...ents.map((e) => ({ value: e.id, label: `${entityLabel(e)} · ${e.id}` }))]}
              onChange={(v) => setForm({ entity: v === '__sel' ? null : v })} />
          </Row>
        ) : null}
        {f.kind === 'widget' ? (
          <>
            <Row label="Widget">
              <SelectField value={f.widget} placeholder="pick a widget" options={catalog.map((id) => ({ value: id }))} onChange={(v) => setForm({ widget: v })} />
            </Row>
            <Row label="Props" class="top" title="Widget props (JSON object), optional">
              <JsonField value={f.widgetProps ?? {}} rows={4} onCommit={(v) => {
                if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) { ctx.toast('props must be a JSON object', 'error'); return; }
                setForm({ widgetProps: (v as Record<string, unknown>) ?? null });
              }} />
            </Row>
          </>
        ) : null}
        {f.kind === 'entity' || f.kind === 'widget' ? (
          <Row label="Direction" title="Subject → camera direction">
            <SelectField value={f.direction}
              options={Object.entries(DIRECTIONS).filter(([k]) => f.kind === 'entity' || k !== 'camera').map(([value, d]) => ({ value, label: d.label }))}
              onChange={(v) => setForm({ direction: v })} />
            {f.kind === 'entity' ? <NumberField value={f.padding} step={0.01} min={0} max={0.45} title="Padding (fraction kept on each side)" label="P" onChange={(v) => setForm({ padding: v })} /> : null}
          </Row>
        ) : null}
        <Row label="Size">
          <SelectField value={f.size} options={Object.entries(SIZES).map(([value, s]) => ({ value, label: s.label }))} onChange={(v) => setForm({ size: v })} />
        </Row>
        {f.size === 'custom' ? (
          <Row label="">
            <div class="wh">
              <NumberField value={f.width} integer min={16} max={4096} label="W" onChange={(v) => setForm({ width: v })} />
              <span class="x">×</span>
              <NumberField value={f.height} integer min={16} max={4096} label="H" onChange={(v) => setForm({ height: v })} />
            </div>
          </Row>
        ) : null}
        <Row label="Overlays">
          <div class="sw">
            <Switch checked={f.hands} label="hands" title="Ghost hands at the user's tracked hand poses" onChange={(v) => setForm({ hands: v })} />
            <Switch checked={f.labels} label="labels" title="Entity ids / names as labels" onChange={(v) => setForm({ labels: v })} />
          </div>
        </Row>
        <Row label="Background">
          <SelectField value={f.background} options={[{ value: 'scene', label: 'scene' }, { value: 'transparent', label: 'transparent' }, { value: 'color', label: 'color' }]}
            onChange={(v) => setForm({ background: v as ShotForm['background'] })} />
          {f.background === 'color' ? <ColorField value={f.color} onChange={(v) => setForm({ color: v })} /> : null}
        </Row>
      </Scroll>
      <div class="go">
        <Button primary icon="camera" onClick={go} title="POST /api/screenshot"
          disabled={(f.kind === 'entity' && !entityId) || (f.kind === 'widget' && !f.widget)}>{busy ? 'Capture (busy…)' : 'Capture'}</Button>
        {f.kind === 'widget' ? (
          <Button icon="image" disabled={!f.widget} title={`Render + save library/widgets/${f.widget || '<id>'}/thumbnail.png (POST /api/widgets/:id/thumbnail)`}
            onClick={() => void thumbnail(ctx, f.widget, f.widgetProps)}>Thumbnail</Button>
        ) : null}
        <IconButton icon="code" title="Copy the request JSON" onClick={copyReq} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ gallery

function Card({ s, fresh }: { s: Shot; fresh: boolean }) {
  return (
    <div class={`dbg-shot-card${fresh ? ' new' : ''}`}>
      <div class="dbg-shot-img" onClick={() => { lightbox.value = s.id; }} title="Open full size">
        <img src={s.url} alt={s.caption} loading="lazy" />
      </div>
      <span class="tag">{s.kind}</span>
      <div class="acts">
        <IconButton icon="external" class="sm" title="Open full size" onClick={() => { lightbox.value = s.id; }} />
        <IconButton icon="save" class="sm" title="Download PNG" onClick={() => download(s)} />
        <IconButton icon="trash" class="sm" danger title="Remove from the gallery" onClick={() => removeShot(s.id)} />
      </div>
      <div class="meta">
        <span class="cap" title={s.caption}>{s.caption}</span>
        <span class="sub"><span>{fmtTime(s.ts).slice(0, 8)}</span><span>{fmtBytes(s.bytes)}</span><span>{s.ms} ms</span></span>
      </div>
    </div>
  );
}

function Lightbox({ ctx }: { ctx: DebugContext }) {
  const list = gallery.value;
  const i = list.findIndex((s) => s.id === lightbox.value);
  const s = list[i];
  useEffect(() => {
    if (!s) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); lightbox.value = null; }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); lightbox.value = list[i - 1].id; }
      else if (e.key === 'ArrowRight' && i < list.length - 1) { e.preventDefault(); lightbox.value = list[i + 1].id; }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [s?.id, i, list.length]);
  if (!s) return null;
  return (
    <div class="dbg-shot-lb" onClick={(e) => { if (e.target === e.currentTarget) lightbox.value = null; }}>
      <img src={s.url} alt={s.caption} />
      <div class="bar">
        <span class="dbg-count">{i + 1}/{list.length}</span>
        <span class="cap">{s.caption}</span>
        <span class="dbg-count">{new Date(s.ts).toLocaleTimeString()} · {fmtBytes(s.bytes)}</span>
        <Button small icon="save" onClick={() => download(s)}>Download</Button>
        <Button small icon="external" onClick={() => window.open(s.url, '_blank')}>New tab</Button>
        {s.req ? <Button small icon="code" onClick={() => void copyText(prettyJson(s.req)).then((ok) => ctx.toast(ok ? 'Request JSON copied' : 'Clipboard unavailable'))}>Request</Button> : null}
      </div>
      {i > 0 ? <button type="button" class="nav prev" title="Newer (←)" onClick={() => { lightbox.value = list[i - 1].id; }}><Icon name="chevronRight" size={20} style={{ transform: 'rotate(180deg)' }} /></button> : null}
      {i < list.length - 1 ? <button type="button" class="nav next" title="Older (→)" onClick={() => { lightbox.value = list[i + 1].id; }}><Icon name="chevronRight" size={20} /></button> : null}
      <IconButton icon="x" class="close" title="Close (Esc)" onClick={() => { lightbox.value = null; }} />
    </div>
  );
}

function Gallery() {
  const list = gallery.value;
  const pend = pending.value;
  if (!list.length && !pend.length) {
    return (
      <Empty icon="image" title="No screenshots yet">
        Capture one on the left, or click <Icon name="camera" size={12} style={{ display: 'inline', verticalAlign: '-2px' }} /> in the toolbar to grab the current 3D view through the mirror.
      </Empty>
    );
  }
  return (
    <Scroll>
      <div class="dbg-shot-grid">
        {pend.map((p) => (
          <div key={p.id} class="dbg-shot-card">
            <div class="dbg-shot-pending"><span class="dbg-shot-spin" />{p.label}…</div>
            <div class="meta"><span class="cap">rendering in the mirror</span><span class="sub">{fmtTime(p.since).slice(0, 8)}</span></div>
          </div>
        ))}
        {list.map((s) => <Card key={s.id} s={s} fresh={s.id === lastNew.value} />)}
      </div>
    </Scroll>
  );
}

function ScreenshotsPanel({ ctx }: PanelProps) {
  ensureCss('screenshots', SHOTS_CSS);
  const n = gallery.value.length;
  return (
    <div class="dbg-shot">
      <ShotFormView ctx={ctx} />
      <div class="dbg-shot-gal">
        <PanelBar>
          <span class="dbg-sub" style={{ margin: 0 }}>Gallery</span>
          <span class="dbg-count">{n} image{n === 1 ? '' : 's'} · in memory, newest first</span>
          <span class="grow" />
          <Button small icon="camera" title="Capture the 3D view's camera (same as the toolbar button)" onClick={() => void captureMyView(ctx)}>My view</Button>
          <IconButton icon="trash" class="sm" danger title="Clear the gallery" disabled={!n}
            onClick={() => { for (const s of gallery.value) URL.revokeObjectURL(s.url); gallery.value = []; }} />
        </PanelBar>
        <Gallery />
      </div>
      <Lightbox ctx={ctx} />
    </div>
  );
}

export default definePanel({
  id: 'screenshots',
  title: 'Screenshots',
  dock: 'bottom',
  order: 50,
  icon: 'image',
  component: ScreenshotsPanel,
  init: (ctx) => registerToolbarAction({
    id: 'screenshot.myView',
    title: 'Screenshot my view (the 3D view’s camera, rendered by the mirror) → Screenshots panel',
    icon: 'camera',
    order: 30,
    active: () => pending.value.length > 0,
    run: async (c) => {
      c.layout.show('screenshots');
      await captureMyView(c);
    },
  }),
  badge: () => (pending.value.length ? '…' : gallery.value.length || null),
});

/** Tests only. */
export const __shotsState = { form, gallery, pending, lightbox };
