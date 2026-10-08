// Hands panel building blocks: per-hand simulator card, feature table with
// condition bands, poses → bindings explanation, pose recorder and the
// read-only pose / binding library.

import { Fragment } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { FeatureCondition, Finger, HandFeatures, Handedness, InteractionBinding, PoseDef } from '@evolspace/protocol';
import { FEATURE_NAMES, derivePose, featureInfo } from '@evolspace/input';
import type { DebugContext } from '../../types.ts';
import type { GesturesInfo } from '../../api.ts';
import { SelectField, Switch, TextField, Vec3Field, NumberField } from '../../ui/fields.tsx';
import { fmtNum, prettyJson } from '../../ui/format.ts';
import { copyText } from '../../ui/hooks.ts';
import { Icon } from '../../ui/icons.tsx';
import { Badge, Button, IconButton, Row } from '../../ui/kit.tsx';
import { entityLabel } from '../../entity.ts';
import { describeAction, type Considered } from './explain.ts';
import { simHeld, simState, patchSim, type HandSimState } from './driver.ts';
import { gestureDefs, type HandLive } from './live.ts';
import { LONG, ORIENTS, ORIENT_IDS, RELAXED_SHAPE, SIM_FINGERS, cloneShape, solvePose, type LongFinger, type OrientId, type SimShape } from './solver.ts';

const HAND_LABEL: Record<Handedness, string> = { left: 'Left', right: 'Right' };

// ------------------------------------------------------------------ helpers

export function condText(c: FeatureCondition): string {
  const f = (v: number) => fmtNum(v, 3);
  if (c.min !== undefined && c.max !== undefined) return `${c.feature} ${f(c.min)}…${f(c.max)}`;
  if (c.min !== undefined) return `${c.feature} ≥ ${f(c.min)}`;
  if (c.max !== undefined) return `${c.feature} ≤ ${f(c.max)}`;
  return c.feature;
}

function entityName(ctx: DebugContext, id: string | undefined | null): string {
  if (!id) return '—';
  const e = ctx.store.scene.peek().entities[id];
  return e ? entityLabel(e) : id;
}

export function poseById(id: string): PoseDef | undefined {
  return gestureDefs.peek()?.poses.find((p) => p.id === id);
}

/** Load a preset (pose id or 'relaxed') into a hand: solve the pose, report if it could not be satisfied. */
export function loadPreset(ctx: DebugContext, hand: Handedness, preset: string): void {
  if (preset === 'relaxed') { patchSim(hand, { preset, shape: cloneShape(RELAXED_SHAPE), solve: null }); return; }
  if (preset === 'custom') { patchSim(hand, { preset }); return; }
  const pose = poseById(preset);
  if (!pose) { ctx.toast(`Unknown pose '${preset}'`, 'warn'); return; }
  const r = solvePose(pose, hand, { poses: gestureDefs.peek()?.poses ?? [] });
  patchSim(hand, { preset, shape: r.shape, solve: r });
  if (!r.ok) ctx.toast(`Could not fully satisfy '${preset}' for the ${hand} hand — closest shape loaded; adjust it manually.`, 'warn');
}

