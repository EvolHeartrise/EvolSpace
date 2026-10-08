// Hands panel (stub) — dock: right. Owned by the agent that implements it; edit only
// this file (and an optional panels/hands/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function HandsPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Hands" icon="hand">
      {"Simulated hands & gestures (ctx.client.sim, ctx.engine): pose presets, pinch at points, active poses and bindings, the headset user's live hands (ctx.store.userPose)."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'hands',
  title: 'Hands',
  dock: 'right',
  order: 10,
  icon: 'hand',
  component: HandsPanel,
});
