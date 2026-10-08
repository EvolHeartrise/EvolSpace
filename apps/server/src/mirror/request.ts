// Validation + normalization of ScreenshotRequests before they reach the
// headless page. Errors thrown here are user-facing (returned to the agent),
// so they say exactly what is wrong.
import type { ScreenshotRequest, ScreenshotView, UserPose } from '@evolspace/protocol';

export const DEFAULT_WIDTH = 1024;
export const DEFAULT_HEIGHT = 768;
export const MIN_SIZE = 16;
export const MAX_SIZE = 4096;
export const THUMBNAIL_SIZE = 512;

/** A request with every optional field resolved (what the page receives). */
export interface NormalizedRequest extends ScreenshotRequest {
  width: number;
  height: number;
  hands: boolean;
  labels: boolean;
}

export class ScreenshotRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotRequestError';
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isQuat = (v: unknown): boolean => Array.isArray(v) && v.length === 4 && v.every(isNum);

function fail(msg: string): never {
  throw new ScreenshotRequestError(`invalid screenshot request: ${msg}`);
}

function checkSize(name: string, v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isNum(v) || v < MIN_SIZE || v > MAX_SIZE) fail(`${name} must be a number in [${MIN_SIZE}, ${MAX_SIZE}], got ${JSON.stringify(v)}`);
  return Math.round(v);
}

export function validateView(view: unknown): ScreenshotView {
  if (!view || typeof view !== 'object') fail('missing "view"');
  const v = view as Record<string, unknown>;
  switch (v.kind) {
    case 'user':
      return { kind: 'user' };
    case 'camera':
      if (!isVec3(v.position)) fail('camera view needs position: [x, y, z]');
      if (v.lookAt !== undefined && !isVec3(v.lookAt)) fail('camera lookAt must be [x, y, z]');
      if (v.rotation !== undefined && !isQuat(v.rotation)) fail('camera rotation must be a quaternion [x, y, z, w]');
      if (v.fov !== undefined && (!isNum(v.fov) || v.fov <= 1 || v.fov >= 179)) fail('camera fov must be in (1, 179) degrees');
      return view as ScreenshotView;
    case 'entity':
      if (typeof v.entity !== 'string' || !v.entity) fail('entity view needs "entity" (an entity id)');
      if (v.direction !== undefined && !isVec3(v.direction)) fail('entity direction must be [x, y, z]');
      if (v.padding !== undefined && (!isNum(v.padding) || v.padding < 0 || v.padding > 10)) fail('entity padding must be a number in [0, 10]');
      return view as ScreenshotView;
    case 'widget':
      if (typeof v.widget !== 'string' || !v.widget) fail('widget view needs "widget" (a widget id)');
      if (v.props !== undefined && (typeof v.props !== 'object' || v.props === null || Array.isArray(v.props))) fail('widget props must be an object');
      if (v.direction !== undefined && !isVec3(v.direction)) fail('widget direction must be [x, y, z]');
      return view as ScreenshotView;
    default:
      return fail(`unknown view kind ${JSON.stringify(v.kind)} (expected user | camera | entity | widget)`);
  }
}

/**
 * Fills defaults: 1024×768, except a 'user' view without an explicit height,
 * which follows the headset's aspect (so the image matches what the user sees).
 * `hands` defaults to true for 'user', false otherwise.
 */
export function normalizeRequest(req: ScreenshotRequest, pose: UserPose | null): NormalizedRequest {
  if (!req || typeof req !== 'object') fail('body must be a ScreenshotRequest object');
  const view = validateView(req.view);
  if (view.kind === 'user' && !pose) {
    throw new ScreenshotRequestError("no user pose: the 'user' view needs a connected primary xr client (headset)");
  }
  let width = checkSize('width', req.width);
  let height = checkSize('height', req.height);
  if (view.kind === 'user') {
    const aspect = pose?.aspect && pose.aspect > 0 ? pose.aspect : 1;
    if (width === undefined && height === undefined) width = DEFAULT_WIDTH;
    if (height === undefined) height = clampSize(Math.round(width! / aspect));
    if (width === undefined) width = clampSize(Math.round(height * aspect));
  }
  if (req.background !== undefined && typeof req.background !== 'string') fail('background must be a string');
  return {
    ...req,
    view,
    width: width ?? DEFAULT_WIDTH,
    height: height ?? DEFAULT_HEIGHT,
    hands: req.hands ?? view.kind === 'user',
    labels: req.labels ?? false,
  };
}

function clampSize(v: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, v));
}

/** Widget ids are folder names; reject anything that could escape widgetsDir. */
export function assertWidgetId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new ScreenshotRequestError(`invalid widget id ${JSON.stringify(id)}`);
  }
}
