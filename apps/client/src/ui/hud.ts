// Client → user feedback. In-world via the runtime's SystemUi (voice HUD +
// level meter, toasts; the pose-recording countdown is the runtime's
// RecordingUi) and mirrored on the 2D page (desktop / setup).

import type { RecorderUiEvent } from '../pose/recorder.ts';
import type { VoiceUiState } from '../audio/ptt.ts';
import type { LandingUi } from './landing.ts';

/** The subset of the runtime's SystemUi the client drives (see packages/runtime/src/system/SystemUi.ts). */
export interface SystemUiPort {
  voiceBegin(): void;
  voiceLevel(v: number): void;
  voiceEnd(cancelled?: boolean): void;
  toast(message: string, kind?: 'info' | 'success' | 'error' | 'voice', seconds?: number): void;
}

export class Hud {
  listening = false;

  constructor(private readonly system: SystemUiPort | null, private readonly page: LandingUi | null) {}

  voice(state: VoiceUiState, detail?: string): void {
    const was = this.listening;
    this.listening = state === 'listening';
    try {
      if (state === 'listening' && !was) this.system?.voiceBegin();
      // An error mid-utterance (e.g. connection lost) discards it like a cancel.
      if (state !== 'listening' && was) this.system?.voiceEnd(detail === 'cancelled' || state === 'error');
    } catch (e) {
      console.warn('[evol] SystemUi voice update failed', e);
    }
    if (state === 'error') this.toast(detail ?? 'Voice error', 'error');
  }

  level(v: number): void {
    try { this.system?.voiceLevel(v); } catch { /* cosmetic */ }
  }

  /**
   * Recording feedback. The in-world countdown/progress ring is the runtime's
   * RecordingUi; here we only report the outcome (and show a countdown on the
   * page when the client times the recording itself).
   */
  recording(e: RecorderUiEvent): void {
    if (e.phase === 'countdown') this.page?.toast(`Recording "${e.name}" in ${e.secondsLeft}…`, 'info', 1000);
    else if (e.phase === 'done') this.toast(`Recorded "${e.name}" (${e.samples} samples, ${e.hand} hand)`, 'success');
    else if (e.phase === 'error') this.toast(`Pose "${e.name}": ${e.message}`, 'error');
  }

  toast(text: string, kind: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
    try { this.system?.toast(text, kind === 'warn' ? 'error' : kind); } catch (e) { console.warn('[evol] SystemUi toast failed', e); }
    this.page?.toast(text, kind === 'success' ? 'info' : kind);
  }
}
