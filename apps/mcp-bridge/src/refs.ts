// Compact string syntax for link endpoints, so Claude can write links tersely:
//   "e-12.value"        → { kind: 'port', entity: 'e-12', port: 'value' }
//   "#weather.seattle"  → { kind: 'channel', channel: 'weather.seattle' }
//   "channel:ui.layer"  → { kind: 'channel', channel: 'ui.layer' }   (alternative spelling)
// Port refs split at the LAST dot: port names are identifiers, while entity ids
// are server-assigned and might contain dots.
import type { PortRef } from '@evolspace/protocol';

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

const SYNTAX_HELP = `use "<entityId>.<port>" (e.g. "e-12.value") or "#<channel>" (e.g. "#interp.ctl.layer")`;

export function parseRef(input: string): PortRef {
  const s = input.trim();
  if (!s) throw new RefError(`empty ref; ${SYNTAX_HELP}`);
  if (/\s/.test(s)) throw new RefError(`ref "${input}" contains whitespace; ${SYNTAX_HELP}`);
  let channel: string | undefined;
  if (s.startsWith('#')) channel = s.slice(1);
  else if (s.startsWith('channel:')) channel = s.slice('channel:'.length);
  if (channel !== undefined) {
    if (!channel) throw new RefError(`ref "${input}" has an empty channel name; ${SYNTAX_HELP}`);
    return { kind: 'channel', channel };
  }
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) throw new RefError(`ref "${input}" is not a port or channel ref; ${SYNTAX_HELP}`);
  const entity = s.slice(0, dot);
  const port = s.slice(dot + 1);
  if (!/^[A-Za-z_$][\w$-]*$/.test(port)) throw new RefError(`ref "${input}": "${port}" is not a valid port name; ${SYNTAX_HELP}`);
  return { kind: 'port', entity, port };
}

export function formatRef(ref: PortRef): string {
  return ref.kind === 'channel' ? `#${ref.channel}` : `${ref.entity}.${ref.port}`;
}

export function sameRef(a: PortRef, b: PortRef): boolean {
  if (a.kind === 'channel' && b.kind === 'channel') return a.channel === b.channel;
  if (a.kind === 'port' && b.kind === 'port') return a.entity === b.entity && a.port === b.port;
  return false;
}
