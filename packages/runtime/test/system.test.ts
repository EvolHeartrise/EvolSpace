import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SystemUi } from '../src/system/SystemUi.ts';
import { RuntimeUiKit } from '../src/ui/UiKit.ts';
import { stubTextFactory } from '../src/ui/stubText.ts';
import { createTheme } from '../src/theme.ts';
import { makeRuntime } from './helpers.ts';
import type { RecordPhase } from '../src/system/RecordingUi.ts';

const head = new THREE.Vector3(0, 1.6, 0);
const q = new THREE.Quaternion();

function sys() {
  const ui = new RuntimeUiKit(createTheme(), { textFactory: stubTextFactory });
  return { s: new SystemUi(ui), ui };
}

function step(s: SystemUi, seconds: number, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) s.update(dt, head, q);
}

describe('SystemUi', () => {
  it('orb reflects agent state with a running timer while working', () => {
    const { s } = sys();
    s.setAgentStatus({ state: 'working', detail: 'Running Bash', since: Date.now() });
    expect(s.orb.current).toBe('working');
    step(s, 3.2);
    const detail = s.orb.group.children.filter((c) => (c as { text?: string }).text !== undefined).map((c) => (c as unknown as { text: string }).text);
    expect(detail.some((t) => /Running Bash · 3s/.test(t))).toBe(true);
    expect(detail).toContain('Claude is working');
  });

  it('offline overrides agent state; listening shows while PTT is held', () => {
    const { s } = sys();
    s.setAgentStatus({ state: 'thinking', since: 0 });
    s.setConnected(false);
    expect(s.orb.current).toBe('offline');
    s.setConnected(true);
    expect(s.orb.current).toBe('thinking');
    s.voiceBegin();
    expect(s.orb.current).toBe('listening');
    expect(s.voice.active).toBe(true);
    s.voiceLevel(0.8);
    step(s, 0.3);
    expect(s.voice.currentLevel).toBeGreaterThan(0.5);
    s.voiceEnd();
    expect(s.orb.current).toBe('thinking');
    s.voiceResult({ type: 'voice.result', utteranceId: 'u', text: 'undo that', route: 'fastpath', command: 'undo' });
    expect(s.voice.resultText).toContain('undo');
    step(s, 4);
    expect(s.voice.resultText).toBeNull();
  });

  it('panel: auto-opens on replies, styles heard messages, scrolls, toggles', () => {
    const { s } = sys();
    const T0 = Date.now();
    expect(s.panel.visible).toBe(false);
    s.addMessage({ id: '1', text: 'make the box red', kind: 'heard', ts: T0 + 1 });
    expect(s.panel.visible).toBe(false);
    s.addMessage({ id: '2', text: 'Done — the box is red.', kind: 'reply', ts: T0 + 2 });
    expect(s.panel.visible).toBe(true);
    step(s, 0.1);
    const texts = s.panel.group.children.filter((c) => c.visible && (c as { text?: string }).text !== undefined).map((c) => (c as unknown as { text: string }).text);
    expect(texts).toContain('you › make the box red');
    expect(texts).toContain('Done — the box is red.');
    for (let i = 3; i < 30; i++) s.addMessage({ id: String(i), text: `m${i}`, kind: 'info', ts: T0 + i });
    s.panel.scroll(5);
    expect(s.panel.scrollPosition).toBe(5);
    s.addMessage({ id: '99', text: 'new', kind: 'info', ts: T0 + 99 });
    expect(s.panel.scrollPosition).toBe(6); // anchored to the same message
    expect(s.togglePanel()).toBe(false);
    s.addMessage({ id: '100', text: 'reply while hidden', kind: 'reply', ts: T0 + 100 });
    expect(s.panel.visible).toBe(true); // autoOpen
    s.autoOpenPanel = false;
    s.togglePanel();
    s.addMessage({ id: '101', text: 'again', kind: 'reply', ts: T0 + 101 });
    expect(s.panel.visible).toBe(false);
  });

  it('toasts coalesce duplicates and expire', () => {
    const { s } = sys();
    s.toast('widget x failed', 'error');
    s.toast('widget x failed', 'error');
    s.toast('saved', 'success');
    expect(s.toasts.active).toBe(2);
    expect(s.toasts.messages()).toContain('widget x failed  ×2');
    step(s, 8);
    expect(s.toasts.active).toBe(0);
  });

  it('recording countdown emits phases for the client to sample', () => {
    const { s } = sys();
    const phases: RecordPhase[] = [];
    s.recording.onPhase((p) => phases.push(p));
    s.recording.start({ type: 'pose.record', requestId: 'r', name: 'thumbs-up', hand: 'right', seconds: 1, countdown: 2 });
    expect(phases).toEqual(['countdown']);
    expect(s.recording.active).toBe(true);
    step(s, 2.1);
    expect(phases).toEqual(['countdown', 'recording']);
    step(s, 1.1);
    expect(phases).toEqual(['countdown', 'recording', 'done']);
    expect(s.recording.active).toBe(false);
    step(s, 2);
    expect(s.recording.group.visible).toBe(false);
  });

  it('replayed history (reconnect) does not reopen the panel; fresh replies do', () => {
    const { s } = sys();
    const now = Date.now();
    s.addMessage({ id: 'old', text: 'earlier answer', kind: 'reply', ts: now - 10 * 60_000 });
    expect(s.panel.visible).toBe(false);
    s.addMessage({ id: 'new', text: 'fresh answer', kind: 'reply', ts: now });
    expect(s.panel.visible).toBe(true);
    s.togglePanel();
    // The server replays the same messages after a reconnect: no auto-open.
    s.addMessage({ id: 'new', text: 'fresh answer', kind: 'reply', ts: now });
    expect(s.panel.visible).toBe(false);
    expect(s.panel.count).toBe(2);
  });

  it('panel keeps messages chronological and the scroll anchored', () => {
    const { s } = sys();
    for (let i = 0; i < 5; i++) s.panel.add({ id: 'm' + i, text: 't' + i, kind: 'info', ts: 1000 + i * 10 });
    s.panel.scroll(2); // bottom of view = m2
    s.panel.add({ id: 'late', text: 'older', kind: 'info', ts: 1005 }); // lands before m1
    expect(s.panel.scrollPosition).toBe(2);
    s.panel.add({ id: 'newest', text: 'n', kind: 'info', ts: 2000 });
    expect(s.panel.scrollPosition).toBe(3);
  });

  it('orb timer counts from AgentStatus.since (survives reconnects)', () => {
    const { s } = sys();
    s.setAgentStatus({ state: 'working', detail: 'Running Bash', since: Date.now() - 125_000 });
    step(s, 0.1);
    expect(s.orb.detailLine).toMatch(/Running Bash · 2m 0[45]s/);
    // A detail change with the same since keeps counting.
    s.setAgentStatus({ state: 'working', detail: 'Editing', since: Date.now() - 125_000 });
    expect(s.orb.detailLine).toMatch(/Editing · 2m 0[45]s/);
    // Implausible since (clock skew) → count locally from 0.
    s.setAgentStatus({ state: 'thinking', since: Date.now() + 60_000 });
    expect(s.orb.detailLine).toBe('0s');
  });

  it('recording can be cancelled; a new request supersedes the old one', () => {
    const { s } = sys();
    const phases: string[] = [];
    s.recording.onPhase((p, r) => phases.push(`${r.requestId}:${p}`));
    s.recording.start({ type: 'pose.record', requestId: 'a', name: 'x', hand: 'left', seconds: 1, countdown: 3 });
    s.recording.start({ type: 'pose.record', requestId: 'b', name: 'y', hand: 'left', seconds: 1, countdown: 0 });
    s.recording.cancel();
    expect(phases).toEqual(['a:countdown', 'a:cancelled', 'b:recording', 'b:cancelled']);
  });
});

