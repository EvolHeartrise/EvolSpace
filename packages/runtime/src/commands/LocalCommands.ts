// Client-local command registry. The client tries these first; unknown names
// go to the server. Handlers receive both phases for held commands
// (e.g. voice.ptt start/end); one-shot commands should act on 'start'.

export type CommandPhase = 'start' | 'end';
export type LocalCommandFn = (args: Record<string, unknown> | undefined, phase: CommandPhase) => void;

export class LocalCommands {
  private fns = new Map<string, LocalCommandFn>();

  constructor(private onError?: (name: string, err: unknown) => void) {}

  /** Register (or replace) a handler. Returns an unregister fn. */
  register(name: string, fn: LocalCommandFn): () => void {
    this.fns.set(name, fn);
    return () => {
      if (this.fns.get(name) === fn) this.fns.delete(name);
    };
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }

  names(): string[] {
    return [...this.fns.keys()];
  }

  /** Returns false if the command is not handled locally. Handler errors are contained. */
  run(name: string, args: Record<string, unknown> | undefined, phase: CommandPhase): boolean {
    const fn = this.fns.get(name);
    if (!fn) return false;
    try {
      fn(args, phase);
    } catch (err) {
      if (this.onError) this.onError(name, err);
      else console.error(`local command ${name} failed`, err);
    }
    return true;
  }
}
