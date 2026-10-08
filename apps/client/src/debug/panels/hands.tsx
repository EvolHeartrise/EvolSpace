// Hands panel — simulated hands & gestures workbench (dock: right).
//   - Per hand: simulate (pose preset solved from the library's PoseDefs, or
//     manual curl / pinch / thumb / orientation), hold-to-apply or latch,
//     placement (right: follow the mouse ray; camera; selected entity) + offset.
//   - Live readouts (real or simulated): computed features with the preset's
//     condition bands, active poses, binding sessions, ray / touch targets and
//     a read-only "which binding would fire" per pose (scope order entity >
//     widget default > entity-default > global).
//   - Pose recording (headset via POST /api/gestures/record, or this page's
//     hands derived locally) and a read-only pose / binding browser.
// The simulation driver runs from init() (independent of the tab being open).

import { signal } from '@preact/signals';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { useNeed, usePoll } from '../ui/hooks.ts';
import { Section, Scroll } from '../ui/kit.tsx';
import { injectPanelsCss } from '../overlays-impl/css.ts';
import { HANDS, installHandSim, simHeld, simState } from './hands/driver.ts';
import { gestureDefs, headsetHands, readLive } from './hands/live.ts';
import { ExplainView, FeatureTable, HandCard, Library, Recorder } from './hands/ui.tsx';

const featSource = signal<'page' | 'headset'>('page');

function HeadsetFeatures({ ctx }: { ctx: DebugContext }) {
  useNeed(ctx, 'userPose');
  const pose = ctx.store.userPose.value;
  const hh = headsetHands(pose, gestureDefs.value?.poses ?? []);
  if (!pose) return <div class="hx-note">No headset pose — connect a headset (its hands stream with user.pose).</div>;
  return (
    <>
      <div class="hx-kv" style={{ flexWrap: 'wrap' }}>
        {HANDS.map((h) => (
          <span key={h} class="hx-chips"><span class="dbg-dim">{h}:</span>{hh[h].features ? (hh[h].poses.length ? hh[h].poses.map((p) => <span key={p} class="hx-chip on">{p}</span>) : <span class="hx-chip">no pose</span>) : <span class="hx-chip">not tracked</span>}</span>
        ))}
      </div>
      <FeatureTable features={{ left: hh.left.features, right: hh.right.features }} bands={false} />
    </>
  );
}

function HandsPanel({ ctx }: PanelProps) {
  const live = usePoll(() => readLive(ctx), 125, [ctx]);
  // Subscribe to state so the cards re-render on edits.
  void simState.left.value; void simState.right.value;
  const nActive = live.left.active.length + live.right.active.length;
  return (
    <Scroll class="hx-panel">
      <Section id="hands.right" title="Right hand" count={live.right.tracked ? live.right.source ?? '' : 'off'}>
        <HandCard ctx={ctx} hand="right" live={live.right} />
      </Section>
      <Section id="hands.left" title="Left hand" count={live.left.tracked ? live.left.source ?? '' : 'off'}>
        <HandCard ctx={ctx} hand="left" live={live.left} />
      </Section>
      <Section id="hands.explain" title="Poses → bindings" count={nActive || undefined}>
        {HANDS.slice().reverse().map((h) => (
          <div key={h} style={{ marginBottom: '6px' }}>
            <div class="dbg-sub">{h} hand{live[h].tracked ? '' : ' · not tracked'}</div>
            <ExplainView ctx={ctx} live={live[h]} />
          </div>
        ))}
      </Section>
      <Section id="hands.features" title="Features" actions={
        <span class="hx-seg">
          {(['page', 'headset'] as const).map((v) => (
            <button key={v} type="button" class={featSource.value === v ? 'on' : ''} title={v === 'page' ? "This page's hands (simulated / mouse)" : "The headset user's live hands (user.pose)"}
              onClick={() => { featSource.value = v; }}>{v === 'page' ? 'this page' : 'headset'}</button>
          ))}
        </span>}>
        {featSource.value === 'page'
          ? <FeatureTable features={{ left: live.left.features, right: live.right.features }} />
          : <HeadsetFeatures ctx={ctx} />}
      </Section>
      <Section id="hands.record" title="Record pose" defaultOpen={false}>
        <Recorder ctx={ctx} />
      </Section>
      <Section id="hands.library" title="Pose & binding library" defaultOpen={false}>
        <Library ctx={ctx} />
      </Section>
    </Scroll>
  );
}

function init(ctx: DebugContext): () => void {
  const offCss = injectPanelsCss();
  const offDefs = ctx.runtime.onGestures((g) => { gestureDefs.value = { poses: g.poses, interactions: g.interactions }; });
  const driver = installHandSim(ctx);
  return () => {
    driver.dispose();
    offDefs();
    offCss();
    for (const h of HANDS) simHeld[h].value = false;
  };
}

export default definePanel({
  id: 'hands',
  title: 'Hands',
  dock: 'right',
  order: 10,
  icon: 'hand',
  component: HandsPanel,
  init,
  badge: () => {
    const n = HANDS.filter((h) => simState[h].value.enabled).length;
    return n ? `sim ${n}` : null;
  },
});
