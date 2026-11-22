import { useEffect } from "react";
import { AppState as RNAppState } from "react-native";

import type { ConnectionStatus } from "../api/wsClient";
import { isBusy, type AssistantStatus, type Metrics } from "../state/machine";
import { askQuestion, bootstrap, cancelAnswer, type ChatMessage, useStore, wakeConnection } from "../state/store";

export interface Assistant {
  status: AssistantStatus;
  busy: boolean;
  connection: ConnectionStatus;
  messages: ChatMessage[];
  lastMetrics: Metrics | null;
  ask: (text: string) => void;
  cancel: () => void;
  retry: (question: string) => void;
}

/**
 * The one hook screens use. Selects only coarse state (status, messages) — never the
 * streaming text, so screens don't re-render per token. Voice (next phase) will add
 * startRecording/stopRecording here and reuse `ask` with the transcript.
 */
export function useAssistant(): Assistant {
  const status = useStore((s) => s.machine.status);
  const connection = useStore((s) => s.connection);
  const messages = useStore((s) => s.messages);
  const lastMetrics = useStore((s) => s.machine.lastMetrics);
  const speaking = useStore((s) => s.speaking);
  // Speaking counts as busy: Stop is shown, and a typed send barges in (stops TTS first).
  return { status, busy: isBusy(status) || speaking, connection, messages, lastMetrics, ask: askQuestion, cancel: cancelAnswer, retry: askQuestion };
}

/** Call once at the app root: device id, socket, docs; reconnect fast when foregrounded. */
export function useAssistantBootstrap(): void {
  useEffect(() => {
    void bootstrap();
    const sub = RNAppState.addEventListener("change", (state) => {
      if (state === "active") wakeConnection();
    });
    return () => sub.remove();
  }, []);
}
