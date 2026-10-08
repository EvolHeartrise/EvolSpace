// Small presentational building blocks for debug panels (styles: styles.ts).

import type { ComponentChildren, DragEventHandler, MouseEventHandler } from 'preact';
import { useState } from 'preact/hooks';
import { Icon, type IconName } from './icons.tsx';

export function IconButton(p: {
  icon: IconName; title: string; onClick?: (e: MouseEvent) => void; active?: boolean; disabled?: boolean;
  size?: number; class?: string; label?: string; danger?: boolean;
}) {
  return (
    <button type="button" class={`dbg-ibtn${p.active ? ' on' : ''}${p.danger ? ' danger' : ''}${p.label ? ' labeled' : ''}${p.class ? ` ${p.class}` : ''}`}
      title={p.title} aria-label={p.title} disabled={p.disabled}
      onClick={(e) => { e.stopPropagation(); p.onClick?.(e); }}>
      <Icon name={p.icon} size={p.size ?? 15} />
      {p.label ? <span>{p.label}</span> : null}
    </button>
  );
}

export function Button(p: { children: ComponentChildren; onClick?: (e: MouseEvent) => void; title?: string; primary?: boolean; danger?: boolean; disabled?: boolean; icon?: IconName; small?: boolean }) {
  return (
    <button type="button" class={`dbg-btn${p.primary ? ' primary' : ''}${p.danger ? ' danger' : ''}${p.small ? ' small' : ''}`} title={p.title} disabled={p.disabled}
      onClick={(e) => { e.stopPropagation(); p.onClick?.(e); }}>
      {p.icon ? <Icon name={p.icon} size={13} /> : null}
      {p.children}
    </button>
  );
}

/** Collapsible titled section (open state kept per `id` for the session). */
const sectionOpen = new Map<string, boolean>();
export function Section(p: { id: string; title: ComponentChildren; children: ComponentChildren; defaultOpen?: boolean; actions?: ComponentChildren; count?: number | string }) {
  const [open, setOpen] = useState(sectionOpen.get(p.id) ?? p.defaultOpen ?? true);
  const toggle = () => { sectionOpen.set(p.id, !open); setOpen(!open); };
  return (
    <section class={`dbg-section${open ? '' : ' closed'}`}>
      <header onClick={toggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span class="t">{p.title}</span>
        {p.count !== undefined ? <span class="dbg-count">{p.count}</span> : null}
        <span class="sp" />
        <span class="acts" onClick={(e) => e.stopPropagation()}>{p.actions}</span>
      </header>
      {open ? <div class="body">{p.children}</div> : null}
    </section>
  );
}

/** Label / value row of a property grid. */
export function Row(p: { label: ComponentChildren; children: ComponentChildren; title?: string; dim?: boolean; class?: string }) {
  return (
    <div class={`dbg-row${p.dim ? ' dim' : ''}${p.class ? ` ${p.class}` : ''}`} title={p.title}>
      <label>{p.label}</label>
      <div class="v">{p.children}</div>
    </div>
  );
}

export function Badge(p: { children: ComponentChildren; kind?: 'info' | 'warn' | 'error' | 'ok' | 'dim'; title?: string }) {
  return <span class={`dbg-badge ${p.kind ?? 'dim'}`} title={p.title}>{p.children}</span>;
}

export function Dot(p: { kind: 'ok' | 'warn' | 'error' | 'off' | 'busy'; title?: string }) {
  return <span class={`dbg-dot ${p.kind}`} title={p.title} />;
}

export function Mono(p: { children: ComponentChildren; dim?: boolean; title?: string; class?: string }) {
  return <span class={`dbg-mono${p.dim ? ' dim' : ''}${p.class ? ` ${p.class}` : ''}`} title={p.title}>{p.children}</span>;
}

export function Empty(p: { icon?: IconName; title: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="dbg-empty">
      {p.icon ? <Icon name={p.icon} size={26} /> : null}
      <div class="t">{p.title}</div>
      {p.children ? <div class="d">{p.children}</div> : null}
    </div>
  );
}

/** Placeholder body for panels that are not implemented yet. */
export function ComingSoon(p: { title: string; icon?: IconName; children?: ComponentChildren }) {
  return (
    <Empty icon={p.icon ?? 'code'} title={`${p.title} — coming soon`}>
      {p.children ?? 'This panel is a stub. Its implementation lives in apps/client/src/debug/panels/.'}
    </Empty>
  );
}

export function SearchBox(p: { value: string; onInput: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div class="dbg-search">
      <Icon name="search" size={13} />
      <input type="text" value={p.value} placeholder={p.placeholder ?? 'Filter…'} spellcheck={false}
        onInput={(e) => p.onInput((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { p.onInput(''); (e.currentTarget as HTMLInputElement).blur(); } }} />
      {p.value ? <button type="button" class="clear" title="Clear" onClick={() => p.onInput('')}><Icon name="x" size={12} /></button> : null}
    </div>
  );
}

/** A thin toolbar row at the top of a panel. */
export function PanelBar(p: { children: ComponentChildren; class?: string }) {
  return <div class={`dbg-pbar${p.class ? ` ${p.class}` : ''}`}>{p.children}</div>;
}

/** Scrollable panel body. */
export function Scroll(p: {
  children: ComponentChildren; class?: string;
  onClick?: MouseEventHandler<HTMLDivElement>; onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>; onDrop?: DragEventHandler<HTMLDivElement>; onDragLeave?: DragEventHandler<HTMLDivElement>;
}) {
  const { children, class: cls, ...rest } = p;
  return <div class={`dbg-scroll${cls ? ` ${cls}` : ''}`} {...rest}>{children}</div>;
}
