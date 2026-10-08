// Lightweight index of the server scene (ids, names, widgets, hierarchy) kept
// by the mirror from scene.snapshot / scene.patch messages. Used for labels,
// for "unknown entity" errors, and to know when to wait for widget creation.
// The runtime owns the real scene graph; this is metadata only.
import type { Entity, SceneOp, SceneState } from '@evolspace/protocol';

export interface IndexedEntity {
  id: string;
  parent: string | null;
  name?: string;
  widget: string;
  visible: boolean;
}

export class SceneIndex {
  readonly entities = new Map<string, IndexedEntity>();
  version = -1;

  applySnapshot(scene: SceneState): void {
    this.entities.clear();
    for (const e of Object.values(scene.entities)) this.put(e);
    this.version = scene.version;
  }

  applyPatch(version: number, ops: SceneOp[]): void {
    for (const op of ops) {
      switch (op.op) {
        case 'add':
          // The server assigns ids before broadcasting; skip anything without one.
          if (op.entity.id) this.put(op.entity as Entity);
          break;
        case 'update': {
          const e = this.entities.get(op.id);
          if (!e) break;
          const p = op.patch;
          if (p.name !== undefined) e.name = p.name;
          if (p.widget !== undefined) e.widget = p.widget;
          if (p.parent !== undefined) e.parent = p.parent;
          if (p.visible !== undefined) e.visible = p.visible;
          break;
        }
        case 'remove':
          this.removeSubtree(op.id);
          break;
        case 'clear':
          this.entities.clear();
          break;
        default:
          break; // link ops don't affect the entity index
      }
    }
    this.version = version;
  }

  has(id: string): boolean {
    return this.entities.has(id);
  }

  /** Entity and its ancestors are all visible. */
  isEffectivelyVisible(id: string): boolean {
    for (let e = this.entities.get(id), guard = 0; e && guard < 1000; e = e.parent ? this.entities.get(e.parent) : undefined, guard++) {
      if (!e.visible) return false;
    }
    return true;
  }

  private put(e: Partial<Entity> & { id?: string; widget: string }): void {
    if (!e.id) return;
    this.entities.set(e.id, {
      id: e.id,
      parent: e.parent ?? null,
      name: e.name,
      widget: e.widget,
      visible: e.visible ?? true,
    });
  }

  private removeSubtree(id: string): void {
    const doomed = new Set([id]);
    // Repeat until no new descendants are found (parents may appear in any order).
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of this.entities.values()) {
        if (e.parent && doomed.has(e.parent) && !doomed.has(e.id)) {
          doomed.add(e.id);
          grew = true;
        }
      }
    }
    for (const d of doomed) this.entities.delete(d);
  }
}

/**
 * True unless every op only moves entities. Transform-only updates (an entity
 * being dragged streams ~10/s) need no settling before a capture.
 */
export function isStructural(ops: SceneOp[]): boolean {
  return ops.some((op) => op.op !== 'update' || Object.keys(op.patch).some((k) => k !== 'transform'));
}
