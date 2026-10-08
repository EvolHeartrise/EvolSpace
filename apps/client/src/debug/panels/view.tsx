// View panel — debug overlays & camera (dock: right).
//   - Overlay toggles (ctx.overlays) for the overlays in ../overlays-impl/:
//     bounds, labels, axes, interactive parts, hand rays, links, headset user,
//     wireframe — plus the runtime floor grid (grid.toggle).
//   - Camera: follow the headset (smoothed, FOV fitted, letterboxed; Esc or a
//     movement key exits), jump to the headset view, frame selection / all,
//     position / rotation readout, copy as a ScreenshotView 'camera' JSON,
//     FOV / near / far.
//   - Renderer stats: fps, frame ms (sparkline), draw calls, triangles,
//     geometries / textures / programs, JS heap; per-entity cost on demand.

import * as THREE from 'three';
import { useEffect, useState } from 'preact/hooks';
import { definePanel, registerOverlay } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel } from '../entity.ts';
import { NumberField, SliderField, Switch } from '../ui/fields.tsx';
import { fmtNum } from '../ui/format.ts';
import { copyText, useNeed, usePoll } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Button, IconButton, Row, Scroll, Section } from '../ui/kit.tsx';
import { injectPanelsCss } from '../overlays-impl/css.ts';
import { OVERLAYS, OVERLAY_SWATCH } from '../overlays-impl/index.ts';
import { FollowHeadset, cameraView, followHalfLife, following } from './view/camera.ts';
import { StatsSampler, measureEntities, stats, type EntityCost } from './view/stats.ts';

let follow: FollowHeadset | null = null;

// ------------------------------------------------------------------ overlays

