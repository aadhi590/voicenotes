import { setAutoSpeak, speaker, useStore } from "../state/store";

/**
 * UI access to the one TTS speaker (voice/speaker.ts, created in the store). Sentence buffering,
 * citation stripping and id-gating happen there; the store feeds it streamed tokens.
 */
export function useSpeaker(): { speaking: boolean; autoSpeak: boolean; setAutoSpeak: (on: boolean) => void; stop: () => void } {
  const speaking = useStore((s) => s.speaking);
  const autoSpeak = useStore((s) => s.autoSpeak);
  return { speaking, autoSpeak, setAutoSpeak, stop: () => speaker.stop() };
}
