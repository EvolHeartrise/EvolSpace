// Events panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/events/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function EventsPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Events" icon="list">
      {"Server event log (ctx.store.events: ring buffer of ServerEvent, long-polled): filter by type/entity, follow mode, details. Client errors jump to their entity."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'events',
  title: 'Events',
  dock: 'bottom',
  order: 20,
  icon: 'list',
  component: EventsPanel,
});
