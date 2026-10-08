import { describe, it, expect } from 'vitest';
import { EnvironmentPolicy } from '../src/xr/environment.ts';

function fakeRuntime(grid = true) {
  const calls: boolean[] = [];
  const rt = {
    environment: { grid },
    setEnvironment(e: { grid?: boolean }) {
      if (typeof e.grid === 'boolean') { rt.environment.grid = e.grid; calls.push(e.grid); }
    },
  };
  return { rt, calls };
}

describe('EnvironmentPolicy (floor grid per session mode)', () => {
  it('hides the grid in AR and restores it when the session ends', () => {
    const { rt, calls } = fakeRuntime(true);
    const p = new EnvironmentPolicy(rt);
    p.onSessionStart('ar');
    expect(rt.environment.grid).toBe(false);
    p.onSessionEnd();
    expect(rt.environment.grid).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  it('keeps the grid in VR and leaves it alone on VR end', () => {
    const { rt, calls } = fakeRuntime(true);
    const p = new EnvironmentPolicy(rt);
    p.onSessionStart('vr');
    p.onSessionEnd();
    expect(rt.environment.grid).toBe(true);
    expect(calls).toEqual([]);
  });

  it('AR → VR switch (end + start) restores the grid', () => {
    const { rt } = fakeRuntime(true);
    const p = new EnvironmentPolicy(rt);
    p.onSessionStart('ar');
    p.onSessionEnd();
    p.onSessionStart('vr');
    expect(rt.environment.grid).toBe(true);
  });

  it('restores a grid the user had turned off (grid.toggle) as off', () => {
    const { rt } = fakeRuntime(false);
    const p = new EnvironmentPolicy(rt);
    p.onSessionStart('ar');
    expect(rt.environment.grid).toBe(false);
    p.onSessionEnd();
    expect(rt.environment.grid).toBe(false);
  });

  it('remembers the pre-AR value across a repeated AR start', () => {
    const { rt } = fakeRuntime(true);
    const p = new EnvironmentPolicy(rt);
    p.onSessionStart('ar');
    p.onSessionStart('ar'); // e.g. a restarted AR session without an end callback
    p.onSessionEnd();
    expect(rt.environment.grid).toBe(true);
  });
});
