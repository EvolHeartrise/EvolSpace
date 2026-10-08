// Panel-scoped CSS for the events / agent / sources / screenshots panels: each
// panel keeps its rules next to its code and injects them once (idempotent),
// on top of the shared dashboard styles (../../styles.ts variables + classes).

const injected = new Set<string>();

/** Small pieces shared by these panels (segmented control). */
const COMMON_CSS = `
.dbg-seg{display:inline-flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden;flex:none}
.dbg-seg button{height:24px;padding:0 9px;border:0;background:transparent;color:var(--dim);cursor:pointer;font-size:11.5px;display:flex;align-items:center;gap:5px;white-space:nowrap}
.dbg-seg button+button{border-left:1px solid var(--line2)}
.dbg-seg button:hover:not(:disabled){color:var(--text);background:var(--hover)}
.dbg-seg button.on{background:rgba(76,195,255,.13);color:var(--accent)}
.dbg-seg button:disabled{opacity:.4;cursor:default}
`;

export function ensureCss(id: string, css: string): void {
  if (injected.has(id) || typeof document === 'undefined') return;
  if (!injected.size) { injected.add('common'); inject('common', COMMON_CSS); }
  injected.add(id);
  inject(id, css);
}

function inject(id: string, css: string): void {
  const el = document.createElement('style');
  el.id = `evol-debug-css-${id}`;
  el.textContent = css;
  document.head.appendChild(el);
}
