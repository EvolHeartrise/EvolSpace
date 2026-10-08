// Structural copy of @evolspace/input's InteractionHost / Hit (ARCHITECTURE.md).
// The runtime only needs the shape, not the input package's code, so it is
// declared here; TypeScript's structural typing makes the runtime's host
// assignable to the input package's interface.

import type {
  Entity,
  Handedness,
  InteractionBinding,
  InteractionEvent,
  PoseEvent,
  Transform,
  Vec3,
} from '@evolspace/protocol';

export interface Hit {
  entity: string;
  point: Vec3;
  distance: number;
  object?: string;
  interactive: boolean;
}

export type GesturePhase = 'start' | 'move' | 'end';

export interface InteractionHost {
  raycast(origin: Vec3, dir: Vec3): Hit | null;
  touch(point: Vec3, radius: number): Hit | null;
  getEntity(id: string): Entity | undefined;
  getWorldTransform(id: string): Transform;
  widgetBindings(widget: string): InteractionBinding[];
  setEntityTransform(id: string, t: Transform, phase: GesturePhase): void;
  deliver(id: string, e: InteractionEvent): void;
  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void;
  publish(channel: string, value: unknown): void;
  poseEvent(e: PoseEvent): void;
  hover?(hand: Handedness, hit: Hit | null): void;
}

/** What InteractionEngine.rays() returns; fed to SpaceRuntime.setPointerRays for visuals. */
export type PointerRays = Partial<Record<Handedness, { origin: Vec3; direction: Vec3; hit: Hit | null }>>;
