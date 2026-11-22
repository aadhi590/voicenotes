import type { Metrics, Source } from "../state/machine";

/** Server -> client events this app cares about (pong is handled internally). */
export type ServerEvent =
  | { type: "sources"; id: string; sources: Source[] }
  | { type: "token"; id: string; text: string }
  | { type: "done"; id: string; metrics: Metrics }
  | { type: "cancelled"; id: string }
  | { type: "error"; id: string | null; message: string };

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface AskSocketHandlers {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

/** The subset of the WebSocket API we use — lets tests inject a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface AskSocketOptions {
  url: string; // full URL incl. ?device_id=
  handlers: AskSocketHandlers;
  createSocket?: WebSocketFactory;
  random?: () => number; // jitter source (tests pass () => 0)
}

const CONNECTING = 0;
const OPEN = 1;
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export const MAX_BACKOFF_MS = 8000;
export const JITTER_RATIO = 0.25;
export const HEARTBEAT_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const QUEUE_TIMEOUT_MS = 8_000;
export const CANT_REACH = "Can't reach server";
export const CONNECTION_LOST = "Connection lost, tap retry";

interface QueuedAsk {
  id: string;
  question: string;
  timer: ReturnType<typeof setTimeout>;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/**
 * One long-lived /ask socket: lazy connect, exponential backoff + jitter reconnect,
 * ping/pong heartbeat, ask queue while disconnected, and an error for any answer that was
 * in flight when the connection dropped.
 */
export class AskSocket {
  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = "closed";
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: QueuedAsk[] = [];
  private readonly inFlight = new Set<string>();
  private readonly createSocket: WebSocketFactory;
  private readonly random: () => number;

  constructor(private readonly options: AskSocketOptions) {
    this.createSocket = options.createSocket ?? defaultFactory;
    this.random = options.random ?? Math.random;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.queue.forEach((q) => clearTimeout(q.timer));
    this.queue = [];
    this.inFlight.clear();
    this.teardown();
    this.setStatus("closed");
  }

  /** Reconnect immediately if we're waiting in backoff (e.g. app came back to the foreground). */
  wake(): void {
    if (this.stopped || this.status !== "closed") return;
    this.clearReconnect();
    this.attempt = 0;
    this.connect();
  }

  ask(id: string, question: string): void {
    if (this.status === "open" && this.ws) {
      this.sendAsk(id, question);
      return;
    }
    const timer = setTimeout(() => {
      this.queue = this.queue.filter((q) => q.id !== id);
      this.emit({ type: "error", id, message: CANT_REACH });
    }, QUEUE_TIMEOUT_MS);
    this.queue.push({ id, question, timer });
    this.wake();
  }

  cancel(id: string): void {
    this.inFlight.delete(id); // the user gave up on it: no "connection lost" error for it later
    const queued = this.queue.find((q) => q.id === id);
    if (queued) {
      clearTimeout(queued.timer);
      this.queue = this.queue.filter((q) => q.id !== id);
      return;
    }
    this.send({ type: "cancel", id });
  }

  // ------------------------------------------------------------------ internals

  private connect(): void {
    this.teardown();
    this.setStatus("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.options.url);
    } catch {
      this.handleClose(null);
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => undefined; // onclose always follows
  }

  private handleOpen(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.attempt = 0;
    this.setStatus("open");
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) {
      clearTimeout(q.timer);
      this.sendAsk(q.id, q.question);
    }
    this.heartbeatTimer = setInterval(() => this.ping(), HEARTBEAT_MS);
  }

  private handleMessage(data: unknown): void {
    let msg: unknown;
    try {
      msg = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return; // malformed frame: ignore
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : null;

    switch (m.type) {
      case "pong":
        this.clearPongTimer();
        return;
      case "sources":
        if (id && Array.isArray(m.sources)) this.emit({ type: "sources", id, sources: m.sources as Source[] });
        return;
      case "token":
        if (id && typeof m.text === "string") this.emit({ type: "token", id, text: m.text });
        return;
      case "done":
        if (id) {
          this.inFlight.delete(id);
          this.emit({ type: "done", id, metrics: (m.metrics ?? {}) as Metrics });
        }
        return;
      case "cancelled":
        if (id) {
          this.inFlight.delete(id);
          this.emit({ type: "cancelled", id });
        }
        return;
      case "error":
        if (id) this.inFlight.delete(id);
        this.emit({ type: "error", id, message: typeof m.message === "string" ? m.message : "Server error" });
        return;
      default:
        return; // unknown type: ignore
    }
  }

  private handleClose(ws: WebSocketLike | null): void {
    if (ws !== null && ws !== this.ws) return; // event from a socket we already replaced
    this.teardown();
    this.setStatus("closed");
    const lost = [...this.inFlight];
    this.inFlight.clear();
    lost.forEach((id) => this.emit({ type: "error", id, message: CONNECTION_LOST }));
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const base = Math.min(BACKOFF_MS[this.attempt] ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS);
    const delay = base + Math.floor(this.random() * JITTER_RATIO * base);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private ping(): void {
    if (this.pongTimer !== null) return;
    this.send({ type: "ping" });
    this.pongTimer = setTimeout(() => {
      // No pong: the proxy silently dropped us. Reconnect now instead of waiting for TCP to notice.
      this.pongTimer = null;
      this.handleClose(this.ws);
    }, PONG_TIMEOUT_MS);
  }

  private sendAsk(id: string, question: string): void {
    this.inFlight.add(id);
    this.send({ type: "ask", id, question });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      /* socket died between the check and the send; onclose handles it */
    }
  }

  private emit(event: ServerEvent): void {
    this.options.handlers.onEvent(event);
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.handlers.onStatus(status);
  }

  /** Detach and close the current socket (its late events are ignored). */
  private teardown(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearPongTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === OPEN || ws.readyState === CONNECTING) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
