// Widgets panel (stub) — dock: left. Owned by the agent that implements it; edit only
// this file (and an optional panels/widgets/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function WidgetsPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Widgets" icon="box">
      {"Widget catalog (ctx.store.catalog): descriptions, props, ports, build errors, thumbnails; spawn in front of the camera with ctx.actions.spawn(widget, props)."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'widgets',
  title: 'Widgets',
  dock: 'left',
  order: 10,
  icon: 'box',
  component: WidgetsPanel,
});
