// STUB — replaced by the mirror component. Keeps the server bootable meanwhile.
import type { Mirror, MirrorDeps } from './types.ts';
export type { Mirror, MirrorDeps };
export async function startMirror(_deps: MirrorDeps): Promise<Mirror> {
  const fail = async (): Promise<never> => { throw new Error('mirror renderer not implemented yet'); };
  return { screenshot: fail, thumbnail: fail, close: async () => {} };
}
