// Registers every debug panel. Each panel lives in its own file (plus an
// optional panels/<id>/ folder) and default-exports a PanelDef (../types.ts).
// To add a panel: create the file, import + list it here once.
//
//   left:   scene, widgets
//   right:  inspector, hands, view
//   bottom: links, channels, events, agent, sources, screenshots

import { registerPanel } from '../registry.ts';
import type { PanelDef } from '../types.ts';
import scene from './scene.tsx';
import widgets from './widgets.tsx';
import inspector from './inspector.tsx';
import hands from './hands.tsx';
import view from './view.tsx';
import links from './links.tsx';
import channels from './channels.tsx';
import events from './events.tsx';
import agent from './agent.tsx';
import sources from './sources.tsx';
import screenshots from './screenshots.tsx';

export const PANELS: PanelDef[] = [scene, widgets, inspector, hands, view, links, channels, events, agent, sources, screenshots];

for (const p of PANELS) registerPanel(p);
