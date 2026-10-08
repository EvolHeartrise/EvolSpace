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
}

export interface Mirror {
  /** Renders and returns a PNG. Rejects with a descriptive Error on failure/timeout. */
  screenshot(req: ScreenshotRequest): Promise<Buffer>;
  /** Renders widget `id` in the studio view, saves library/widgets/<id>/thumbnail.png, returns the PNG. */
  thumbnail(widgetId: string, props?: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
}
