// Screenshots panel CSS (injected once by screenshots.tsx via ensureCss).

export const SHOTS_CSS = `
.dbg-shot{display:grid;grid-template-columns:340px minmax(0,1fr);flex:1;min-height:0}
.dbg-shot-form{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
.dbg-shot-form .dbg-scroll{padding:6px 10px 4px}
.dbg-shot-form .dbg-row{grid-template-columns:78px minmax(0,1fr);min-height:27px}
.dbg-shot-form .dbg-seg{flex:1}
.dbg-shot-form .dbg-seg button{flex:1;justify-content:center;padding:0 4px}
.dbg-shot-form .wh{display:flex;align-items:center;gap:4px;flex:1;min-width:0}
.dbg-shot-form .wh .x{color:var(--faint)}
.dbg-shot-form .hint{font-size:11px;color:var(--faint);line-height:1.4;padding:2px 0 4px 86px}
.dbg-shot-form .hint.warn{color:var(--accent2)}
.dbg-shot-form .go{display:flex;gap:6px;padding:7px 10px;border-top:1px solid var(--line);flex:none}
.dbg-shot-form .go .dbg-btn{flex:1;justify-content:center;height:28px}
.dbg-shot-form .sw{display:flex;gap:14px}
.dbg-shot-form .dbg-json textarea{min-height:44px}
.dbg-shot-gal{display:flex;flex-direction:column;min-width:0;min-height:0}
.dbg-shot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;padding:8px;align-content:start}
.dbg-shot-card{position:relative;display:flex;flex-direction:column;border:1px solid var(--line2);border-radius:8px;overflow:hidden;background:var(--bg2);min-width:0}
.dbg-shot-card:hover{border-color:var(--border)}
.dbg-shot-card.new{animation:dbgshot-in .5s ease-out}
@keyframes dbgshot-in{from{box-shadow:0 0 0 2px var(--accent);transform:scale(.98)}}
.dbg-shot-img{position:relative;height:132px;display:flex;align-items:center;justify-content:center;cursor:zoom-in;
  background:#0b0f15 repeating-conic-gradient(#121924 0% 25%,#0d121a 0% 50%) 0 0/16px 16px}
.dbg-shot-img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.dbg-shot-card .meta{display:flex;flex-direction:column;gap:1px;padding:5px 8px 6px;min-width:0}
.dbg-shot-card .cap{font-size:11.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-shot-card .sub{font:10.5px var(--mono);color:var(--faint);display:flex;gap:8px}
.dbg-shot-card .acts{position:absolute;top:5px;right:5px;display:flex;gap:2px;opacity:0;transition:opacity .12s}
.dbg-shot-card:hover .acts{opacity:1}
.dbg-shot-card .acts .dbg-ibtn{background:rgba(9,13,19,.85);border-color:var(--line2);color:var(--text)}
.dbg-shot-card .tag{position:absolute;left:6px;top:6px;font:600 9.5px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;padding:3px 5px;border-radius:4px;background:rgba(9,13,19,.8);color:var(--dim);border:1px solid var(--line2)}
.dbg-shot-pending{height:132px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:var(--dim);font-size:12px;background:var(--bg2)}
.dbg-shot-spin{width:22px;height:22px;border-radius:50%;border:2px solid var(--line2);border-top-color:var(--accent);animation:dbgorb-spin2 .8s linear infinite}
@keyframes dbgorb-spin2{to{transform:rotate(360deg)}}
.dbg-shot-lb{position:fixed;inset:0;z-index:65;background:rgba(4,6,10,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px 60px}
.dbg-shot-lb img{max-width:100%;max-height:calc(100vh - 120px);object-fit:contain;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.6);
  background:#0b0f15 repeating-conic-gradient(#121924 0% 25%,#0d121a 0% 50%) 0 0/16px 16px}
.dbg-shot-lb .bar{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12.5px;max-width:100%}
.dbg-shot-lb .bar .cap{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-shot-lb .nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:56px;border-radius:8px;border:1px solid var(--line2);background:rgba(17,24,35,.8);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center}
.dbg-shot-lb .nav:hover{background:var(--surface2)}
.dbg-shot-lb .nav.prev{left:12px}.dbg-shot-lb .nav.next{right:12px}
.dbg-shot-lb .close{position:absolute;top:12px;right:12px}
`;
