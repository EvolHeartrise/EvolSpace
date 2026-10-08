// Agent panel (stub) — dock: bottom. Owned by the agent that implements it; edit only
// this file (and an optional panels/agent/ folder). Contract: ../types.ts (PanelDef,
// DebugContext). Shared UI: ../ui/kit.tsx, ../ui/fields.tsx, ../ui/hooks.ts.

import { definePanel } from '../registry.ts';
import type { PanelProps } from '../types.ts';
import { ComingSoon } from '../ui/kit.tsx';

function AgentPanel(_p: PanelProps) {
  return (
    <ComingSoon title="Agent" icon="bot">
      {"Claude status + messages (ctx.store.agentStatus / agentMessages), ask Claude (agent.ask), simulate voice (POST /api/voice/simulate)."}
    </ComingSoon>
  );
}

export default definePanel({
  id: 'agent',
  title: 'Agent',
  dock: 'bottom',
  order: 30,
  icon: 'bot',
  component: AgentPanel,
});
