// The only module that instantiates classes from @evolspace/runtime and
// @evolspace/input. The rest of the client uses the aliases/ports below, so
// API drift in those packages is contained here.

import type * as THREE from 'three';
import * as Runtime from '@evolspace/runtime';
import * as Input from '@evolspace/input';
import type { ClientRole, HandFrame, HandFeatures, Vec3 } from '@evolspace/protocol';
import type { Pose } from './math/space.ts';
import type { SynthSpecLike } from './desktop/controls.ts';

export type InteractionHost = Input.InteractionHost;
export type Hit = Input.Hit;
export type NetClient = Runtime.NetClient;
export type RuntimePort = Runtime.SpaceRuntime;
export type EnginePort = Input.InteractionEngine;
export type RecordPhase = Runtime.RecordPhase;

export interface HandVisualPort {
  readonly object: THREE.Object3D;
  update(frame: HandFrame | undefined): void;
}

export function createNet(url: string, role: ClientRole, hello: { userAgent?: string; capabilities?: string[]; wantPrimary?: boolean }): NetClient {
  return new Runtime.NetClient(url, role, { hello });
}

export function createRuntime(opts: { scene: THREE.Scene; net: NetClient; role: ClientRole; renderer: THREE.WebGLRenderer; camera: THREE.Camera }): RuntimePort {
  return new Runtime.SpaceRuntime({ ...opts, isMirror: false });
}

export function createEngine(host: InteractionHost): EnginePort {
  return new Input.InteractionEngine(host);
}

/**
 * Wrap the runtime's InteractionHost so `runCommand` goes through the client
 * CommandRouter (logging + client commands) while everything else hits the runtime.
 */
export function routeHostCommands(host: InteractionHost, run: InteractionHost['runCommand']): InteractionHost {
  // The engine calls host methods several times per frame: bind each once
  // (re-bound only if the underlying function changes) to avoid per-call allocation.
  const bound = new Map<PropertyKey, { fn: (...a: unknown[]) => unknown; b: (...a: unknown[]) => unknown }>();
  return new Proxy(host, {
    get(target, key) {
      if (key === 'runCommand') return run;
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== 'function') return v;
      const c = bound.get(key);
      if (c && c.fn === v) return c.b;
      const b = (v as (...a: unknown[]) => unknown).bind(target);
      bound.set(key, { fn: v as (...a: unknown[]) => unknown, b });
      return b;
    },
  });
}

export function createHandVisual(runtime: RuntimePort): HandVisualPort {
  return Runtime.createHandVisual(runtime.theme);
}

/** Pure functions from the input package (injected into testable modules). */
export const input = {
  computeFeatures: (frame: HandFrame, head: Pose, other?: HandFrame): HandFeatures => Input.computeFeatures(frame, head, other),
  pinchPoint: (frame: HandFrame): Vec3 => Input.pinchPoint(frame),
  rayAnchor: (frame: HandFrame): Vec3 => Input.rayAnchor(frame),
  shoulderPosition: (hand: 'left' | 'right', head: Pose): Vec3 => Input.shoulderPosition(hand, head),
  synthHand: (spec: SynthSpecLike): HandFrame => Input.synthHand(spec as Input.SynthHandSpec),
};
