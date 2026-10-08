// Widget catalog, sources, forced builds, bundles and thumbnails.
import { existsSync, promises as fsp } from 'node:fs';
import type { Router } from '../http/router.ts';
import { HttpError, reply, type Reply } from '../http/router.ts';
import { readJsonBody } from '../http/body.ts';
import type { Services } from '../services.ts';
import { ScreenshotRequestError } from '../mirror/index.ts';

export function widgetRoutes(r: Router, s: Services): void {
  r.get('/api/widgets', () => s.widgets.list());

  r.get('/api/widgets/:id', async ({ params }) => {
    const m = s.widgets.manifest(params.id);
    const source = await s.widgets.source(params.id);
    if (!m && source === undefined) throw new HttpError(404, `unknown widget '${params.id}' (available: ${s.widgets.ids().join(', ') || 'none'})`);
    return { ...(m ?? { id: params.id, description: '', props: {}, inputs: {}, outputs: {}, interactions: [], hash: '', url: '', hasThumbnail: false, error: 'not built yet' }), source: source ?? '' };
  });

  r.post('/api/widgets/:id/build', async ({ params }) => {
    if (!s.widgets.exists(params.id)) throw new HttpError(404, `no library/widgets/${params.id}/widget.ts`);
    const res = await s.widgets.build(params.id);
    return res.ok ? { ok: true, manifest: res.manifest } : { ok: false, error: res.error, ...(res.manifest ? { manifest: res.manifest } : {}) };
  });

  r.post('/api/widgets/:id/thumbnail', async ({ req, params }) => {
    if (!s.widgets.manifest(params.id)?.hash) throw new HttpError(404, `widget '${params.id}' is not built`);
    const body = await readJsonBody<{ props?: Record<string, unknown> }>(req);
    let png: Buffer;
    try {
      png = await (await s.mirror()).thumbnail(params.id, body.props);
    } catch (e) {
      if (e instanceof ScreenshotRequestError) throw new HttpError(400, (e as Error).message);
      throw new HttpError(502, `thumbnail failed: ${(e as Error).message}`);
    }
    s.widgets.refreshThumbnail(params.id);
    return reply(png, 'image/png', 200, { 'Cache-Control': 'no-store' });
  });

  r.get('/widgets/:id.js', ({ params, req }) => {
    const b = s.widgets.bundle(params.id);
    if (!b) {
      const m = s.widgets.manifest(params.id);
      throw new HttpError(404, m?.error ? `widget '${params.id}' has no successful build: ${m.error}` : `unknown widget '${params.id}'`);
    }
    const etag = `"${b.hash}"`;
    const headers = { 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) return { $reply: true, status: 304, headers } satisfies Reply;
    return reply(b.code, 'text/javascript; charset=utf-8', 200, headers);
  });

  r.get('/widgets/:id/thumbnail.png', async ({ params }) => {
    if (!/^[A-Za-z0-9_-]+$/.test(params.id)) throw new HttpError(400, 'bad widget id');
    const file = s.widgets.thumbnailPath(params.id);
    if (!existsSync(file)) throw new HttpError(404, 'no thumbnail');
    return reply(await fsp.readFile(file), 'image/png', 200, { 'Cache-Control': 'no-cache' });
  });
}
