// Links panel CSS (injected once by the panel; shared variables from styles.ts).

export const LINKS_CSS = `
.dbg-lk{container-type:inline-size;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.dbg-lk-head,.dbg-lk-row{display:grid;grid-template-columns:34px minmax(0,1.15fr) 16px minmax(0,1.15fr) minmax(0,1fr) minmax(0,1.05fr) 50px;align-items:center;gap:6px;padding:0 6px 0 8px}
.dbg-lk-head{height:24px;font:600 10px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
.dbg-lk-row{min-height:28px;border-bottom:1px solid var(--line);font-size:12px;position:relative}
.dbg-lk-row:hover{background:var(--hover)}
.dbg-lk-row.off>:not(:first-child){opacity:.45}
.dbg-lk-row.err{box-shadow:inset 2px 0 0 var(--neg)}
.dbg-lk-row>*{min-width:0}
.dbg-ep{display:flex;align-items:center;gap:5px;min-width:0;cursor:pointer;border-radius:4px;padding:2px 3px;margin-left:-3px;white-space:nowrap}
.dbg-ep:hover{background:var(--hover)}
.dbg-ep:hover .en{color:var(--accent)}
.dbg-ep .ico{width:14px;height:14px;border-radius:3px;flex:none;display:flex;align-items:center;justify-content:center;font:700 8px/1 var(--sans);color:#0b0f15}
.dbg-ep .ico.ch{background:rgba(255,181,71,.18);color:var(--accent2);font-size:10px}
.dbg-ep .en{overflow:hidden;text-overflow:ellipsis;color:var(--text);min-width:0;flex:0 1 auto}
.dbg-ep .pt{font:11.5px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;flex:0 1000 auto;min-width:16px}
.dbg-ep .pt::before{content:'.';color:var(--faint)}
.dbg-ep.ch .en{font:11.5px var(--mono);color:var(--accent2)}
.dbg-ep.missing .en{color:var(--neg);text-decoration:line-through}
.dbg-lk-arrow{color:var(--faint);text-align:center;font-size:12px}
.dbg-lk-row .tfx{height:22px;width:100%;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--accent2);font:11.5px var(--mono);padding:0 5px;outline:0;min-width:0}
.dbg-lk-row .tfx::placeholder{color:var(--faint);opacity:0;font-family:var(--sans)}
.dbg-lk-row:hover .tfx::placeholder,.dbg-lk-row .tfx:focus::placeholder{opacity:1}
.dbg-lk-row .tfx:hover{border-color:var(--line2)}
.dbg-lk-row .tfx:focus{border-color:rgba(76,195,255,.65);background:var(--bg0);color:var(--text)}
.dbg-lk-row .tfx.bad{border-color:rgba(255,93,108,.7)!important}
.dbg-lk-val{display:flex;align-items:center;gap:6px;min-width:0;font:11.5px var(--mono);white-space:nowrap}
.dbg-lk-val .pulse{width:6px;height:6px;border-radius:50%;flex:none;background:var(--line2);transition:background .5s,box-shadow .5s}
.dbg-lk-val .pulse.on{background:var(--accent);box-shadow:0 0 0 3px rgba(76,195,255,.18);transition:none}
.dbg-lk-val .v{overflow:hidden;text-overflow:ellipsis;color:var(--accent);border-radius:3px;padding:0 2px;min-width:0;flex:0 1 auto}
.dbg-lk-val .v.flash{animation:dbglkflash .5s ease-out}
@keyframes dbglkflash{from{background:rgba(76,195,255,.2)}to{background:transparent}}
.dbg-lk-val .v.none{color:var(--faint)}
.dbg-lk-val .out{color:var(--dim);overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1000 auto}
.dbg-lk-val .out::before{content:'⇒ ';color:var(--faint)}
.dbg-lk-val .prev{color:var(--accent2);overflow:hidden;text-overflow:ellipsis}
.dbg-lk-val .prev.bad{color:var(--neg)}
.dbg-lk-acts{display:flex;align-items:center;justify-content:flex-end;gap:1px}
.dbg-lk-acts .errico{color:var(--neg);display:flex;cursor:help;padding:0 3px}
.dbg-lk-acts .dbg-ibtn{opacity:0}
.dbg-lk-row:hover .dbg-lk-acts .dbg-ibtn{opacity:1}
.dbg-lk-more{padding:8px 12px;color:var(--faint);font-size:11.5px}
.dbg-lk-form{display:flex;flex-direction:column;gap:6px;padding:8px;border-bottom:1px solid var(--line);background:var(--bg2);flex:none}
.dbg-lk-form .ln{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dbg-lk-form .end{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 330px}
.dbg-lk-form .end .side{font:600 10px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);width:30px;flex:none}
.dbg-lk-form .end .dbg-select{flex:1 1 0;min-width:70px}
.dbg-lk-form .end .dbg-text{flex:1 1 0;min-width:90px}
.dbg-lk-form .arrow{color:var(--faint);flex:none;padding:0 2px}
.dbg-seg{display:inline-flex;border:1px solid var(--line2);border-radius:5px;overflow:hidden;flex:none;height:24px}
.dbg-seg button{border:0;background:transparent;color:var(--faint);font-size:11px;padding:0 7px;cursor:pointer}
.dbg-seg button+button{border-left:1px solid var(--line2)}
.dbg-seg button.on{background:rgba(76,195,255,.14);color:var(--accent)}
.dbg-seg button:hover:not(.on){color:var(--text)}
.dbg-lk-form .tf{display:flex;align-items:center;gap:6px;flex:1 1 260px;min-width:0}
.dbg-lk-form .tf .f{font:italic 600 12px var(--sans);color:var(--accent2);width:30px;flex:none;text-align:center}
.dbg-lk-form .tf .dbg-text{color:var(--accent2)}
.dbg-lk-form .tf .dbg-text.bad{border-color:rgba(255,93,108,.7)}
.dbg-lk-form .msgs{flex:1 1 200px;min-width:0;font-size:11.5px;display:flex;flex-direction:column;gap:1px}
.dbg-lk-form .msgs .e{color:var(--faint)}
.dbg-lk-form .msgs .e.hard{color:var(--neg)}
.dbg-lk-form .msgs .w{color:var(--accent2)}
.dbg-lk-form .msgs .ok{color:var(--pos)}
.dbg-lk-form .btns{display:flex;gap:6px;flex:none;margin-left:auto}
@container (max-width:640px){
  .dbg-lk-head,.dbg-lk-row{grid-template-columns:34px minmax(0,1fr) 14px minmax(0,1fr) minmax(0,1fr) 44px}
  .dbg-lk-head>:nth-child(5),.dbg-lk-row>:nth-child(5){display:none}
}
`;
