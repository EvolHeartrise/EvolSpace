// API keys and other secrets for sources. They live in ONE file outside the repo
// (default ~/.config/evolspace/secrets.env, override with EVOL_SECRETS_FILE), as dotenv-style
// KEY=value lines. A source declares the names it needs in source.json ("secrets": ["X_API_KEY"]);
// the supervisor reads the file fresh at every start and hands that source exactly those
// variables — no other source, widget, channel or log line ever sees them.
import os from 'node:os';
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.EVOL_SECRETS_FILE || path.join(os.homedir(), '.config', 'evolspace', 'secrets.env'));
}

/** Parse dotenv-style text: KEY=value, optional `export `, '#' comments, single/double quotes. */
export function parseSecrets(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      v = v.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    out.set(m[1], v);
  }
  return out;
}

export interface ResolvedSecrets {
  values: Record<string, string>;
  missing: string[];
  /** Problems worth logging (never contains values). */
  warnings: string[];
}

/** Read `file` and pick `names`. Empty values count as missing. */
export function resolveSecrets(names: readonly string[], file: string): ResolvedSecrets {
  const warnings: string[] = [];
  let all = new Map<string, string>();
  if (names.length && existsSync(file)) {
    try {
      all = parseSecrets(readFileSync(file, 'utf8'));
      if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) {
        warnings.push(`${file} is readable by other users; run: chmod 600 "${file}"`);
      }
    } catch (e) {
      warnings.push(`cannot read ${file}: ${(e as Error).message}`);
    }
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = all.get(n);
    if (v) values[n] = v;
    else missing.push(n);
  }
  return { values, missing, warnings };
}

/** Create an empty, private secrets file with usage notes (if there is none). Returns true if created. */
export function ensureSecretsFile(file: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, [
    '# EvolSpace secrets: API keys for data sources (library/sources/*).',
    '# One KEY=value per line. A source gets only the keys listed in its',
    '# source.json "secrets" array; widgets, channels and logs never see them.',
    '# Keep this file private (chmod 600) and out of git. After editing,',
    '# restart the source that uses the key (sources tool / API).',
    '',
  ].join('\n'), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return true;
}

/** Replace any secret value occurring in a log line (in case a source prints one). */
export function redact(line: string, values: readonly string[]): string {
  let out = line;
  for (const v of values) if (v.length >= 6 && out.includes(v)) out = out.split(v).join('[secret]');
  return out;
}
