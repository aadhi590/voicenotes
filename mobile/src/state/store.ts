import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { create } from "zustand";

import * as api from "../api/http";
import type { DocInfo, PickedFile, UploadResult } from "../api/http";
import { AskSocket, type ConnectionStatus, type ServerEvent } from "../api/wsClient";
import { CONFIG_ERROR, MAX_QUESTION_CHARS, WS_URL } from "../config";
import { TokenBuffer } from "../hooks/useTokenBuffer";
import { isUselessTranscript } from "../voice/silence";
import { Speaker } from "../voice/speaker";
import { getDeviceId } from "./deviceId";
import { type MachineEvent, type MachineState, type Metrics, type Source, initialMachineState, isBusy, reducer } from "./machine";

export type MessageRole = "user" | "assistant" | "error";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  sources: Source[];
  metrics?: Metrics;
  cancelled?: boolean;
  retryQuestion?: string; // error bubbles: the question to re-ask
}

export interface AppState {
  deviceId: string | null;
  connection: ConnectionStatus;
  machine: MachineState;
  messages: ChatMessage[];
  docs: DocInfo[];
  totalChunks: number;
  docsLoaded: boolean;
  docsBusy: boolean;
  docsError: string | null;
  lastUpload: UploadResult | null;
  serverWarning: string | null;
  // voice
  speaking: boolean; // TTS is playing (can outlast the stream)
  autoSpeak: boolean;
  voiceHint: string | null; // "Didn't catch that", mic/STT problems
  lastSttMs: number | null;
}

export const useStore = create<AppState>(() => ({
  deviceId: null,
  connection: "closed",
  machine: initialMachineState,
  messages: [],
  docs: [],
  totalChunks: 0,
  docsLoaded: false,
  docsBusy: false,
  docsError: null,
  lastUpload: null,
  serverWarning: null,
  speaking: false,
  autoSpeak: true,
  voiceHint: null,
  lastSttMs: null,
}));

/** The one TTS speaker. Tied to the active question id: old-id sentences are dropped. */
export const speaker = new Speaker((speaking) => useStore.setState({ speaking }));
const AUTO_SPEAK_KEY = "voicenotes.autoSpeak";
let sttGeneration = 0; // bumps on every new recording / typed ask: stale transcripts are dropped

/** The streaming answer's text. Only StreamingBubble subscribes to it. */
export const streamBuffer = new TokenBuffer();

let socket: AskSocket | null = null; // the one instance

const EMPTY: Source[] = [];

function dispatch(event: MachineEvent, extra: Partial<AppState> = {}): void {
  useStore.setState((s) => {
    const machine = reducer(s.machine, event);
    if (machine === s.machine && Object.keys(extra).length === 0) return s; // no re-render
    return { machine, ...extra };
  });
}

const withMessage = (message: ChatMessage): Partial<AppState> => ({
  messages: [...useStore.getState().messages, message],
});

/** Move whatever streamed so far into the history as a cancelled answer, and clear the buffer. */
function archivePartial(id: string, sources: Source[]): Partial<AppState> {
  const text = streamBuffer.finish();
  streamBuffer.reset();
  if (!text.trim()) return {};
  return withMessage({ id: `${id}-partial`, role: "assistant", text, sources, cancelled: true });
}

