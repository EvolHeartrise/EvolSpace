// Links panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/links/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function LinksPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Links" icon="link">
      {"All links in the scene: port\u2192port, channel\u2192port, port\u2192channel. Create, edit transforms, enable/disable, live values flowing through each link."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'links',
  title: 'Links',
  dock: 'bottom',
  order: 0,
  icon: 'link',
  component: LinksPanel,
});
