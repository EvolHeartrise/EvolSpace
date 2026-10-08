// Debug dashboard CSS (dark, compact, runtime theme colors). Injected once.
// Panels can use the classes below (dbg-row, dbg-section, dbg-mono, dbg-badge…)
// and the CSS variables (--bg, --surface, --border, --text, --dim, --accent…).

import type { Theme } from '@evolspace/protocol';

export function debugCss(t: Theme): string {
  return `
@font-face{font-family:'Inter';src:url(/fonts/Inter-Regular.ttf) format('truetype');font-weight:400;font-display:swap}
@font-face{font-family:'Inter';src:url(/fonts/Inter-SemiBold.ttf) format('truetype');font-weight:600;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url(/fonts/JetBrainsMono-Regular.ttf) format('truetype');font-weight:400;font-display:swap}
:root{
  --bg0:#090d13;--bg:${t.background};--bg2:#111823;--surface:${t.surface};--surface2:#222c3c;
  --border:${t.border};--line:#1e2734;--line2:#283244;
  --text:${t.text};--dim:${t.textDim};--faint:#5d697b;
  --accent:${t.accent};--accent2:${t.accent2};--pos:${t.positive};--neg:${t.negative};
  --sel:rgba(76,195,255,.16);--sel2:rgba(76,195,255,.28);--hover:rgba(255,255,255,.045);
  --x:#ff6b7a;--y:#6fdc8c;--z:#5aa9ff;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,Consolas,monospace;
  --dbg-top:40px;
}
body.evol-debug #evol-landing{display:none}
body.evol-debug #evol-toasts{right:calc(var(--dbg-right,0px) + 14px);bottom:calc(var(--dbg-bottom,0px) + 14px);z-index:40}
body.evol-debug #evol-toasts div{font-family:var(--sans);font-size:12.5px;background:rgba(17,24,35,.96);border:1px solid var(--line2);border-left:3px solid var(--accent);white-space:pre-wrap;max-width:420px}
body.evol-debug #evol-toasts div.error{border-left-color:var(--neg)}body.evol-debug #evol-toasts div.warn{border-left-color:var(--accent2)}
body.evol-debug #evol-listening{left:calc(var(--dbg-left,0px) + (100vw - var(--dbg-left,0px) - var(--dbg-right,0px)) / 2);bottom:calc(var(--dbg-bottom,0px) + 18px);z-index:40}
body.dbg-scrubbing,body.dbg-scrubbing *{cursor:ew-resize!important;user-select:none!important}
body.dbg-resizing,body.dbg-resizing *{user-select:none!important}
body.dbg-resizing-x,body.dbg-resizing-x *{cursor:col-resize!important}
body.dbg-resizing-y,body.dbg-resizing-y *{cursor:row-resize!important}

.dbg-root{position:fixed;inset:0;z-index:15;display:grid;font:12.5px/1.4 var(--sans);color:var(--text);background:var(--bg0);
  grid-template-columns:var(--dbg-left) minmax(0,1fr) var(--dbg-right);grid-template-rows:var(--dbg-top) minmax(0,1fr) var(--dbg-bottom);
  grid-template-areas:"tb tb tb" "left view right" "left bottom right";-webkit-font-smoothing:antialiased}
.dbg-root.hidden{display:none}
.dbg-root *{box-sizing:border-box}
.dbg-root ::-webkit-scrollbar{width:10px;height:10px}
.dbg-root ::-webkit-scrollbar-thumb{background:#273142;border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.dbg-root ::-webkit-scrollbar-thumb:hover{background-color:#334055}
.dbg-root ::-webkit-scrollbar-corner{background:transparent}
.dbg-root button{font:inherit;color:inherit}
.dbg-icon{flex:none;display:block}

/* ---------- viewport */
.dbg-view{grid-area:view;position:relative;min-width:0;min-height:0;overflow:hidden;background:#0b0f15}
.dbg-canvas-host{position:absolute;inset:0}
.dbg-canvas-host canvas{display:block;width:100%;height:100%;outline:none;touch-action:none}
.dbg-view-hud{position:absolute;left:10px;top:8px;display:flex;gap:6px;align-items:center;pointer-events:none;font-size:11.5px;color:var(--dim)}
.dbg-view-hud .chip{pointer-events:auto;background:rgba(11,15,21,.72);border:1px solid var(--line2);border-radius:6px;padding:3px 8px;backdrop-filter:blur(4px);display:flex;gap:6px;align-items:center}
.dbg-view-hud .chip b{color:var(--text);font-weight:600}
.dbg-view-help{position:absolute;right:10px;bottom:8px;font-size:11px;color:var(--faint);pointer-events:none;text-align:right;line-height:1.6}
.dbg-view-help kbd,.dbg-kbd{font:10.5px var(--mono);color:var(--dim);background:rgba(26,34,48,.85);border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;padding:0 4px;margin:0 1px}

/* ---------- toolbar */
.dbg-toolbar{grid-area:tb;display:flex;align-items:center;gap:6px;padding:0 8px;background:var(--bg0);border-bottom:1px solid var(--line);min-width:0;overflow:hidden}
.dbg-brand{display:flex;align-items:center;gap:7px;font-weight:600;letter-spacing:.2px;padding-right:6px;white-space:nowrap}
.dbg-brand .logo{width:18px;height:18px;border-radius:5px;background:conic-gradient(from 210deg,var(--accent),#a98bff,var(--accent2),var(--accent));box-shadow:0 0 0 1px rgba(255,255,255,.08) inset}
.dbg-brand .tag{font:600 9.5px/1 var(--sans);letter-spacing:.08em;color:var(--accent2);border:1px solid rgba(255,181,71,.35);background:rgba(255,181,71,.08);border-radius:4px;padding:3px 5px}
.dbg-tsep{width:1px;height:20px;background:var(--line2);margin:0 4px;flex:none}
.dbg-tgroup{display:flex;align-items:center;gap:2px;min-width:0}
.dbg-tspacer{flex:1}
.dbg-conn{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:6px;color:var(--dim);font:11.5px var(--mono);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.dbg-ws{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px 0 9px;border-radius:6px;border:1px solid var(--line2);background:var(--bg2);cursor:pointer;white-space:nowrap;max-width:240px}
.dbg-ws:hover{border-color:var(--border);background:var(--surface)}
.dbg-ws .n{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dbg-ws .k{color:var(--faint);font-size:11px}
.dbg-ver{font:11px var(--mono);color:var(--faint);padding:0 4px;white-space:nowrap}
.dbg-headset{display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--line2);font-size:12px;white-space:nowrap;color:var(--dim)}
.dbg-headset.on{color:var(--text);border-color:rgba(69,212,155,.35);background:rgba(69,212,155,.07)}

/* ---------- buttons */
.dbg-ibtn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:28px;height:28px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dim);cursor:pointer;flex:none}
.dbg-ibtn:hover:not(:disabled){background:var(--hover);color:var(--text)}
.dbg-ibtn.on{color:var(--accent);background:rgba(76,195,255,.1);border-color:rgba(76,195,255,.25)}
.dbg-ibtn:disabled{opacity:.35;cursor:default}
.dbg-ibtn.danger:hover{color:var(--neg)}
.dbg-ibtn.labeled{padding:0 9px 0 7px;font-size:12px}
.dbg-ibtn.sm{min-width:22px;height:22px;padding:0 3px;border-radius:5px}
.dbg-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:6px;border:1px solid var(--line2);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;white-space:nowrap}
.dbg-btn:hover:not(:disabled){border-color:var(--border);background:var(--surface2)}
.dbg-btn.primary{background:var(--accent);border-color:var(--accent);color:#06121b;font-weight:600}
.dbg-btn.primary:hover:not(:disabled){background:#6fd0ff;border-color:#6fd0ff}
.dbg-btn.danger{color:var(--neg)}
.dbg-btn.small{height:22px;padding:0 8px;font-size:11.5px}
.dbg-btn:disabled{opacity:.4;cursor:default}

/* ---------- docks */
.dbg-dock{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg);overflow:hidden}
.dbg-dock.left{grid-area:left;border-right:1px solid var(--line)}
.dbg-dock.right{grid-area:right;border-left:1px solid var(--line)}
.dbg-dock.bottom{grid-area:bottom;border-top:1px solid var(--line)}
.dbg-tabs{display:flex;align-items:stretch;height:32px;flex:none;background:var(--bg2);border-bottom:1px solid var(--line);padding-left:2px;min-width:0}
.dbg-tabs .list{display:flex;align-items:stretch;min-width:0;overflow-x:auto;scrollbar-width:none;flex:1}
.dbg-tabs .list::-webkit-scrollbar{display:none}
.dbg-tab{display:flex;align-items:center;gap:6px;padding:0 11px;border:0;background:transparent;color:var(--dim);cursor:pointer;white-space:nowrap;position:relative;font-size:12px}
.dbg-tab:hover{color:var(--text);background:var(--hover)}
.dbg-tab.on{color:var(--text);background:var(--bg)}
.dbg-tab.on::after{content:'';position:absolute;left:8px;right:8px;top:0;height:2px;border-radius:0 0 2px 2px;background:var(--accent)}
.dbg-tab .b{font:600 10px/1 var(--sans);padding:2px 5px;border-radius:8px;background:var(--surface2);color:var(--dim)}
.dbg-tab .b.err{background:rgba(255,93,108,.18);color:var(--neg)}
.dbg-tabs .tools{display:flex;align-items:center;gap:1px;padding:0 4px;flex:none}
.dbg-dock-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.dbg-rail{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;background:var(--bg2);height:100%}
.dbg-rail .dbg-tab{writing-mode:vertical-rl;transform:rotate(180deg);padding:10px 0;width:100%;justify-content:center}
.dbg-dock.right .dbg-rail .dbg-tab{transform:none}
.dbg-rail .dbg-tab.on::after{display:none}
.dbg-resizer{position:absolute;z-index:5;background:transparent;transition:background .12s}
.dbg-resizer:hover,.dbg-resizer.active{background:rgba(76,195,255,.45)}
.dbg-dock.left .dbg-resizer{top:0;bottom:0;right:-2px;width:5px;cursor:col-resize}
.dbg-dock.right .dbg-resizer{top:0;bottom:0;left:-2px;width:5px;cursor:col-resize}
.dbg-dock.bottom .dbg-resizer{left:0;right:0;top:-2px;height:5px;cursor:row-resize}
.dbg-panel-error{padding:14px;color:var(--neg);font:12px var(--mono);white-space:pre-wrap;overflow:auto}

/* ---------- panel scaffolding */
.dbg-pbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--line);flex:none;min-width:0}
.dbg-pbar .grow{flex:1;min-width:0}
.dbg-scroll{flex:1;min-height:0;overflow:auto;position:relative}
.dbg-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 18px;color:var(--faint);text-align:center;height:100%}
.dbg-empty .t{color:var(--dim);font-weight:600}
.dbg-empty .d{font-size:12px;max-width:340px;line-height:1.5}
.dbg-search{display:flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 8px;border:1px solid var(--line2);border-radius:6px;background:var(--bg0);color:var(--faint);flex:1;min-width:0}
.dbg-search:focus-within{border-color:rgba(76,195,255,.6);color:var(--dim)}
.dbg-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font:12px var(--sans)}
.dbg-search .clear{display:flex;border:0;background:transparent;color:var(--faint);cursor:pointer;padding:2px}
.dbg-count{font:11px var(--mono);color:var(--faint)}
.dbg-mono{font-family:var(--mono);font-size:11.5px}
.dbg-mono.dim{color:var(--faint)}
.dbg-dim{color:var(--dim)}
.dbg-badge{display:inline-flex;align-items:center;gap:4px;font:600 10.5px/1 var(--sans);padding:3px 6px;border-radius:5px;white-space:nowrap}
.dbg-badge.dim{background:var(--surface);color:var(--dim)}
.dbg-badge.info{background:rgba(76,195,255,.12);color:var(--accent)}
.dbg-badge.ok{background:rgba(69,212,155,.12);color:var(--pos)}
.dbg-badge.warn{background:rgba(255,181,71,.13);color:var(--accent2)}
.dbg-badge.error{background:rgba(255,93,108,.15);color:var(--neg)}
.dbg-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--faint)}
.dbg-dot.ok{background:var(--pos);box-shadow:0 0 0 3px rgba(69,212,155,.15)}
.dbg-dot.warn{background:var(--accent2);box-shadow:0 0 0 3px rgba(255,181,71,.15)}
.dbg-dot.error{background:var(--neg);box-shadow:0 0 0 3px rgba(255,93,108,.15)}
.dbg-dot.busy{background:var(--accent);animation:dbgpulse 1s ease-in-out infinite}
@keyframes dbgpulse{50%{opacity:.35}}

/* ---------- sections / property rows */
.dbg-section{border-bottom:1px solid var(--line)}
.dbg-section>header{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px 0 7px;cursor:pointer;user-select:none;color:var(--dim);position:sticky;top:0;background:var(--bg);z-index:1}
.dbg-section>header:hover{color:var(--text)}
.dbg-section>header .t{font:600 10.5px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase}
.dbg-section>header .sp{flex:1}
.dbg-section>header .acts{display:flex;gap:2px}
.dbg-section>.body{padding:2px 10px 10px}
.dbg-row{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;gap:8px;min-height:28px;padding:1px 0}
.dbg-row>label{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-row>.v{min-width:0;display:flex;align-items:center;gap:6px}
.dbg-row.dim>label{color:var(--faint)}
.dbg-row.top{align-items:start}.dbg-row.top>label{padding-top:5px}

/* ---------- fields */
.dbg-num{display:flex;align-items:center;height:24px;border:1px solid var(--line2);border-radius:5px;background:var(--bg0);min-width:0;flex:1;cursor:ew-resize;overflow:hidden}
.dbg-num:hover{border-color:#36435a}
.dbg-num.editing,.dbg-num:focus-within{border-color:rgba(76,195,255,.65);cursor:text}
.dbg-num .lbl{flex:none;width:18px;text-align:center;font:600 10px/22px var(--sans);color:var(--faint);background:rgba(255,255,255,.03);border-right:1px solid var(--line2);user-select:none}
.dbg-num .lbl.x{color:var(--x)}.dbg-num .lbl.y{color:var(--y)}.dbg-num .lbl.z{color:var(--z)}
.dbg-num input{flex:1;min-width:0;width:100%;height:100%;border:0;outline:0;background:transparent;color:var(--text);font:11.5px var(--mono);padding:0 6px;cursor:inherit}
.dbg-num.disabled{opacity:.5;cursor:default}
.dbg-vec3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;flex:1;min-width:0}
.dbg-text{height:24px;border:1px solid var(--line2);border-radius:5px;background:var(--bg0);color:var(--text);font:12px var(--sans);padding:0 7px;outline:0;min-width:0;flex:1;width:100%}
.dbg-text.mono{font:11.5px var(--mono)}
.dbg-text:hover{border-color:#36435a}.dbg-text:focus{border-color:rgba(76,195,255,.65)}
.dbg-select{height:24px;border:1px solid var(--line2);border-radius:5px;background:var(--bg0);color:var(--text);font:12px var(--sans);padding:0 4px;outline:0;flex:1;min-width:0}
.dbg-select:focus{border-color:rgba(76,195,255,.65)}
.dbg-slider{display:grid;grid-template-columns:minmax(0,1fr) 76px;gap:8px;align-items:center;flex:1;min-width:0}
.dbg-slider input[type=range]{width:100%;accent-color:var(--accent);height:16px;margin:0}
.dbg-color{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.dbg-color .sw{position:relative;width:24px;height:24px;border-radius:5px;border:1px solid var(--line2);flex:none;cursor:pointer;overflow:hidden}
.dbg-color .sw input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.dbg-json{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dbg-json textarea{width:100%;resize:vertical;border:1px solid var(--line2);border-radius:5px;background:var(--bg0);color:var(--text);font:11.5px/1.45 var(--mono);padding:5px 7px;outline:0;tab-size:2}
.dbg-json textarea:focus{border-color:rgba(76,195,255,.65)}
.dbg-json.invalid textarea{border-color:rgba(255,93,108,.7)}
.dbg-json .err{color:var(--neg);font:11px var(--mono)}
.dbg-json .hint{color:var(--faint);font-size:11px}
.dbg-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.dbg-switch input{position:absolute;opacity:0;width:0;height:0}
.dbg-switch .track{width:28px;height:16px;border-radius:9px;background:var(--surface2);border:1px solid var(--line2);position:relative;transition:background .12s}
.dbg-switch .knob{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--dim);transition:left .12s,background .12s}
.dbg-switch.on .track{background:rgba(76,195,255,.35);border-color:rgba(76,195,255,.5)}
.dbg-switch.on .knob{left:14px;background:var(--accent)}
.dbg-switch input:focus-visible+.track{outline:1px solid var(--accent)}
.dbg-switch.disabled{opacity:.45;cursor:default}
.dbg-switch .l{color:var(--dim);font-size:12px}

/* ---------- menus & dialogs */
.dbg-menu{position:fixed;z-index:60;min-width:190px;padding:4px;border-radius:8px;background:#151d29;border:1px solid var(--line2);box-shadow:0 12px 32px rgba(0,0,0,.5);font:12.5px var(--sans);color:var(--text)}
.dbg-menu .it{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 10px 0 6px;border:0;border-radius:5px;background:transparent;cursor:pointer;text-align:left}
.dbg-menu .it:hover:not(:disabled){background:var(--sel)}
.dbg-menu .it:disabled{opacity:.4;cursor:default}
.dbg-menu .it.danger{color:var(--neg)}
.dbg-menu .it .ic{width:16px;display:flex;justify-content:center;color:var(--dim)}
.dbg-menu .it .l{flex:1;white-space:nowrap}
.dbg-menu .it .h{color:var(--faint);font:11px var(--mono);padding-left:18px}
.dbg-menu .sep{height:1px;background:var(--line2);margin:4px 2px}
.dbg-menu .hdr{font:600 10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:6px 8px 3px}
.dbg-modal{position:fixed;inset:0;z-index:70;background:rgba(5,8,12,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:16vh}
.dbg-dialog{width:360px;max-width:calc(100vw - 32px);background:#151d29;border:1px solid var(--line2);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:9px;box-shadow:0 18px 50px rgba(0,0,0,.55);font:12.5px var(--sans);color:var(--text)}
.dbg-dialog .title{font-weight:600;font-size:14px}
.dbg-dialog label{color:var(--dim)}
.dbg-dialog .dbg-text{height:30px;font-size:13px}
.dbg-dialog .err{color:var(--neg);font-size:11.5px}
.dbg-dialog .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}

/* ---------- scene tree */
.dbg-tree{padding:4px 0 24px;min-height:100%}
.dbg-tree.drop-root{box-shadow:inset 0 0 0 1px rgba(76,195,255,.6)}
.dbg-trow{display:flex;align-items:center;gap:5px;height:26px;padding-right:6px;cursor:default;position:relative;white-space:nowrap;outline:0}
.dbg-trow:hover{background:var(--hover)}
.dbg-trow.sel{background:var(--sel)}
.dbg-trow.sel:focus-visible,.dbg-trow:focus-visible{box-shadow:inset 0 0 0 1px rgba(76,195,255,.6)}
.dbg-trow.drop{box-shadow:inset 0 0 0 1.5px var(--accent);background:var(--sel)}
.dbg-trow.hidden-e .name,.dbg-trow.hidden-e .ico{opacity:.45}
.dbg-trow .tw{width:16px;height:16px;display:flex;align-items:center;justify-content:center;color:var(--faint);flex:none;border-radius:4px}
.dbg-trow .tw:hover{color:var(--text);background:var(--hover)}
.dbg-trow .ico{width:16px;height:16px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:700 9px/1 var(--sans);color:#0b0f15}
.dbg-trow .name{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.dbg-trow .wid{color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1000 auto}
.dbg-trow .sp{flex:1 1 0;min-width:4px}
.dbg-trow .id{font:10.5px var(--mono);color:var(--faint);flex:none}
.dbg-trow .err{color:var(--neg);display:flex;flex:none}
.dbg-trow .tg{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:4px;background:transparent;color:var(--faint);cursor:pointer;flex:none;opacity:0}
.dbg-trow:hover .tg,.dbg-trow .tg.set{opacity:1}
.dbg-trow .tg.set{color:var(--accent2)}
.dbg-trow .tg:hover{color:var(--text);background:var(--hover)}
.dbg-trow mark{background:rgba(255,181,71,.25);color:inherit;border-radius:2px}
.dbg-guide{position:absolute;top:0;bottom:0;width:1px;background:var(--line2)}

/* ---------- inspector */
.dbg-insp-head{display:flex;flex-direction:column;gap:6px;padding:10px 10px 10px;border-bottom:1px solid var(--line)}
.dbg-insp-head .l1{display:flex;align-items:center;gap:8px}
.dbg-insp-head .ico{width:26px;height:26px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;font:700 11px/1 var(--sans);color:#0b0f15}
.dbg-insp-head .nm{flex:1;min-width:0}
.dbg-insp-head .nm .dbg-text{height:28px;font-size:13.5px;font-weight:600;background:transparent;border-color:transparent;padding:0 6px}
.dbg-insp-head .nm .dbg-text:hover{border-color:var(--line2)}.dbg-insp-head .nm .dbg-text:focus{border-color:rgba(76,195,255,.65);background:var(--bg0)}
.dbg-insp-head .l2{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dim);font-size:12px}
.dbg-insp-head .desc{color:var(--faint);font-size:11.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.dbg-insp-head .desc.open{display:block;-webkit-line-clamp:unset}
.dbg-insp-head .desc:hover{color:var(--dim)}
.dbg-insp-head .errbox{background:rgba(255,93,108,.08);border:1px solid rgba(255,93,108,.3);color:#ff9aa5;border-radius:6px;padding:6px 8px;font:11px/1.45 var(--mono);white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.dbg-idchip{display:inline-flex;align-items:center;gap:4px;font:11px var(--mono);color:var(--dim);background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:2px 4px 2px 6px;cursor:pointer}
.dbg-idchip:hover{color:var(--text);border-color:var(--border)}
.dbg-propname{display:flex;align-items:center;gap:4px;min-width:0}
.dbg-propname .n{overflow:hidden;text-overflow:ellipsis}
.dbg-propname .def{width:5px;height:5px;border-radius:50%;background:var(--accent);flex:none}
.dbg-ports{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
.dbg-ports td{padding:3px 4px;border-bottom:1px solid var(--line);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-ports td.n{width:34%;color:var(--text)}
.dbg-ports td.t{width:58px;color:var(--faint);font:10.5px var(--mono)}
.dbg-ports td.val{font:11.5px var(--mono);color:var(--accent)}
.dbg-ports td.val.none{color:var(--faint)}
.dbg-ports tr.flash td.val{animation:dbgflash .6s ease-out}
@keyframes dbgflash{from{background:rgba(76,195,255,.25)}to{background:transparent}}
.dbg-sub{font:600 10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:8px 0 3px}
.dbg-linkrow{display:flex;align-items:center;gap:6px;min-height:24px;font:11.5px var(--mono);color:var(--dim)}
.dbg-linkrow .ref{color:var(--text);cursor:pointer;border-radius:3px;padding:0 2px}
.dbg-linkrow .ref:hover{background:var(--hover);color:var(--accent)}
.dbg-linkrow .arrow{color:var(--faint)}
.dbg-linkrow .tf{color:var(--accent2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-pre{margin:0;font:11px/1.5 var(--mono);color:var(--dim);white-space:pre-wrap;word-break:break-word;background:var(--bg0);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:320px;overflow:auto}
`;
}

export function injectDebugStyles(theme: Theme): HTMLStyleElement {
  const el = document.createElement('style');
  el.id = 'evol-debug-css';
  el.textContent = debugCss(theme);
  document.head.appendChild(el);
  return el;
}
