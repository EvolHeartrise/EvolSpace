// Editable fields for debug panels. Value fields report edits as
//   onChange(value, { group, final })
// `group` is one id per gesture (a scrub drag, a slider drag, a typed commit),
// so callers pass it to actions.update(..., { group }) → one undo step.
// `final` is false for throttled live updates during a drag.

import type { KeyboardEventHandler } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { newGroupId } from '../store.ts';
import { fmtNum, prettyJson } from './format.ts';

export interface EditInfo {
  group: string;
  final: boolean;
}

const LIVE_MS = 50;

/** Throttled emitter for one drag gesture (leading + trailing, final always delivered). */
function useLiveEmitter<T>(onChange: (v: T, info: EditInfo) => void) {
  const st = useRef<{ group: string; last: number; pending: T | undefined; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => () => { if (st.current?.timer) clearTimeout(st.current.timer); }, []);
  return {
    begin() { st.current = { group: newGroupId(), last: 0, pending: undefined, timer: null }; },
    live(v: T) {
      const s = st.current;
      if (!s) return;
      const now = performance.now();
      if (now - s.last >= LIVE_MS) { s.last = now; cb.current(v, { group: s.group, final: false }); return; }
      s.pending = v;
      if (!s.timer) s.timer = setTimeout(() => {
        s.timer = null;
        if (s.pending !== undefined && st.current === s) { s.last = performance.now(); cb.current(s.pending, { group: s.group, final: false }); s.pending = undefined; }
      }, LIVE_MS);
    },
    end(v: T) {
      const s = st.current;
      st.current = null;
      if (s?.timer) clearTimeout(s.timer);
      cb.current(v, { group: s?.group ?? newGroupId(), final: true });
    },
    once(v: T) { cb.current(v, { group: newGroupId(), final: true }); },
  };
}

/**
 * Edit draft as state (for rendering) mirrored in a ref (for handlers): Enter
 * commits and clears it, so the blur that follows sees no draft; Esc clears it
 * without committing.
 */
function useDraft<T>() {
  const [draft, setState] = useState<T | null>(null);
  const ref = useRef<T | null>(null);
  const set = (v: T | null) => { ref.current = v; setState(v); };
  /** Take the current draft (and clear it). */
  const take = (): T | null => { const v = ref.current; set(null); return v; };
  return { draft, set, take, ref };
}

function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step >= 1) return 0;
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? Math.ceil(-Math.log10(step)) : s.length - i - 1;
}

export function clampNum(v: number, o: { min?: number; max?: number; integer?: boolean; step?: number }): number {
  let x = v;
  if (o.integer) x = Math.round(x);
  if (o.min !== undefined && x < o.min) x = o.min;
  if (o.max !== undefined && x > o.max) x = o.max;
  if (!o.integer && o.step) x = Number(x.toFixed(Math.min(10, decimalsOf(o.step) + 2)));
  return x;
}

export interface NumberFieldProps {
  value: number | undefined;
  onChange: (v: number, info: EditInfo) => void;
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Prefix label (drag it to scrub). */
  label?: string;
  labelClass?: string;
  disabled?: boolean;
  title?: string;
  /** Show "mixed"/placeholder when value is undefined. */
  placeholder?: string;
}

