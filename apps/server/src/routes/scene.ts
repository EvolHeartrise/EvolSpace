// Scene, prefab and workspace routes.
import type { OpSource, SceneOp } from '@evolspace/protocol';
import type { Router } from '../http/router.ts';
import { HttpError } from '../http/router.ts';
import { readJsonObject } from '../http/body.ts';
import { summarizeScene } from '../scene/summary.ts';
import { listPrefabs, type InstantiateOptions } from '../scene/prefabs.ts';
import { SceneError } from '../scene/validate.ts';
import type { Services } from '../services.ts';

const SOURCES: OpSource[] = ['agent', 'user', 'voice', 'widget', 'system'];

/** SceneErrors become 400s with the op index. */
export function sceneErr(e: unknown): never {
  if (e instanceof SceneError) throw new HttpError(400, e.message, e.opIndex !== undefined ? { opIndex: e.opIndex } : undefined);
  throw e;
}

export function sceneRoutes(r: Router, s: Services): void {
  r.get('/api/scene', () => s.store.scene);
  r.get('/api/scene/summary', () => summarizeScene(s.store.scene));

  r.post('/api/scene/ops', async ({ req }) => {
    const body = await readJsonObject(req);
    const ops = body.ops;
    if (!Array.isArray(ops)) throw new HttpError(400, 'body must be {ops: SceneOp[], source?}');
    const source = SOURCES.includes(body.source as OpSource) ? (body.source as OpSource) : 'agent';
    const group = typeof body.group === 'string' ? body.group : undefined;
    try {
      const res = s.applyOps(ops as SceneOp[], source, group);
      return { version: res.version, ids: res.ids, ...(res.warnings.length ? { warnings: res.warnings } : {}) };
    } catch (e) { sceneErr(e); }
  });

  // ok:false = nothing to undo/redo (or, with error, the history had to be dropped).
  const history = (res: { version: number; ok: boolean; error?: string }) => {
    if (res.error) s.log.error(res.error);
    return { version: res.version, ok: res.ok, ...(res.error ? { error: res.error } : {}) };
  };
  r.post('/api/scene/undo', () => history(s.store.undo()));
  r.post('/api/scene/redo', () => history(s.store.redo()));

  r.get('/api/prefabs', () => listPrefabs(s.paths.prefabs));
  r.post('/api/prefabs/:id/instantiate', async ({ req, params }) => {
    const body = await readJsonObject(req);
    const opts: InstantiateOptions = {};
    if (body.transform !== undefined) opts.transform = body.transform as InstantiateOptions['transform'];
    if (body.parent !== undefined) opts.parent = body.parent as string | null;
    if (body.props !== undefined) {
      if (typeof body.props !== 'object' || body.props === null) throw new HttpError(400, 'props must be {<prefabLocalId>: {...props}}');
      opts.props = body.props as InstantiateOptions['props'];
    }
    try {
      const out = await s.instantiatePrefab(params.id, opts, SOURCES.includes(body.source as OpSource) ? (body.source as OpSource) : 'agent');
      return { ids: out.ids, version: out.version };
    } catch (e) { sceneErr(e); }
  });

  r.get('/api/workspaces', async () => ({ current: s.workspaces.current, list: await s.workspaces.list() }));
  r.post('/api/workspaces/:name/save', async ({ params }) => {
    try { return { current: await s.workspaces.save(params.name) }; } catch (e) { sceneErr(e); }
  });
  r.post('/api/workspaces/:name/load', async ({ params }) => {
    try { await s.workspaces.load(params.name); return { current: s.workspaces.current, version: s.store.version }; } catch (e) {
      if (e instanceof SceneError && /does not exist/.test(e.message)) throw new HttpError(404, e.message);
      sceneErr(e);
    }
  });
  r.post('/api/workspaces/:name/new', async ({ params }) => {
    try { await s.workspaces.create(params.name); return { current: s.workspaces.current, version: s.store.version }; } catch (e) {
      if (e instanceof SceneError && /already exists/.test(e.message)) throw new HttpError(409, e.message);
      sceneErr(e);
    }
  });
}
