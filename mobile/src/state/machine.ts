/**
 * Assistant state machine: a pure reducer. No I/O, no timers — side effects (socket sends,
 * token buffering) live in the store. Every server event carries an id; events whose id is
 * not the active one are dropped, which is what makes cancel and barge-in clean.
 */

export type AssistantStatus = "idle" | "recording" | "transcribing" | "thinking" | "streaming" | "error";

export interface Source {
  n: number;
  doc_name: string;
  page: number;
  snippet: string;
}

export interface Metrics {
  retrieval_ms: number;
  ttft_ms: number | null;
  total_ms: number;
  tokens: number;
}

export interface MachineState {
  status: AssistantStatus;
  activeId: string | null;
  question: string | null; // question of the active (or last failed) request, for Retry
  sources: Source[];
  error: string | null;
  lastMetrics: Metrics | null;
}

export type MachineEvent =
  | { type: "ASK"; id: string; question: string }
  | { type: "SOURCES"; id: string; sources: Source[] }
  | { type: "TOKEN"; id: string }
  | { type: "DONE"; id: string; metrics: Metrics }
  | { type: "CANCEL" }
  | { type: "CANCELLED"; id: string }
  | { type: "ERROR"; id: string | null; message: string }
  | { type: "RESET" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "TRANSCRIBED"; text: string };

export const initialMachineState: MachineState = {
  status: "idle",
  activeId: null,
  question: null,
  sources: [],
  error: null,
  lastMetrics: null,
};

export const BUSY_MESSAGE = "Busy, retry in a few seconds";

export function isBusy(status: AssistantStatus): boolean {
  return status === "thinking" || status === "streaming";
}

/** Map raw server/client errors to what the user should read. */
export function friendlyError(message: string): string {
  return /rate limit/i.test(message) ? BUSY_MESSAGE : message;
}

const isActive = (state: MachineState, id: string): boolean => isBusy(state.status) && state.activeId === id;

export function reducer(state: MachineState, event: MachineEvent): MachineState {
  switch (event.type) {
    case "ASK":
      // From any state. If a question is in flight this is barge-in: the store cancels the old
      // id on the socket; here we just switch activeId so the old id's late events are dropped.
      return { ...state, status: "thinking", activeId: event.id, question: event.question, sources: [], error: null };

    case "SOURCES":
      return isActive(state, event.id) ? { ...state, sources: event.sources } : state;

    case "TOKEN":
      if (!isActive(state, event.id)) return state;
      // Same object when already streaming: subscribers selecting `status` don't re-render per token.
      return state.status === "streaming" ? state : { ...state, status: "streaming" };

    case "DONE":
      return isActive(state, event.id)
        ? { ...state, status: "idle", activeId: null, lastMetrics: event.metrics }
        : state;

    case "CANCEL": // optimistic: the user is done with this answer right now
      return isBusy(state.status) ? { ...state, status: "idle", activeId: null } : state;

    case "CANCELLED": // server-confirmed cancel; after an optimistic CANCEL this id is no longer active
      return isActive(state, event.id) ? { ...state, status: "idle", activeId: null } : state;

    case "ERROR":
      // id === null: connection/protocol level error -> applies to whatever is happening.
      if (event.id !== null && event.id !== state.activeId) return state;
      return { ...state, status: "error", activeId: null, error: friendlyError(event.message) };

    case "RESET":
      return { ...state, status: "idle", activeId: null, error: null };

    // Voice (next phase): idle/error -> recording -> transcribing -> idle (then the store ASKs).
    case "START_RECORDING":
      return state.status === "idle" || state.status === "error"
        ? { ...state, status: "recording", activeId: null, error: null }
        : state;

    case "STOP_RECORDING":
      return state.status === "recording" ? { ...state, status: "transcribing" } : state;

    case "TRANSCRIBED":
      return state.status === "transcribing" ? { ...state, status: "idle" } : state;

    default:
      return state;
  }
}
