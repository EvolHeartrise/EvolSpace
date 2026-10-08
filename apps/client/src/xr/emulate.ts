// Emulated XR (IWER): ?emulate=quest3 installs Meta's Immersive Web Emulation
// Runtime before any session request, so the *real* WebXR code path (session,
// reference spaces, anchors, hand joints) runs in desktop Chrome / Playwright.
// ?devui=1 adds IWER's DevUI (on-screen headset/hand controls); ?sem=<env>
// loads a synthetic room (living_room, office_small, …) for AR emulation.
//
// Loaded with dynamic import so none of this ships to the headset path.

export interface EmulationOptions {
  device: string;     // 'quest3' | 'quest2' | 'questpro'
  devui: boolean;
  sem?: string | null;
}

export interface EmulationHandle {
  /** The IWER XRDevice (typed loosely to keep iwer out of the main bundle's types). */
  device: unknown;
  description: string;
}

export async function installEmulation(opts: EmulationOptions): Promise<EmulationHandle> {
  const iwer = await import('iwer');
  const configs: Record<string, typeof iwer.metaQuest3> = {
    quest3: iwer.metaQuest3,
    quest2: iwer.metaQuest2,
    questpro: iwer.metaQuestPro,
  };
  const config = configs[opts.device] ?? iwer.metaQuest3;
  const device = new iwer.XRDevice(config);
  // Override a native runtime too (e.g. Chrome with a WebXR flag) — emulation was explicitly requested.
  device.installRuntime({ forceInstall: true });
  // Hand tracking is the primary input on EvolSpace.
  device.primaryInputMode = 'hand';
  if (opts.devui) {
    const { DevUI } = await import('@iwer/devui');
    device.installDevUI(DevUI as unknown as Parameters<typeof device.installDevUI>[0]);
  }
  if (opts.sem) {
    const { SyntheticEnvironmentModule } = await import('@iwer/sem');
    device.installSEM(SyntheticEnvironmentModule as unknown as Parameters<typeof device.installSEM>[0]);
    try {
      device.sem?.loadDefaultEnvironment(opts.sem);
    } catch (e) {
      console.warn(`[evol] SEM environment '${opts.sem}' failed to load`, e);
    }
  }
  return { device, description: `${config.name} (IWER ${device.version})${opts.devui ? ' + DevUI' : ''}` };
}
