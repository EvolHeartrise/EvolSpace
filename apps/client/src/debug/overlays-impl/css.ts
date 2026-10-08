// Styles of the Hands and View panels + viewport overlays (injected once; uses the
// dashboard's CSS variables from ../styles.ts).

export const PANELS_C_CSS = `
.hx-seg{display:inline-flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden;flex:none;background:var(--bg0)}
.hx-seg button{border:0;background:transparent;color:var(--dim);font:11.5px var(--sans);height:22px;padding:0 8px;cursor:pointer}
.hx-seg button+button{border-left:1px solid var(--line2)}
.hx-seg button:hover{color:var(--text);background:var(--hover)}
.hx-seg button.on{color:var(--accent);background:rgba(76,195,255,.12)}
.hx-hold{flex:1;height:28px;border-radius:6px;border:1px dashed rgba(76,195,255,.45);background:rgba(76,195,255,.06);color:var(--accent);font:600 12px var(--sans);cursor:pointer;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;gap:6px}
.hx-hold:hover{background:rgba(76,195,255,.12)}
.hx-hold.on{background:var(--accent);color:#06121b;border-style:solid;box-shadow:0 0 0 3px rgba(76,195,255,.18)}
.hx-hold:disabled{opacity:.4;cursor:default}
.hx-hand-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:24px;margin:2px 0 4px;font-size:12px;color:var(--dim)}
.hx-hand-head .src{font:11px var(--mono);color:var(--faint)}
.hx-chips{display:flex;flex-wrap:wrap;gap:3px;min-width:0}
.hx-chip{font:10.5px/1 var(--mono);padding:3px 5px;border-radius:4px;background:var(--surface);color:var(--dim);white-space:nowrap;border:1px solid transparent}
.hx-chip.on{background:rgba(76,195,255,.14);color:var(--accent);border-color:rgba(76,195,255,.3)}
.hx-chip.ok{background:rgba(69,212,155,.12);color:var(--pos)}
.hx-chip.warn{background:rgba(255,181,71,.12);color:var(--accent2)}
.hx-chip.bad{background:rgba(255,93,108,.12);color:var(--neg)}
.hx-chip.cond{cursor:default}
.hx-fingers{display:grid;grid-template-columns:52px minmax(0,1fr) 38px;gap:2px 8px;align-items:center;padding:2px 0 4px}
.hx-fingers label{color:var(--dim);font-size:11.5px}
.hx-fingers input[type=range]{width:100%;accent-color:var(--accent);height:14px;margin:0}
.hx-fingers .v{font:11px var(--mono);color:var(--text);text-align:right}
.hx-fingers .v.auto{color:var(--faint)}
.hx-sub{display:flex;align-items:center;gap:6px;margin:6px 0 2px;font:600 10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);cursor:pointer;user-select:none}
.hx-sub:hover{color:var(--dim)}
.hx-feat{display:grid;grid-template-columns:minmax(0,1fr) 112px 112px;gap:1px 8px;align-items:center;font-size:11.5px}
.hx-feat .h{font:600 10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:2px 0 4px}
.hx-feat .n{color:var(--dim);font:11px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hx-feat .n.c{color:var(--text)}
.hx-cell{display:flex;align-items:center;gap:5px;min-width:0;height:17px}
.hx-bar{position:relative;flex:1;height:6px;border-radius:3px;background:var(--bg0);border:1px solid var(--line);overflow:hidden}
.hx-bar .band{position:absolute;top:0;bottom:0;background:rgba(76,195,255,.22)}
.hx-bar .fill{position:absolute;top:0;bottom:0;left:0;background:#3a4a62}
.hx-bar .mk{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;background:var(--text)}
.hx-cell.in .hx-bar .fill{background:rgba(69,212,155,.55)}.hx-cell.in .mk{background:var(--pos)}
.hx-cell.out .hx-bar .fill{background:rgba(255,93,108,.45)}.hx-cell.out .mk{background:var(--neg)}
.hx-cell .num{font:10.5px var(--mono);color:var(--dim);width:40px;text-align:right;flex:none}
.hx-cell.in .num{color:var(--pos)}.hx-cell.out .num{color:var(--neg)}
.hx-cell.na{color:var(--faint);font:10.5px var(--mono)}
.hx-ex{display:grid;grid-template-columns:96px minmax(0,1fr);gap:2px 8px;align-items:center;font-size:11.5px}
.hx-ex .p{display:flex}
.hx-ex .b{display:flex;align-items:center;gap:5px;min-width:0;color:var(--dim);white-space:nowrap;overflow:hidden}
.hx-ex .b .id{color:var(--text);font:11px var(--mono)}
.hx-ex .b .act{color:var(--accent2);font:11px var(--mono);overflow:hidden;text-overflow:ellipsis}
.hx-ex .b .tg{color:var(--dim);overflow:hidden;text-overflow:ellipsis}
.hx-ex .b.none{color:var(--faint)}
.hx-ex .b.fire .id{color:var(--pos)}
.hx-scope{font:600 9.5px/1 var(--sans);letter-spacing:.04em;padding:2px 4px;border-radius:3px;background:var(--surface2);color:var(--dim);text-transform:uppercase;flex:none}
.hx-scope.entity{background:rgba(169,139,255,.18);color:#c3b0ff}.hx-scope.widget{background:rgba(255,181,71,.15);color:var(--accent2)}
.hx-scope.entity-default{background:rgba(76,195,255,.13);color:var(--accent)}.hx-scope.global{background:rgba(69,212,155,.12);color:var(--pos)}
.hx-kv{display:flex;align-items:center;gap:6px;min-height:22px;font-size:12px;color:var(--dim);min-width:0}
.hx-kv b{color:var(--text);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hx-lib-pose{padding:6px 0;border-bottom:1px solid var(--line)}
.hx-lib-pose:last-child{border-bottom:0}
.hx-lib-pose .t{display:flex;align-items:center;gap:6px}
.hx-lib-pose .t .id{font:600 12px var(--mono);color:var(--text)}
.hx-lib-pose .d{color:var(--faint);font-size:11.5px;line-height:1.4;margin:2px 0 4px}
.hx-lib-bind{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 6px;align-items:center;padding:3px 0;font-size:11.5px}
.hx-lib-bind .l{display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap;overflow:hidden}
.hx-lib-bind .l .id{font:11px var(--mono);color:var(--text)}
.hx-lib-bind .l .act{font:11px var(--mono);color:var(--accent2);overflow:hidden;text-overflow:ellipsis}
.hx-lib-bind .r{color:var(--faint);font:10.5px var(--mono)}
.hx-progress{height:4px;border-radius:2px;background:var(--bg0);overflow:hidden;flex:1}
.hx-progress>div{height:100%;background:var(--accent);transition:width .1s linear}
.hx-path{display:inline-flex;align-items:center;gap:4px;font:11px var(--mono);color:var(--accent);cursor:pointer;border-radius:4px;padding:1px 3px}
.hx-path:hover{background:var(--hover)}
.hx-note{color:var(--faint);font-size:11.5px;line-height:1.45;margin:4px 0}
.hx-warn{color:var(--accent2);font-size:11.5px;line-height:1.45}

/* ---- view panel */
.vw-ov{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:0 9px;align-items:center;min-height:30px;padding:2px 0;border-bottom:1px solid var(--line)}
.vw-ov:last-child{border-bottom:0}
.vw-ov .sw{width:9px;height:9px;border-radius:2px;flex:none}
.vw-ov .tx{min-width:0}
.vw-ov .tx .t{font-size:12.5px;color:var(--text)}
.vw-ov .tx .d{font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vw-ov.off .tx .t{color:var(--dim)}
.vw-btns{display:flex;flex-wrap:wrap;gap:5px}
.vw-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.vw-stat{background:var(--bg0);border:1px solid var(--line);border-radius:6px;padding:5px 7px;min-width:0}
.vw-stat .k{font:600 9.5px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);white-space:nowrap}
.vw-stat .v{font:13px var(--mono);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-stat .v small{font-size:10.5px;color:var(--faint)}
.vw-spark{display:block;width:100%;height:34px;margin-top:6px}
.vw-cost{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed;margin-top:6px}
.vw-cost td{padding:2px 4px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-cost td.n{color:var(--text);cursor:pointer}.vw-cost td.n:hover{color:var(--accent)}
.vw-cost td.num{font:11px var(--mono);color:var(--dim);text-align:right;width:62px}
.vw-follow{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:rgba(69,212,155,.08);border:1px solid rgba(69,212,155,.3);color:var(--pos);font-size:12px;margin-bottom:6px}

/* ---- viewport DOM overlays (labels, follow letterbox) */
.vw-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2}
.vw-label{position:absolute;left:0;top:0;white-space:nowrap;font:11px/1.25 var(--sans);color:#dbe6f5;background:rgba(9,13,19,.78);border:1px solid rgba(255,255,255,.08);border-radius:4px;padding:2px 6px;will-change:transform;display:none}
.vw-label .w{color:#8a97aa}.vw-label .i{font:10px var(--mono);color:#5d697b}
.vw-label{opacity:.88}.vw-label.sel{border-color:rgba(76,195,255,.6);color:#fff;opacity:1;z-index:1}
.vw-label.headset{background:rgba(69,212,155,.16);border-color:rgba(69,212,155,.5);color:#bff3dc;font-weight:600}
.vw-label.hit{background:rgba(255,181,71,.14);border-color:rgba(255,181,71,.45);color:#ffd9a0;font-size:10.5px}
.vw-frame{position:absolute;pointer-events:none;border:1.5px solid rgba(69,212,155,.7);border-radius:3px;box-shadow:0 0 0 9999px rgba(5,8,12,.35);z-index:2}
.vw-frame .tag{position:absolute;left:6px;top:5px;font:600 10.5px var(--sans);color:#bff3dc;background:rgba(9,13,19,.7);border-radius:3px;padding:2px 6px;letter-spacing:.02em}
`;

export function injectPanelsCss(): () => void {
  if (typeof document === 'undefined') return () => {};
  let el = document.getElementById('dbg-css-panels-c') as HTMLStyleElement | null;
  if (el) return () => {};
  el = document.createElement('style');
  el.id = 'dbg-css-panels-c';
  el.textContent = PANELS_C_CSS;
  document.head.appendChild(el);
  return () => el?.remove();
}
