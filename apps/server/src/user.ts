// Latest user state from the primary xr client, summarized for the agent
// (GET /api/user): head, mode, focus/gaze/selection, and per hand: tracked,
// wrist pose, rounded features and the currently active pose names.
import type { Handedness, PoseEvent, UserPose, HandFrame } from '@evolspace/protocol';
import { loadInput as defaultLoadInput, type InputModule } from './gestures/input.ts';
import { round, roundVec } from './scene/math.ts';

export interface HandSummary {
  tracked: boolean;
  wrist?: { position: number[]; rotation: number[] };
  features?: Record<string, number>;
  poses: string[];
  joints?: number[];
}

export class UserState {
  private pose: UserPose | null = null;
  private receivedAt = 0;
  private active: Record<Handedness, Set<string>> = { left: new Set(), right: new Set() };

  constructor(private readonly loadInput: () => Promise<Pick<InputModule, 'computeFeatures'>> = defaultLoadInput) {}

  get latest(): UserPose | null { return this.pose; }

  setPose(p: UserPose): void {
    this.pose = p;
    this.receivedAt = Date.now();
  }

  onPoseEvent(e: PoseEvent): void {
    const set = this.active[e.hand];
    if (!set) return;
    if (e.phase === 'start') set.add(e.pose); else set.delete(e.pose);
  }

  activePoses(hand: Handedness): string[] { return [...this.active[hand]].sort(); }

  /** Primary xr client went away. */
  clear(): void {
    this.pose = null;
    this.active.left.clear();
    this.active.right.clear();
  }

  async summary(raw = false): Promise<Record<string, unknown> | null> {
    const p = this.pose;
    if (!p) return null;
    let compute: ((f: HandFrame, other?: HandFrame) => Record<string, number>) | null = null;
    let featuresError: string | undefined;
    try {
      const input = await this.loadInput();
      compute = (f, other) => input.computeFeatures(f, p.head, other);
    } catch (e) {
      featuresError = (e as Error).message;
    }
    const hands: Partial<Record<Handedness, HandSummary>> = {};
    for (const hand of ['left', 'right'] as const) {
      const f = p.hands?.[hand];
      if (!f || !Array.isArray(f.joints) || f.joints.length < 7) {
        hands[hand] = { tracked: false, poses: this.activePoses(hand) };
        continue;
      }
      const h: HandSummary = {
        tracked: true,
        wrist: { position: roundVec(f.joints.slice(0, 3)), rotation: roundVec(f.joints.slice(3, 7)) },
        poses: this.activePoses(hand),
      };
      if (compute) {
        try {
          const other = p.hands?.[hand === 'left' ? 'right' : 'left'];
          const feats = compute(f, other);
          h.features = Object.fromEntries(Object.entries(feats).map(([k, v]) => [k, round(v, 3)]));
        } catch (e) {
          featuresError = `computeFeatures failed: ${(e as Error).message}`;
        }
      }
      if (raw) h.joints = f.joints;
      hands[hand] = h;
    }
    return {
      t: p.t,
      ageMs: Date.now() - this.receivedAt,
      mode: p.mode,
      head: { position: roundVec([...p.head.position]), rotation: roundVec([...p.head.rotation]) },
      ...(p.fov !== undefined ? { fov: p.fov } : {}),
      ...(p.aspect !== undefined ? { aspect: round(p.aspect, 3) } : {}),
      focus: p.focus ?? {},
      gaze: p.gaze ?? null,
      selected: p.selected ?? null,
      hands,
      ...(featuresError ? { featuresError } : {}),
    };
  }
}
