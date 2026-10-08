// Short, readable ids ("e-7f3a"). Collisions are checked by the caller via `taken`;
// the length grows automatically if the space gets crowded.
import { randomBytes } from 'node:crypto';

export function shortId(prefix: string, taken: (id: string) => boolean = () => false, hexLen = 4): string {
  for (let attempt = 0; ; attempt++) {
    const len = hexLen + Math.floor(attempt / 8); // after 8 collisions, use a longer id
    const id = `${prefix}-${randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)}`;
    if (!taken(id)) return id;
  }
}

/** Ids supplied by users/agents: readable, URL- and filename-safe. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Workspace / pose / prefab names used as file names. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isSafeName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}
