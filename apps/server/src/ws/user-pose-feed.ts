// Forwards the primary xr client's user.pose to clients that asked for it with
// the hello capability `user-pose` (the desktop debug dashboard), rate-limited
// to ≤15 Hz with latest-wins (leading + trailing edge, so the final pose of a
// motion is never dropped). `clear()` (primary gone) sends `pose: null`.
import type { ServerMessage, UserPose } from '@evolspace/protocol';
import type { ClientConnection } from './client.ts';

export const USER_POSE_CAPABILITY = 'user-pose';

export interface UserPoseFeedHub {
  broadcast(msg: ServerMessage, filter?: (c: ClientConnection) => boolean): number;
  readonly clients: Map<string, ClientConnection>;
}

export class UserPoseFeed {
  private lastSentAt = -Infinity;
  private pending: UserPose | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly hub: UserPoseFeedHub, private readonly intervalMs = 1000 / 15, private readonly now: () => number = Date.now) {}

  static wants(c: ClientConnection): boolean {
    return c.capabilities.includes(USER_POSE_CAPABILITY);
  }

  /** True if at least one connected client subscribed (skip all work otherwise). */
  private hasSubscribers(): boolean {
    for (const c of this.hub.clients.values()) if (c.helloed && UserPoseFeed.wants(c)) return true;
    return false;
  }

  offer(pose: UserPose): void {
    if (!this.hasSubscribers()) return;
    const t = this.now();
    if (t - this.lastSentAt >= this.intervalMs && !this.timer) {
      this.send(pose, t);
      return;
    }
    this.pending = pose;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const p = this.pending;
        this.pending = null;
        if (p) this.send(p, this.now());
      }, Math.max(0, this.intervalMs - (t - this.lastSentAt)));
      this.timer.unref?.();
    }
  }

  /** The primary left: subscribers get `pose: null`. */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
    this.hub.broadcast({ type: 'user.pose', pose: null }, UserPoseFeed.wants);
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
  }

  private send(pose: UserPose, t: number): void {
    this.lastSentAt = t;
    this.hub.broadcast({ type: 'user.pose', pose }, UserPoseFeed.wants);
  }
}
