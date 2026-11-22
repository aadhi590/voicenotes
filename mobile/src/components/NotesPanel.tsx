import * as DocumentPicker from "expo-document-picker";
import { useCallback } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { DocInfo } from "../api/http";
import { clearAllDocs, removeDoc, uploadFile, useStore } from "../state/store";
import { colors, radius } from "../theme";

const PICKER_TYPES = ["application/pdf", "text/plain", "text/markdown", "text/x-markdown"];

/** Open the system picker and upload the chosen file. Shared by the panel and the empty state. */
export async function pickAndUpload(): Promise<void> {
  const result = await DocumentPicker.getDocumentAsync({ type: PICKER_TYPES, copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets?.length) return;
  const asset = result.assets[0];
  await uploadFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType });
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

const docKey = (d: DocInfo): string => d.doc_name;

export function NotesPanel({ visible, onClose }: Props) {
  const docs = useStore((s) => s.docs);
  const busy = useStore((s) => s.docsBusy);
  const error = useStore((s) => s.docsError);
  const lastUpload = useStore((s) => s.lastUpload);
  const totalChunks = useStore((s) => s.totalChunks);

  const confirmClear = useCallback(() => {
    Alert.alert("Clear all notes?", "This removes every uploaded document from the server.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear all", style: "destructive", onPress: () => void clearAllDocs() },
    ]);
  }, []);

  const renderDoc = useCallback(
    ({ item }: { item: DocInfo }) => <DocRow doc={item} disabled={busy} />,
    [busy],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>{`Notes (${docs.length})`}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={pickAndUpload}
          disabled={busy}
          style={[styles.upload, busy && styles.disabled]}
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.uploadText}>Upload PDF / TXT / MD</Text>}
        </Pressable>

        {lastUpload ? (
          <Text style={styles.success}>
            {`✓ ${lastUpload.doc_name} · ${lastUpload.pages} page${lastUpload.pages === 1 ? "" : "s"} · ${lastUpload.chunks} chunk${lastUpload.chunks === 1 ? "" : "s"}`}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <FlatList
          data={docs}
          keyExtractor={docKey}
          renderItem={renderDoc}
          style={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No notes uploaded yet.</Text>}
        />

        {docs.length > 0 ? (
          <View style={styles.footer}>
            <Text style={styles.total}>{`${totalChunks} chunks indexed`}</Text>
            <Pressable onPress={confirmClear} disabled={busy} hitSlop={8} accessibilityRole="button">
              <Text style={styles.clear}>Clear all</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

function DocRow({ doc, disabled }: { doc: DocInfo; disabled: boolean }) {
  const onDelete = useCallback(() => void removeDoc(doc.doc_name), [doc.doc_name]);
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.docName} numberOfLines={1}>{doc.doc_name}</Text>
        <Text style={styles.docMeta}>{`${doc.chunks} chunk${doc.chunks === 1 ? "" : "s"}`}</Text>
      </View>
      <Pressable onPress={onDelete} disabled={disabled} style={styles.delete} accessibilityRole="button" accessibilityLabel={`Delete ${doc.doc_name}`}>
        <Text style={styles.deleteText}>Delete</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  done: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  upload: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 15, alignItems: "center" },
  disabled: { opacity: 0.6 },
  uploadText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  success: { color: colors.ok, marginTop: 12 },
  error: { color: "#FFB4B6", backgroundColor: colors.dangerBg, padding: 10, borderRadius: radius.sm, marginTop: 12 },
  list: { flex: 1, marginTop: 14 },
  empty: { color: colors.textDim, textAlign: "center", marginTop: 30 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, marginRight: 12 },
  docName: { color: colors.text, fontSize: 16 },
  docMeta: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  delete: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt },
  deleteText: { color: colors.danger, fontWeight: "600" },
  footer: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 14 },
  total: { color: colors.textDim },
  clear: { color: colors.danger, fontWeight: "700" },
});
