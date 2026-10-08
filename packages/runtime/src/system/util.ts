import type * as THREE from 'three';

/** Orient `o` (in its parent frame) so its +Z faces the parent's origin (where the head is). */
export function faceOrigin(o: THREE.Object3D): void {
  const p = o.position;
  const len = Math.hypot(p.x, p.y, p.z);
  if (len < 1e-6) return;
  const yaw = Math.atan2(-p.x, -p.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, p.y / len)));
  o.rotation.set(pitch, yaw, 0, 'YXZ');
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