function onServerEvent(event: ServerEvent): void {
  const { machine } = useStore.getState();
  const active = isBusy(machine.status) && event.id !== null && event.id === machine.activeId;

  switch (event.type) {
    case "sources":
      dispatch({ type: "SOURCES", id: event.id, sources: event.sources });
      return;
    case "token":
      if (!active) return; // stale id (cancelled / barged-in): drop
      streamBuffer.append(event.text);
      speaker.feed(event.id, event.text); // no-op unless auto-speak began this id
      dispatch({ type: "TOKEN", id: event.id }); // no-op object after the first token
      return;
    case "done": {
      if (!active) return;
      const text = streamBuffer.finish();
      streamBuffer.reset();
      speaker.finish(event.id); // speak the last partial sentence
      const message: ChatMessage = { id: event.id, role: "assistant", text, sources: machine.sources, metrics: event.metrics };
      dispatch({ type: "DONE", id: event.id, metrics: event.metrics }, withMessage(message));
      return;
    }
    case "cancelled":
      dispatch({ type: "CANCELLED", id: event.id });
      return;
    case "error": {
      const relevant = event.id === null ? isBusy(machine.status) : active;
      if (!relevant) return;
      speaker.stop();
      const partial = archivePartial(event.id ?? "conn", machine.sources);
      const next = reducer(machine, { type: "ERROR", id: event.id, message: event.message });
      const errorMessage: ChatMessage = {
        id: `${event.id ?? "conn"}-error-${Date.now()}`,
        role: "error",
        text: next.error ?? event.message,
        sources: EMPTY,
        retryQuestion: machine.question ?? undefined,
      };
      useStore.setState((s) => ({ machine: next, messages: [...(partial.messages ?? s.messages), errorMessage] }));
      return;
    }
  }
}

// ---------------------------------------------------------------- actions

export async function bootstrap(): Promise<void> {
  const deviceId = await getDeviceId();
  useStore.setState({ deviceId });
  AsyncStorage.getItem(AUTO_SPEAK_KEY)
    .then((v) => v !== null && useStore.setState({ autoSpeak: v === "1" }))
    .catch(() => undefined);
  if (CONFIG_ERROR || !WS_URL) return;
  if (!socket) {
    socket = new AskSocket({
      url: `${WS_URL}?device_id=${encodeURIComponent(deviceId)}`,
      handlers: {
        onEvent: onServerEvent,
        onStatus: (connection) => useStore.setState({ connection }),
      },
    });
  }
  socket.start();
  void refreshDocs();
  api
    .health()
    .then((h) => useStore.setState({ serverWarning: h.groq_configured ? null : "Server is missing its Groq API key." }))
    .catch(() => undefined); // connectivity is shown by the socket dot
}

export function wakeConnection(): void {
  socket?.wake();
}

export function askQuestion(rawText: string): void {
  const question = rawText.trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) return;
  const { machine, autoSpeak } = useStore.getState();
  const id = Crypto.randomUUID();
  sttGeneration += 1; // a typed question supersedes any transcript still in flight

  // Barge-in order: (a) stop TTS + clear its queue, (b) cancel the active WS question, (c) ask.
  speaker.stop();
  let extra: Partial<AppState> = {};
  if (isBusy(machine.status) && machine.activeId) {
    socket?.cancel(machine.activeId); // barge-in
    extra = archivePartial(machine.activeId, machine.sources);
  } else {
    streamBuffer.reset();
  }
  const base = extra.messages ?? useStore.getState().messages;
  const userMessage: ChatMessage = { id: `${id}-q`, role: "user", text: question, sources: EMPTY };
  dispatch({ type: "ASK", id, question }, { messages: [...base, userMessage], voiceHint: null });
  if (autoSpeak) speaker.begin(id);

  if (!socket) {
    onServerEvent({ type: "error", id, message: CONFIG_ERROR ?? "Not connected yet" });
    return;
  }
  socket.ask(id, question);
}

/** Stop button / barge-in: silence TTS first, then cancel the in-flight answer (if any). */
export function cancelAnswer(): void {
  speaker.stop();
  const { machine } = useStore.getState();
  if (!isBusy(machine.status) || !machine.activeId) return;
  socket?.cancel(machine.activeId);
  dispatch({ type: "CANCEL" }, archivePartial(machine.activeId, machine.sources));
}

export function setAutoSpeak(on: boolean): void {
  useStore.setState({ autoSpeak: on });
  if (!on) speaker.stop();
  AsyncStorage.setItem(AUTO_SPEAK_KEY, on ? "1" : "0").catch(() => undefined);
}

// ---------------------------------------------------------------- voice