/** Numeric field: type + Enter, ↑/↓ (Shift ×10), or drag horizontally to scrub (Shift fine, Ctrl coarse). */
export function NumberField(p: NumberFieldProps) {
  const d = useDraft<string>();
  const draft = d.draft;
  const input = useRef<HTMLInputElement>(null);
  const emit = useLiveEmitter(p.onChange);
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number; cur: number } | null>(null);
  const step = p.step ?? (p.integer ? 1 : 0.01);
  const shown = draft ?? (p.value === undefined || !Number.isFinite(p.value) ? '' : fmtNum(p.value, Math.max(4, decimalsOf(step))));

  const commitDraft = () => {
    const raw = d.take();
    if (raw === null) return;
    const txt = raw.trim();
    if (!txt) return;
    let v: number;
    try {
      // Allow simple arithmetic ("0.5*2", "1/3"): digits/operators only.
      v = /^[-+*/().\d\se]+$/i.test(txt) ? Number(Function(`"use strict";return (${txt})`)()) : Number(txt);
    } catch { v = NaN; }
    if (!Number.isFinite(v)) return;
    v = clampNum(v, { ...p, step });
    if (v !== p.value) emit.once(v);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (p.disabled || e.button !== 0 || document.activeElement === input.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: p.value ?? 0, moved: false, id: e.pointerId, cur: p.value ?? 0 };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < 3) return;
      d.moved = true;
      emit.begin();
      document.body.classList.add('dbg-scrubbing');
    }
    const k = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
    const v = clampNum(d.start + Math.round(dx) * step * k, { ...p, step });
    if (v !== d.cur) { d.cur = v; emit.live(v); }
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    document.body.classList.remove('dbg-scrubbing');
    try { (e.currentTarget as HTMLElement).releasePointerCapture(d.id); } catch { /* released */ }
    if (d.moved) emit.end(d.cur);
    else { input.current?.focus(); input.current?.select(); }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { commitDraft(); (e.currentTarget as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') { d.set(null); (e.currentTarget as HTMLInputElement).blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
      const v = clampNum((p.value ?? 0) + step * k, { ...p, step });
      d.set(null);
      emit.once(v);
    }
  };

  return (
    <div class={`dbg-num${p.disabled ? ' disabled' : ''}${draft !== null ? ' editing' : ''}`} title={p.title}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {p.label ? <span class={`lbl${p.labelClass ? ` ${p.labelClass}` : ''}`}>{p.label}</span> : null}
      <input ref={input} type="text" inputMode="decimal" spellcheck={false} disabled={p.disabled} value={shown} placeholder={p.placeholder}
        onFocus={(e) => { d.set(shown); (e.currentTarget as HTMLInputElement).select(); }}
        onInput={(e) => d.set((e.currentTarget as HTMLInputElement).value)}
        onBlur={commitDraft} onKeyDown={onKeyDown} />
    </div>
  );
}

const AXES = [['X', 'x'], ['Y', 'y'], ['Z', 'z']] as const;

export function Vec3Field(p: { value: [number, number, number]; onChange: (v: [number, number, number], info: EditInfo) => void; step?: number; min?: number; max?: number; disabled?: boolean; labels?: [string, string, string] }) {
  return (
    <div class="dbg-vec3">
      {AXES.map(([L, cls], i) => (
        <NumberField key={L} label={p.labels?.[i] ?? L} labelClass={cls} value={p.value[i]} step={p.step} min={p.min} max={p.max} disabled={p.disabled}
          onChange={(v, info) => { const next = [...p.value] as [number, number, number]; next[i] = v; p.onChange(next, info); }} />
      ))}
    </div>
  );
}

/** Range slider + numeric field (live updates while dragging). */
export function SliderField(p: { value: number; min: number; max: number; step?: number; integer?: boolean; onChange: (v: number, info: EditInfo) => void; disabled?: boolean }) {
  const emit = useLiveEmitter(p.onChange);
  const dragging = useRef(false);
  const step = p.step ?? (p.integer ? 1 : (p.max - p.min) / 200);
  const [local, setLocal] = useState<number | null>(null);
  const v = local ?? p.value;
  return (
    <div class="dbg-slider">
      <input type="range" min={p.min} max={p.max} step={step} value={v} disabled={p.disabled}
        onPointerDown={() => { dragging.current = true; emit.begin(); }}
        onInput={(e) => {
          const x = clampNum(Number((e.currentTarget as HTMLInputElement).value), { ...p, step });
          setLocal(x);
          if (dragging.current) emit.live(x); else emit.once(x);
        }}
        onChange={(e) => {
          const x = clampNum(Number((e.currentTarget as HTMLInputElement).value), { ...p, step });
          setLocal(null);
          if (dragging.current) { dragging.current = false; emit.end(x); }
        }}
        onPointerUp={() => { if (dragging.current) { dragging.current = false; if (local !== null) emit.end(local); setLocal(null); } }} />
      <NumberField value={p.value} min={p.min} max={p.max} step={p.step} integer={p.integer} disabled={p.disabled} onChange={p.onChange} />
    </div>
  );
}

