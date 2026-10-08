// BeatSaberRL v10 body: forward kinematics from a replay pose q36 = [root pos xyz, root quat wxyz,
// 29 joint angles]. Mirror of BeatSaberRL viz/app/src/lib/replay.js bodyFK (model.rs
// HUMANOID_FRAMES): 30 frames [parent, anchor (parent frame), axis, joint index | -1 weld].
// Allocation-free: results live in flat Float64Arrays (positions 30×3, rotations 30×9 row-major).
// World frame: x right, y up, the player at z = -0.65, notes come from +z.

const AX = [1, 0, 0], AXN = [-1, 0, 0], AY = [0, 1, 0], AZ = [0, 0, 1];
const Z3 = [0, 0, 0];
type Frame = [parent: number, anchor: number[], axis: number[], coord: number];
export const FRAMES: Frame[] = [
  [-1, [0, 0.10, 0], AX, 0], //  0 spine_pitch
  [0, Z3, AY, 1], //  1 spine_yaw
  [1, Z3, AZ, 2], //  2 spine_roll + chest
  [2, [0, 0.66, 0], AZ, -1], //  3 head (weld)
  [2, [-0.20, 0.43, 0], AY, 4], //  4 l_sh_yaw
  [4, Z3, AXN, 3], //  5 l_sh_pitch
  [5, Z3, AZ, 5], //  6 l_sh_twist + uarm_l
  [6, [0, 0, 0.35], AXN, 6], //  7 l_elbow + farm_l
  [7, [0, 0, 0.30], AZ, 7], //  8 l_wr_roll
  [8, Z3, AY, 9], //  9 l_wr_dev
  [9, Z3, AXN, 8], // 10 l_wr_bend + hand_l
  [2, [0.20, 0.43, 0], AY, 11], // 11 r_sh_yaw
  [11, Z3, AXN, 10], // 12 r_sh_pitch
  [12, Z3, AZ, 12], // 13 r_sh_twist + uarm_r
  [13, [0, 0, 0.35], AXN, 13], // 14 r_elbow + farm_r
  [14, [0, 0, 0.30], AZ, 14], // 15 r_wr_roll
  [15, Z3, AY, 16], // 16 r_wr_dev
  [16, Z3, AXN, 15], // 17 r_wr_bend + hand_r
  [-1, [-0.10, 0, 0], AXN, 17], // 18 l_hip_pitch
  [18, Z3, AY, 18], // 19 l_hip_yaw
  [19, Z3, AZ, 19], // 20 l_hip_roll + thigh_l
  [20, [0, -0.44, 0], AX, 20], // 21 l_knee + shank_l
  [21, [0, -0.43, 0], AXN, 21], // 22 l_ankle_pitch
  [22, Z3, AZ, 22], // 23 l_ankle_roll + foot_l
  [-1, [0.10, 0, 0], AXN, 23], // 24 r_hip_pitch
  [24, Z3, AY, 24], // 25 r_hip_yaw
  [25, Z3, AZ, 25], // 26 r_hip_roll + thigh_r
  [26, [0, -0.44, 0], AX, 26], // 27 r_knee + shank_r
  [27, [0, -0.43, 0], AXN, 27], // 28 r_ankle_pitch
  [28, Z3, AZ, 28], // 29 r_ankle_roll + foot_r
];
export const F = {
  CHEST: 2, HEAD: 3,
  L_SHOULDER: 4, L_ELBOW: 7, L_WRIST: 8, L_HAND: 10,
  R_SHOULDER: 11, R_ELBOW: 14, R_WRIST: 15, R_HAND: 17,
  L_THIGH: 20, L_SHANK: 21, L_ANKLE: 22, L_FOOT: 23,
  R_THIGH: 26, R_SHANK: 27, R_ANKLE: 28, R_FOOT: 29,
} as const;

const N = FRAMES.length;

export class BodyFK {
  /** Frame origins, world (30 × xyz). */
  readonly p = new Float64Array(N * 3);
  /** Frame rotations, world-from-frame (30 × 3×3 row-major). */
  readonly r = new Float64Array(N * 9);
  /** Root (pelvis) position and rotation. */
  readonly p0 = new Float64Array(3);
  readonly r0 = new Float64Array(9);
  private readonly ra = new Float64Array(9);

