// Contract between the server core and the mirror renderer (owned by the mirror component).
import type { ScreenshotRequest, UserPose } from '@evolspace/protocol';

export interface MirrorDeps {
  /** Base URL the headless browser loads, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Latest pose of the primary xr client, or null if no headset connected. */
  getUserPose(): UserPose | null;
  /** Absolute path of library/widgets (thumbnails are saved as <id>/thumbnail.png). */
  widgetsDir: string;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Optional tuning; every field also has an env-var override (see README). */
  options?: MirrorOptions;
}

export interface MirrorOptions {
  /** Max time for one capture (render + encode), ms. Env EVOL_MIRROR_TIMEOUT_MS. Default 20000. */
  captureTimeoutMs?: number;
  /** Max time to launch Chromium + load the mirror page + connect, ms. Default 45000. */
  startupTimeoutMs?: number;
  /** WebGL backend policy. Env EVOL_MIRROR_GPU = auto | gpu | software. Default auto. */
  gpu?: 'auto' | 'gpu' | 'software';
  /** Extra Chromium command-line args. Env EVOL_MIRROR_ARGS (space separated). */
  extraArgs?: string[];
  /** Path (+query) of the mirror page relative to baseUrl. Default '/?role=mirror'. */
  pagePath?: string;
}

export interface MirrorStatus {
  running: boolean;
  /** e.g. "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 ...)" */
  webglRenderer?: string;
  software?: boolean;
  launchConfig?: string;
  captures: number;
  failures: number;
  restarts: number;
  queued: number;
}

export interface Mirror {
  /** Renders and returns a PNG. Rejects with a descriptive Error on failure/timeout. */
  screenshot(req: ScreenshotRequest): Promise<Buffer>;
  /** Renders widget `id` in the studio view, saves library/widgets/<id>/thumbnail.png, returns the PNG. */
  thumbnail(widgetId: string, props?: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
  /** Diagnostics (renderer backend, counters). Optional so older stubs stay compatible. */
  status?(): MirrorStatus;
}
