// One-off agents in the space: one small agent orb per running (or just-finished)
// one-off agent, fixed where the user was when they invoked it (the server places
// it in front of that head pose, facing it). Label = the request, status line =
// what the agent is doing + elapsed time. The server drops an agent from the list
// a few seconds after it finishes; its orb goes with it.

import * as THREE from 'three';
import type { OneshotAgentStatus } from '@evolspace/protocol';
import type { RuntimeUiKit } from '../ui/UiKit.ts';
import { AgentOrb } from './AgentOrb.ts';
import { truncate } from './util.ts';

/** World-fixed orbs are read from further away than the HUD orb: draw them bigger. */
const SCALE = 1.6;

export class OneshotOrbs {
  readonly group = new THREE.Group();
  private readonly orbs = new Map<number, AgentOrb>();

  constructor(private readonly ui: RuntimeUiKit) {
    this.group.name = 'oneshot-agents';
  }

  get count(): number {
    return this.orbs.size;
  }

  orb(id: number): AgentOrb | undefined {
    return this.orbs.get(id);
  }

  set(agents: OneshotAgentStatus[]): void {
    const live = new Set<number>();
    for (const a of agents) {
      live.add(a.id);
      let orb = this.orbs.get(a.id);
      if (!orb) {
        orb = new AgentOrb(this.ui);
        orb.group.name = `oneshot-agent-${a.id}`;
        orb.group.scale.setScalar(SCALE);
        this.group.add(orb.group);
        this.orbs.set(a.id, orb);
      }
      orb.group.position.fromArray(a.position);
      orb.group.quaternion.fromArray(a.rotation);
      orb.setTitle(`One-off: ${truncate(a.text.replace(/\s+/g, ' ').trim(), 48)}`);
      orb.set(a.state, a.detail ?? '', a.since);
    }
    for (const [id, orb] of this.orbs) {
      if (live.has(id)) continue;
      orb.group.removeFromParent();
      orb.dispose();
      this.orbs.delete(id);
    }
  }

  update(dt: number): void {
    for (const orb of this.orbs.values()) orb.update(dt);
  }

  dispose(): void {
    this.set([]);
  }
}
