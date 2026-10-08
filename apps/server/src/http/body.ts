// Request body readers with size limits.
import type { IncomingMessage } from 'node:http';
import { HttpError } from './router.ts';

export async function readBody(req: IncomingMessage, limit = 512 * 1024 * 1024): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `body too large (${declared} > ${limit} bytes)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `body too large (> ${limit} bytes)`);
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

/** Parse a JSON body. Empty body → `fallback` (default {}). */
export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage, fallback: unknown = {}, limit = 32 * 1024 * 1024): Promise<T> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return fallback as T;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch (e) {
    throw new HttpError(400, `invalid JSON body: ${(e as Error).message}`);
  }
}

/** JSON body that must be an object. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const v = await readJsonBody<unknown>(req);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'expected a JSON object body');
  return v as Record<string, unknown>;
}