export const DIDNT_CATCH = "Didn't catch that";

/** Mic tapped: interrupt whatever is happening (TTS, answer) and enter recording. */
export function beginRecording(): void {
  cancelAnswer(); // (a) Speech.stop + clear queue, (b) cancel WS question
  sttGeneration += 1;
  dispatch({ type: "RESET" }); // error -> idle so START_RECORDING applies
  dispatch({ type: "START_RECORDING" }, { voiceHint: null });
}

/** Recording was discarded (silence, too short, mic problem): back to idle with a hint. */
export function abandonRecording(hint: string | null): void {
  sttGeneration += 1;
  const { status } = useStore.getState().machine;
  if (status === "recording" || status === "transcribing") dispatch({ type: "RESET" }, { voiceHint: hint });
  else useStore.setState({ voiceHint: hint });
}

function deleteQuietly(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* temp cache file */
  }
}

/** Recording finished: /stt, drop useless transcripts, then ask (shows the transcript as the user bubble). */
export async function transcribeAndAsk(uri: string, peakDb: number): Promise<void> {
  const generation = ++sttGeneration;
  dispatch({ type: "STOP_RECORDING" }); // -> transcribing
  const { deviceId } = useStore.getState();
  let text = "";
  try {
    if (!deviceId) throw new Error("Not ready yet");
    const result = await api.transcribeAudio(deviceId, uri);
    text = result.text.trim();
    useStore.setState({ lastSttMs: result.ms });
  } catch (err) {
    if (generation === sttGeneration) abandonRecording(err instanceof Error ? err.message : "Transcription failed");
    return;
  } finally {
    deleteQuietly(uri);
  }
  // Superseded (typed question, new recording) while we were waiting: drop it.
  if (generation !== sttGeneration || useStore.getState().machine.status !== "transcribing") return;
  if (isUselessTranscript(text, peakDb)) {
    abandonRecording(DIDNT_CATCH);
    return;
  }
  dispatch({ type: "TRANSCRIBED", text });
  askQuestion(text);
}

// ---------------------------------------------------------------- notes

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export async function refreshDocs(): Promise<void> {
  const { deviceId } = useStore.getState();
  if (!deviceId || CONFIG_ERROR) return;
  try {
    const list = await api.listDocs(deviceId);
    // Server storage is in-memory: its answer is the truth, even if it's suddenly empty.
    useStore.setState({ docs: list.docs, totalChunks: list.total_chunks, docsLoaded: true, docsError: null });
  } catch (err) {
    useStore.setState({ docsLoaded: true, docsError: messageOf(err) });
  }
}

export async function uploadFile(file: PickedFile): Promise<boolean> {
  const { deviceId } = useStore.getState();
  if (!deviceId) return false;
  useStore.setState({ docsBusy: true, docsError: null, lastUpload: null });
  try {
    const result = await api.uploadDoc(deviceId, file);
    useStore.setState({ lastUpload: result });
    await refreshDocs();
    return true;
  } catch (err) {
    useStore.setState({ docsError: messageOf(err) });
    return false;
  } finally {
    useStore.setState({ docsBusy: false });
  }
}

export async function removeDoc(docName: string): Promise<void> {
  const { deviceId } = useStore.getState();
  if (!deviceId) return;
  useStore.setState({ docsBusy: true, docsError: null });
  try {
    await api.deleteDoc(deviceId, docName);
  } catch (err) {
    useStore.setState({ docsError: messageOf(err) });
  } finally {
    await refreshDocs();
    useStore.setState({ docsBusy: false });
  }
}

export async function clearAllDocs(): Promise<void> {
  const { deviceId } = useStore.getState();
  if (!deviceId) return;
  useStore.setState({ docsBusy: true, docsError: null, lastUpload: null });
  try {
    await api.clearDocs(deviceId);
  } catch (err) {
    useStore.setState({ docsError: messageOf(err) });
  } finally {
    await refreshDocs();
    useStore.setState({ docsBusy: false });
  }
}
