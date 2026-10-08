// Client command routing. One namespace (see ARCHITECTURE.md "Commands"):
//   1. client-owned commands (voice.ptt, session.mode, …) — registered into the
//      runtime's local command registry, so they also run when the runtime
//      dispatches them (server-pushed {type:'command'}, system UI buttons);
//   2. runtime local commands (select, agent.panel.toggle, …);
//   3. otherwise forwarded to the server as {type:'command'} (start phase only;
//      server commands are one-shot, so held 'end' phases are dropped).

import type { ClientMessage } from '@evolspace/protocol';

export type CommandPhase = 'start' | 'end';
export type CommandArgs = Record<string, unknown> | undefined;
export type CommandHandler = (args: CommandArgs, phase: CommandPhase) => void;

export interface CommandTarget {
  runLocalCommand(name: string, args: CommandArgs, phase: CommandPhase): boolean;
  registerLocalCommand?(name: string, fn: CommandHandler): () => void;
}

export interface CommandLogEntry {
  name: string;
  phase: CommandPhase;
  route: 'local' | 'server' | 'dropped';
  t: number;
}

export class CommandRouter {
  private readonly handlers = new Map<string, CommandHandler>();
  /** Recent routing decisions (debugging / tests via __evol.state()). */
  readonly log: CommandLogEntry[] = [];

  constructor(
    private readonly runtime: CommandTarget | null,
    private readonly send: (m: ClientMessage) => void,
  ) {}

  /** Register a client-owned command. Returns an unregister fn. */
  register(name: string, handler: CommandHandler): () => void {
    const safe: CommandHandler = (a, p) => {
      try { handler(a, p); } catch (e) { console.error(`[evol] command ${name} failed`, e); }
    };
    this.handlers.set(name, safe);
    const offRuntime = this.runtime?.registerLocalCommand?.(name, safe);
    return () => {
      if (this.handlers.get(name) === safe) this.handlers.delete(name);
      offRuntime?.();
    };
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  /** Run a command from a binding, keyboard, voice HUD or test hook. */
  run(name: string, args: CommandArgs, phase: CommandPhase = 'start'): CommandLogEntry['route'] {
    let route: CommandLogEntry['route'];
    const h = this.handlers.get(name);
    if (h) {
      h(args, phase);
      route = 'local';
    } else if (this.runtime?.runLocalCommand(name, args, phase)) {
      route = 'local';
    } else if (phase === 'start') {
      this.send(args ? { type: 'command', name, args } : { type: 'command', name });
      route = 'server';
    } else {
      route = 'dropped';
    }
    this.log.push({ name, phase, route, t: Date.now() });
    if (this.log.length > 50) this.log.shift();
    return route;
  }
}
