// Replay data store: collects the bsrl-replay source's channels (<prefix>.meta/q/chart/walls/hud/
// torque) and commits a consistent set once every tensor matches meta. Pure TS, no three.js.

import type { ChannelValue } from '@evolspace/protocol';
import { isTensor, toFloat32 } from '../../shared/tensor.ts';

export interface ReplayMeta {
  id: string;
  song: string;
  difficulty: string;
  model: string;
  pp: number;
  score: number;
  ticks: number;
  hz: number;
  handleLen: number;
  trackAnchor: string | null;
  notes: number;
  walls: number;
  index: number;
  total: number;
  loadId: string | number;
}

/** Chart columns (see library/sources/bsrl-replay/replay.mjs). */
export const C = { T: 0, X: 1, Y: 2, COLOR: 3, ANGLE: 4, SPEED: 5, ANY: 6, KIND: 7, RTICK: 8, OUTCOME: 9, POINTS: 10, REASON: 11, N: 12 } as const;
export const KIND = { NOTE: 0, BOMB: 1, CHAIN_HEAD: 2, CHAIN_LINK: 3 } as const;
export const OUTCOME = { NONE: -1, GOOD: 0, BAD: 1, MISS: 2, BOMB: 3 } as const;
export const REASONS = ['ok', 'slow', 'angle', 'wrong hand', 'miss', 'post', 'bomb', 'wall', 'wall'];
/** HUD columns. */
export const H = { SCORE: 0, MAX: 1, COMBO: 2, MULT: 3, PROGRESS: 4, MISSES: 5, ENERGY: 6, MAX_COMBO: 7, N: 8 } as const;

export interface Replay {
  meta: ReplayMeta;
  T: number;
  hz: number;
  duration: number;
  q: Float32Array;
  chart: Float32Array;
  N: number;
  /** Chart rows sorted by hit time. */
  order: Int32Array;
  /** Hit times in `order` (for binary search). */
  times: Float32Array;
  minSpeed: number;
  walls: Float32Array;
  W: number;
  hud: Float32Array;
  torque: Float32Array;
}

export const KEYS = ['meta', 'q', 'chart', 'walls', 'hud', 'torque', 'status'] as const;
type Key = (typeof KEYS)[number];

interface F32 { shape: number[]; data: Float32Array }

export class ReplayStore {
  private meta: ReplayMeta | null = null;
  private t: Partial<Record<Key, F32>> = {};
  status = '';
  replay: Replay | null = null;
  /** Bumped on each commit. */
  version = 0;

  /** Feed a channel value; returns true when a new replay was committed or the status changed. */
  set(key: Key, v: ChannelValue): boolean {
    if (key === 'status') {
      const s = typeof v === 'string' ? v : '';
      const changed = s !== this.status;
      this.status = s;
      return changed;
    }
    if (key === 'meta') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || isTensor(v)) return false;
      this.meta = v as unknown as ReplayMeta;
    } else {
      if (!isTensor(v)) return false;
      this.t[key] = { shape: v.shape.slice(), data: toFloat32(v) };
    }
    return this.tryCommit();
  }

  private tryCommit(): boolean {
    const m = this.meta;
    const { q, chart, walls, hud, torque } = this.t;
    if (!m || !q || !chart || !walls || !hud || !torque) return false;
    if (this.replay && this.replay.meta.loadId === m.loadId && this.replay.q === q.data && this.replay.chart === chart.data) return false;
    const T = m.ticks;
    const ok = q.shape[0] === T && q.shape[1] === 36 && hud.shape[0] === T && torque.shape[0] === T &&
      chart.shape[0] === m.notes && chart.shape[1] === C.N && walls.shape[0] === m.walls && T > 1;
    if (!ok) return false;
    const N = m.notes;
    const order = new Int32Array(N);
    for (let i = 0; i < N; i++) order[i] = i;
    const cd = chart.data;
    order.sort((a, b) => cd[a * C.N] - cd[b * C.N]);
    const times = new Float32Array(N);
    let minSpeed = Infinity;
    for (let j = 0; j < N; j++) {
      times[j] = cd[order[j] * C.N];
      const sp = cd[order[j] * C.N + C.SPEED];
      if (sp > 0 && sp < minSpeed) minSpeed = sp;
    }
    const hz = m.hz > 0 ? m.hz : 30;
    this.replay = {
      meta: m, T, hz, duration: (T - 1) / hz, q: q.data, chart: cd, N, order, times,
      minSpeed: Number.isFinite(minSpeed) ? Math.max(1, minSpeed) : 10,
      walls: walls.data, W: m.walls, hud: hud.data, torque: torque.data,
    };
    this.version++;
    return true;
  }
}

/** First index j with times[j] >= t. */
export function lowerBound(times: Float32Array, t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function gradeOf(pct: number): string {
  if (pct >= 90) return 'SS';
  if (pct >= 80) return 'S';
  if (pct >= 65) return 'A';
  if (pct >= 50) return 'B';
  if (pct >= 35) return 'C';
  if (pct >= 20) return 'D';
  return 'E';
}

/** Score in groups of three separated by spaces (the game's format). */
export function formatScore(score: number): string {
  const s = String(Math.round(score));
  let out = '';
  for (let end = s.length; end > 0; end -= 3) {
    const chunk = s.slice(Math.max(0, end - 3), end);
    out = out ? chunk + ' ' + out : chunk;
  }
  return out;
}

export function formatClock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
