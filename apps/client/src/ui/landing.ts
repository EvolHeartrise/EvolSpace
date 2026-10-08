// Minimal 2D page UI (outside XR): connection status, Enter VR / Enter AR,
// settings toggles, mic status, desktop controls help, and DOM toasts. Inside
// XR the in-world SystemUi (runtime) takes over; this panel is for setup and
// for desktop/emulated use.

import type { ClientSettings } from '../config.ts';
import type { XrMode } from '../xr/session.ts';

export interface LandingState {
  net: 'connecting' | 'connected' | 'offline';
  primary: boolean;
  clientId: string | null;
  role: string;
  xr: Record<XrMode, boolean>;
  inXr: XrMode | null;
  pendingMode: XrMode | null;
  mic: string;
  micError?: string;
  emulation?: string;
  origin: string;
  listening: boolean;
}

export interface LandingActions {
  enter(mode: XrMode): void;
  exit(): void;
  enableMic(): void;
  recalibrate(): void;
  setSetting<K extends keyof ClientSettings>(k: K, v: ClientSettings[K]): void;
}

const CSS = `
#evol-landing{position:fixed;top:12px;left:12px;z-index:20;width:300px;max-width:calc(100vw - 24px);
  font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#e9eef5;background:rgba(14,19,27,.86);
  border:1px solid #3b475a;border-radius:12px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35);user-select:none}
#evol-landing h1{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px;letter-spacing:.2px}
#evol-landing .pill{font-size:11px;padding:2px 8px;border-radius:99px;background:#1a2230;border:1px solid #3b475a;margin-left:auto}
#evol-landing .pill.ok{color:#45d49b;border-color:#2c6b52}#evol-landing .pill.bad{color:#ff5d6c;border-color:#7a2e37}
#evol-landing .row{display:flex;gap:8px;margin:8px 0}
#evol-landing button{flex:1;font:inherit;font-weight:600;color:#0e131b;background:#4cc3ff;border:0;border-radius:8px;padding:9px 10px;cursor:pointer}
#evol-landing button.alt{background:#ffb547}#evol-landing button.ghost{background:#1a2230;color:#e9eef5;border:1px solid #3b475a;font-weight:500}
#evol-landing button:disabled{opacity:.35;cursor:not-allowed}
#evol-landing label{display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;color:#c9d2de}
#evol-landing .dim{color:#8d99ab;font-size:12px}#evol-landing .err{color:#ff5d6c;font-size:12px}
#evol-landing .notice{color:#ffb547;font-size:12px;margin:6px 0}
#evol-landing details{margin-top:8px}#evol-landing summary{cursor:pointer;color:#8d99ab}
#evol-landing a.link{color:#4cc3ff;text-decoration:none;font-weight:600}#evol-landing a.link:hover{text-decoration:underline}
#evol-landing kbd{font:11px ui-monospace,monospace;background:#1a2230;border:1px solid #3b475a;border-radius:4px;padding:0 4px}
#evol-landing.collapsed .body{display:none}
#evol-listening{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:21;display:none;
  font:600 14px system-ui,sans-serif;color:#0e131b;background:#45d49b;border-radius:99px;padding:8px 18px}
#evol-toasts{position:fixed;right:12px;bottom:12px;z-index:22;display:flex;flex-direction:column;gap:6px;max-width:380px}
#evol-toasts div{font:13px system-ui,sans-serif;color:#e9eef5;background:rgba(14,19,27,.92);border-left:3px solid #4cc3ff;
  border-radius:6px;padding:8px 12px;box-shadow:0 4px 14px rgba(0,0,0,.3)}
#evol-toasts div.error{border-left-color:#ff5d6c}#evol-toasts div.warn{border-left-color:#ffb547}
`;

export class LandingUi {
  private readonly el: HTMLDivElement;
  private readonly listening: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly refs: Record<string, HTMLElement> = {};

