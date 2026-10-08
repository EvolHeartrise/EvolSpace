// Sources panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/sources/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function SourcesPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Sources" icon="cpu">
      {"Supervised data sources (ctx.store.sources, needs 'sources'): status, restarts, log tail, start/stop/restart."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'sources',
  title: 'Sources',
  dock: 'bottom',
  order: 40,
  icon: 'cpu',
  component: SourcesPanel,
});
