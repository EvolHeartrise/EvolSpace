// Structural validation for library/poses/*.json and library/interactions/*.json.
// Returns human-readable problems (empty = valid) so the server can report
// precise errors to the agent when a hand-edited file is wrong. Unknown
// feature names are reported as warnings: they are legal (the condition simply
// never holds) but almost always a typo.

import { FEATURE_NAMES } from './features.ts';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const KNOWN_FEATURES = new Set(FEATURE_NAMES);

export function validatePoseDef(x: unknown, expectedId?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(x)) return { errors: ['pose must be a JSON object'], warnings };
  if (typeof x.id !== 'string' || !x.id) errors.push('id must be a non-empty string');
  else if (expectedId !== undefined && x.id !== expectedId) errors.push(`id "${x.id}" must equal the file name "${expectedId}"`);
  if (typeof x.description !== 'string') errors.push('description must be a string');
  if (!['left', 'right', 'either'].includes(x.hand as string)) errors.push('hand must be "left", "right" or "either"');
  if (!['builtin', 'recorded', 'manual'].includes(x.source as string)) errors.push('source must be "builtin", "recorded" or "manual"');
  if (x.enterMs !== undefined && (!isNum(x.enterMs) || x.enterMs < 0)) errors.push('enterMs must be a number >= 0');
  if (x.exitSlack !== undefined && (!isNum(x.exitSlack) || x.exitSlack < 0)) errors.push('exitSlack must be a number >= 0');
  if (!Array.isArray(x.conditions) || x.conditions.length === 0) {
    errors.push('conditions must be a non-empty array');
  } else {
    x.conditions.forEach((c, i) => {
      if (!isObj(c) || typeof c.feature !== 'string') {
        errors.push(`conditions[${i}] must be {feature, min?, max?}`);
        return;
      }
      if (c.min === undefined && c.max === undefined) errors.push(`conditions[${i}] (${c.feature}) needs min and/or max`);
      if (c.min !== undefined && !isNum(c.min)) errors.push(`conditions[${i}].min must be a number`);
      if (c.max !== undefined && !isNum(c.max)) errors.push(`conditions[${i}].max must be a number`);
      if (isNum(c.min) && isNum(c.max) && c.min > c.max) errors.push(`conditions[${i}] (${c.feature}): min > max`);
      if (!KNOWN_FEATURES.has(c.feature)) warnings.push(`conditions[${i}]: unknown feature "${c.feature}" (see packages/input/FEATURES.md)`);
    });
  }
  return { errors, warnings };
}

const TARGETS = ['ray', 'touch', 'near', 'none'];
const HANDS = [undefined, 'left', 'right', 'either', 'both'];

function validateBinding(b: unknown, where: string, poseIds: Set<string> | undefined, errors: string[], warnings: string[]): void {
  if (!isObj(b)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof b.id !== 'string' || !b.id) errors.push(`${where}.id must be a non-empty string`);
  if (typeof b.pose !== 'string' || !b.pose) errors.push(`${where}.pose must be a pose id`);
  else if (poseIds && !poseIds.has(b.pose)) warnings.push(`${where}: pose "${b.pose}" does not exist in library/poses`);
  if (!HANDS.includes(b.hand as string | undefined)) errors.push(`${where}.hand must be left|right|either|both`);
  if (!TARGETS.includes(b.target as string)) errors.push(`${where}.target must be ray|touch|near|none`);
  if (b.priority !== undefined && !isNum(b.priority)) errors.push(`${where}.priority must be a number`);
  const a = b.action;
  if (!isObj(a)) {
    errors.push(`${where}.action must be an object`);
    return;
  }
  switch (a.type) {
    case 'grab':
    case 'scale':
      if (b.target === 'none') errors.push(`${where}: ${a.type} needs a target (ray|touch|near)`);
      break;
    case 'widget':
      if (typeof a.handler !== 'string' || !a.handler) errors.push(`${where}.action.handler must be a string`);
      break;
    case 'command':
      if (typeof a.command !== 'string' || !a.command) errors.push(`${where}.action.command must be a string`);
      if (a.args !== undefined && !isObj(a.args)) errors.push(`${where}.action.args must be an object`);
      break;
    case 'channel':
      if (typeof a.channel !== 'string' || !a.channel) errors.push(`${where}.action.channel must be a string`);
      if (!('value' in a)) errors.push(`${where}.action.value is required`);
      break;
    default:
      errors.push(`${where}.action.type must be grab|scale|widget|command|channel`);
  }
}

/** Validate an interaction set; pass the known pose ids to also flag dangling pose references. */
export function validateInteractionSet(x: unknown, poseIds?: Iterable<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(x)) return { errors: ['interaction set must be a JSON object'], warnings };
  if (typeof x.description !== 'string') errors.push('description must be a string');
  if (x.scope !== 'global' && x.scope !== 'entity-default') errors.push('scope must be "global" or "entity-default"');
  const ids = poseIds ? new Set(poseIds) : undefined;
  if (!Array.isArray(x.bindings)) errors.push('bindings must be an array');
  else {
    const seen = new Set<string>();
    x.bindings.forEach((b, i) => {
      validateBinding(b, `bindings[${i}]`, ids, errors, warnings);
      const id = isObj(b) ? b.id : undefined;
      if (typeof id === 'string') {
        if (seen.has(id)) errors.push(`bindings[${i}]: duplicate id "${id}"`);
        seen.add(id);
      }
    });
  }
  return { errors, warnings };
}

/** Validate a single binding (e.g. an entity's `interactions` entry or a widget default). */
export function validateInteractionBinding(x: unknown, poseIds?: Iterable<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateBinding(x, 'binding', poseIds ? new Set(poseIds) : undefined, errors, warnings);
  return { errors, warnings };
}

