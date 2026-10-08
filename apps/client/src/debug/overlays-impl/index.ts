// The View panel's 3D debug overlays (registered by panels/view.tsx init).
// Each overlay lives under its own world-level group (never under entity
// nodes → never hit-tested, never in entity bounds), owns all its GPU / DOM
// resources and disposes them when turned off.

import type { OverlayDef } from '../types.ts';
import { axesOverlay, boundsOverlay, interactiveOverlay, labelsOverlay } from './entities.ts';
import { avatarOverlay, raysOverlay } from './hands.ts';
import { linksOverlay } from './links.ts';
import { wireframeOverlay } from './wireframe.ts';

export const OVERLAYS: OverlayDef[] = [
  boundsOverlay, labelsOverlay, axesOverlay, interactiveOverlay, raysOverlay, linksOverlay, avatarOverlay, wireframeOverlay,
];

/** Swatch color per overlay (View panel list). */
export const OVERLAY_SWATCH: Record<string, string> = {
  bounds: '#4cc3ff', labels: '#dbe6f5', axes: 'linear-gradient(90deg,#ff6b7a 33%,#6fdc8c 33% 66%,#5aa9ff 66%)', interactive: '#ffb547',
  rays: '#c38bff', links: '#a98bff', avatar: '#45d49b', wireframe: '#8a97aa',
};
