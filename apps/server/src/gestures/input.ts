// Module boundary to @evolspace/input (built by another component). Loaded
// lazily so the server boots — and only the features that need it degrade —
// if the package is missing or broken.
import type { HandFeatures, HandFrame, Handedness, PoseDef, Quat, Vec3 } from '@evolspace/protocol';

export interface ValidationResult { errors: string[]; warnings: string[] }

export interface InputModule {
  computeFeatures(frame: HandFrame, head: { position: Vec3; rotation: Quat }, other?: HandFrame): HandFeatures;
  derivePose(samples: HandFeatures[], opts: { id: string; hand: Handedness | 'either'; description?: string; sigma?: number }): PoseDef;
  /** Optional: structural + semantic checks (unknown feature names, bad hand values) used for gesture-file warnings. */
  validatePoseDef?(x: unknown, expectedId?: string): ValidationResult;
  validateInteractionSet?(x: unknown, poseIds?: Iterable<string>): ValidationResult;
}

let cached: Promise<InputModule> | null = null;

export function loadInput(): Promise<InputModule> {
  cached ??= (async () => {
    // A variable specifier keeps type-checkers from requiring the package at build time.
    const spec = '@evolspace/input';
    const mod = (await import(spec)) as Partial<InputModule>;
    if (typeof mod.computeFeatures !== 'function' || typeof mod.derivePose !== 'function') {
      throw new Error('@evolspace/input does not export computeFeatures/derivePose yet');
    }
    return mod as InputModule;
  })();
  // Don't cache failures forever: the package may be fixed while the server runs.
  cached.catch(() => { cached = null; });
  return cached;
}
