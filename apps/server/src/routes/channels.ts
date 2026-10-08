// Data channel routes: list, get, put (JSON / tensor frame / raw bytes), SSE.
import type { ServerResponse } from 'node:http';
import { decodeTensorFrame, tensorToJson } from '@evolspace/protocol';
import type { Router } from '../http/router.ts';
import { HttpError, reply } from '../http/router.ts';
import { readBody } from '../http/body.ts';
import { ChannelError, DataBus, parseShape, type Channel } from '../data/bus.ts';
import type { Services } from '../services.ts';

export const TENSOR_MIME = 'application/x-evol-tensor';

const chanErr = (e: unknown): never => {
  if (e instanceof ChannelError) throw new HttpError(e.status, e.message);
  throw e;
};

/** JSON-safe channel value (tensors as {$tensor, dtype, shape, b64}). */
export function jsonSafe(ch: Channel): unknown {
  return ch.tensor ? tensorToJson(ch.tensor) : ch.value;
}

export function channelRoutes(r: Router, s: Services): void {
  r.get('/api/channels', () => s.bus.list());

  r.get('/api/channels/:name', ({ params, req, query }) => {
    const ch = s.bus.get(params.name);
    if (!ch) throw new HttpError(404, `no value on channel '${params.name}' yet`);
    const wantJson = query.get('format') === 'json' || (!!ch.tensor && /application\/json/.test(req.headers.accept ?? '') && !(req.headers.accept ?? '').includes(TENSOR_MIME));
    const headers = { 'X-Seq': String(ch.info.seq), 'Cache-Control': 'no-store' };
    if (ch.tensor && !wantJson) {
      return reply(DataBus.tensorFrame(ch), TENSOR_MIME, 200, { ...headers, 'X-Dtype': ch.tensor.dtype, 'X-Shape': ch.tensor.shape.join(',') });
    }
    return reply(JSON.stringify(jsonSafe(ch)), 'application/json; charset=utf-8', 200, headers);
  });

  r.put('/api/channels/:name', async ({ params, req, query }) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const producer = (req.headers['x-producer'] as string | undefined) ?? query.get('producer') ?? undefined;
    const description = (req.headers['x-description'] as string | undefined) ?? query.get('description') ?? undefined;
    const opts = { ...(producer ? { producer } : {}), ...(description ? { description } : {}) };
    const buf = await readBody(req);
    const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); // plain view (see ws/hub.ts)
    try {
      if (type === TENSOR_MIME) {
        let frame;
        try { frame = decodeTensorFrame(body); } catch (e) { throw new ChannelError(`malformed ${TENSOR_MIME} body: ${(e as Error).message}`); }
        return s.bus.publish(params.name, frame.tensor, { ...opts, producer: opts.producer ?? frame.header.producer });
      }
      const dtype = req.headers['x-dtype'] as string | undefined;
      const shape = req.headers['x-shape'] as string | undefined;
      if (dtype || shape) {
        if (!dtype || shape === undefined) throw new ChannelError('raw tensor PUT needs both X-Dtype and X-Shape headers');
        return s.bus.publishRaw(params.name, dtype, parseShape(shape), body, opts);
      }
      if (body.length === 0) throw new ChannelError('empty body (send JSON, a tensor frame, or raw bytes with X-Dtype/X-Shape)');
      let value: unknown;
      try { value = JSON.parse(buf.toString('utf8')); } catch (e) { throw new ChannelError(`body is not valid JSON: ${(e as Error).message}`); }
      return s.bus.publish(params.name, value, opts);
    } catch (e) { return chanErr(e); }
  });

  r.delete('/api/channels/:name', ({ params }) => {
    if (!s.bus.delete(params.name)) throw new HttpError(404, `no channel '${params.name}'`);
    return { ok: true };
  });

  r.get('/api/channels/:name/events', ({ params, req, res }) => {
    sse(res);
    const name = params.name;
    // Latest-wins under backpressure: while the response buffer is full keep only the newest value.
    let blocked = false;
    let pending: Channel | null = null;
    const write = (ch: Channel) => {
      if (blocked) { pending = ch; return; }
      const ok = res.write(`id: ${ch.info.seq}\ndata: ${JSON.stringify(jsonSafe(ch))}\n\n`);
      if (!ok) blocked = true;
    };
    res.on('drain', () => {
      blocked = false;
      const p = pending; pending = null;
      if (p) write(p);
    });
    const cur = s.bus.get(name);
    if (cur) write(cur);
    const off = s.bus.onPublish((ch) => { if (ch.info.name === name) write(ch); });
    const hb = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { off(); clearInterval(hb); });
    return undefined;
  });
}

export function sse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
}