describe('runtime ↔ system UI wiring', () => {
  it('routes agent/voice/record messages, panel toggle command, connection state', () => {
    const { rt, ws } = makeRuntime();
    ws.serverSend({ type: 'agent.status', status: { state: 'working', detail: 'Edit', since: 1 } });
    expect(rt.system.orb.current).toBe('working');
    ws.serverSend({ type: 'agent.message', message: { id: 'm', text: 'hello', kind: 'reply', ts: Date.now() } });
    expect(rt.system.panel.count).toBe(1);
    expect(rt.runLocalCommand('agent.panel.toggle', undefined, 'start')).toBe(true);
    expect(rt.system.panel.visible).toBe(false);
    const rec = vi.fn();
    rt.system.recording.onPhase(rec);
    ws.serverSend({ type: 'pose.record', requestId: 'r', name: 'p', hand: 'left', seconds: 1, countdown: 1 });
    expect(rec).toHaveBeenCalledWith('countdown', expect.objectContaining({ requestId: 'r' }));
    // Server-sent client commands run locally.
    const fn = vi.fn();
    rt.registerLocalCommand('session.mode', fn);
    ws.serverSend({ type: 'command', name: 'session.mode', args: { mode: 'ar' } });
    expect(fn).toHaveBeenCalledWith({ mode: 'ar' }, 'start');
    ws.drop();
    expect(rt.system.orb.current).toBe('offline');
  });

  it('mirror role hides system UI and pointer visuals', () => {
    const { rt } = makeRuntime({ role: 'mirror' });
    expect(rt.isMirror).toBe(true);
    expect(rt.system.group.visible).toBe(false);
  });
});
