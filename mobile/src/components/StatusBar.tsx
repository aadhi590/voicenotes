import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ConnectionStatus } from "../api/wsClient";
import type { AssistantStatus } from "../state/machine";
import { colors, radius } from "../theme";

const DOT_COLOR: Record<ConnectionStatus, string> = { open: colors.ok, connecting: colors.warn, closed: colors.danger };
const DOT_LABEL: Record<ConnectionStatus, string> = { open: "Connected", connecting: "Connecting", closed: "Offline" };

const STATE_LABEL: Record<AssistantStatus, string> = {
  idle: "Ready",
  recording: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  streaming: "Answering",
  error: "Error",
};

/** Connection dot (green/amber/red). */
function ConnectionDotBase({ status }: { status: ConnectionStatus }) {
  return (
    <View style={styles.dotWrap} accessibilityLabel={DOT_LABEL[status]}>
      <View style={[styles.dot, { backgroundColor: DOT_COLOR[status] }]} />
    </View>
  );
}
export const ConnectionDot = memo(ConnectionDotBase);

/** Small pill with the assistant state. */
function StatePillBase({ status }: { status: AssistantStatus }) {
  const active = status !== "idle";
  return (
    <View style={[styles.pill, active && styles.pillActive, status === "error" && styles.pillError]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{STATE_LABEL[status]}</Text>
    </View>
  );
}
export const StatePill = memo(StatePillBase);

const styles = StyleSheet.create({
  dotWrap: { padding: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt },
  pillActive: { backgroundColor: colors.chipBg },
  pillError: { backgroundColor: colors.dangerBg },
  pillText: { color: colors.textDim, fontSize: 12, fontWeight: "600" },
  pillTextActive: { color: colors.chipText },
});
