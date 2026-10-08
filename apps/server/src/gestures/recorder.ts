// Pose recording: ask the primary xr client to sample hand features
// (pose.record → countdown → pose.recording), derive a PoseDef from the samples
// and save it to library/poses/<name>.json (the gesture watcher then broadcasts it).
import path from 'node:path';
import type { HandFeatures, Handedness, PoseDef, ServerMessage } from '@evolspace/protocol';
import { atomicWrite } from '../util/fs.ts';
import { isSafeName, shortId } from '../util/ids.ts';
import type { InputModule } from './input.ts';

export class RecordError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'RecordError'; }
}

export interface RecordRequest {
  name: string;
  hand: Handedness | 'either';
  seconds?: number;
  countdown?: number;
  description?: string;
  /**
   * Pre-sampled feature frames (e.g. from the desktop debug page's simulated hands).
   * When given, no headset round trip happens: the PoseDef is derived from these directly.
   */
  frames?: HandFeatures[];
}

interface Pending {
  resolve: (r: { hand: Handedness; frames: HandFeatures[] }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  clientId: string;
  /** Set while the recording client is disconnected (it may reconnect with a new id). */
  grace: NodeJS.Timeout | null;
}

export interface RecorderDeps {
  posesDir: string;
  /** Primary xr client id, or null. */
  primaryClient(): string | null;
  send(clientId: string, msg: ServerMessage): void;
  loadInput(): Promise<Pick<InputModule, 'derivePose'>>;
  /** Extra time allowed beyond countdown+seconds for the round trip. */
  slackMs?: number;
  /**
   * How long a recording survives its client disconnecting. The headset's
   * NetClient queues pose.recording across reconnects (with a new client id),
   * so a Wi-Fi blip shouldn't fail the request. Default 10 s.
   */
  reconnectGraceMs?: number;
}

export class PoseRecorder {
  private pending = new Map<string, Pending>();

  constructor(private readonly d: RecorderDeps) {}

  async record(req: RecordRequest): Promise<PoseDef> {
    if (typeof req.name !== 'string' || !isSafeName(req.name)) throw new RecordError(`"name" must be a file-safe pose id like "thumbs-up"`);
    if (!['left', 'right', 'either'].includes(req.hand)) throw new RecordError(`"hand" must be 'left', 'right' or 'either'`);
    if (req.frames !== undefined) return this.save(req, await this.fromFrames(req.frames));
    if (req.frames !== undefined) return this.save(req, await this.fromFrames(req.frames));
    const seconds = clamp(req.seconds ?? 3, 0.5, 30);
    const countdown = clamp(req.countdown ?? 3, 0, 10);
    const clientId = this.d.primaryClient();
    if (!clientId) throw new RecordError('no headset connected (pose recording needs the primary xr client)', 409);
    const derive = await this.d.loadInput().catch((e: Error) => { throw new RecordError(`pose derivation unavailable: ${e.message}`, 503); });

    const requestId = shortId('rec', (x) => this.pending.has(x), 6);
    const timeoutMs = (seconds + countdown) * 1000 + (this.d.slackMs ?? 15_000);
    const result = await new Promise<{ hand: Handedness; frames: HandFeatures[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(requestId);
        if (p) this.settle(requestId, p);
        reject(new RecordError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the headset to send the recording`, 504));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, clientId, grace: null });
      this.d.send(clientId, { type: 'pose.record', requestId, name: req.name, hand: req.hand, seconds, countdown });
    });
    if (!result.frames.length) throw new RecordError('the recording contained no tracked-hand samples (was the hand visible?)', 422);
    return this.save(req, { derive, frames: result.frames });
  }

  private async fromFrames(frames: unknown): Promise<{ derive: Pick<InputModule, 'derivePose'>; frames: HandFeatures[] }> {
    const ok = Array.isArray(frames) && frames.length > 0 && frames.length <= 3000 && frames.every((f) =>
      f !== null && typeof f === 'object' && !Array.isArray(f) && Object.values(f as object).every((v) => typeof v === 'number'));
    if (!ok) throw new RecordError('"frames" must be a non-empty array (max 3000) of feature objects {name: number}');
    const derive = await this.d.loadInput().catch((e: Error) => { throw new RecordError(`pose derivation unavailable: ${e.message}`, 503); });
    return { derive, frames: frames as HandFeatures[] };
  }

  private async save(req: RecordRequest, r: { derive: Pick<InputModule, 'derivePose'>; frames: HandFeatures[] }): Promise<PoseDef> {
    const pose = r.derive.derivePose(r.frames, { id: req.name, hand: req.hand, description: req.description ?? `Recorded pose '${req.name}'` });
    const saved: PoseDef = { ...pose, id: req.name, source: 'recorded' };
    await atomicWrite(path.join(this.d.posesDir, `${req.name}.json`), JSON.stringify(saved, null, 2) + '\n');
    return saved;
  }

  /**
   * pose.recording from a client. Returns false if nothing was waiting for it.
   * Accepted from the requested client, or — after that client dropped — from
   * whichever client delivers it (the same headset reconnected under a new id;
   * request ids are random, so only the client that got pose.record knows it).
   */
  onRecording(clientId: string, msg: { requestId: string; hand: Handedness; frames: HandFeatures[] }): boolean {
    const p = this.pending.get(msg.requestId);
    if (!p) return false;
    if (p.clientId !== clientId && !p.grace) return false; // not ours to answer while the requester is still connected
    this.settle(msg.requestId, p);
    p.resolve({ hand: msg.hand, frames: Array.isArray(msg.frames) ? msg.frames : [] });
    return true;
  }

  /** The recording client went away: give it a grace period to reconnect and deliver. */
  onDisconnect(clientId: string): void {
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId || p.grace) continue;
      p.grace = setTimeout(() => {
        this.settle(id, p);
        p.reject(new RecordError('the headset disconnected during recording and did not come back', 503));
      }, this.d.reconnectGraceMs ?? 10_000);
    }
  }

  close(): void {
    for (const [id, p] of [...this.pending]) { this.settle(id, p); p.reject(new RecordError('server shutting down', 503)); }
  }

  private settle(id: string, p: Pending): void {
    clearTimeout(p.timer);
    if (p.grace) clearTimeout(p.grace);
    this.pending.delete(id);
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
