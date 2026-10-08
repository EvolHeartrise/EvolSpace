// Health, events, agent I/O, commands, user, screenshots, gestures, voice, sources.
import path from 'node:path';
import type { Handedness, ScreenshotRequest } from '@evolspace/protocol';
import type { Router } from '../http/router.ts';
import { HttpError, reply } from '../http/router.ts';
import { readJsonObject } from '../http/body.ts';
import { isAgentState, isMessageKind } from '../agent.ts';
import { CommandError } from '../commands.ts';
import { RecordError } from '../gestures/recorder.ts';
import { SourceError } from '../sources/supervisor.ts';
import type { Services } from '../services.ts';
import { ScreenshotRequestError } from '../mirror/index.ts';

const passStatus = (e: unknown): never => {
  if (e instanceof CommandError || e instanceof RecordError || e instanceof SourceError) throw new HttpError(e.status, e.message);
  throw e;
};

export function systemRoutes(r: Router, s: Services): void {
  r.get('/api/health', () => ({
    ok: true,
    version: s.config.serverVersion,
    clients: s.hub.summary(),
    workspace: s.store.workspace,
    sceneVersion: s.store.version,
    uptimeSec: Math.round(process.uptime()),
    mirror: s.mirrorStatus(),
  }));

  // ---------------------------------------------------------------- events
  r.get('/api/events', async ({ query }) => {
    const sinceRaw = query.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? undefined : Number(sinceRaw);
    if (since !== undefined && !Number.isFinite(since)) throw new HttpError(400, 'since must be a number');
    const wait = Math.min(Math.max(Number(query.get('wait') ?? 0) || 0, 0), 120_000);
    const types = (query.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new HttpError(400, 'limit must be a positive integer');
    // A caller that disconnects early just leaves a waiter that expires after `wait`.
    return s.events.wait({ since, types, limit }, wait);
  });

  // ---------------------------------------------------------------- agent
  r.get('/api/agent/status', () => ({ status: s.agent.status, messages: s.agent.recent() }));
  r.post('/api/agent/status', async ({ req }) => {
    const b = await readJsonObject(req);
    if (!isAgentState(b.state)) throw new HttpError(400, `state must be one of idle, listening, transcribing, thinking, working, error`);
    s.agent.setStatus(b.state, typeof b.detail === 'string' && b.detail ? b.detail.slice(0, 200) : undefined);
    return {};
  });
  r.post('/api/agent/say', async ({ req }) => {
    const b = await readJsonObject(req);
    if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
    const kind = b.kind === undefined ? 'reply' : b.kind;
    if (!isMessageKind(kind)) throw new HttpError(400, `kind must be reply, info, error or heard`);
    return { id: s.agent.say(b.text, kind).id };
  });

  // ---------------------------------------------------------------- commands
  r.get('/api/commands', () => s.commands.list());
  r.post('/api/command', async ({ req }) => {
    const b = await readJsonObject(req);
    if (typeof b.name !== 'string' || !b.name) throw new HttpError(400, 'name is required');
    const args = b.args && typeof b.args === 'object' ? (b.args as Record<string, unknown>) : undefined;
    try {
      const result = await s.commands.run(b.name, args, { origin: 'http' });
      return result === undefined ? { ok: true } : { ok: true, result };
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(e.status, e.message, { ok: false });
      const status = (e as { status?: number }).status;
      throw new HttpError(typeof status === 'number' ? status : 500, (e as Error).message, { ok: false });
    }
  });

  // ---------------------------------------------------------------- user & view
  r.get('/api/user', async ({ query }) => s.user.summary(query.get('raw') === '1' || query.get('raw') === 'true'));

  r.post('/api/screenshot', async ({ req }) => {
    const b = await readJsonObject(req);
    const view = (b.view ?? { kind: 'user' }) as ScreenshotRequest['view'];
    if (!view || typeof view !== 'object' || !['user', 'camera', 'entity', 'widget'].includes((view as { kind: string }).kind)) {
      throw new HttpError(400, `view.kind must be 'user', 'camera', 'entity' or 'widget'`);
    }
    if (view.kind === 'user' && !s.user.latest) throw new HttpError(409, 'no headset pose available for a user view (is the primary xr client connected?) — use view.kind camera/entity/widget');
    if (view.kind === 'entity' && !s.store.entity(view.entity)) throw new HttpError(404, `entity '${view.entity}' does not exist`);
    const request = { ...b, view } as ScreenshotRequest;
    try {
      const png = await (await s.mirror()).screenshot(request);
      return reply(png, 'image/png', 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      if (e instanceof ScreenshotRequestError) throw new HttpError(400, (e as Error).message);
      throw new HttpError(502, `screenshot failed: ${(e as Error).message}`);
    }
  });

  // ---------------------------------------------------------------- gestures
  r.get('/api/gestures', () => {
    const d = s.gestures.current;
    return { poses: d.poses, interactions: d.interactions, ...(Object.keys(d.errors).length ? { errors: d.errors } : {}) };
  });
  r.post('/api/gestures/record', async ({ req }) => {
    const b = await readJsonObject(req);
    try {
      return await s.recorder.record({
        name: b.name as string,
        hand: (b.hand ?? 'either') as Handedness | 'either',
        seconds: typeof b.seconds === 'number' ? b.seconds : undefined,
        countdown: typeof b.countdown === 'number' ? b.countdown : undefined,
        description: typeof b.description === 'string' ? b.description : undefined,
      });
    } catch (e) { return passStatus(e); }
  });

  // ---------------------------------------------------------------- voice
  r.get('/api/voice/commands', () => s.voice.commands());
  r.post('/api/voice/simulate', async ({ req }) => {
    const b = await readJsonObject(req);
    if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
    const context = b.context && typeof b.context === 'object' ? (b.context as Record<string, unknown>) : undefined;
    return s.voice.simulate(b.text, context);
  });

  // ---------------------------------------------------------------- sources
  r.get('/api/sources', () => s.sources.list());
  r.get('/api/sources/:id', ({ params }) => {
    const st = s.sources.get(params.id);
    if (!st) throw new HttpError(404, `unknown source '${params.id}'`);
    return st;
  });
  r.post('/api/sources/:id/start', ({ params }) => { try { return s.sources.start(params.id); } catch (e) { return passStatus(e); } });
  r.post('/api/sources/:id/stop', async ({ params }) => { try { return await s.sources.stop(params.id); } catch (e) { return passStatus(e); } });
  r.post('/api/sources/:id/restart', async ({ params }) => { try { return await s.sources.restart(params.id); } catch (e) { return passStatus(e); } });

  // ---------------------------------------------------------------- help
  r.get('/api', () => ({ routes: r.describe(), docs: path.posix.join('packages', 'protocol', 'src', 'api.ts') }));
}
