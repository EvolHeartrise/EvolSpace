// resid-flow — the residual stream of a transformer as a 3D flow through its
// layers. Consumes the "Interp data contract" (ARCHITECTURE.md) on channels
// `<prefix>.*` (default prefix 'interp'). See README.md in this folder.
//
// Module top level is side-effect free (the server evaluates the bundle to
// read the static fields); three.js comes from ctx.THREE.

import type { WidgetDefinition } from '@evolspace/protocol';
import { ResidFlow, type ResidProps } from './controller.ts';

const definition: WidgetDefinition<ResidProps> = {
  description:
    "Residual stream as a 3D flow: layers stacked along +Y, one smooth trajectory per token through its projected residual (P.resid.proj), " +
    "attn/MLP write ticks, a lens plane at the selected layer with the P.lens.readout panel and attention arcs. " +
    "Pinch a layer to move the lens, a node to select a token, drag the lens handle to scrub; publishes <prefix>.ctl.layer/token.",
  version: '1.1.0',
  props: {
    prefix: { type: 'string', default: 'interp', description: "Channel prefix P of the interp data contract (P.meta, P.resid.proj, ...)." },
    width: { type: 'number', default: 0.6, min: 0.1, max: 3, step: 0.05, description: 'Edge length of each layer plane (m).' },
    height: { type: 'number', default: 0.8, min: 0.1, max: 4, step: 0.05, description: 'Total stack height (m) when layerSpacing is 0 (auto).' },
    layerSpacing: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, description: 'Fixed distance between layer planes (m); 0 = height / L.' },
    normalize: { type: 'enum', options: ['global', 'layer'], default: 'global', description: "Projection scaling: 'global' keeps one scale (shows growth), 'layer' fills each plane." },
    depthJitter: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.05, description: 'Use projection component 2 as a y offset of up to this fraction of the spacing.' },
    tokenFilter: { type: 'json', default: [], description: 'Token group names to show (array or comma-separated string); empty = all tokens.' },
    colorBy: { type: 'enum', options: ['group', 'position', 'norm', 'probe'], default: 'group', description: "Trajectory/node color: token group (palette), position, residual norm, or probe score (needs 'probe')." },
    probe: { type: 'string', default: '', description: "Probe name for colorBy 'probe' (reads <prefix>.probe.<name>, [L+1, T])." },
    showAttn: { type: 'boolean', default: true, description: 'Attention arcs from the selected token to the keys it attends, in the lens plane.' },
    showDelta: { type: 'boolean', default: true, description: 'Paired attn/MLP write-magnitude ticks beside nodes (P.resid.delta).' },
    showParticles: { type: 'boolean', default: true, description: 'Animated flow particles along trajectories and arcs.' },
    showLabels: { type: 'boolean', default: true, description: 'Layer labels.' },
    showReadout: { type: 'boolean', default: true, description: 'Lens readout panel (P.lens.readout) beside the lens plane.' },
    dimOthers: { type: 'boolean', default: true, description: 'Dim other trajectories while a token is selected.' },
    pickNodeSetsLayer: { type: 'boolean', default: true, description: "Pinching a node also moves the lens to that node's layer." },
    publishLayer: { type: 'boolean', default: true, description: 'Publish <prefix>.ctl.layer when the user selects a layer. Turn off when a linked control (e.g. a slider) already publishes it.' },
    publishToken: { type: 'boolean', default: true, description: 'Publish <prefix>.ctl.token when the user selects a token.' },
    attnHead: { type: 'integer', default: -1, min: -1, max: 255, description: 'Attention head for arcs; -1 = mean over heads.' },
    attnTopK: { type: 'integer', default: 8, min: 1, max: 64, description: 'Maximum number of attention arcs.' },
    tubeWidth: { type: 'number', default: 0.005, min: 0.0005, max: 0.03, step: 0.0005, description: 'Max trajectory width (m) at full norm; auto-thinned for long sequences.' },
    flowSpeed: { type: 'number', default: 1.4, min: 0, max: 10, step: 0.1, description: 'Flow particle speed in layers per second.' },
  },
  inputs: {
    layer: { type: 'number', description: 'Lens layer index into P.meta.layers (0 = embed).' },
    token: { type: 'number', description: 'Selected token index.' },
    sample: { type: 'number', description: "Dataset sample index; forwarded to <prefix>.ctl.sample. Link a user-gesture output (e.g. a slider's 'commit'), not one that emits on create." },
  },
  outputs: {
    layer: { type: 'number', description: 'Lens layer after a user/channel change.' },
    token: { type: 'number', description: 'Selected token after a user/channel change.' },
  },
  interactions: [
    {
      id: 'resid-pick',
      description: 'Pinch a layer frame to move the lens there, a token node to select it, or pinch-drag the lens handle up/down to scrub layers. Pinching elsewhere grabs the widget.',
      pose: 'pinch',
      hand: 'either',
      target: 'near',
      action: { type: 'widget', handler: 'pick' },
      priority: 10,
    },
  ],
  size: [1.1, 1.0, 0.65],
  create(ctx) {
    return new ResidFlow(ctx);
  },
};

export default definition;
