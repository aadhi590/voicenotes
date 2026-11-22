import { memo, useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { MAX_QUESTION_CHARS } from "../config";
import { colors, radius } from "../theme";

interface Props {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/**
 * Text input + Send/Stop. While an answer is in flight and the input is empty the button is a
 * red Stop; with text it's Send, which barges in (cancels the current answer, asks the new one).
 */
function ComposerBase({ busy, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const hasText = text.trim().length > 0;
  const showStop = busy && !hasText;

  const send = useCallback(() => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  }, [text, onSend]);

  return (
    <View style={styles.wrap}>
      {/* ───── VOICE SLOT (next phase): replace with the hold-to-talk mic button ───── */}
      <View style={[styles.round, styles.mic]} accessibilityLabel="Voice input (coming soon)" accessibilityState={{ disabled: true }}>
        <Text style={styles.micGlyph}>🎤</Text>
      </View>

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={disabled ? "Upload notes to start…" : "Ask about your notes…"}
        placeholderTextColor={colors.textDim}
        multiline
        maxLength={MAX_QUESTION_CHARS}
        editable={!disabled}
        onSubmitEditing={send}
        submitBehavior="submit"
        returnKeyType="send"
      />

      {showStop ? (
        <Pressable onPress={onStop} style={[styles.round, styles.stop]} accessibilityRole="button" accessibilityLabel="Stop answer">
          <View style={styles.stopSquare} />
        </Pressable>
      ) : (
        <Pressable
          onPress={send}
          disabled={!hasText || disabled}
          style={[styles.round, styles.send, (!hasText || disabled) && styles.sendDisabled]}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Send new question" : "Send"}
        >
          <Text style={styles.sendGlyph}>↑</Text>
        </Pressable>
      )}
    </View>
  );
}

export const Composer = memo(ComposerBase);

const SIZE = 44;
const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    minHeight: SIZE,
    maxHeight: 120,
    color: colors.text,
    fontSize: 16,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
  },
  round: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: "center", justifyContent: "center" },
  mic: { backgroundColor: colors.surfaceAlt, opacity: 0.45 },
  micGlyph: { fontSize: 18 },
  send: { backgroundColor: colors.accent },
  sendDisabled: { opacity: 0.4 },
  sendGlyph: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: -2 },
  stop: { backgroundColor: colors.danger },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: "#fff" },
});