function OverlayList({ ctx }: { ctx: DebugContext }) {
  const defs = ctx.overlays.defs.value;
  const on = ctx.overlays.enabled.value;
  const grid = usePoll(() => ctx.runtime.environment.grid, 500, [ctx]);
  const [gridLocal, setGridLocal] = useState<boolean | null>(null);
  const gridOn = gridLocal ?? grid;
  useEffect(() => { setGridLocal(null); }, [grid]);
  const mine = new Set(OVERLAYS.map((o) => o.id));
  const ordered = [...defs.filter((d) => mine.has(d.id)), ...defs.filter((d) => !mine.has(d.id))];
  return (
    <div>
      {ordered.map((d) => (
        <div key={d.id} class={`vw-ov${on.has(d.id) ? '' : ' off'}`} data-overlay={d.id}>
          <span class="sw" style={{ background: OVERLAY_SWATCH[d.id] ?? 'var(--faint)' }} />
          <span class="tx"><div class="t">{d.title}</div>{d.description ? <div class="d" title={d.description}>{d.description}</div> : null}</span>
          <Switch checked={on.has(d.id)} onChange={(v) => ctx.overlays.setEnabled(d.id, v)} title={`${on.has(d.id) ? 'Hide' : 'Show'} ${d.title}`} />
        </div>
      ))}
      <div class={`vw-ov${gridOn ? '' : ' off'}`} data-overlay="grid">
        <span class="sw" style={{ background: '#5d697b' }} />
        <span class="tx"><div class="t">Floor grid</div><div class="d">Runtime environment grid (grid.toggle; also in the toolbar)</div></span>
        <Switch checked={gridOn} onChange={(v) => { setGridLocal(v); ctx.actions.command('grid.toggle', { visible: v }); }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ camera

const RAD2DEG = 180 / Math.PI;

function CameraTools({ ctx }: { ctx: DebugContext }) {
  useNeed(ctx, 'userPose');
  const pose = ctx.store.userPose.value;
  const isFollowing = following.value;
  const cam = usePoll(() => {
    const c = ctx.camera;
    const e = new THREE.Euler().setFromQuaternion(c.quaternion, 'YXZ');
    return { p: c.position.toArray().map((v) => fmtNum(v, 3)), yaw: e.y * RAD2DEG, pitch: e.x * RAD2DEG, roll: e.z * RAD2DEG, fov: c.fov, near: c.near, far: c.far };
  }, 150, [ctx]);
  const setCam = (patch: Partial<Pick<THREE.PerspectiveCamera, 'fov' | 'near' | 'far'>>) => {
    Object.assign(ctx.camera, patch);
    ctx.camera.updateProjectionMatrix();
  };
  const copyView = () => {
    const v = cameraView(ctx.camera, ctx.runtime.root);
    void copyText(JSON.stringify(v)).then((ok) => ctx.toast(ok ? 'Copied ScreenshotView camera JSON' : 'Clipboard unavailable', ok ? 'info' : 'warn'));
  };
  return (
    <>
      {isFollowing ? (
        <div class="vw-follow">
          <Icon name="headset" size={14} /> Following the headset{pose ? '' : ' (waiting for a pose…)'}
          <span style={{ flex: 1 }} />
          <span class="dbg-kbd">Esc</span>
          <Button small onClick={() => follow?.stop()}>Stop</Button>
        </div>
      ) : null}
      <div class="vw-btns">
        <Button small primary={isFollowing} icon="headset" disabled={!pose && !isFollowing}
          title={pose ? 'Lock the desktop camera to the headset head pose (smoothed). Esc or a movement key exits.' : 'No headset pose (connect a headset)'}
          onClick={() => (isFollowing ? follow?.stop() : follow?.start())}>Follow headset</Button>
        <Button small icon="view" disabled={!pose} title="Jump once to the headset's eye position and view direction"
          onClick={() => { if (!follow?.jump()) ctx.toast('No headset pose', 'warn'); }}>Jump to headset</Button>
        <Button small icon="target" disabled={!ctx.store.selection.value} title="Frame the selection (F)" onClick={() => ctx.actions.frame()}>Frame sel.</Button>
        <Button small icon="crosshair" title="Frame everything (Shift+F)" onClick={() => ctx.actions.frameAll()}>Frame all</Button>
      </div>
      <Row label="Position" title="world coordinates (m)"><span class="dbg-mono">{cam.p.join(', ')}</span></Row>
      <Row label="Yaw / pitch / roll"><span class="dbg-mono">{cam.yaw.toFixed(1)}°, {cam.pitch.toFixed(1)}°, {cam.roll.toFixed(1)}°</span>
        <span style={{ flex: 1 }} /><IconButton icon="copy" class="sm" title="Copy as ScreenshotView 'camera' JSON (space coords) — for /api/screenshot" onClick={copyView} /></Row>
      <Row label="FOV (vertical)"><SliderField value={Math.round(cam.fov * 10) / 10} min={15} max={120} step={0.5} disabled={isFollowing} onChange={(v) => setCam({ fov: v })} /></Row>
      <Row label="Near / far">
        <NumberField label="n" value={cam.near} step={0.005} min={0.001} max={10} onChange={(v) => setCam({ near: Math.min(v, ctx.camera.far - 0.01) })} />
        <NumberField label="f" value={cam.far} step={1} min={1} max={10000} onChange={(v) => setCam({ far: Math.max(v, ctx.camera.near + 0.01) })} />
      </Row>
      <Row label="Smoothing" title="Half-life of the follow smoothing (s); 0 = locked"><SliderField value={followHalfLife.value} min={0} max={0.5} step={0.01} onChange={(v) => { followHalfLife.value = v; }} /></Row>
      {pose ? (
        <Row label="Headset" dim><span class="dbg-mono dim">{pose.head.position.map((v) => fmtNum(v, 2)).join(', ')} · {pose.fov ? `${fmtNum(pose.fov, 1)}° × ${fmtNum(pose.aspect ?? 1, 2)}` : 'fov ?'} · {pose.mode}</span></Row>
      ) : <Row label="Headset" dim><span class="dbg-dim">not connected</span></Row>}
    </>
  );
}

// ------------------------------------------------------------------ stats

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 300, H = 34;
  const max = Math.max(33.4, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join(' ');
  const y16 = H - (16.7 / max) * (H - 2) - 1;
  return (
    <svg class="vw-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={y16} y2={y16} stroke="rgba(69,212,155,.35)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" />
      <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function Stat({ k, v, title }: { k: string; v: preact.ComponentChildren; title?: string }) {
  return <div class="vw-stat" title={title}><div class="k">{k}</div><div class="v">{v}</div></div>;
}

function RendererStats({ ctx }: { ctx: DebugContext }) {
  useEffect(() => {
    const s = new StatsSampler(ctx);
    return () => s.dispose();
  }, [ctx]);
  const st = stats.value;
  const [costs, setCosts] = useState<EntityCost[] | null>(null);
  if (!st) return <div class="dbg-dim">Sampling…</div>;
  const ents = ctx.store.scene.value.entities;
  return (
    <>
      <div class="vw-stats">
        <Stat k="fps" v={<>{st.fps.toFixed(0)}</>} />
        <Stat k="frame ms" v={<>{st.avgMs.toFixed(1)} <small>max {st.maxMs.toFixed(0)}</small></>} title="frame interval (rAF), last ~60 frames" />
        <Stat k="draw calls" v={st.calls} />
        <Stat k="triangles" v={big(st.triangles)} title={`${st.triangles} triangles · ${st.lines} lines · ${st.points} points`} />
        <Stat k="geo / tex" v={<>{st.geometries} <small>/ {st.textures}</small></>} title="geometries / textures in GPU memory" />
        <Stat k="JS heap" v={st.heapMB !== null ? <>{st.heapMB.toFixed(0)} <small>MB</small></> : '—'} title={st.heapLimitMB ? `limit ${st.heapLimitMB.toFixed(0)} MB` : 'not available in this browser'} />
      </div>
      <Sparkline values={st.history} />
      <div class="hx-kv" style={{ marginTop: '4px' }}>
        <span>programs <b>{st.programs}</b></span>
        <span style={{ flex: 1 }} />
        <Button small icon="refresh" title="Count draw objects and triangles of every entity's own content" onClick={() => setCosts(measureEntities(ctx))}>Per-entity cost</Button>
      </div>
      {costs ? (
        <table class="vw-cost">
          <tbody>
            {costs.slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td class="n" title={`${c.id} — click to select`} onClick={() => ctx.actions.select(c.id)}>{ents[c.id] ? entityLabel(ents[c.id]) : c.id} <span class="dbg-mono dim">{c.id}</span></td>
                <td class="num" title="draw objects">{c.objects} obj</td>
                <td class="num" title="triangles">{big(c.triangles)} tri</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ panel

function ViewPanel({ ctx }: PanelProps) {
  const n = ctx.overlays.enabled.value.size;
  return (
    <Scroll class="vw-panel">
      <Section id="view.overlays" title="Overlays" count={n || undefined}
        actions={<IconButton icon="eyeOff" class="sm" title="All overlays off" onClick={() => { for (const id of ctx.overlays.enabled.peek()) ctx.overlays.setEnabled(id, false); }} />}>
        <OverlayList ctx={ctx} />
      </Section>
      <Section id="view.camera" title="Camera" actions={following.value ? <Badge kind="ok">following</Badge> : null}>
        <CameraTools ctx={ctx} />
      </Section>
      <Section id="view.stats" title="Renderer">
        <RendererStats ctx={ctx} />
      </Section>
    </Scroll>
  );
}

function init(ctx: DebugContext): () => void {
  const offCss = injectPanelsCss();
  const offs = OVERLAYS.map((o) => registerOverlay(o));
  follow = new FollowHeadset(ctx);
  return () => {
    follow?.dispose();
    follow = null;
    for (const o of offs) o();
    offCss();
  };
}

export default definePanel({
  id: 'view',
  title: 'View',
  dock: 'right',
  order: 20,
  icon: 'view',
  component: ViewPanel,
  init,
  badge: () => (following.value ? 'follow' : null),
});
