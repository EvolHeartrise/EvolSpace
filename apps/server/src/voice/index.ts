// STUB — replaced by the voice component. Keeps the server bootable meanwhile.
import type { VoiceDeps, VoiceService } from './types.ts';
export type { VoiceDeps, VoiceService };
export function createVoice(deps: VoiceDeps): VoiceService {
  return {
    onBegin() {}, onAudio() {},
    onEnd() { deps.say('Voice not implemented yet', 'error'); },
    async simulate(text, context) { deps.agentAsk(text, context ?? {}); return { route: 'agent' }; },
    commands: () => [],
    close: async () => {},
  };
}
