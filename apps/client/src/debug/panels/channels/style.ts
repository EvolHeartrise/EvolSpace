// Injects a panel's CSS once (idempotent; survives HMR by id). Panels A
// (links, widgets, channels) keep their styles next to their code instead of
// the shared styles.ts.

export function ensureStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

export const CHANNELS_CSS = `
.dbg-ch{display:flex;flex:1;min-height:0;min-width:0;outline:0}
.dbg-ch-list{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1 1 55%;container-type:inline-size}
.dbg-ch.has-detail .dbg-ch-list{flex:0 0 var(--ch-list-w,46%);max-width:70%;min-width:260px}
.dbg-ch-split{flex:none;width:5px;margin:0 -2px;cursor:col-resize;position:relative;z-index:2;background:transparent;transition:background .12s}
.dbg-ch-split:hover,.dbg-ch-split.active{background:rgba(76,195,255,.45)}
.dbg-ch-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--line)}
.dbg-ch-head,.dbg-ch-row{display:grid;grid-template-columns:minmax(90px,1fr) 104px 58px 50px 44px 40px minmax(60px,110px);align-items:center;gap:8px;padding:0 10px 0 8px}
.dbg-ch-head{height:24px;font:600 10px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line);flex:none;background:var(--bg)}
.dbg-ch-head>span:nth-child(n+3):not(:last-child),.dbg-ch-row>span:nth-child(n+3):not(:last-child){text-align:right}
.dbg-ch-row{height:24px;cursor:default;white-space:nowrap;font-size:12px;position:absolute;left:0;right:0}
.dbg-ch-row>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dbg-ch-row:hover{background:var(--hover)}
.dbg-ch-row.sel{background:var(--sel)}
.dbg-ch-row .nm{font:11.5px var(--mono);color:var(--text)}
.dbg-ch-row .nm mark{background:rgba(255,181,71,.25);color:inherit;border-radius:2px}
.dbg-ch-row .ty{font:11px var(--mono);color:var(--accent)}
.dbg-ch-row .ty.json{color:var(--dim)}
.dbg-ch-row .n{font:11px var(--mono);color:var(--dim)}
.dbg-ch-row .rate{color:var(--pos)}
.dbg-ch-row .pr{color:var(--faint);font-size:11.5px}
.dbg-ch-row.fresh .seq{animation:dbgflash .6s ease-out}
@container (max-width:520px){
  .dbg-ch-head,.dbg-ch-row{grid-template-columns:minmax(90px,1fr) 100px 56px 46px 42px 34px}
  .dbg-ch-head>span:last-child,.dbg-ch-row>span:last-child{display:none}
}
@container (max-width:440px){
  .dbg-ch-head,.dbg-ch-row{grid-template-columns:minmax(90px,1fr) 96px 44px 42px 32px}
  .dbg-ch-head>span:nth-child(3),.dbg-ch-row>span:nth-child(3),.dbg-ch-head>span:last-child,.dbg-ch-row>span:last-child{display:none}
}
@container (max-width:340px){
  .dbg-ch-head,.dbg-ch-row{grid-template-columns:minmax(80px,1fr) 88px 34px}
  .dbg-ch-head>span:nth-child(3),.dbg-ch-row>span:nth-child(3),.dbg-ch-head>span:nth-child(5),.dbg-ch-row>span:nth-child(5),.dbg-ch-head>span:nth-child(6),.dbg-ch-row>span:nth-child(6),.dbg-ch-head>span:last-child,.dbg-ch-row>span:last-child{display:none}
}
.dbg-vlist{flex:1;min-height:0;overflow:auto;position:relative}
.dbg-ch-dhead{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 10px;border-bottom:1px solid var(--line);flex:none;min-width:0;height:37px}
.dbg-ch-dhead .t{font:600 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}
.dbg-ch-dhead .live{display:flex;align-items:center;gap:5px;color:var(--faint);font-size:11px;white-space:nowrap}
.dbg-ch-body{flex:1;min-height:0;overflow:auto;padding:8px 10px 12px;display:flex;flex-direction:column;gap:8px}
.dbg-ch-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;color:var(--faint);font-size:11px}
.dbg-ch-meta .desc{color:var(--dim);font-size:11.5px;flex-basis:100%}
.dbg-stats{display:flex;flex-wrap:wrap;gap:3px 14px;font:11px var(--mono);color:var(--dim)}
.dbg-stats b{font-weight:400;color:var(--faint);margin-right:4px;font-family:var(--sans);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.dbg-stats .bad{color:var(--neg)}
.dbg-big{font:600 22px/1.1 var(--mono);color:var(--text);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;word-break:break-all}
.dbg-big .u{font:11px var(--sans);color:var(--faint)}
.dbg-viz{position:relative;width:100%;min-width:0}
.dbg-viz canvas{display:block;width:100%;border-radius:5px;background:var(--bg0);border:1px solid var(--line)}
.dbg-viz .tip{position:absolute;pointer-events:none;font:10.5px var(--mono);background:rgba(11,15,21,.92);border:1px solid var(--line2);color:var(--text);border-radius:4px;padding:2px 6px;white-space:nowrap;z-index:2}
.dbg-viz .axis{display:flex;justify-content:space-between;font:10px var(--mono);color:var(--faint);margin-top:2px;gap:8px}
.dbg-legend{display:flex;align-items:center;gap:6px;font:10px var(--mono);color:var(--faint);flex:none}
.dbg-legend .bar{height:7px;width:96px;flex:none;border-radius:3px;border:1px solid var(--line)}
.dbg-slices{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.dbg-slices .ax{display:flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--dim)}
.dbg-slices .ax input[type=range]{width:120px;accent-color:var(--accent);height:14px;margin:0}
.dbg-slices .ax .i{min-width:44px;color:var(--text)}
.dbg-quick{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dbg-quick .dbg-slider{max-width:420px}
.dbg-quick .lbl{font:600 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.dbg-edit{display:flex;flex-direction:column;gap:5px;border:1px solid var(--line2);border-radius:6px;padding:7px;background:var(--bg2)}
.dbg-edit .bar{display:flex;align-items:center;gap:6px}
.dbg-edit textarea{width:100%;resize:vertical;border:1px solid var(--line2);border-radius:5px;background:var(--bg0);color:var(--text);font:11.5px/1.45 var(--mono);padding:5px 7px;outline:0;tab-size:2;min-height:54px}
.dbg-edit textarea:focus{border-color:rgba(76,195,255,.65)}
.dbg-edit.invalid textarea{border-color:rgba(255,93,108,.7)}
.dbg-edit .err{color:var(--neg);font:11px var(--mono)}
.dbg-edit .hint{color:var(--faint);font-size:11px}
.dbg-jt{font:11.5px/1.55 var(--mono);color:var(--text);background:var(--bg0);border:1px solid var(--line);border-radius:6px;padding:5px 8px;overflow:auto;max-height:none}
.dbg-jt .ln{white-space:nowrap;display:flex;align-items:baseline;gap:0}
.dbg-jt .tg{display:inline-flex;width:14px;justify-content:center;color:var(--faint);cursor:pointer;flex:none;align-self:center}
.dbg-jt .tg:hover{color:var(--text)}
.dbg-jt .sp{display:inline-block;width:14px;flex:none}
.dbg-jt .k{color:#9fb3cc}
.dbg-jt .s{color:#a7e3a1;white-space:pre}
.dbg-jt .num{color:var(--accent)}
.dbg-jt .b{color:var(--accent2)}
.dbg-jt .nul{color:var(--faint)}
.dbg-jt .sum{color:var(--faint);cursor:pointer}
.dbg-jt .sum:hover{color:var(--dim)}
.dbg-jt .more{color:var(--faint);font-style:italic}
.dbg-confirm{color:var(--neg)!important;background:rgba(255,93,108,.12)!important;border-color:rgba(255,93,108,.35)!important}
`;
