// Static checks for a WidgetDefinition — the server's checkStatics plus the
// library's own conventions (every prop has a valid default, color defaults
// pass the runtime's color validator, descriptions are useful).

const PROP_TYPES = ['number', 'integer', 'boolean', 'string', 'color', 'vec3', 'enum', 'json', 'channel'];
const PORT_TYPES = ['number', 'boolean', 'string', 'vec3', 'color', 'json', 'tensor', 'event', 'any'];
// Runtime prop validator (packages/runtime/src/widgets/props.ts) accepts these as colors.
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_COLOR = /^(rgb|rgba|hsl|hsla)\(|^[a-z]+$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function checkDefinition(def: unknown): string[] {
  const out: string[] = [];
  if (!isObj(def)) return ['definition is not an object'];
  if (typeof def.description !== 'string' || def.description.trim().length < 40) out.push('description must be a helpful sentence or two (≥ 40 chars)');
  if (typeof def.version !== 'string') out.push('version must be a string');
  if (typeof def.create !== 'function') out.push('create must be a function');
  const props = def.props ?? {};
  if (!isObj(props)) out.push('props must be an object');
  else {
    for (const [name, spec] of Object.entries(props)) {
      if (!isObj(spec) || !PROP_TYPES.includes(spec.type as string)) { out.push(`props.${name}: bad type`); continue; }
      const d = spec.default;
      if (d === undefined) { out.push(`props.${name}: needs a default`); continue; }
      const t = spec.type as string;
      const bad = (msg: string) => out.push(`props.${name}: default ${JSON.stringify(d)} ${msg}`);
      if (t === 'number' || t === 'integer') {
        if (!isNum(d)) bad('is not a finite number');
        else {
          if (t === 'integer' && !Number.isInteger(d)) bad('is not an integer');
          if (isNum(spec.min) && d < spec.min) bad(`< min ${spec.min}`);
          if (isNum(spec.max) && d > spec.max) bad(`> max ${spec.max}`);
        }
      } else if (t === 'boolean' && typeof d !== 'boolean') bad('is not a boolean');
      else if ((t === 'string' || t === 'channel') && typeof d !== 'string') bad('is not a string');
      else if (t === 'color' && !(typeof d === 'string' && (HEX.test(d) || CSS_COLOR.test(d)))) bad('is not accepted by the runtime color validator');
      else if (t === 'vec3' && !(Array.isArray(d) && d.length === 3 && d.every(isNum))) bad('is not [x, y, z]');
      else if (t === 'enum') {
        if (!Array.isArray(spec.options) || !spec.options.length) out.push(`props.${name}: enum needs options`);
        else if (!spec.options.includes(d)) bad(`is not one of ${spec.options.join('|')}`);
      }
    }
  }
  for (const field of ['inputs', 'outputs'] as const) {
    const ports = def[field] ?? {};
    if (!isObj(ports)) { out.push(`${field} must be an object`); continue; }
    for (const [name, spec] of Object.entries(ports)) {
      if (!isObj(spec) || !PORT_TYPES.includes(spec.type as string)) out.push(`${field}.${name}: bad type`);
      if (isObj(spec) && typeof spec.description !== 'string') out.push(`${field}.${name}: needs a description`);
    }
  }
  if (def.interactions !== undefined) {
    if (!Array.isArray(def.interactions)) out.push('interactions must be an array');
    else for (const b of def.interactions) {
      if (!isObj(b) || typeof b.id !== 'string' || typeof b.pose !== 'string' || typeof b.target !== 'string' || !isObj(b.action)) out.push(`interactions: malformed binding ${JSON.stringify(b)}`);
    }
  }
  // size is optional in the contract. Omit it ONLY for widgets that can be empty
  // (e.g. `group`): the runtime picker hit-tests empty content as a box of `size`.
  if (def.size !== undefined && !(Array.isArray(def.size) && def.size.length === 3 && def.size.every((n) => isNum(n) && n > 0))) out.push('size must be [x, y, z] > 0 meters');
  return out;
}

/** Validate a concrete prop value against its spec (server + runtime rules). Returns an error or null. */
export function checkPropValue(spec: { type: string; min?: number; max?: number; options?: string[] }, v: unknown): string | null {
  switch (spec.type) {
    case 'number':
    case 'integer':
      if (!isNum(v)) return 'must be a finite number';
      if (spec.type === 'integer' && !Number.isInteger(v)) return 'must be an integer';
      if (isNum(spec.min) && v < spec.min) return `must be >= ${spec.min}`;
      if (isNum(spec.max) && v > spec.max) return `must be <= ${spec.max}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be a boolean';
    case 'string':
    case 'channel':
      return typeof v === 'string' ? null : 'must be a string';
    case 'color':
      return typeof v === 'string' && (HEX.test(v) || CSS_COLOR.test(v)) ? null : 'must be a color the runtime accepts';
    case 'vec3':
      return Array.isArray(v) && v.length === 3 && v.every(isNum) ? null : 'must be [x, y, z]';
    case 'enum':
      return typeof v === 'string' && (spec.options ?? []).includes(v) ? null : `must be one of ${(spec.options ?? []).join('|')}`;
    default:
      return null;
  }
}
