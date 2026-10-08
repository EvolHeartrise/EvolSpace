// Repair a scene read from disk (data/workspaces/<name>.json) before it
// becomes the authoritative state. Workspace files are hand-editable (Claude
// may edit them, older versions may lack fields), and a malformed entity must
// not crash every client: missing fields get defaults, broken parts are
// dropped, and each repair is reported so it can be logged.
import type { Entity, Link } from '@evolspace/protocol';
import { IDENTITY_TRANSFORM } from '@evolspace/protocol';
import { ID_RE } from '../util/ids.ts';
import { checkAnchor, checkInteractions, checkPartialTransform, checkPortRefShape, checkTags, isObj, mergeTransform } from './validate.ts';

export interface SanitizedScene {
  entities: Record<string, Entity>;
  links: Record<string, Link>;
  /** Human-readable repairs made (empty when the file was clean). */
  problems: string[];
}

export function sanitizeScene(rawEntities: unknown, rawLinks: unknown): SanitizedScene {
  const problems: string[] = [];
  const entities: Record<string, Entity> = {};
  const links: Record<string, Link> = {};
  const attempt = <T>(what: string, f: () => T, fallback: T): T => {
    try { return f(); } catch (e) { problems.push(`${what}: ${(e as Error).message} (reset)`); return fallback; }
  };

  if (rawEntities !== undefined && !isObj(rawEntities)) problems.push('entities is not an object (ignored)');
  for (const [id, e] of Object.entries(isObj(rawEntities) ? rawEntities : {})) {
    if (!ID_RE.test(id)) { problems.push(`entity id '${id}' is invalid (dropped)`); continue; }
    if (!isObj(e) || typeof e.widget !== 'string' || !e.widget) { problems.push(`entity '${id}' has no widget (dropped)`); continue; }
    const out: Entity = {
      id,
      parent: typeof e.parent === 'string' ? e.parent : null,
      widget: e.widget,
      props: isObj(e.props) ? e.props : {},
      transform: attempt(`entity '${id}' transform`, () => mergeTransform(IDENTITY_TRANSFORM, checkPartialTransform(e.transform)), structuredClone(IDENTITY_TRANSFORM)),
      visible: typeof e.visible === 'boolean' ? e.visible : true,
    };
    if (e.id !== undefined && e.id !== id) problems.push(`entity '${id}' had id '${String(e.id)}' (key wins)`);
    if (typeof e.name === 'string') out.name = e.name;
    if (e.anchor != null) { const a = attempt(`entity '${id}' anchor`, () => checkAnchor(e.anchor), undefined); if (a) out.anchor = a; }
    if (e.tags != null) { const t = attempt(`entity '${id}' tags`, () => checkTags(e.tags), undefined); if (t) out.tags = t; }
    if (e.interactions != null) { const i = attempt(`entity '${id}' interactions`, () => checkInteractions(e.interactions), undefined); if (i) out.interactions = i; }
    if (typeof e.locked === 'boolean') out.locked = e.locked;
    entities[id] = out;
  }

  // Parents must exist and must not form cycles.
  for (const e of Object.values(entities)) {
    if (e.parent !== null && !entities[e.parent]) { problems.push(`entity '${e.id}' had missing parent '${e.parent}' (now a root)`); e.parent = null; }
  }
  for (const e of Object.values(entities)) {
    const seen = new Set<string>([e.id]);
    for (let p = e.parent; p !== null; p = entities[p].parent) {
      if (seen.has(p)) { problems.push(`entity '${e.id}' was in a parent cycle (now a root)`); e.parent = null; break; }
      seen.add(p);
    }
  }

  if (rawLinks !== undefined && !isObj(rawLinks)) problems.push('links is not an object (ignored)');
  for (const [id, l] of Object.entries(isObj(rawLinks) ? rawLinks : {})) {
    if (!ID_RE.test(id) || !isObj(l)) { problems.push(`link '${id}' is invalid (dropped)`); continue; }
    try {
      const from = checkPortRefShape(l.from, `link '${id}' from`);
      const to = checkPortRefShape(l.to, `link '${id}' to`);
      for (const p of [from, to]) if (p.kind === 'port' && !entities[p.entity]) throw new Error(`references missing entity '${p.entity}'`);
      const link: Link = { id, from, to, enabled: typeof l.enabled === 'boolean' ? l.enabled : true };
      if (typeof l.transform === 'string' && l.transform) link.transform = l.transform;
      links[id] = link;
    } catch (e) {
      problems.push(`link '${id}': ${(e as Error).message} (dropped)`);
    }
  }
  return { entities, links, problems };
}
