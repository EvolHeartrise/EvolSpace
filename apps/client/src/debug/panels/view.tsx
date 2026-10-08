// View panel (stub) — dock: right. Owned by the agent that implements it; edit only
// this file (and an optional panels/view/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function ViewPanel(_p: PanelProps) {
  return (
    <ComingSoon title="View" icon="view">
      {"Debug overlays (ctx.overlays: registerOverlay in registry.ts) and camera tools: bounds, rays, labels, axes, user head/FOV frustum, camera bookmarks."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'view',
  title: 'View',
  dock: 'right',
  order: 20,
  icon: 'view',
  component: ViewPanel,
});
