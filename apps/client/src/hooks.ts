// window.__evol — test/automation hooks (Playwright, devtools, the mirror's
// harness). Stable surface:
//
//   __evol.runtime / engine / net / client
//   __evol.sim.setHands(specs | frames)  simulated hands override real input (any mode)
//   __evol.sim.clearHands()
//   __evol.sim.setPinchAt(hand, point, pinching)  hand whose pinch point is exactly at `point`
//   __evol.sim.command(name, args?, phase?)  run a command through the client router
//   __evol.state()                       JSON-safe snapshot (connection, mode, hands, ptt, …)
//
// Specs are the input package's SynthHandSpec in SPACE coordinates, e.g.
//   __evol.sim.setHands({ hand: 'right', position: [0, 1.2, -0.4], pinch: 'index' })

import type { HandFrame, Handedness } from '@evolspace/protocol';
import type { EvolClient } from './app.ts';
import type { SimHandInput } from './sim/sim.ts';
import type { CommandArgs, CommandPhase } from './commands.ts';

export interface EvolHooks {
  client: EvolClient;
  runtime: EvolClient['runtime'];
  engine: EvolClient['engine'];
  net: EvolClient['net'];
  sim: {
    setHands(input: SimHandInput | SimHandInput[] | Partial<Record<Handedness, SimHandInput>>): Partial<Record<Handedness, HandFrame>>;
    clearHands(): void;
    /** Put a hand's pinch point at `point` (space coords), pinching or not. */
    setPinchAt(hand: Handedness, point: [number, number, number], pinching: boolean, rotation?: [number, number, number, number]): HandFrame;
    command(name: string, args?: CommandArgs, phase?: CommandPhase): string;
  };
  state(): Record<string, unknown>;
  /** Debug dashboard context (only with ?debug=1 / /debug, once it has started). */
  debug?: import('./debug/types.ts').DebugContext;
}

declare global {
  interface Window {
    __evol?: EvolHooks;
  }
}

export function installHooks(client: EvolClient): EvolHooks {
  const hooks: EvolHooks = {
    client,
    // Getters: the hooks are installed before start() and must see late-created objects.
    get runtime() { return client.runtime; },
    get engine() { return client.engine; },
    get net() { return client.net; },
    sim: {
      setHands: (input) => client.sim.setHands(input),
      clearHands: () => client.sim.clearHands(),
      setPinchAt: (hand, point, pinching, rotation) => client.sim.setPinchAt(hand, point, pinching, rotation),
      command: (name, args, phase = 'start') => client.command(name, args, phase),
    },
    state: () => (client.started ? JSON.parse(JSON.stringify(client.state())) as Record<string, unknown> : { booting: true }),
  };
  window.__evol = hooks;
  return hooks;
}
