import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Source } from "../state/machine";
import { colors, radius } from "../theme";

interface Props {
  source: Source | null;
  onClose: () => void;
}

/** Bottom sheet with the cited chunk: doc, page and snippet. */
export function SourceSheet({ source, onClose }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={source !== null} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close source" />
      <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <View style={styles.handle} />
        {source ? (
          <>
            <Text style={styles.label}>{`Source [${source.n}]`}</Text>
            <Text style={styles.title}>{source.doc_name}</Text>
            <Text style={styles.page}>{`Page ${source.page}`}</Text>
            <Text style={styles.snippet}>{`“${source.snippet.trim()}…”`}</Text>
          </>
        ) : null}
        <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 14 },
  label: { color: colors.chipText, fontWeight: "700", fontSize: 13 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: 4 },
  page: { color: colors.textDim, marginTop: 2 },
  snippet: { color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 14 },
  close: { marginTop: 20, alignSelf: "stretch", alignItems: "center", paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  closeText: { color: colors.text, fontWeight: "600" },
});
