// Sources panel CSS (injected once by sources.tsx via ensureCss).

export const SOURCES_CSS = `
.dbg-src{display:grid;grid-template-columns:minmax(340px,1fr) minmax(0,1.25fr);flex:1;min-height:0}
.dbg-src-list{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line)}
.dbg-src-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px 8px 6px 10px;border-bottom:1px solid rgba(30,39,52,.6);cursor:pointer}
.dbg-src-row:hover{background:var(--hover)}
.dbg-src-row.sel{background:var(--sel)}
.dbg-src-row.exited{box-shadow:inset 2px 0 0 var(--neg);animation:dbgsrc-flash 1.2s ease-out}
@keyframes dbgsrc-flash{from{background:rgba(255,93,108,.22)}}
.dbg-src-row .m{display:flex;flex-direction:column;min-width:0;gap:1px}
.dbg-src-row .l1{display:flex;align-items:center;gap:6px;min-width:0}
.dbg-src-row .id{font:600 12px var(--mono);color:var(--text);white-space:nowrap}
.dbg-src-row .ds{color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-src-row .l2{display:flex;gap:10px;font:10.5px var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden}
.dbg-src-row .l2 .bad{color:var(--neg)}
.dbg-src-row .acts{display:flex;gap:1px}
.dbg-src-row .err{color:var(--neg);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-src-log{display:flex;flex-direction:column;min-width:0;min-height:0}
.dbg-src-log .hd{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--line);flex:none;min-width:0}
.dbg-src-log .hd .t{font:600 12px var(--mono)}
.dbg-src-exits{display:flex;flex-direction:column;gap:2px;padding:5px 8px;border-bottom:1px solid var(--line);flex:none;max-height:72px;overflow:auto}
.dbg-src-exit{display:flex;align-items:center;gap:7px;font:11px var(--mono);color:#ff9aa5;white-space:nowrap}
.dbg-src-exit .tm{color:var(--faint)}
.dbg-src-exit.ok{color:var(--dim)}
.dbg-src-lines{flex:1;min-height:0;overflow:auto;margin:0;padding:6px 0 10px;font:11px/1.55 var(--mono);color:var(--dim);background:var(--bg0)}
.dbg-src-lines div{padding:0 10px;white-space:pre-wrap;word-break:break-word}
.dbg-src-lines div:hover{background:rgba(255,255,255,.03)}
.dbg-src-lines .e{color:#ff8f9a;background:rgba(255,93,108,.05)}
.dbg-src-lines .w{color:var(--accent2)}
.dbg-src-lines .n{display:inline-block;width:30px;color:#3f4a5b;user-select:none;text-align:right;margin-right:10px}
`;
