// stderr-only logger. stdout is the MCP JSON-RPC wire: anything printed there
// corrupts the protocol, so every diagnostic in the bridge goes through here.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(
  scope = 'evolspace-mcp',
  level: LogLevel = (process.env.EVOL_BRIDGE_LOG as LogLevel) in ORDER ? (process.env.EVOL_BRIDGE_LOG as LogLevel) : 'info',
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < min) return;
    const msg = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    sink(`[${scope}] ${lvl}: ${msg}`);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
