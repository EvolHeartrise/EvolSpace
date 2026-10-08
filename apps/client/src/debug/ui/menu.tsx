// Context menus and small prompt dialogs (one global layer, rendered by the shell).

import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icons.tsx';

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  run?: () => void;
}
export type MenuEntry = MenuItem | 'separator' | { header: string };

interface MenuState { x: number; y: number; items: MenuEntry[] }
const menu = signal<MenuState | null>(null);

/** Open a menu at the pointer (or under an element). */
export function openMenu(at: MouseEvent | { x: number; y: number } | HTMLElement, items: MenuEntry[]): void {
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left; y = r.bottom + 2;
  } else if ('clientX' in at) {
    at.preventDefault();
    at.stopPropagation();
    x = at.clientX; y = at.clientY;
  } else ({ x, y } = at);
  menu.value = { x, y, items };
}

export function closeMenu(): void {
  menu.value = null;
}

interface PromptState { title: string; label?: string; value: string; ok: string; resolve: (v: string | null) => void; validate?: (v: string) => string | null }
const prompt = signal<PromptState | null>(null);

/** Small modal text prompt. Resolves null when cancelled. */
export function promptText(o: { title: string; label?: string; value?: string; ok?: string; validate?: (v: string) => string | null }): Promise<string | null> {
  prompt.value?.resolve(null);
  return new Promise((resolve) => {
    prompt.value = { title: o.title, label: o.label, value: o.value ?? '', ok: o.ok ?? 'OK', validate: o.validate, resolve };
  });
}

function MenuView({ st }: { st: MenuState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: st.x, y: st.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(st.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(st.y, innerHeight - r.height - 4)) });
  }, [st]);
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) closeMenu(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); } };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  return (
    <div ref={ref} class="dbg-menu" style={{ left: `${pos.x}px`, top: `${pos.y}px` }} onContextMenu={(e) => e.preventDefault()}>
      {st.items.map((it, i) => {
        if (it === 'separator') return <div key={i} class="sep" />;
        if ('header' in it) return <div key={i} class="hdr">{it.header}</div>;
        return (
          <button key={i} type="button" class={`it${it.danger ? ' danger' : ''}`} disabled={it.disabled}
            onClick={() => { closeMenu(); it.run?.(); }}>
            <span class="ic">{it.checked !== undefined ? (it.checked ? <Icon name="check" size={13} /> : null) : it.icon ? <Icon name={it.icon} size={13} /> : null}</span>
            <span class="l">{it.label}</span>
            {it.hint ? <span class="h">{it.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function PromptView({ st }: { st: PromptState }) {
  const [v, setV] = useState(st.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const err = st.validate?.(v) ?? (v.trim() ? null : 'required');
  const done = (val: string | null) => { prompt.value = null; st.resolve(val); };
  return (
    <div class="dbg-modal" onPointerDown={(e) => { if (e.target === e.currentTarget) done(null); }}>
      <form class="dbg-dialog" onSubmit={(e) => { e.preventDefault(); if (!err) done(v.trim()); }}>
        <div class="title">{st.title}</div>
        {st.label ? <label>{st.label}</label> : null}
        <input ref={input} type="text" class="dbg-text" value={v} spellcheck={false}
          onInput={(e) => setV((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }} />
        {err && v ? <div class="err">{err}</div> : null}
        <div class="btns">
          <button type="button" class="dbg-btn" onClick={() => done(null)}>Cancel</button>
          <button type="submit" class="dbg-btn primary" disabled={!!err}>{st.ok}</button>
        </div>
      </form>
    </div>
  );
}

/** Rendered once by the shell. */
export function OverlayLayer() {
  const m = menu.value;
  const p = prompt.value;
  return (
    <>
      {m ? <MenuView st={m} key={`${m.x},${m.y}`} /> : null}
      {p ? <PromptView st={p} /> : null}
    </>
  );
}