  /** FK of the pose at q[off .. off+36). */
  compute(q: ArrayLike<number>, off = 0): void {
    const { p, r, p0, r0, ra } = this;
    p0[0] = q[off]; p0[1] = q[off + 1]; p0[2] = q[off + 2];
    let w = q[off + 3], x = q[off + 4], y = q[off + 5], z = q[off + 6];
    const n = Math.hypot(w, x, y, z) || 1;
    w /= n; x /= n; y /= n; z /= n;
    r0[0] = 1 - 2 * (y * y + z * z); r0[1] = 2 * (x * y - w * z); r0[2] = 2 * (x * z + w * y);
    r0[3] = 2 * (x * y + w * z); r0[4] = 1 - 2 * (x * x + z * z); r0[5] = 2 * (y * z - w * x);
    r0[6] = 2 * (x * z - w * y); r0[7] = 2 * (y * z + w * x); r0[8] = 1 - 2 * (x * x + y * y);
    for (let f = 0; f < N; f++) {
      const [parent, a, axis, coord] = FRAMES[f];
      const R = parent < 0 ? r0 : r, ro = parent < 0 ? 0 : parent * 9;
      const P = parent < 0 ? p0 : p, po = parent < 0 ? 0 : parent * 3;
      const o3 = f * 3, o9 = f * 9;
      p[o3] = P[po] + R[ro] * a[0] + R[ro + 1] * a[1] + R[ro + 2] * a[2];
      p[o3 + 1] = P[po + 1] + R[ro + 3] * a[0] + R[ro + 4] * a[1] + R[ro + 5] * a[2];
      p[o3 + 2] = P[po + 2] + R[ro + 6] * a[0] + R[ro + 7] * a[1] + R[ro + 8] * a[2];
      if (coord < 0) {
        for (let i = 0; i < 9; i++) r[o9 + i] = R[ro + i];
        continue;
      }
      // Rodrigues rotation about the (unit) axis, then R_parent · Ra
      const ang = q[off + 7 + coord];
      const s = Math.sin(ang), c = Math.cos(ang), k = 1 - c;
      const [ax, ay, az] = axis;
      ra[0] = c + k * ax * ax; ra[1] = k * ax * ay - s * az; ra[2] = k * ax * az + s * ay;
      ra[3] = k * ax * ay + s * az; ra[4] = c + k * ay * ay; ra[5] = k * ay * az - s * ax;
      ra[6] = k * ax * az - s * ay; ra[7] = k * ay * az + s * ax; ra[8] = c + k * az * az;
      for (let i = 0; i < 3; i++) {
        const a0 = R[ro + i * 3], a1 = R[ro + i * 3 + 1], a2 = R[ro + i * 3 + 2];
        r[o9 + i * 3] = a0 * ra[0] + a1 * ra[3] + a2 * ra[6];
        r[o9 + i * 3 + 1] = a0 * ra[1] + a1 * ra[4] + a2 * ra[7];
        r[o9 + i * 3 + 2] = a0 * ra[2] + a1 * ra[5] + a2 * ra[8];
      }
    }
  }

  /** World point `local` (x, y, z) in frame f → out[0..2]. */
  point(f: number, lx: number, ly: number, lz: number, out: Float64Array | number[]): void {
    const { p, r } = this, o3 = f * 3, o9 = f * 9;
    out[0] = p[o3] + r[o9] * lx + r[o9 + 1] * ly + r[o9 + 2] * lz;
    out[1] = p[o3 + 1] + r[o9 + 3] * lx + r[o9 + 4] * ly + r[o9 + 5] * lz;
    out[2] = p[o3 + 2] + r[o9 + 6] * lx + r[o9 + 7] * ly + r[o9 + 8] * lz;
  }

  /** Saber of hand 0 (left) / 1 (right): blade base and tip (world) given the handle length. */
  saber(hand: 0 | 1, handleLen: number, base: Float64Array, tip: Float64Array, grip: Float64Array): void {
    const w = (hand === 0 ? F.L_WRIST : F.R_WRIST) * 3;
    const h = (hand === 0 ? F.L_HAND : F.R_HAND) * 9;
    const { p, r } = this;
    const dx = r[h + 2], dy = r[h + 5], dz = r[h + 8]; // blade dir = hand frame's z column
    const hl = handleLen > 0 ? handleLen : 0;
    const g = handleLen > 0 ? 0 : 0.16; // no handle in the sim: draw one behind the wrist
    grip[0] = p[w] - g * dx; grip[1] = p[w + 1] - g * dy; grip[2] = p[w + 2] - g * dz;
    base[0] = p[w] + hl * dx; base[1] = p[w + 1] + hl * dy; base[2] = p[w + 2] + hl * dz;
    tip[0] = base[0] + dx; tip[1] = base[1] + dy; tip[2] = base[2] + dz;
  }
}

/**
 * Pose at fractional time (s) from tick-major q [T, 36]: linear between ticks, root quaternion
 * nlerp with sign fix (exact at ticks; the original viewer's Hermite only matters in slow motion).
 */
export function poseAt(q: Float32Array, T: number, hz: number, time: number, out: Float64Array): void {
  const f = Math.min(Math.max(time * hz, 0), T - 1);
  const k = Math.floor(f), u = f - k, k1 = Math.min(k + 1, T - 1);
  const a = k * 36, b = k1 * 36;
  for (let i = 0; i < 36; i++) out[i] = q[a + i] + (q[b + i] - q[a + i]) * u;
  const dot = q[a + 3] * q[b + 3] + q[a + 4] * q[b + 4] + q[a + 5] * q[b + 5] + q[a + 6] * q[b + 6];
  if (dot < 0) for (let i = 3; i < 7; i++) out[i] = q[a + i] - (q[b + i] + q[a + i]) * u;
}
