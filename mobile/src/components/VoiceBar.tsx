import { memo, useCallback, useEffect } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { BAR_COUNT, useRecorder } from "../hooks/useRecorder";
import type { AssistantStatus } from "../state/machine";
import { abandonRecording, beginRecording, transcribeAndAsk, useStore } from "../state/store";
import { colors } from "../theme";

const MIC_SIZE = 72;
const BAR_HEIGHT = 36;

function Bar({ index, levels }: { index: number; levels: SharedValue<number[]> }) {
  // Runs on the UI thread: metering updates never re-render React.
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: withTiming(0.12 + 0.88 * (levels.value[index] ?? 0), { duration: 70 }) }],
  }));
  return <Animated.View style={[styles.bar, style]} />;
}

function Waveform({ levels }: { levels: SharedValue<number[]> }) {
  return (
    <View style={styles.wave} accessibilityLabel="Recording level">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <Bar key={i} index={i} levels={levels} />
      ))}
    </View>
  );
}

function labelFor(status: AssistantStatus, speaking: boolean): string {
  if (status === "recording") return "Listening… tap to stop";
  if (status === "transcribing") return "Transcribing…";
  if (status === "thinking") return "Thinking… tap to interrupt";
  if (status === "streaming") return speaking ? "Speaking… tap to interrupt" : "Answering… tap to interrupt";
  if (speaking) return "Speaking… tap to interrupt";
  return "Tap to ask";
}

/** Big mic + waveform + state label. Tap = start/stop recording, or interrupt (barge-in). */
function VoiceBarBase({ disabled }: { disabled: boolean }) {
  const status = useStore((s) => s.machine.status);
  const speaking = useStore((s) => s.speaking);
  const hint = useStore((s) => s.voiceHint);

  const onUtterance = useCallback((u: { uri: string; peakDb: number }) => void transcribeAndAsk(u.uri, u.peakDb), []);
  const { start, stop, levels, micProblem, clearMicProblem } = useRecorder({ onUtterance, onDiscard: abandonRecording });

  const recording = status === "recording";
  const transcribing = status === "transcribing";

  const onPress = useCallback(async () => {
    if (recording) {
      stop();
      return;
    }
    if (transcribing) return;
    // Barge-in order: (a) stop TTS, (b) cancel the WS question — both in beginRecording — (c) record.
    beginRecording();
    clearMicProblem();
    const ok = await start();
    if (!ok) abandonRecording(null);
  }, [recording, transcribing, start, stop, clearMicProblem]);

  // Red pulse while recording.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (recording) pulse.value = withRepeat(withTiming(1.12, { duration: 550 }), -1, true);
    else {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: 150 });
    }
  }, [recording, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  const interruptible = status === "thinking" || status === "streaming" || speaking;

  return (
    <View style={styles.wrap}>
      {recording ? <Waveform levels={levels} /> : null}
      <Animated.View style={pulseStyle}>
        <Pressable
          onPress={onPress}
          disabled={disabled || transcribing}
          style={[styles.mic, recording && styles.micRecording, interruptible && styles.micInterrupt, disabled && styles.dim]}
          accessibilityRole="button"
          accessibilityLabel={recording ? "Stop recording" : interruptible ? "Interrupt and ask by voice" : "Ask by voice"}
        >
          {transcribing ? <ActivityIndicator color="#fff" /> : <Text style={styles.glyph}>{recording ? "■" : "🎤"}</Text>}
        </Pressable>
      </Animated.View>
      <Text style={styles.label}>{labelFor(status, speaking)}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {micProblem ? (
        <View style={styles.problem}>
          <Text style={styles.problemText}>{micProblem.message}</Text>
          {micProblem.canOpenSettings ? (
            <Pressable onPress={() => void Linking.openSettings()} style={styles.settings} accessibilityRole="button">
              <Text style={styles.settingsText}>Open settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const VoiceBar = memo(VoiceBarBase);

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingTop: 10, paddingBottom: 4, gap: 6 },
  wave: { flexDirection: "row", alignItems: "center", height: BAR_HEIGHT, gap: 3, marginBottom: 4 },
  bar: { width: 4, height: BAR_HEIGHT, borderRadius: 2, backgroundColor: colors.danger },
  mic: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  micRecording: { backgroundColor: colors.danger },
  micInterrupt: { backgroundColor: colors.surfaceAlt, borderWidth: 2, borderColor: colors.accent },
  dim: { opacity: 0.4 },
  glyph: { fontSize: 28, color: "#fff" },
  label: { color: colors.textDim, fontSize: 13 },
  hint: { color: colors.warn, fontSize: 13 },
  problem: { alignItems: "center", gap: 6, paddingHorizontal: 24 },
  problemText: { color: "#FFB4B6", textAlign: "center" },
  settings: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surfaceAlt },
  settingsText: { color: colors.text, fontWeight: "600" },
});
