// Client → server message handling (text + binary frames).
import type { ClientMessage, PoseEvent, UserPose } from '@evolspace/protocol';
import { decodeAudioFrame, decodeTensorFrame, isAudioFrame } from '@evolspace/protocol';
import type { Services } from '../services.ts';
import type { ClientConnection } from './client.ts';
import { SceneError } from '../scene/validate.ts';

type Msg<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

const isNums = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Minimal structural check: everything /api/user and the mirror dereference unconditionally. */
export function isUserPose(p: unknown): p is UserPose {
  if (!p || typeof p !== 'object') return false;
  const u = p as Partial<UserPose>;
  return !!u.head && isNums(u.head.position, 3) && isNums(u.head.rotation, 4)
    && (u.hands === undefined || (typeof u.hands === 'object' && u.hands !== null));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function createHandlers(s: Services) {
  const warn = (c: ClientConnection, message: string) => {
    s.log.warn(`client ${c.id}: ${message}`);
    s.event('client.log', { clientId: c.id, role: c.role, level: 'warn', message: `[server] ${message}` });
  };

  function onText(c: ClientConnection, raw: Record<string, unknown> & { type: string }): void {
    const m = raw as unknown as ClientMessage;
    switch (m.type) {
      case 'scene.ops': {
        const source = m.source === 'widget' ? 'widget' : 'user';
        try {
          s.applyOps(m.ops, source, typeof m.group === 'string' ? m.group : undefined);
        } catch (e) {
          // The client may have applied the ops optimistically: resync it.
          warn(c, `scene.ops rejected: ${(e as Error).message}`);
          c.send({ type: 'scene.snapshot', scene: s.store.scene });
          if (!(e instanceof SceneError)) throw e;
        }
        return;
      }
      case 'scene.undo': case 'scene.redo': {
        const res = m.type === 'scene.undo' ? s.store.undo() : s.store.redo();
        if (res.error) warn(c, res.error);
        return;
      }
      case 'user.pose':
        if (!c.primary) return; // only the primary xr client defines "the user"
        if (isUserPose(m.pose)) { s.user.setPose(m.pose); s.userPoseFeed.offer(m.pose); }
        else if (!c.badPoseWarned) { c.badPoseWarned = true; warn(c, 'user.pose ignored: expected {t, mode, head: {position: [x,y,z], rotation: [x,y,z,w]}, hands}'); }
        return;
      case 'channel.subscribe': {
        const names = strings(m.channels);
        c.subscribe(names);
        // Deliver current values immediately.
        for (const name of names) {
          if (name === '*' || name.endsWith('.*')) {
            for (const n of s.bus.names()) if (c.isSubscribed(n)) { const ch = s.bus.get(n); if (ch) c.sendChannel(ch); }
          } else {
            const ch = s.bus.get(name);
            if (ch) c.sendChannel(ch);
          }
        }
        return;
      }
      case 'channel.unsubscribe': c.unsubscribe(strings(m.channels)); return;
      case 'channel.publish':
        try {
          s.bus.publish(m.channel, m.value, { producer: `client:${c.id}`, origin: c.id });
        } catch (e) { warn(c, `channel.publish '${String(m.channel)}': ${(e as Error).message}`); }
        return;
      case 'widget.event':
        s.event('widget.event', { clientId: c.id, entity: m.entity, widget: m.widget, name: m.name, ...(m.data !== undefined ? { data: m.data } : {}) });
        return;
      case 'client.error':
        s.event('client.error', { clientId: c.id, role: c.role, message: m.message, ...(m.stack ? { stack: m.stack } : {}), ...(m.entity ? { entity: m.entity } : {}), ...(m.widget ? { widget: m.widget } : {}) });
        return;
      case 'client.log':
        s.event('client.log', { clientId: c.id, role: c.role, level: m.level, message: m.message, ...(m.entity ? { entity: m.entity } : {}) });
        return;
      case 'pose.event': {
        const e = m.event as PoseEvent;
        if (!e || typeof e.pose !== 'string') { warn(c, 'pose.event without event.pose'); return; }
        if (c.primary) s.user.onPoseEvent(e);
        s.event('pose.event', { clientId: c.id, ...e });
        return;
      }
      case 'pose.recording':
        if (!s.recorder.onRecording(c.id, m)) warn(c, `pose.recording for unknown request '${m.requestId}'`);
        return;
      case 'agent.ask':
        if (typeof m.text !== 'string' || !m.text.trim()) { warn(c, 'agent.ask without text'); return; }
        s.agentAsk(m.text, { ...(m.context ?? {}), clientId: c.id, origin: 'ws' });
        return;
      case 'voice.begin': s.voice.onBegin(c.id, m as Msg<'voice.begin'>); return;
      case 'voice.end': s.voice.onEnd(c.id, m as Msg<'voice.end'>); return;
      case 'command': {
        const name = m.name;
        if (typeof name !== 'string') { warn(c, 'command without name'); return; }
        // App-level liveness probe: answer right away (clients count any inbound message).
        if (name === 'ping') { c.send({ type: 'command', name: 'pong' }); return; }
        void s.commands.run(name, m.args, { clientId: c.id, origin: 'ws' }).catch((e: Error) => {
          warn(c, `command '${name}' failed: ${e.message}`);
          c.send({ type: 'agent.message', message: { id: `err-${Date.now().toString(36)}`, text: `Command '${name}' failed: ${e.message}`, kind: 'error', ts: Date.now() } });
        });
        return;
      }
      default:
        warn(c, `unknown message type '${String((m as { type: unknown }).type)}'`);
    }
  }

  function onBinary(c: ClientConnection, bytes: Uint8Array): void {
    if (isAudioFrame(bytes)) {
      const { utteranceId, pcm } = decodeAudioFrame(bytes);
      s.voice.onAudio(c.id, utteranceId, pcm);
      return;
    }
    try {
      const { header, tensor } = decodeTensorFrame(bytes);
      s.bus.publish(header.channel, tensor, { producer: header.producer ?? `client:${c.id}`, origin: c.id });
    } catch (e) {
      warn(c, `bad binary frame (${bytes.byteLength} bytes): ${(e as Error).message}`);
    }
  }

  return { onText, onBinary };
}
