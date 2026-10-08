// Agent panel CSS (injected once by agent.tsx via ensureCss). The orb mirrors
// the XR AgentOrb (packages/runtime/src/system/AgentOrb.ts): same colors
// (SYSTEM_STYLE.agent) and the same motion per state.

export const AGENT_CSS = `
.dbg-ag{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(300px,1fr);flex:1;min-height:0}
.dbg-ag-main{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line)}
.dbg-ag-side{display:flex;flex-direction:column;min-width:0;min-height:0}
.dbg-ag-head{display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--line);flex:none;min-width:0}
.dbg-ag-head .st{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.3}
.dbg-ag-head .st .s{font-weight:600;font-size:12.5px;display:flex;gap:8px;align-items:baseline}
.dbg-ag-head .st .s .el{font:11px var(--mono);color:var(--faint);font-weight:400}
.dbg-ag-head .st .dt{color:var(--dim);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dbg-orb{--c:#8d99ab;position:relative;width:26px;height:26px;flex:none}
.dbg-orb .core{position:absolute;inset:7px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);animation:dbgorb-breathe 4s ease-in-out infinite}
.dbg-orb .halo{position:absolute;inset:2px;border-radius:50%;border:1.5px solid var(--c);opacity:.35}
.dbg-orb .arc{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;border-top-color:var(--c);opacity:0}
.dbg-orb .dots{position:absolute;inset:0;opacity:0}
.dbg-orb .dots i{position:absolute;left:11px;top:0;width:4px;height:4px;border-radius:50%;background:var(--c);transform-origin:2px 13px}
.dbg-orb .dots i:nth-child(2){transform:rotate(120deg)}.dbg-orb .dots i:nth-child(3){transform:rotate(240deg)}
.dbg-orb.idle .core{animation-duration:4s;opacity:.8}
.dbg-orb.listening .halo{animation:dbgorb-pulse .9s ease-out infinite;opacity:.8}
.dbg-orb.transcribing .dots{opacity:1;animation:dbgorb-spin 1.4s linear infinite}
.dbg-orb.thinking .arc{opacity:1;animation:dbgorb-spin 2.6s linear infinite}
.dbg-orb.thinking .core{animation-duration:1.8s}
.dbg-orb.working .arc{opacity:1;animation:dbgorb-spin .9s linear infinite}
.dbg-orb.working .dots{opacity:.8;animation:dbgorb-spin 1.6s linear infinite reverse}
.dbg-orb.error .halo{opacity:.9}
.dbg-orb.error .core{animation:dbgorb-blink 1.6s ease-in-out infinite}
.dbg-orb.offline .core{opacity:.45;animation:none;box-shadow:none}
@keyframes dbgorb-breathe{50%{transform:scale(.82);opacity:.7}}
@keyframes dbgorb-pulse{from{transform:scale(.85);opacity:.9}to{transform:scale(1.35);opacity:0}}
@keyframes dbgorb-spin{to{transform:rotate(360deg)}}
@keyframes dbgorb-blink{50%{opacity:.35}}

.dbg-ag-msgs{flex:1;min-height:0;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.dbg-ag-m{display:flex;gap:7px;align-items:flex-start;max-width:100%}
.dbg-ag-m .b{padding:5px 9px;border-radius:9px;font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;min-width:0}
.dbg-ag-m .tm{font:10px var(--mono);color:var(--faint);padding-top:6px;flex:none}
.dbg-ag-m.reply .b{background:rgba(76,195,255,.09);border:1px solid rgba(76,195,255,.22);color:var(--text);border-top-left-radius:3px}
.dbg-ag-m.reply .who{color:var(--accent)}
.dbg-ag-m.error .b{background:rgba(255,93,108,.09);border:1px solid rgba(255,93,108,.3);color:#ff9aa5}
.dbg-ag-m.info .b{background:transparent;color:var(--dim);padding:2px 0;font-size:12px}
.dbg-ag-m.heard,.dbg-ag-m.ask{flex-direction:row-reverse;align-self:flex-end}
.dbg-ag-m.heard .b{background:var(--surface);border:1px solid var(--line2);color:var(--text);border-top-right-radius:3px}
.dbg-ag-m.ask .b{background:rgba(169,139,255,.1);border:1px solid rgba(169,139,255,.3);color:var(--text);border-top-right-radius:3px}
.dbg-ag-m .who{font:600 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding-top:7px;flex:none;display:flex;align-items:center;gap:3px}
.dbg-ag-m.ask .who{color:#b9a3ff}
.dbg-ag-m.route{align-self:flex-end}
.dbg-ag-route{display:inline-flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--dim);border:1px dashed var(--line2);border-radius:7px;padding:3px 8px}
.dbg-ag-route .r{font-weight:600}
.dbg-ag-route .tx{color:var(--text);font-family:var(--sans);font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-ag-send{width:30px;height:28px;padding:0;justify-content:center}
.dbg-ag-route .r.fastpath{color:var(--pos)}.dbg-ag-route .r.agent{color:#b9a3ff}.dbg-ag-route .r.none{color:var(--faint)}.dbg-ag-route .r.error{color:var(--neg)}

.dbg-ag-comp{display:flex;align-items:center;gap:6px;padding:7px 8px;border-top:1px solid var(--line);flex:none;min-width:0}
.dbg-ag-comp input.dbg-text{height:28px;font-size:12.5px}
.dbg-ag-ctx{display:inline-flex;align-items:center;gap:4px;font:10.5px var(--mono);color:var(--dim);background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:2px 3px 2px 6px;white-space:nowrap;max-width:180px;overflow:hidden;flex:none}
.dbg-ag-ctx button{display:flex;border:0;background:transparent;color:var(--faint);cursor:pointer;padding:1px}
.dbg-ag-ctx button:hover{color:var(--text)}
.dbg-ptt{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:14px;border:1px solid var(--line2);background:var(--surface);color:var(--dim);cursor:pointer;font-size:12px;white-space:nowrap;user-select:none;touch-action:none;flex:none}
.dbg-ptt:hover{color:var(--text);border-color:var(--border)}
.dbg-ptt.on{background:rgba(76,195,255,.18);border-color:#4cc3ff;color:#9fe0ff;box-shadow:0 0 0 3px rgba(76,195,255,.15)}
.dbg-ptt.busy{border-color:rgba(79,217,212,.6);color:#4fd9d4}
.dbg-ptt .lv{width:28px;height:4px;border-radius:2px;background:var(--line2);overflow:hidden}
.dbg-ptt .lv i{display:block;height:100%;background:#4cc3ff}

.dbg-ag-test{padding:7px 8px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;flex:none}
.dbg-ag-res{display:flex;flex-direction:column;gap:3px;font-size:12px;min-height:38px}
.dbg-ag-res .l1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dbg-ag-res .k{color:var(--faint);font-size:11px}
.dbg-ag-res .forms{font:10.5px var(--mono);color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-ag-cmds{flex:1;min-height:0;overflow:auto;padding:2px 0 8px}
.dbg-ag-cmd{padding:5px 10px;border-bottom:1px solid rgba(30,39,52,.6)}
.dbg-ag-cmd.hit{background:rgba(69,212,155,.07);box-shadow:inset 2px 0 0 var(--pos)}
.dbg-ag-cmd .h{display:flex;align-items:baseline;gap:7px;min-width:0}
.dbg-ag-cmd .id{font:600 11.5px var(--mono);color:var(--text)}
.dbg-ag-cmd .run{font:11px var(--mono);color:var(--accent2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dbg-ag-cmd .ds{color:var(--faint);font-size:11.5px;margin:1px 0 3px}
.dbg-ag-cmd .ps{display:flex;flex-wrap:wrap;gap:3px}
.dbg-ag-cmd .p{font:10.5px var(--mono);color:var(--dim);background:var(--bg0);border:1px solid var(--line);border-radius:4px;padding:1px 5px;word-break:break-all;cursor:pointer}
.dbg-ag-cmd .p:hover{border-color:var(--border);color:var(--text)}
.dbg-ag-cmd .p.hit{border-color:rgba(69,212,155,.6);color:var(--pos);background:rgba(69,212,155,.08)}
.dbg-ag-cmd .p.bad{border-color:rgba(255,93,108,.5);color:var(--neg)}
`;
