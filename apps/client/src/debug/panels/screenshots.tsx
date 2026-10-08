// Screenshots panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/screenshots/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function ScreenshotsPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Screenshots" icon="image">
      {"Mirror screenshots (user / camera / entity / widget views) and the toolbar's \"Screenshot (my view)\" action (registerToolbarAction id 'screenshot.myView')."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'screenshots',
  title: 'Screenshots',
  dock: 'bottom',
  order: 50,
  icon: 'image',
  component: ScreenshotsPanel,
});
