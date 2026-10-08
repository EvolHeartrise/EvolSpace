// Maps mirror (screenshot/thumbnail) failures to HTTP statuses: problems with
// the request itself are 4xx (the caller can fix them), renderer trouble is 5xx.
//
//   400  ScreenshotRequestError (bad view/size/background, invalid widget id), and
//        page-side request errors: invalid background, unknown widget/entity,
//        a widget that fails to load or reports an error while rendering
//   503  mirror busy (queue full), closed, startup cancelled
//   504  capture/startup timeouts
//   502  anything else (browser crash, lost GPU context, page API missing, ...)
import { HttpError } from '../http/router.ts';
import { ScreenshotRequestError } from '../mirror/index.ts';

/** Page-side messages (apps/client/src/mirror) that describe a bad request, not a broken renderer. */
const REQUEST_ERRORS = [
  /^mirror: invalid background\b/,
  /^mirror: unknown (widget|entity)\b/,
  /^mirror: request has no view\b/,
  /^mirror: no user pose\b/,
  /^mirror: widget "[^"]*" (failed|reported an error while rendering)\b/,
  /^invalid screenshot request\b/,
];
const UNAVAILABLE = [/^mirror: busy\b/, /^mirror: closed\b/, /^mirror: startup cancelled\b/];
const TIMEOUT = [/\btimed out after \d+ ?ms\b/, /\bTimeout \d+ ?ms exceeded\b/i];

export function mirrorHttpStatus(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof ScreenshotRequestError) return 400;
  const err = e as { name?: unknown; message?: unknown };
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  if (err?.name === 'TimeoutError' || TIMEOUT.some((re) => re.test(msg))) return 504;
  if (UNAVAILABLE.some((re) => re.test(msg))) return 503;
  if (REQUEST_ERRORS.some((re) => re.test(msg))) return 400;
  return 502;
}

/** Throws the HttpError for a mirror failure (`what` prefixes renderer failures, e.g. "screenshot failed"). */
export function mirrorHttpError(e: unknown, what: string): never {
  if (e instanceof HttpError) throw e;
  const status = mirrorHttpStatus(e);
  const msg = e instanceof Error ? e.message : String(e);
  throw new HttpError(status, status === 400 ? msg : `${what}: ${msg}`);
}
