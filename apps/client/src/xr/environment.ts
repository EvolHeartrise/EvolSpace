// Per-session-mode environment: the runtime's floor grid covers the real floor
// in passthrough, so it is hidden while an AR session runs and restored to what
// it was (default on, or whatever `grid.toggle` set) when AR ends or switches to VR.

import type { XrMode } from './session.ts';

export interface EnvironmentPort {
  readonly environment: { grid: boolean };
  setEnvironment(env: { grid?: boolean }): void;
}

export class EnvironmentPolicy {
  /** Grid visibility before entering AR (null = not in AR). */
  private savedGrid: boolean | null = null;

  constructor(private readonly env: EnvironmentPort) {}

  onSessionStart(mode: XrMode): void {
    if (mode === 'ar') {
      if (this.savedGrid === null) this.savedGrid = this.env.environment.grid;
      this.env.setEnvironment({ grid: false });
    } else {
      this.restore();
    }
  }

  onSessionEnd(): void {
    this.restore();
  }

  private restore(): void {
    if (this.savedGrid === null) return;
    this.env.setEnvironment({ grid: this.savedGrid });
    this.savedGrid = null;
  }
}
