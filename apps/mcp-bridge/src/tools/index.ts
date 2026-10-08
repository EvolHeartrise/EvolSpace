// The full tool set exposed by the bridge, in the order Claude sees them.
import type { ToolDef } from '../tool.ts';
import { sceneTools } from './scene.ts';
import { widgetTools } from './widgets.ts';
import { dataTools } from './data.ts';
import { agentTools } from './agent.ts';
import { systemTools } from './system.ts';

export const ALL_TOOLS: ToolDef[] = [...sceneTools, ...widgetTools, ...agentTools, ...dataTools, ...systemTools];