/** Text input that commits on Enter / blur (Esc reverts). */
export function TextField(p: { value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; disabled?: boolean; list?: string; title?: string; class?: string }) {
  const d = useDraft<string>();
  const draft = d.draft;
  const commit = () => {
    const v = d.take();
    if (v !== null && v !== p.value) p.onCommit(v);
  };
  return (
    <input type="text" class={`dbg-text${p.mono ? ' mono' : ''}${p.class ? ` ${p.class}` : ''}`} value={draft ?? p.value} placeholder={p.placeholder}
      disabled={p.disabled} list={p.list} spellcheck={false} title={p.title}
      onInput={(e) => d.set((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.currentTarget as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { d.set(null); (e.currentTarget as HTMLInputElement).blur(); }
      }} />
  );
}

export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string; label?: string }) {
  return (
    <label class={`dbg-switch${p.checked ? ' on' : ''}${p.disabled ? ' disabled' : ''}`} title={p.title}>
      <input type="checkbox" checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span class="track"><span class="knob" /></span>
      {p.label ? <span class="l">{p.label}</span> : null}
    </label>
  );
}

export function SelectField<T extends string>(p: { value: T | ''; options: Array<{ value: T; label?: string }>; onChange: (v: T) => void; disabled?: boolean; placeholder?: string; title?: string }) {
  return (
    <select class="dbg-select" value={p.value} disabled={p.disabled} title={p.title} onChange={(e) => p.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
      {p.placeholder !== undefined && !p.options.some((o) => o.value === p.value) ? <option value="" disabled>{p.placeholder}</option> : null}
      {p.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
    </select>
  );
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function toHex6(c: string): string | null {
  if (!HEX.test(c)) return null;
  return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c.toLowerCase();
}

/** Color: swatch (native picker, live while dragging) + text (hex or a theme name like "accent"). */
export function ColorField(p: { value: string; onChange: (v: string, info: EditInfo) => void; resolve?: (name: string) => string | undefined; disabled?: boolean }) {
  const emit = useLiveEmitter(p.onChange);
  const active = useRef(false);
  const hex = toHex6(p.value) ?? toHex6(p.resolve?.(p.value) ?? '') ?? '#000000';
  return (
    <div class="dbg-color">
      <label class="sw" style={{ background: hex }} title={HEX.test(p.value) ? p.value : `${p.value} → ${hex}`}>
        <input type="color" value={hex} disabled={p.disabled}
          onInput={(e) => { if (!active.current) { active.current = true; emit.begin(); } emit.live((e.currentTarget as HTMLInputElement).value); }}
          onChange={(e) => { active.current = false; emit.end((e.currentTarget as HTMLInputElement).value); }} />
      </label>
      <TextField value={p.value} mono disabled={p.disabled} onCommit={(v) => emit.once(v.trim())} />
    </div>
  );
}

/** JSON editor: validates while typing; commits valid changes on blur / Ctrl+Enter (Esc reverts). */
export function JsonField(p: { value: unknown; onCommit: (v: unknown) => void; rows?: number; disabled?: boolean; placeholder?: string }) {
  const text = prettyJson(p.value);
  const d = useDraft<string>();
  const draft = d.draft;
  let error: string | null = null;
  if (draft !== null && draft.trim()) {
    try { JSON.parse(draft); } catch (e) { error = (e as Error).message; }
  }
  const commit = () => {
    const txt = d.ref.current;
    if (txt === null) return;
    let v: unknown;
    try { v = txt.trim() ? JSON.parse(txt) as unknown : undefined; } catch { return; } // invalid: keep the draft
    d.set(null);
    if (JSON.stringify(v) !== JSON.stringify(p.value)) p.onCommit(v);
  };
  const lines = Math.min(p.rows ?? 12, Math.max(2, (draft ?? text).split('\n').length));
  const onKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { d.set(null); e.currentTarget.blur(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget, s = ta.selectionStart, en = ta.selectionEnd;
      const v = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
      d.set(v);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };
  return (
    <div class={`dbg-json${error ? ' invalid' : ''}${draft !== null ? ' dirty' : ''}`}>
      <textarea rows={lines} spellcheck={false} disabled={p.disabled} placeholder={p.placeholder} value={draft ?? text}
        onInput={(e) => d.set((e.currentTarget as HTMLTextAreaElement).value)} onBlur={commit} onKeyDown={onKeyDown} />
      {error ? <div class="err">{error}</div> : draft !== null ? <div class="hint">Ctrl+Enter or click away to apply · Esc to revert</div> : null}
    </div>
  );
}
