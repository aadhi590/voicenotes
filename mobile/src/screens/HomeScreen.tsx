import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChatList } from "../components/ChatList";
import { Composer } from "../components/Composer";
import { NotesPanel, pickAndUpload } from "../components/NotesPanel";
import { PerfOverlay } from "../components/PerfOverlay";
import { SourceSheet } from "../components/SourceSheet";
import { ConnectionDot, StatePill } from "../components/StatusBar";
import { VoiceBar } from "../components/VoiceBar";
import { CONFIG_ERROR } from "../config";
import { useAssistant, useAssistantBootstrap } from "../hooks/useAssistant";
import { useSpeaker } from "../hooks/useSpeaker";
import type { Source } from "../state/machine";
import { useStore } from "../state/store";
import { colors, radius } from "../theme";

export function HomeScreen() {
  useAssistantBootstrap();
  const { status, busy, connection, messages, lastMetrics, ask, cancel, retry } = useAssistant();
  const docCount = useStore((s) => s.docs.length);
  const docsLoaded = useStore((s) => s.docsLoaded);
  const uploading = useStore((s) => s.docsBusy);
  const docsError = useStore((s) => s.docsError);
  const serverWarning = useStore((s) => s.serverWarning);
  const sttMs = useStore((s) => s.lastSttMs);
  const { autoSpeak, setAutoSpeak } = useSpeaker();

  const [notesOpen, setNotesOpen] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [perf, setPerf] = useState(false);

  const openNotes = useCallback(() => setNotesOpen(true), []);
  const closeNotes = useCallback(() => setNotesOpen(false), []);
  const closeSource = useCallback(() => setSource(null), []);
  const toggleSpeak = useCallback(() => setAutoSpeak(!autoSpeak), [autoSpeak, setAutoSpeak]);
  const togglePerf = useCallback(() => {
    if (__DEV__) setPerf((p) => !p);
  }, []);

  const showEmpty = docsLoaded && docCount === 0 && messages.length === 0 && !CONFIG_ERROR;
  const banner = CONFIG_ERROR ?? serverWarning;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onLongPress={togglePerf} delayLongPress={600}>
          <Text style={styles.title}>VoiceNotes</Text>
        </Pressable>
        <ConnectionDot status={connection} />
        <StatePill status={status} />
        <View style={styles.spacer} />
        <Pressable
          onPress={toggleSpeak}
          style={[styles.notesBtn, !autoSpeak && styles.speakOff]}
          accessibilityRole="switch"
          accessibilityState={{ checked: autoSpeak }}
          accessibilityLabel="Auto-speak answers"
        >
          <Text style={styles.notesText}>{autoSpeak ? "🔊 Auto-speak" : "🔇 Muted"}</Text>
        </Pressable>
        <Pressable onPress={openNotes} style={styles.notesBtn} accessibilityRole="button">
          <Text style={styles.notesText}>{`Notes (${docCount})`}</Text>
        </Pressable>
      </View>

      {banner ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      ) : null}

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        {perf ? <PerfOverlay metrics={lastMetrics} sttMs={sttMs} /> : null}
        {showEmpty ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Upload your notes to start asking questions</Text>
            <Text style={styles.emptySub}>PDF, TXT or Markdown. Answers cite the page they came from.</Text>
            <Pressable onPress={pickAndUpload} disabled={uploading} style={[styles.bigUpload, uploading && styles.dim]} accessibilityRole="button">
              <Text style={styles.bigUploadText}>{uploading ? "Uploading…" : "Upload notes"}</Text>
            </Pressable>
            {docsError ? <Text style={styles.emptyError}>{docsError}</Text> : null}
          </View>
        ) : (
          <ChatList messages={messages} onSourcePress={setSource} onRetry={retry} />
        )}
        <VoiceBar disabled={!!CONFIG_ERROR} />
        <Composer busy={busy} disabled={!!CONFIG_ERROR} onSend={ask} onStop={cancel} />
      </KeyboardAvoidingView>

      <NotesPanel visible={notesOpen} onClose={closeNotes} />
      <SourceSheet source={source} onClose={closeSource} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "800" },
  spacer: { flex: 1 },
  notesBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt },
  notesText: { color: colors.text, fontWeight: "600" },
  speakOff: { opacity: 0.6 },
  banner: { backgroundColor: colors.danger, paddingHorizontal: 14, paddingVertical: 10 },
  bannerText: { color: "#fff", fontWeight: "600" },
  body: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, textAlign: "center", marginTop: 8, lineHeight: 20 },
  bigUpload: { marginTop: 24, backgroundColor: colors.accent, paddingHorizontal: 32, paddingVertical: 16, borderRadius: radius.lg },
  dim: { opacity: 0.6 },
  bigUploadText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  emptyError: { color: "#FFB4B6", marginTop: 16, textAlign: "center" },
});
