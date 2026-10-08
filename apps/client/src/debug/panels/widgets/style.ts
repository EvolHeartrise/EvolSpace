// Widgets panel CSS (injected once by the panel; shared variables from styles.ts).

export const WIDGETS_CSS = `
.dbg-wl{padding:2px 0 16px}
.dbg-wrow{display:flex;align-items:center;gap:9px;padding:5px 8px 5px 8px;cursor:pointer;position:relative;border-left:2px solid transparent}
.dbg-wrow:hover{background:var(--hover)}
.dbg-witem.open>.dbg-wrow{background:var(--sel);border-left-color:var(--accent)}
.dbg-witem.bad>.dbg-wrow{border-left-color:var(--neg)}
.dbg-thumb{width:46px;height:34px;border-radius:5px;flex:none;overflow:hidden;background:var(--bg0);border:1px solid var(--line);display:flex;align-items:center;justify-content:center}
.dbg-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dbg-thumb .g{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:700 12px/1 var(--sans);color:#0b0f15;opacity:.9}
.dbg-thumb.big{width:100%;height:auto;aspect-ratio:4/3;max-height:150px;border-radius:6px}
.dbg-thumb.big img{object-fit:contain}
.dbg-wrow .tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dbg-wrow .l1{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
.dbg-wrow .id{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dbg-wrow .id mark,.dbg-wrow .ds mark{background:rgba(255,181,71,.25);color:inherit;border-radius:2px}
.dbg-wrow .ver{font:10.5px var(--mono);color:var(--faint);flex:none}
.dbg-wrow .n{font:600 10px/1 var(--sans);padding:2px 5px;border-radius:8px;background:var(--surface2);color:var(--dim);flex:none}
.dbg-wrow .er{color:var(--neg);display:flex;flex:none}
.dbg-wrow .ds{color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-wrow .sp{flex:1}
.dbg-wrow .add{opacity:0}
.dbg-wrow:hover .add,.dbg-witem.open .add{opacity:1}
.dbg-wdet{padding:8px 10px 12px 12px;border-bottom:1px solid var(--line);border-left:2px solid var(--accent);background:rgba(17,24,35,.55);display:flex;flex-direction:column;gap:8px}
.dbg-witem.bad .dbg-wdet{border-left-color:var(--neg)}
.dbg-wdet .desc{color:var(--dim);font-size:12px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.dbg-wdet .desc.open{display:block;-webkit-line-clamp:unset}
.dbg-wdet .desc:hover{color:var(--text)}
.dbg-wdet .acts{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.dbg-wdet .path{display:flex;align-items:center;gap:5px;font:11px var(--mono);color:var(--dim);cursor:pointer;min-width:0;align-self:flex-start;max-width:100%;background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:2px 6px}
.dbg-wdet .path span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-wdet .path:hover{color:var(--text);border-color:var(--border)}
.dbg-wdet .meta{display:flex;flex-wrap:wrap;gap:4px 10px;font:10.5px var(--mono);color:var(--faint)}
.dbg-wdet .errbox{background:rgba(255,93,108,.08);border:1px solid rgba(255,93,108,.3);color:#ff9aa5;border-radius:6px;padding:6px 8px;font:11px/1.45 var(--mono);white-space:pre-wrap;word-break:break-word;max-height:64px;overflow:hidden;cursor:pointer;position:relative}
.dbg-wdet .errbox.open{max-height:260px;overflow:auto;cursor:text}
.dbg-wdet .errbox:not(.open)::after{content:'click to expand';position:absolute;right:6px;bottom:3px;font:10px var(--sans);color:var(--faint);background:#1a1418;padding:0 3px}
.dbg-wdet .res{font:11px var(--mono);display:flex;align-items:center;gap:6px}
.dbg-wdet .res.ok{color:var(--pos)}.dbg-wdet .res.bad{color:var(--neg);white-space:pre-wrap;word-break:break-word}
.dbg-wdet .dbg-ports td.n{width:38%}
.dbg-wdet .dbg-ports td.t{width:60px}
.dbg-wdet .dbg-ports td.d{color:var(--dim);font:11px var(--mono)}
.dbg-wdet .dbg-ports td.ds{color:var(--faint);font-size:11px}
.dbg-wdet .chips{display:flex;flex-wrap:wrap;gap:4px}
.dbg-wdet .chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:2px 6px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-wdet .chip:hover{border-color:var(--border);color:var(--accent)}
.dbg-wdet .chip .i{font:10.5px var(--mono);color:var(--faint)}
.dbg-wdet .evs{display:flex;flex-direction:column;gap:3px}
.dbg-wdet .ev{font:11px/1.4 var(--mono);color:#ff9aa5;display:flex;gap:6px}
.dbg-wdet .ev .t{color:var(--faint);flex:none}
.dbg-wdet .ev .m{white-space:pre-wrap;word-break:break-word;min-width:0}
`;
