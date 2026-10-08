// Pure helpers of the scene tree panel (unit-tested).

import type { Entity } from '@evolspace/protocol';
import type { TreeNode } from '../../store.ts';

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Matches the filter itself (vs. shown as an ancestor of a match). */
  match: boolean;
}

export function entityMatches(e: Entity, q: string): boolean {
  if (!q) return true;
  return (e.name ?? '').toLowerCase().includes(q) || e.widget.toLowerCase().includes(q) || e.id.toLowerCase().includes(q);
}

/**
 * Visible rows in display order. Without a query, collapsed nodes hide their
 * children. With a query, matching nodes and their ancestors are shown
 * (expanded regardless of the collapsed set).
 */
export function flattenTree(roots: TreeNode[], collapsed: ReadonlySet<string>, query = ''): FlatRow[] {
  const q = query.trim().toLowerCase();
  const out: FlatRow[] = [];
  if (!q) {
    const walk = (n: TreeNode, depth: number) => {
      const expanded = !collapsed.has(n.id);
      out.push({ node: n, depth, hasChildren: n.children.length > 0, expanded, match: true });
      if (expanded) for (const c of n.children) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
  }
  const keep = new Map<string, boolean>(); // id → subtree has a match
  const scan = (n: TreeNode): boolean => {
    let any = entityMatches(n.entity, q);
    for (const c of n.children) if (scan(c)) any = true;
    keep.set(n.id, any);
    return any;
  };
  for (const r of roots) scan(r);
  const walk = (n: TreeNode, depth: number) => {
    if (!keep.get(n.id)) return;
    const kids = n.children.filter((c) => keep.get(c.id));
    out.push({ node: n, depth, hasChildren: kids.length > 0, expanded: true, match: entityMatches(n.entity, q) });
    for (const c of kids) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Ids of all ancestors of `id` (closest first). */
export function ancestorsOf(entities: Record<string, Entity>, id: string): string[] {
  const out: string[] = [];
  let cur = entities[id]?.parent ?? null;
  const seen = new Set<string>([id]);
  while (cur && entities[cur] && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = entities[cur].parent;
  }
  return out;
}

/** True if `candidate` is `id` or one of its descendants (invalid reparent target). */
export function isSelfOrDescendant(entities: Record<string, Entity>, id: string, candidate: string): boolean {
  return candidate === id || ancestorsOf(entities, candidate).includes(id);
}
