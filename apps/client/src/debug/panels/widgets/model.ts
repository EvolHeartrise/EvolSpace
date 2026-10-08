// Widgets panel logic (pure): search, port/prop summaries, instances, recent
// errors from the event log (client errors of its instances + failed builds).

import type { Entity, SceneState, ServerEvent, WidgetManifest } from '@evolspace/protocol';

export function widgetList(catalog: Record<string, WidgetManifest>): WidgetManifest[] {
  return Object.values(catalog).sort((a, b) => a.id.localeCompare(b.id));
}

/** Multi-term match on id, description, port and prop names. Errors-only optional. */
export function filterWidgets(list: readonly WidgetManifest[], q: string, errorsOnly = false): WidgetManifest[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((m) => {
    if (errorsOnly && !m.error) return false;
    if (!terms.length) return true;
    const hay = [m.id, m.description, ...Object.keys(m.inputs ?? {}), ...Object.keys(m.outputs ?? {}), ...Object.keys(m.props ?? {})].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function buildErrorCount(catalog: Record<string, WidgetManifest>): number {
  return Object.values(catalog).filter((m) => !!m.error).length;
}

/** "2 in · 1 out · 5 props" */
export function portsSummary(m: Pick<WidgetManifest, 'inputs' | 'outputs' | 'props'>): string {
  const i = Object.keys(m.inputs ?? {}).length, o = Object.keys(m.outputs ?? {}).length, p = Object.keys(m.props ?? {}).length;
  const parts: string[] = [];
  if (i) parts.push(`${i} in`);
  if (o) parts.push(`${o} out`);
  if (p) parts.push(`${p} prop${p === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'no ports or props';
}

export function instancesOf(scene: Pick<SceneState, 'entities'>, widget: string): Entity[] {
  return Object.values(scene.entities).filter((e) => e.widget === widget);
}

/** Instance counts per widget id. */
export function instanceCounts(scene: Pick<SceneState, 'entities'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of Object.values(scene.entities)) out.set(e.widget, (out.get(e.widget) ?? 0) + 1);
  return out;
}

export interface WidgetErrorItem {
  ts: number;
  kind: 'client' | 'build';
  message: string;
  entity?: string;
}

/**
 * Recent errors that concern a widget (newest first): client.error events whose
 * `widget` is it or whose `entity` is one of its instances, and failed widget.build events.
 */
export function widgetErrors(events: readonly ServerEvent[], widget: string, scene: Pick<SceneState, 'entities'>, max = 20): WidgetErrorItem[] {
  const out: WidgetErrorItem[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i];
    const d = e.data;
    if (e.type === 'client.error') {
      const ent = typeof d.entity === 'string' ? d.entity : undefined;
      const mine = d.widget === widget || (ent !== undefined && scene.entities[ent]?.widget === widget);
      if (mine) out.push({ ts: e.ts, kind: 'client', message: String(d.message ?? 'error'), ...(ent ? { entity: ent } : {}) });
    } else if (e.type === 'widget.build' && d.widget === widget && d.ok === false) {
      out.push({ ts: e.ts, kind: 'build', message: String(d.error ?? 'build failed') });
    }
  }
  return out;
}

/** Repo-relative source path of a widget. */
export function sourcePath(id: string): string {
  return `library/widgets/${id}/widget.ts`;
}

/** Compact default value for the props table. */
export function fmtDefault(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return JSON.stringify(v);
  try { const s = JSON.stringify(v); return s.length > 40 ? `${s.slice(0, 40)}…` : s; } catch { return String(v); }
}