  constructor(private readonly actions: LandingActions, settings: ClientSettings, opts: { showXrButtons: boolean }) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.id = 'evol-landing';
    this.el.innerHTML = `
      <h1><span>EvolSpace</span><span class="pill" data-ref="net">connecting…</span></h1>
      <div class="body">
        <div class="dim" data-ref="who"></div>
        <div class="row" data-ref="xrRow">
          <button data-ref="vr">Enter VR</button>
          <button class="alt" data-ref="ar">Enter AR</button>
        </div>
        <div class="row"><button class="ghost" data-ref="exit" style="display:none">Exit XR</button></div>
        <div class="notice" data-ref="pending" style="display:none"></div>
        <div class="row">
          <button class="ghost" data-ref="mic">Enable mic</button>
          <button class="ghost" data-ref="recal" title="Place the space origin at your feet, facing where you look">Recenter space</button>
        </div>
        <div class="dim" data-ref="micState"></div>
        <div class="err" data-ref="micErr"></div>
        <label><input type="checkbox" data-set="handsInVr"> Show hands in VR</label>
        <label><input type="checkbox" data-set="handsInAr"> Show hands in AR (passthrough)</label>
        <label><input type="checkbox" data-set="highRes"> High resolution (sharper text, next session)</label>
        <label><input type="checkbox" data-set="perfOverlay"> Perf overlay</label>
        <div class="dim" data-ref="origin"></div>
        <div class="dim" data-ref="emu"></div>
        <div class="row"><a class="link" data-ref="debug" href="/debug" title="Desktop dashboard: scene tree, inspector, channels, events… (no headset needed)">Debug mode →</a></div>
        <details><summary>Desktop controls</summary><div class="dim" style="margin-top:6px">
          <kbd>RMB</kbd>-drag look · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Q</kbd>/<kbd>E</kbd> down/up ·
          <kbd>Shift</kbd> fast · <kbd>MMB</kbd>/<kbd>Alt</kbd>+drag orbit · wheel dolly<br>
          <kbd>LMB</kbd> hold = pinch (grab / press) · <kbd>Ctrl</kbd>+<kbd>LMB</kbd> = select ·
          wheel while pinching = push/pull · hold <kbd>V</kbd> = push-to-talk · <kbd>P</kbd> perf ·
          <kbd>H</kbd> hide this panel
        </div></details>
      </div>`;
    document.body.appendChild(this.el);
    this.el.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => { this.refs[n.dataset.ref!] = n; });
    if (!opts.showXrButtons) this.refs.xrRow.style.display = 'none';
    // Keep a ?server= override when switching to debug mode (/debug keeps query params).
    const server = new URLSearchParams(location.search).get('server');
    if (server) (this.refs.debug as HTMLAnchorElement).href = `/debug?server=${encodeURIComponent(server)}`;

    this.refs.vr.addEventListener('click', () => actions.enter('vr'));
    this.refs.ar.addEventListener('click', () => actions.enter('ar'));
    this.refs.exit.addEventListener('click', () => actions.exit());
    this.refs.mic.addEventListener('click', () => actions.enableMic());
    this.refs.recal.addEventListener('click', () => actions.recalibrate());
    this.el.querySelectorAll<HTMLInputElement>('input[data-set]').forEach((input) => {
      const key = input.dataset.set as keyof ClientSettings;
      input.checked = Boolean(settings[key]);
      input.addEventListener('change', () => actions.setSetting(key, input.checked as never));
    });
    // Keep page-UI clicks from reaching the desktop pinch/look controls.
    for (const ev of ['pointerdown', 'pointerup', 'wheel', 'contextmenu'] as const) {
      this.el.addEventListener(ev, (e) => e.stopPropagation());
    }

    this.listening = document.createElement('div');
    this.listening.id = 'evol-listening';
    this.listening.textContent = '● Listening…';
    document.body.appendChild(this.listening);

    this.toasts = document.createElement('div');
    this.toasts.id = 'evol-toasts';
    document.body.appendChild(this.toasts);
  }

  toggleCollapsed(): void {
    this.el.classList.toggle('collapsed');
  }

  syncSettings(s: ClientSettings): void {
    this.el.querySelectorAll<HTMLInputElement>('input[data-set]').forEach((input) => {
      input.checked = Boolean(s[input.dataset.set as keyof ClientSettings]);
    });
  }

  render(s: LandingState): void {
    const net = this.refs.net;
    net.textContent = s.net === 'connected' ? (s.primary ? 'connected · primary' : 'connected') : s.net === 'connecting' ? 'connecting…' : 'offline';
    net.className = `pill ${s.net === 'connected' ? 'ok' : s.net === 'offline' ? 'bad' : ''}`;
    this.refs.who.textContent = `role ${s.role}${s.clientId ? ` · ${s.clientId}` : ''}`;
    const vr = this.refs.vr as HTMLButtonElement, ar = this.refs.ar as HTMLButtonElement;
    vr.disabled = !s.xr.vr || s.inXr === 'vr';
    ar.disabled = !s.xr.ar || s.inXr === 'ar';
    vr.title = s.xr.vr ? '' : 'immersive-vr not supported here (try ?emulate=quest3)';
    ar.title = s.xr.ar ? '' : 'immersive-ar not supported here (try ?emulate=quest3)';
    this.refs.exit.style.display = s.inXr ? '' : 'none';
    this.refs.pending.style.display = s.pendingMode ? '' : 'none';
    this.refs.pending.textContent = s.pendingMode ? `Pinch or click to switch to ${s.pendingMode.toUpperCase()}` : '';
    this.refs.micState.textContent = `Mic: ${s.mic}`;
    this.refs.micErr.textContent = s.micError ?? '';
    (this.refs.mic as HTMLButtonElement).disabled = s.mic === 'ready';
    this.refs.origin.textContent = `Space origin: ${s.origin}`;
    this.refs.emu.textContent = s.emulation ? `Emulation: ${s.emulation}` : '';
    this.listening.style.display = s.listening ? 'block' : 'none';
  }

  toast(text: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4000): void {
    const d = document.createElement('div');
    d.className = kind;
    d.textContent = text;
    this.toasts.appendChild(d);
    while (this.toasts.childElementCount > 5) this.toasts.firstElementChild?.remove();
    setTimeout(() => d.remove(), ms);
  }
}
