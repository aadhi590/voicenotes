import { memo, useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { Source } from "../state/machine";
import type { ChatMessage } from "../state/store";
import { colors, radius } from "../theme";
import { citedNumbers, parseCitations } from "../utils/citations";
import { CitationChip } from "./CitationChip";

interface Props {
  message: ChatMessage;
  onSourcePress: (source: Source) => void;
  onRetry: (question: string) => void;
}

/** A finished message. Memoized: never re-renders while a new answer streams. */
function MessageBubbleBase({ message, onSourcePress, onRetry }: Props) {
  const { role, text, sources } = message;
  const segments = useMemo(() => (role === "assistant" ? parseCitations(text, sources.length) : null), [role, text, sources.length]);

  const sourcesLine = useMemo(() => {
    if (!segments) return "";
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const n of citedNumbers(segments)) {
      const s = sources[n - 1];
      const label = `${s.doc_name} p.${s.page}`;
      if (!seen.has(label)) {
        seen.add(label);
        parts.push(label);
      }
    }
    return parts.join(" · ");
  }, [segments, sources]);

  const handleCite = useCallback((n: number) => onSourcePress(sources[n - 1]), [onSourcePress, sources]);
  const handleRetry = useCallback(() => message.retryQuestion && onRetry(message.retryQuestion), [message.retryQuestion, onRetry]);

  if (role === "user") {
    return (
      <View style={[styles.row, styles.rowRight]}>
        <View style={[styles.bubble, styles.user]}>
          <Text style={styles.text}>{text}</Text>
        </View>
      </View>
    );
  }

  if (role === "error") {
    return (
      <View style={styles.row}>
        <View style={[styles.bubble, styles.error]}>
          <Text style={styles.errorText}>{text}</Text>
          {message.retryQuestion ? (
            <Pressable onPress={handleRetry} style={styles.retry} accessibilityRole="button">
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={[styles.bubble, styles.assistant]}>
        <Text style={styles.text}>
          {segments?.map((seg, i) =>
            seg.type === "text" ? seg.value : <CitationChip key={`c${i}`} n={seg.n} onPress={handleCite} />,
          )}
        </Text>
        {message.cancelled ? <Text style={styles.meta}>Stopped</Text> : null}
        {sourcesLine ? <Text style={styles.meta} numberOfLines={2}>{`Sources: ${sourcesLine}`}</Text> : null}
      </View>
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleBase);

export const bubbleStyles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 4, flexDirection: "row" },
  bubble: { maxWidth: "86%", borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  assistant: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  text: { color: colors.text, fontSize: 16, lineHeight: 23 },
});

const styles = StyleSheet.create({
  ...bubbleStyles,
  rowRight: { justifyContent: "flex-end" },
  user: { backgroundColor: colors.userBubble },
  error: { backgroundColor: colors.dangerBg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.danger },
  errorText: { color: "#FFB4B6", fontSize: 15, lineHeight: 21 },
  retry: { marginTop: 8, alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.danger },
  retryText: { color: "#fff", fontWeight: "700" },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 6 },
});
