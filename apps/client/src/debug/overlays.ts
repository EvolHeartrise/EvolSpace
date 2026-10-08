// Runs the registered 3D debug overlays: creates an instance while an overlay
// is enabled, disposes it when disabled, calls update() every frame (after
// runtime.update, before render). Enabled ids persist with the layout.

import { computed, effect, type ReadonlySignal } from '@preact/signals';
import type { DebugContext, OverlayDef, OverlayHost, OverlayInstance } from './types.ts';
import type { LayoutStore } from './layout.ts';

export class OverlayRunner implements OverlayHost {
  readonly enabled: ReadonlySignal<ReadonlySet<string>>;
  private readonly live = new Map<string, { def: OverlayDef; inst: OverlayInstance }>();
  private stopEffect: (() => void) | null = null;
  private stopFrame: (() => void) | null = null;

  constructor(readonly defs: ReadonlySignal<OverlayDef[]>, private readonly layout: LayoutStore) {
    this.enabled = computed(() => {
      const saved = this.layout.state.value.overlays;
      if (saved) return new Set(saved);
      return new Set(this.defs.value.filter((d) => d.defaultEnabled).map((d) => d.id));
    });
  }

  /** Start creating/updating overlays (needs the full context). */
  start(ctx: DebugContext): void {
    this.stopEffect = effect(() => {
      const on = this.enabled.value;
      const defs = this.defs.value;
      for (const [id, l] of [...this.live]) {
        const def = defs.find((d) => d.id === id);
        if (!on.has(id) || def !== l.def) this.destroy(id);
      }
      for (const def of defs) {
        if (!on.has(def.id) || this.live.has(def.id)) continue;
        try {
          this.live.set(def.id, { def, inst: def.create(ctx) });
        } catch (e) {
          console.error(`[debug] overlay ${def.id} failed to start`, e);
          ctx.toast(`Overlay '${def.title}' failed: ${(e as Error).message}`, 'error');
        }
      }
    });
    this.stopFrame = ctx.client.onFrame((dt, tMs) => {
      for (const [id, l] of this.live) {
        if (!l.inst.update) continue;
        try { l.inst.update(dt, tMs); } catch (e) {
          console.error(`[debug] overlay ${id} update failed; disabling it`, e);
          ctx.toast(`Overlay '${l.def.title}' crashed and was disabled: ${(e as Error).message}`, 'error');
          this.setEnabled(id, false);
        }
      }
    });
  }

  isEnabled(id: string): boolean {
    return this.enabled.value.has(id);
  }

  setEnabled(id: string, on: boolean): void {
    const next = new Set(this.enabled.peek());
    if (on) next.add(id); else next.delete(id);
    this.layout.setOverlays([...next]);
  }

  toggle(id: string): void {
    this.setEnabled(id, !this.enabled.peek().has(id));
  }

  private destroy(id: string): void {
    const l = this.live.get(id);
    this.live.delete(id);
    try { l?.inst.dispose(); } catch (e) { console.error(`[debug] overlay ${id} dispose failed`, e); }
  }

  dispose(): void {
    this.stopEffect?.();
    this.stopFrame?.();
    for (const id of [...this.live.keys()]) this.destroy(id);
  }
}
