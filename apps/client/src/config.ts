// URL parameters and persisted client settings.
//
//   ?role=xr|desktop|mirror   (default xr)
//   ?emulate=quest3           install IWER before requesting a session
//   ?devui=1                  IWER DevUI overlay (with emulate)
//   ?sem=living_room          IWER synthetic environment (with emulate, AR)
//   ?server=wss://host:8443   WebSocket base override (default: same origin /ws);
//                             http(s):// and bare host:port are accepted; ?ws= is an alias
//   ?fps=72|90|120  ?fbscale=1.2  ?foveation=0.5
//   ?autoenter=vr|ar          request a session right away (works with emulate; real
//                             browsers still need a gesture)
//   ?perf=1                   show the perf overlay on start
//   ?debug=1                  desktop debug dashboard (src/debug, lazy-loaded); implies role=desktop
//                             unless role=mirror (a debug tab never requests primary or streams user.pose).
//                             http://<server>/debug redirects to /?role=desktop&debug=1

import type { ClientRole } from '@evolspace/protocol';
import type { XrMode } from './xr/session.ts';
import { safeStorage } from './xr/origin.ts';

export interface ClientConfig {
  role: Exclude<ClientRole, 'tool'>;
  wsUrl: string;
  emulate: string | null;
  devui: boolean;
  sem: string | null;
  autoEnter: XrMode | null;
  frameRate?: number;
  framebufferScale?: number;
  foveation?: number;
  perf: boolean;
  /** Desktop debug dashboard (?debug=1 or /debug). Always role=desktop. */
  debug: boolean;
}

export function parseConfig(loc: { search: string; protocol: string; host: string } = location): ClientConfig {
  const q = new URLSearchParams(loc.search);
  const roleParam = q.get('role');
  const debug = q.get('debug') === '1' || q.get('debug') === 'true';
  // Debug mode is a desktop dashboard: it must never take the headset's primary slot.
  const role: ClientConfig['role'] = roleParam === 'mirror' ? 'mirror' : roleParam === 'desktop' || debug ? 'desktop' : 'xr';
  const num = (k: string) => {
    const v = q.get(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // Accept ws(s)://, http(s):// (mapped to ws(s)) or a bare host:port (same scheme as the page).
  // `ws` is an alias (the mirror documents ?ws=; main.ts passes this URL to it).
  const server = (q.get('server') ?? q.get('ws'))?.trim() || null;
  const pageWs = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = server
    ? /^wss?:\/\//i.test(server) ? server
      : /^https?:\/\//i.test(server) ? server.replace(/^http/i, 'ws')
        : `${pageWs}//${server}`
    : `${pageWs}//${loc.host}`;
  const wsUrl = /\/ws\/?$/.test(wsBase) ? wsBase : `${wsBase.replace(/\/$/, '')}/ws`;
  const auto = q.get('autoenter');
  return {
    role,
    wsUrl,
    emulate: q.get('emulate'),
    devui: q.get('devui') === '1',
    sem: q.get('sem'),
    autoEnter: auto === 'vr' || auto === 'ar' ? auto : null,
    frameRate: num('fps'),
    framebufferScale: num('fbscale'),
    foveation: num('foveation'),
    perf: q.get('perf') === '1',
    debug: debug && role === 'desktop',
  };
}

/** User toggles that persist across reloads (per device, localStorage). */
export interface ClientSettings {
  /** Render virtual hands in AR (real hands are visible through passthrough). */
  handsInAr: boolean;
  /** Render virtual hands in VR. */
  handsInVr: boolean;
  /** Higher framebuffer scale for sharper text (costs GPU). */
  highRes: boolean;
  perfOverlay: boolean;
  /** Preferred mode for the big "Enter" button. */
  lastMode: XrMode;
}

const SETTINGS_KEY = 'evolspace.client.settings';
const DEFAULT_SETTINGS: ClientSettings = { handsInAr: false, handsInVr: true, highRes: false, perfOverlay: false, lastMode: 'vr' };

export class SettingsStore {
  private readonly store = safeStorage();
  value: ClientSettings;
  private listeners = new Set<(s: ClientSettings) => void>();

  constructor() {
    let parsed: Partial<ClientSettings> = {};
    try { parsed = JSON.parse(this.store.getItem(SETTINGS_KEY) ?? '{}') as Partial<ClientSettings>; } catch { /* corrupt → defaults */ }
    this.value = { ...DEFAULT_SETTINGS, ...parsed };
  }

  set(patch: Partial<ClientSettings>): void {
    this.value = { ...this.value, ...patch };
    this.store.setItem(SETTINGS_KEY, JSON.stringify(this.value));
    for (const l of this.listeners) l(this.value);
  }

  onChange(cb: (s: ClientSettings) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
