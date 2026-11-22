import * as Crypto from "expo-crypto";
import { create } from "zustand";

import * as api from "../api/http";
import type { DocInfo, PickedFile, UploadResult } from "../api/http";
import { AskSocket, type ConnectionStatus, type ServerEvent } from "../api/wsClient";
import { CONFIG_ERROR, MAX_QUESTION_CHARS, WS_URL } from "../config";
import { TokenBuffer } from "../hooks/useTokenBuffer";
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
}));

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
      dispatch({ type: "TOKEN", id: event.id }); // no-op object after the first token
      return;
    case "done": {
      if (!active) return;
      const text = streamBuffer.finish();
      streamBuffer.reset();
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
  const { machine } = useStore.getState();
  const id = Crypto.randomUUID();

  let extra: Partial<AppState> = {};
  if (isBusy(machine.status) && machine.activeId) {
    socket?.cancel(machine.activeId); // barge-in
    extra = archivePartial(machine.activeId, machine.sources);
  } else {
    streamBuffer.reset();
  }
  const base = extra.messages ?? useStore.getState().messages;
  const userMessage: ChatMessage = { id: `${id}-q`, role: "user", text: question, sources: EMPTY };
  dispatch({ type: "ASK", id, question }, { messages: [...base, userMessage] });

  if (!socket) {
    onServerEvent({ type: "error", id, message: CONFIG_ERROR ?? "Not connected yet" });
    return;
  }
  socket.ask(id, question);
}

export function cancelAnswer(): void {
  const { machine } = useStore.getState();
  if (!isBusy(machine.status) || !machine.activeId) return;
  socket?.cancel(machine.activeId);
  dispatch({ type: "CANCEL" }, archivePartial(machine.activeId, machine.sources));
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