function Seg<T extends string>(p: { value: T; options: Array<{ value: T; label: string; title?: string }>; onChange: (v: T) => void }) {
  return (
    <span class="hx-seg">
      {p.options.map((o) => (
        <button key={o.value} type="button" class={o.value === p.value ? 'on' : ''} title={o.title} onClick={() => p.onChange(o.value)}>{o.label}</button>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ simulator card

const fingersOpen = signal<Record<Handedness, boolean>>({ left: false, right: false });

function HoldButton({ hand, label }: { hand: Handedness; label: string }) {
  const held = simHeld[hand].value;
  const release = () => { simHeld[hand].value = false; };
  useEffect(() => {
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('blur', release); release(); };
  }, [hand]);
  return (
    <button type="button" class={`hx-hold${held ? ' on' : ''}`} title="Pose is applied only while you hold this button"
      onPointerDown={(e) => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); simHeld[hand].value = true; }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>
      <Icon name="hand" size={13} />{held ? `Holding ${label}` : `Hold ${label}`}
    </button>
  );
}

function FingerSliders({ hand, st }: { hand: Handedness; st: HandSimState }) {
  const s = st.shape;
  const edit = (fn: (x: SimShape) => void) => {
    const n = cloneShape(s);
    fn(n);
    patchSim(hand, { shape: n, preset: 'custom', solve: null });
  };
  const auto = (f: Finger) => f === s.pinch || (f === 'thumb' && (!!s.pinch || s.thumb === 'wrap'));
  return (
    <>
      <div class="hx-fingers">
        {SIM_FINGERS.map((f) => (
          <Fragment key={f}>
            <label key={`l${f}`} title={`curl.${f}`}>{f}</label>
            <input key={`r${f}`} type="range" min={0} max={1} step={0.01} value={s.curl[f]} disabled={auto(f)}
              title={auto(f) ? 'chosen by the hand model (pinch / thumb wrap)' : `curl.${f}`}
              onInput={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); edit((x) => { x.curl[f] = v; }); }} />
            <span key={`v${f}`} class={`v${auto(f) ? ' auto' : ''}`}>{auto(f) ? 'auto' : s.curl[f].toFixed(2)}</span>
          </Fragment>
        ))}
      </div>
      <Row label="Pinch" title="Finger the thumb tip touches">
        <SelectField value={s.pinch ?? 'none'} options={[{ value: 'none', label: 'none' }, ...LONG.map((f) => ({ value: f, label: `thumb ↔ ${f}` }))]}
          onChange={(v) => edit((x) => { x.pinch = v === 'none' ? null : v as LongFinger; })} />
        <NumberField value={s.pinchGap} step={0.001} min={0.002} max={0.05} title="pinch gap (m)" disabled={!s.pinch}
          onChange={(v) => edit((x) => { x.pinchGap = v; })} />
      </Row>
      <Row label="Thumb">
        <Seg value={s.thumb} options={[{ value: 'free', label: 'free' }, { value: 'wrap', label: 'wrap', title: 'Thumb wrapped over the fingers (fist)' }]}
          onChange={(v) => edit((x) => { x.thumb = v; })} />
        <NumberField label="∠" value={s.thumbSpread} step={1} min={-20} max={100} title="thumb abduction (deg)" onChange={(v) => edit((x) => { x.thumbSpread = v; })} />
        <NumberField label="↔" value={s.spread} step={0.5} min={0} max={30} title="finger spread (deg)" onChange={(v) => edit((x) => { x.spread = v; })} />
      </Row>
      <Row label="Orientation" title="Relative to the placement frame">
        <SelectField value={s.orient} options={ORIENT_IDS.map((o) => ({ value: o, label: ORIENTS[o].label }))}
          onChange={(v) => edit((x) => { x.orient = v as OrientId; })} />
      </Row>
    </>
  );
}

export function HandCard({ ctx, hand, live }: { ctx: DebugContext; hand: Handedness; live: HandLive }) {
  const st = simState[hand].value;
  const poses = gestureDefs.value?.poses ?? [];
  const label = st.preset === 'custom' ? 'custom' : st.preset;
  const options = [
    ...poses.filter((p) => p.hand === 'either' || p.hand === hand).map((p) => ({ value: p.id, label: p.id })),
    { value: 'relaxed', label: 'relaxed (rest)' },
    { value: 'custom', label: 'custom (sliders)' },
  ];
  const placements = hand === 'right'
    ? [{ value: 'cursor' as const, label: 'cursor', title: 'Follows the mouse ray like the desktop hand' }, { value: 'camera' as const, label: 'camera', title: 'Fixed in front of the camera' }, { value: 'entity' as const, label: 'selection', title: 'Contact point on the selected entity' }]
    : [{ value: 'camera' as const, label: 'camera', title: 'Fixed in front of the camera' }, { value: 'entity' as const, label: 'selection', title: 'Contact point on the selected entity' }];
  const applied = st.mode === 'latch' ? st.latched : simHeld[hand].value;
  const enable = (on: boolean) => {
    patchSim(hand, { enabled: on, latched: on ? st.latched : false });
    if (on && !st.solve && st.preset !== 'custom') loadPreset(ctx, hand, st.preset);
  };
  const solveChip = st.solve
    ? st.solve.ok
      ? <span class="hx-chip ok" title={`slack ${fmtNum(st.solve.slack, 3)}${st.solve.alsoMatches.length ? ` · also matches ${st.solve.alsoMatches.join(', ')}` : ''}`}>✓ classifies</span>
      : <span class="hx-chip bad" title={`violation ${fmtNum(st.solve.violation, 3)}`}>✗ not satisfied</span>
    : null;
  const fo = fingersOpen.value[hand];
  return (
    <div class="hx-card" data-hand={hand}>
      <div class="hx-hand-head">
        <Switch checked={st.enabled} onChange={enable} label="simulate" title={`Simulate the ${hand} hand (overrides the mouse hand)`} />
        <span style={{ flex: 1 }} />
        {live.tracked ? <Badge kind={live.source === 'sim' ? 'info' : 'dim'}>{live.source}</Badge> : <Badge kind="dim">not tracked</Badge>}
        {live.active.map((p) => <span key={p} class="hx-chip on">{p}</span>)}
      </div>
      {st.enabled ? (
        <>
          <Row label="Pose">
            <SelectField value={st.preset} options={options} onChange={(v) => loadPreset(ctx, hand, v)} />
            {solveChip}
          </Row>
          <Row label="Apply" title="Hold: active only while the button is pressed. Latch: toggles.">
            <Seg value={st.mode} options={[{ value: 'hold', label: 'hold' }, { value: 'latch', label: 'latch' }]}
              onChange={(v) => { patchSim(hand, { mode: v, latched: false }); simHeld[hand].value = false; }} />
            {st.mode === 'hold'
              ? <HoldButton hand={hand} label={label} />
              : <button type="button" class={`hx-hold${applied ? ' on' : ''}`} title="Toggle the pose" onClick={() => patchSim(hand, { latched: !st.latched })}>
                  <Icon name={applied ? 'check' : 'hand'} size={13} />{applied ? `${label} on` : `Apply ${label}`}
                </button>}
          </Row>
          <Row label="Place">
            <Seg value={st.placement === 'cursor' && hand === 'left' ? 'camera' : st.placement} options={placements} onChange={(v) => patchSim(hand, { placement: v })} />
            <span style={{ flex: 1 }} />
            <IconButton icon="refresh" class="sm" title="Reset offset" onClick={() => patchSim(hand, { offset: [0, 0, 0] })} />
          </Row>
          <Row label="Offset" title="Nudge the hand in its placement frame (m): drag to scrub — moves a latched grab">
            <Vec3Field value={st.offset} step={0.005} onChange={(v) => patchSim(hand, { offset: v })} />
          </Row>
          {st.placement === 'entity' && !ctx.store.selection.value ? <div class="hx-warn">No selection — the hand stays in front of the camera.</div> : null}
          <div class="hx-sub" onClick={() => { fingersOpen.value = { ...fingersOpen.value, [hand]: !fo }; }}>
            <Icon name={fo ? 'chevronDown' : 'chevronRight'} size={11} />Shape (curls, pinch, thumb, orientation)
          </div>
          {fo ? <FingerSliders hand={hand} st={st} /> : null}
        </>
      ) : (
        <div class="hx-note">
          {hand === 'right' ? 'Mouse hand (LMB = pinch). ' : 'Untracked on desktop. '}Turn on <b>simulate</b> to pose this hand from the pose library or sliders.
        </div>
      )}
      <HandTargets ctx={ctx} live={live} />
    </div>
  );
}

function HandTargets({ ctx, live }: { ctx: DebugContext; live: HandLive }) {
  if (!live.tracked) return null;
  return (
    <div style={{ marginTop: '4px' }}>
      <div class="hx-kv">
        <Icon name="crosshair" size={12} />ray <b title={live.rayHit?.entity}>{entityName(ctx, live.rayHit?.entity)}</b>
        {live.rayHit?.interactive ? <span class="hx-chip warn" title={live.rayHit.object}>interactive</span> : null}
        <span style={{ flex: 1 }} />
        touch <b title={live.touchHit?.entity}>{entityName(ctx, live.touchHit?.entity)}</b>
        {live.touchHit?.interactive ? <span class="hx-chip warn">interactive</span> : null}
      </div>
      {live.sessions.length ? live.sessions.map((s) => (
        <div class="hx-kv" key={`${s.pose}`}>
          <Icon name="play" size={11} /><span class="hx-chip ok">{s.binding}</span>
          {s.action !== s.binding || (s.mode && s.mode !== s.action) ? <span class="dbg-mono dim">{s.action}{s.mode && s.mode !== s.action ? `→${s.mode}` : ''}</span> : null}
          {s.target ? <b>→ {entityName(ctx, s.target)}</b> : null}
        </div>
      )) : null}
    </div>
  );
}

// ------------------------------------------------------------------ features

/** Conditions of a hand's selected preset, by feature. */
function presetConds(hand: Handedness): Map<string, FeatureCondition> {
  const st = simState[hand].peek();
  const m = new Map<string, FeatureCondition>();
  const pose = st.enabled && st.preset !== 'custom' && st.preset !== 'relaxed' ? poseById(st.preset) : undefined;
  for (const c of pose?.conditions ?? []) m.set(c.feature, c);
  return m;
}

function FeatureCell({ name, v, cond }: { name: string; v: number | undefined; cond?: FeatureCondition }) {
  if (v === undefined || !Number.isFinite(v)) return <div class="hx-cell na">—</div>;
  const [lo, hi] = featureInfo(name).range;
  const L = Number.isFinite(lo) ? lo : -1, H = Number.isFinite(hi) ? hi : 1;
  const pct = (x: number) => `${(Math.min(1, Math.max(0, (x - L) / (H - L))) * 100).toFixed(1)}%`;
  let cls = '';
  let band = null;
  if (cond) {
    const inside = (cond.min === undefined || v >= cond.min) && (cond.max === undefined || v <= cond.max);
    cls = inside ? ' in' : ' out';
    const a = cond.min ?? L, b = cond.max ?? H;
    band = <div class="band" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />;
  }
  const unit = featureInfo(name).unit;
  const digits = unit === 'deg' ? 0 : unit === 'm' ? 3 : 2;
  return (
    <div class={`hx-cell${cls}`} title={`${name} = ${v}${cond ? ` · preset: ${condText(cond)}` : ''}`}>
      <div class="hx-bar">{band}<div class="fill" style={{ width: pct(v) }} /><div class="mk" style={{ left: pct(v) }} /></div>
      <span class="num">{v.toFixed(digits)}</span>
    </div>
  );
}

export function FeatureTable({ features, bands = true }: { features: Record<Handedness, HandFeatures | undefined>; bands?: boolean }) {
  const none = new Map<string, FeatureCondition>();
  const cl = bands ? presetConds('left') : none, cr = bands ? presetConds('right') : none;
  const names = FEATURE_NAMES.filter((n) => n !== 'hands.distance' || features.left?.[n] !== undefined || features.right?.[n] !== undefined);
  return (
    <div class="hx-feat">
      <span class="h">feature</span><span class="h">left</span><span class="h">right</span>
      {names.map((n) => (
        <Fragment key={n}>
          <span key={`n${n}`} class={`n${cl.has(n) || cr.has(n) ? ' c' : ''}`} title={featureInfo(n).description}>{n}</span>
          <FeatureCell key={`l${n}`} name={n} v={features.left?.[n]} cond={cl.get(n)} />
          <FeatureCell key={`r${n}`} name={n} v={features.right?.[n]} cond={cr.get(n)} />
        </Fragment>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ poses → bindings

function considerTitle(list: Considered[]): string {
  return list.map((c) => `${c.scope}: ${c.binding.id} — ${c.ok ? 'ok' : c.reason}`).join('\n') || 'no binding uses this pose on this hand';
}

export function ExplainView({ ctx, live }: { ctx: DebugContext; live: HandLive }) {
  if (!live.explain.length) return <div class="hx-note">No poses loaded.</div>;
  return (
    <div class="hx-ex">
      {live.explain.map(({ pose, active, firing, ex }) => {
        const w = ex.winner;
        const shown = firing ? { id: firing.binding, act: firing.action, target: firing.target, scope: undefined as string | undefined } : null;
        return (
          <Fragment key={pose}>
            <span key={`p${pose}`} class="p"><span class={`hx-chip${active ? ' on' : ''}`}>{pose}</span></span>
            {shown ? (
              <span key={`b${pose}`} class="b fire" title={`firing now\n${considerTitle(ex.considered)}`}>
                <Icon name="play" size={10} /><span class="id">{shown.id}</span>{shown.act !== shown.id ? <span class="act">{shown.act}</span> : null}
                {shown.target ? <span class="tg">→ {entityName(ctx, shown.target)}</span> : null}
              </span>
            ) : w ? (
              <span key={`b${pose}`} class="b" title={considerTitle(ex.considered)}>
                <span class={`hx-scope ${w.scope}`}>{w.scope === 'entity-default' ? 'default' : w.scope}</span>
                <span class="id">{w.binding.id}</span>{describeAction(w.binding) !== w.binding.id ? <span class="act">{describeAction(w.binding)}</span> : null}
                {w.target ? <span class="tg">→ {entityName(ctx, w.target)}{w.via ? ` (${w.via})` : ''}</span> : null}
              </span>
            ) : (
              <span key={`b${pose}`} class="b none" title={considerTitle(ex.considered)}>
                — {ex.considered.length ? ex.considered[0].reason : 'no binding'}
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ recording

interface RecState {
  name: string;
  hand: Handedness | 'either';
  seconds: number;
  countdown: number;
  description: string;
  phase: 'idle' | 'countdown' | 'recording' | 'deriving' | 'done' | 'error';
  progress: number;
  secondsLeft: number;
  source: 'headset' | 'local' | null;
  result: PoseDef | null;
  saved: boolean;
  error: string | null;
}
const rec = signal<RecState>({
  name: 'my-pose', hand: 'right', seconds: 2, countdown: 3, description: '',
  phase: 'idle', progress: 0, secondsLeft: 0, source: null, result: null, saved: false, error: null,
});
const setRec = (p: Partial<RecState>) => { rec.value = { ...rec.value, ...p }; };
let recTimer: ReturnType<typeof setInterval> | null = null;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

async function startRecording(ctx: DebugContext, source: 'headset' | 'local'): Promise<void> {
  const r = rec.value;
  if (!NAME_RE.test(r.name)) { setRec({ phase: 'error', error: 'Name must be a file-safe id like "thumbs-up"' }); return; }
  setRec({ phase: 'countdown', progress: 0, secondsLeft: r.countdown, source, result: null, saved: false, error: null });
  const t0 = performance.now();
  const total = (r.countdown + r.seconds) * 1000;
  if (source === 'headset') {
    // The server drives the headset's countdown + sampling; mirror the timing here.
    recTimer = setInterval(() => {
      const el = performance.now() - t0;
      if (el < r.countdown * 1000) setRec({ phase: 'countdown', secondsLeft: Math.ceil(r.countdown - el / 1000) });
      else setRec({ phase: el < total ? 'recording' : 'deriving', progress: Math.min(1, (el - r.countdown * 1000) / (r.seconds * 1000)) });
    }, 100);
    try {
      const pose = await ctx.api.recordGesture({ name: r.name, hand: r.hand, seconds: r.seconds, countdown: r.countdown, ...(r.description.trim() ? { description: r.description.trim() } : {}) });
      setRec({ phase: 'done', result: pose, saved: true, progress: 1 });
      ctx.toast(`Recorded pose '${pose.id}' → library/poses/${pose.id}.json`);
    } catch (e) {
      setRec({ phase: 'error', error: (e as Error).message });
    } finally {
      if (recTimer) clearInterval(recTimer);
      recTimer = null;
    }
    return;
  }
  // Local: sample this page's hands (simulated or mouse) at ~30 Hz, derive here.
  const hand: Handedness = r.hand !== 'either' ? r.hand : simState.left.peek().enabled && !simState.right.peek().enabled ? 'left' : 'right';
  const samples: Array<Record<string, number>> = [];
  let nextSample = t0 + r.countdown * 1000;
  await new Promise<void>((resolve) => {
    recTimer = setInterval(() => {
      const now = performance.now();
      const el = now - t0;
      if (el < r.countdown * 1000) { setRec({ phase: 'countdown', secondsLeft: Math.ceil(r.countdown - el / 1000) }); return; }
      while (nextSample <= now && nextSample <= t0 + total) {
        const f = ctx.engine.matcher.features(hand);
        if (f) samples.push({ ...f });
        nextSample += 1000 / 30;
      }
      setRec({ phase: 'recording', progress: Math.min(1, (el - r.countdown * 1000) / (r.seconds * 1000)) });
      if (el >= total) { clearInterval(recTimer!); recTimer = null; resolve(); }
    }, 20);
  });
  if (!samples.length) { setRec({ phase: 'error', error: `No ${hand} hand samples — is the hand tracked (simulate it, or hover the 3D view)?` }); return; }
  setRec({ phase: 'deriving' });
  try {
    // The server derives + saves from pre-sampled frames (no headset round trip).
    const saved = await ctx.api.recordGesture({ name: r.name, hand: r.hand, frames: samples, ...(r.description.trim() ? { description: r.description.trim() } : {}) });
    setRec({ phase: 'done', result: saved, saved: true, progress: 1 });
    ctx.toast(`Recorded pose '${saved.id}' → library/poses/${saved.id}.json`);
  } catch (e) {
    // Older server or save failure: keep a local preview the user can copy.
    const pose = derivePose(samples, { id: r.name, hand: r.hand, description: r.description.trim() || `Recorded pose '${r.name}'` });
    setRec({ phase: 'done', result: { ...pose, id: r.name, source: 'recorded' }, saved: false, progress: 1 });
    ctx.toast(`Could not save on the server (${(e as Error).message}); showing a local preview`, 'warn');
  }
}

export function Recorder({ ctx }: { ctx: DebugContext }) {
  const r = rec.value;
  const headset = ctx.store.headset.value.connected;
  const busy = r.phase === 'countdown' || r.phase === 'recording' || r.phase === 'deriving';
  useEffect(() => () => { /* keep running across tab switches */ }, []);
  const path = r.result ? `library/poses/${r.result.id}.json` : '';
  return (
    <>
      <Row label="Name"><TextField value={r.name} mono placeholder="pose-id" onCommit={(v) => setRec({ name: v.trim() })} /></Row>
      <Row label="Hand / time">
        <SelectField value={r.hand} options={[{ value: 'right', label: 'right' }, { value: 'left', label: 'left' }, { value: 'either', label: 'either' }]} onChange={(v) => setRec({ hand: v })} />
        <NumberField label="s" value={r.seconds} step={0.5} min={0.5} max={30} title="seconds to sample" onChange={(v) => setRec({ seconds: v })} />
        <NumberField label="⏱" value={r.countdown} step={1} min={0} max={10} integer title="countdown (s)" onChange={(v) => setRec({ countdown: v })} />
      </Row>
      <Row label="Description"><TextField value={r.description} placeholder="what the pose is for (optional)" onCommit={(v) => setRec({ description: v })} /></Row>
      <Row label="">
        <Button primary small icon="headset" disabled={busy || !headset} title={headset ? 'POST /api/gestures/record: the headset samples its real hands; the server saves the PoseDef' : 'No headset connected (recording through the server needs the primary xr client)'}
          onClick={() => void startRecording(ctx, 'headset')}>Record headset</Button>
        <Button small icon="hand" disabled={busy} title="Sample this page's hands (simulated / mouse) and save the derived PoseDef via the server"
          onClick={() => void startRecording(ctx, 'local')}>Record here</Button>
      </Row>
      {busy ? (
        <div class="hx-kv">
          {r.phase === 'countdown' ? <><Icon name="dot" size={12} />Hold the pose… starting in <b>{r.secondsLeft}</b></> : <><Icon name="mic" size={12} />{r.phase === 'deriving' ? 'deriving…' : 'recording'}</>}
          <div class="hx-progress"><div style={{ width: `${(r.progress * 100).toFixed(0)}%` }} /></div>
        </div>
      ) : null}
      {r.phase === 'error' ? <div class="hx-warn">{r.error}</div> : null}
      {r.result ? (
        <>
          <div class="hx-kv" style={{ marginTop: '4px' }}>
            {r.saved ? <Badge kind="ok">saved</Badge> : <Badge kind="warn" title="Derived in this page only (the server could not save it)">preview</Badge>}
            <span class="hx-path" title="Copy path" onClick={() => void copyText(path).then((ok) => ctx.toast(ok ? `Copied ${path}` : 'Clipboard unavailable'))}><Icon name="folder" size={11} />{path}</span>
            <span style={{ flex: 1 }} />
            <IconButton icon="copy" class="sm" title="Copy PoseDef JSON" onClick={() => void copyText(JSON.stringify(r.result, null, 2) + '\n').then((ok) => ctx.toast(ok ? 'PoseDef JSON copied' : 'Clipboard unavailable'))} />
          </div>
          <div class="hx-chips" style={{ margin: '4px 0' }}>{r.result.conditions.map((c) => <span key={c.feature} class="hx-chip cond">{condText(c)}</span>)}</div>
          {!r.saved ? <div class="hx-note">Not saved: paste the JSON into <span class="dbg-mono">{path}</span> (or ask Claude) — the server hot-reloads it.</div> : null}
          <pre class="dbg-pre" style={{ maxHeight: '220px' }}>{prettyJson(r.result)}</pre>
        </>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ library

const libInfo = signal<GesturesInfo | null>(null);
const libError = signal<string | null>(null);

async function loadLibrary(ctx: DebugContext): Promise<void> {
  try { libInfo.value = await ctx.api.gestures(); libError.value = null; } catch (e) { libError.value = (e as Error).message; }
}

function BindingRow({ b }: { b: InteractionBinding }) {
  return (
    <div class="hx-lib-bind" title={b.description}>
      <span class="l"><span class="id">{b.id}</span><span class="hx-chip">{b.pose}</span><span class="act">{describeAction(b)}</span></span>
      <span class="r">{b.hand ?? 'either'} · {b.target}{b.priority ? ` · p${b.priority}` : ''}</span>
    </div>
  );
}

export function Library({ ctx }: { ctx: DebugContext }) {
  const [tab, setTab] = useState<'poses' | 'bindings'>('poses');
  useEffect(() => { void loadLibrary(ctx); }, [ctx]);
  const info = libInfo.value;
  const live = gestureDefs.value;
  const poses = info?.poses ?? live?.poses ?? [];
  const sets = info?.interactions ?? live?.interactions ?? {};
  const usedBy = (pose: string) => Object.values(sets).flatMap((s) => s.bindings).filter((b) => b.pose === pose).map((b) => b.id);
  const issues = { ...(info?.errors ?? {}) };
  return (
    <>
      <div class="hx-kv" style={{ marginBottom: '4px' }}>
        <Seg value={tab} options={[{ value: 'poses', label: `poses ${poses.length}` }, { value: 'bindings', label: `sets ${Object.keys(sets).length}` }]} onChange={setTab} />
        <span style={{ flex: 1 }} />
        <IconButton icon="refresh" class="sm" title="Reload (GET /api/gestures)" onClick={() => void loadLibrary(ctx)} />
      </div>
      {libError.value ? <div class="hx-warn">{libError.value}</div> : null}
      {Object.entries(issues).map(([f, m]) => <div key={f} class="hx-warn"><Icon name="alert" size={11} /> {f}: {m}</div>)}
      {Object.entries(info?.warnings ?? {}).map(([f, list]) => <div key={f} class="hx-note"><Icon name="alert" size={11} /> {f}: {list.join('; ')}</div>)}
      {tab === 'poses' ? poses.map((p) => (
        <div key={p.id} class="hx-lib-pose">
          <div class="t">
            <span class="id">{p.id}</span>
            <Badge kind="dim">{p.hand}</Badge>
            <Badge kind={p.source === 'recorded' ? 'info' : 'dim'}>{p.source}</Badge>
            <span class="dbg-mono dim" title="enterMs (debounce)">{p.enterMs ?? 60}ms</span>
            <span style={{ flex: 1 }} />
            {(['left', 'right'] as const).filter((h) => p.hand === 'either' || p.hand === h).map((h) => (
              <button key={h} type="button" class="dbg-btn small" title={`Simulate on the ${h} hand`}
                onClick={() => { if (!simState[h].peek().enabled) patchSim(h, { enabled: true }); loadPreset(ctx, h, p.id); }}>{h === 'left' ? 'L' : 'R'}</button>
            ))}
          </div>
          <div class="d">{p.description}</div>
          <div class="hx-chips">{p.conditions.map((c) => <span key={c.feature} class="hx-chip cond">{condText(c)}</span>)}</div>
          {usedBy(p.id).length ? <div class="hx-note" style={{ margin: '3px 0 0' }}>used by: {usedBy(p.id).join(', ')}</div> : null}
        </div>
      )) : Object.entries(sets).sort(([a], [b]) => a.localeCompare(b)).map(([name, set]) => (
        <div key={name} class="hx-lib-pose">
          <div class="t"><span class="id">{name}</span><span class={`hx-scope ${set.scope}`}>{set.scope}</span><span style={{ flex: 1 }} /><span class="dbg-mono dim">library/interactions/{name}.json</span></div>
          <div class="d">{set.description}</div>
          {set.bindings.map((b) => <BindingRow key={b.id} b={b} />)}
        </div>
      ))}
      <div class="hx-note">Scope order: entity › widget default › entity-default › global. Widget defaults live in each widget's manifest; entity bindings in the Inspector.</div>
    </>
  );
}

export { HAND_LABEL };
