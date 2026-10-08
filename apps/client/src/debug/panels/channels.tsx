// Channels panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/channels/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function ChannelsPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Channels" icon="radio">
      {"Data bus browser: every channel with kind, dtype/shape, size, rate and producer; live values (JSON + tensor previews); publish test values. Use ctx.store.need('channels') / useNeed(ctx, 'channels')."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'channels',
  title: 'Channels',
  dock: 'bottom',
  order: 10,
  icon: 'radio',
  component: ChannelsPanel,
});
