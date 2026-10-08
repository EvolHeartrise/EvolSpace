// Events panel CSS (injected once by events.tsx via ensureCss).

export const EVENTS_CSS = `
.dbg-ev-bar{gap:6px}
.dbg-ev-bar .dbg-search{flex:0 1 240px;min-width:120px}
.dbg-ev-chips{display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent);padding-right:18px}
.dbg-ev-chips::-webkit-scrollbar{display:none}
.dbg-ev-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px 0 6px;border-radius:11px;border:1px solid var(--line2);background:transparent;color:var(--dim);cursor:pointer;font:11px var(--sans);white-space:nowrap;flex:none}
.dbg-ev-chip:hover{color:var(--text);border-color:var(--border)}
.dbg-ev-chip .d{width:7px;height:7px;border-radius:50%;flex:none}
.dbg-ev-chip .n{font:10px var(--mono);color:var(--faint)}
.dbg-ev-chip.off{opacity:.42;border-style:dashed}
.dbg-ev-chip.off .d{background:transparent!important;box-shadow:inset 0 0 0 1px var(--faint)}
.dbg-ev-chip.err{color:var(--neg);border-color:rgba(255,93,108,.35)}
.dbg-ev-chip.err.on{background:rgba(255,93,108,.14);border-color:rgba(255,93,108,.6);color:#ff8f9a}
.dbg-ev-list{font-size:12px}
.dbg-ev-row{position:relative;border-bottom:1px solid rgba(30,39,52,.55)}
.dbg-ev-row>.l{display:flex;align-items:center;gap:8px;height:24px;padding:0 8px 0 4px;cursor:pointer;white-space:nowrap;min-width:0}
.dbg-ev-row:hover>.l{background:var(--hover)}
.dbg-ev-row.open>.l{background:rgba(76,195,255,.07)}
.dbg-ev-row.error{background:rgba(255,93,108,.055);box-shadow:inset 2px 0 0 var(--neg)}
.dbg-ev-row.warn{box-shadow:inset 2px 0 0 var(--accent2)}
.dbg-ev-row.dim>.l .sum{color:var(--faint)}
.dbg-ev-row .tw{color:var(--faint);display:flex;flex:none;width:12px}
.dbg-ev-row .tm{font:10.5px var(--mono);color:var(--faint);flex:none}
.dbg-ev-type{display:inline-flex;align-items:center;gap:5px;width:118px;flex:none;font:10.5px var(--mono);color:var(--dim);overflow:hidden}
.dbg-ev-type .d{width:6px;height:6px;border-radius:2px;flex:none}
.dbg-ev-row.error .dbg-ev-type{color:#ff8f9a}
.dbg-ev-row .sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.dbg-ev-row .sum b{font-weight:600}
.dbg-ev-row .sum .dm{color:var(--faint)}
.dbg-ev-row .sum .t-error{color:var(--neg)}.dbg-ev-row .sum .t-warn{color:var(--accent2)}.dbg-ev-row .sum .t-info{color:var(--pos)}.dbg-ev-row .sum .t-dim{color:var(--faint)}
.dbg-ev-ent{font:10.5px var(--mono);color:var(--accent);background:rgba(76,195,255,.09);border-radius:4px;padding:1px 4px;cursor:pointer}
.dbg-ev-ent:hover{background:rgba(76,195,255,.22);color:#9fe0ff}
.dbg-ev-ent.gone{color:var(--faint);background:var(--surface);cursor:default;text-decoration:line-through}
.dbg-ev-row .cid{font:10.5px var(--mono);color:var(--faint);flex:none}
.dbg-ev-row .seq{font:10px var(--mono);color:#3f4a5b;flex:none;width:42px;text-align:right}
.dbg-ev-det{padding:4px 10px 10px 26px;display:flex;flex-direction:column;gap:6px;cursor:auto}
.dbg-ev-det .acts{display:flex;gap:6px;align-items:center}
.dbg-ev-det .lbl{font:600 10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.dbg-ev-det .dbg-pre{max-height:220px}
.dbg-ev-stack{margin:0;font:11px/1.55 var(--mono);background:rgba(255,93,108,.05);border:1px solid rgba(255,93,108,.22);border-radius:6px;padding:7px 9px;max-height:240px;overflow:auto;white-space:pre}
.dbg-ev-stack .msg{color:#ff9aa5;white-space:pre-wrap;word-break:break-word}
.dbg-ev-stack .fr{color:var(--dim)}
.dbg-ev-stack .fr.own{color:var(--text)}
.dbg-ev-stack .fr.vendor{color:#4a5568}
.dbg-ev-log{margin:0;font:11px/1.5 var(--mono);color:var(--dim);background:var(--bg0);border:1px solid var(--line);border-radius:6px;padding:7px 9px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dbg-ev-follow{position:absolute;right:16px;bottom:10px;z-index:3;display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid rgba(76,195,255,.45);background:rgba(13,24,36,.94);color:var(--accent);font:600 11.5px var(--sans);cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)}
.dbg-ev-follow:hover{background:rgba(20,40,58,.98)}
.dbg-ev-wrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
`;
