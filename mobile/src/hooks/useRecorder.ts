import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

import { DIDNT_CATCH } from "../state/store";
import { initialVad, normalizeDb, shouldDiscardRecording, vadStep, type VadState } from "../voice/silence";

export const BAR_COUNT = 24;
const POLL_MS = 50;
const SMOOTHING = 0.45; // 0 = no smoothing, 1 = frozen

// m4a/AAC mono 16 kHz: Whisper's native rate, small uploads. Metering drives VAD + waveform.
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { ...RecordingPresets.HIGH_QUALITY.android, sampleRate: 16000 },
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, sampleRate: 16000 },
};

export interface Utterance {
  uri: string;
  durationMs: number;
  peakDb: number;
}

export interface MicProblem {
  message: string;
  canOpenSettings: boolean;
}

interface Callbacks {
  onUtterance: (u: Utterance) => void;
  onDiscard: (hint: string | null) => void;
}

const zeros = (): number[] => new Array<number>(BAR_COUNT).fill(0);

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* temp cache */
  }
}

/**
 * Tap-to-start / tap-to-stop recorder with hands-free end-of-utterance (1.2 s of silence after
 * speech), a 30 s cap, a silence guard (never calls /stt for silent or too-short taps), and
 * auto-stop when the app goes to the background.
 */
export function useRecorder({ onUtterance, onDiscard }: Callbacks): {
  start: () => Promise<boolean>;
  stop: () => void;
  levels: SharedValue<number[]>;
  micProblem: MicProblem | null;
  clearMicProblem: () => void;
} {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const levels = useSharedValue<number[]>(zeros());
  const [micProblem, setMicProblem] = useState<MicProblem | null>(null);

  const active = useRef(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const vad = useRef<VadState>(initialVad);
  const smoothed = useRef(0);
  const callbacks = useRef<Callbacks>({ onUtterance, onDiscard });
  callbacks.current = { onUtterance, onDiscard };

  const finish = useCallback(
    async (reason: "user" | "auto" | "background") => {
      if (!active.current) return;
      active.current = false;
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      const durationMs = Date.now() - startedAt.current;
      try {
        await recorder.stop();
      } catch {
        /* already stopped */
      }
      // Back to playback mode so TTS isn't quiet / routed to the earpiece.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      levels.value = zeros();
      const uri = recorder.uri;
      const { peakDb } = vad.current;

      if (reason === "background" || !uri) {
        deleteQuietly(uri);
        callbacks.current.onDiscard(null);
        return;
      }
      if (shouldDiscardRecording(durationMs, peakDb)) {
        deleteQuietly(uri);
        callbacks.current.onDiscard(DIDNT_CATCH);
        return;
      }
      callbacks.current.onUtterance({ uri, durationMs, peakDb });
    },
    [recorder, levels],
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (active.current) return true;
    try {
      let perm = await getRecordingPermissionsAsync();
      if (!perm.granted && perm.canAskAgain) perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setMicProblem({ message: "Microphone access is off. Allow it to ask by voice.", canOpenSettings: true });
        return false;
      }
      setMicProblem(null);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setMicProblem({ message: "Couldn't start the microphone. Try again.", canOpenSettings: false });
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      return false;
    }

    active.current = true;
    startedAt.current = Date.now();
    vad.current = initialVad;
    smoothed.current = 0;
    poll.current = setInterval(() => {
      if (!active.current) return;
      const db = recorder.getStatus().metering;
      const step = vadStep(vad.current, db, Date.now() - startedAt.current);
      vad.current = step.state;
      smoothed.current = smoothed.current * SMOOTHING + normalizeDb(db) * (1 - SMOOTHING);
      levels.value = [...levels.value.slice(1), smoothed.current];
      if (step.stop) void finish("auto");
    }, POLL_MS);
    return true;
  }, [recorder, levels, finish]);

  const stop = useCallback(() => {
    void finish("user");
  }, [finish]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void finish("background");
    });
    return () => {
      sub.remove();
      if (poll.current) clearInterval(poll.current);
    };
  }, [finish]);

  const clearMicProblem = useCallback(() => setMicProblem(null), []);
  return { start, stop, levels, micProblem, clearMicProblem };
}
