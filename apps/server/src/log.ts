// Minimal leveled logger. Each module gets a tagged child: log.child('scene').
// Kept dependency-free; output is single-line so it greps well.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(tag: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Replace the sink (tests use this to silence or capture output). */
  sink?: (level: LogLevel, line: string, rest: unknown[]) => void;
}

const defaultSink = (level: LogLevel, line: string, rest: unknown[]): void => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line, ...rest);
};

export function createLogger(opts: LoggerOptions = {}, tag = 'server'): Logger {
  const min = ORDER[opts.level ?? (process.env.EVOL_LOG_LEVEL as LogLevel) ?? 'info'] ?? ORDER.info;
  const sink = opts.sink ?? defaultSink;
  const emit = (level: LogLevel, msg: string, rest: unknown[]): void => {
    if (ORDER[level] < min) return;
    const ts = new Date().toISOString().slice(11, 23);
    sink(level, `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`, rest);
  };
  return {
    debug: (m, ...r) => emit('debug', m, r),
    info: (m, ...r) => emit('info', m, r),
    warn: (m, ...r) => emit('warn', m, r),
    error: (m, ...r) => emit('error', m, r),
    child: (t) => createLogger(opts, `${tag}:${t}`),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = createLogger({ sink: () => {} });
