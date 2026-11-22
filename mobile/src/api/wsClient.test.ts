import {
  AskSocket,
  BACKOFF_MS,
  CANT_REACH,
  CONNECTION_LOST,
  HEARTBEAT_MS,
  PONG_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
  type ConnectionStatus,
  type ServerEvent,
  type WebSocketLike,
} from "./wsClient";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // --- test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSends(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const client = new AskSocket({
    url: "wss://example.test/ask?device_id=dev1",
    handlers: { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0, // no jitter: deterministic backoff
  });
  const latest = (): FakeSocket => sockets[sockets.length - 1];
  return { client, sockets, events, statuses, latest };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("AskSocket", () => {
  test("connects lazily with the device_id URL and reports status", () => {
    const { client, sockets, statuses, latest } = setup();
    expect(sockets).toHaveLength(0);
    client.start();
    expect(latest().url).toBe("wss://example.test/ask?device_id=dev1");
    expect(statuses).toEqual(["connecting"]);
    latest().open();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  test("ask before open is queued and flushed on open", () => {
    const { client, latest } = setup();
    client.start();
    client.ask("q1", "What is RR?");
    expect(latest().sent).toEqual([]);
    latest().open();
    expect(latest().sent).toEqual([{ type: "ask", id: "q1", question: "What is RR?" }]);
  });

  test("a queued ask that never gets a connection -> 'Can't reach server' after 8s", () => {
    const { client, events } = setup();
    client.start();
    client.ask("q1", "hi");
    jest.advanceTimersByTime(QUEUE_TIMEOUT_MS);
    expect(events).toContainEqual({ type: "error", id: "q1", message: CANT_REACH });
  });

  test("cancel of a queued ask removes it (never sent, no timeout error)", () => {
    const { client, events, latest } = setup();
    client.start();
    client.ask("q1", "hi");
    client.cancel("q1");
    latest().open();
    jest.advanceTimersByTime(QUEUE_TIMEOUT_MS);
    expect(latest().sent).toEqual([]);
    expect(events).toEqual([]);
  });

  test("reconnects with exponential backoff 0.5s, 1s, 2s, 4s, 8s, then stays at 8s", () => {
    const { client, sockets, latest } = setup();
    client.start();
    for (const delay of [...BACKOFF_MS, 8000]) {
      const before = sockets.length;
      latest().drop();
      jest.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(before); // not yet
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
    }
  });

  test("backoff resets after a successful open", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().drop();
    jest.advanceTimersByTime(BACKOFF_MS[0]);
    latest().drop();
    jest.advanceTimersByTime(BACKOFF_MS[1]);
    latest().open();
    const before = sockets.length;
    latest().drop();
    jest.advanceTimersByTime(BACKOFF_MS[0]);
    expect(sockets).toHaveLength(before + 1);
  });

  test("jitter is added on top of the base delay", () => {
    const sockets: FakeSocket[] = [];
    const client = new AskSocket({
      url: "wss://x/ask",
      handlers: { onEvent: () => undefined, onStatus: () => undefined },
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      random: () => 0.99,
    });
    client.start();
    sockets[0].drop();
    jest.advanceTimersByTime(BACKOFF_MS[0]);
    expect(sockets).toHaveLength(1); // 500ms + jitter not elapsed yet
    jest.advanceTimersByTime(BACKOFF_MS[0] * 0.25);
    expect(sockets).toHaveLength(2);
  });

  test("heartbeat: ping every 25s; a missing pong within 10s forces a reconnect", () => {
    const { client, sockets, statuses, latest } = setup();
    client.start();
    const first = latest();
    first.open();

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(first.sent).toContainEqual({ type: "ping" });
    first.serverSends({ type: "pong" }); // healthy
    jest.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(sockets).toHaveLength(1);

    jest.advanceTimersByTime(HEARTBEAT_MS - PONG_TIMEOUT_MS); // next ping; no pong this time
    jest.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(statuses[statuses.length - 1]).toBe("closed");
    expect(first.closed).toBe(true);
    jest.advanceTimersByTime(BACKOFF_MS[0]);
    expect(sockets).toHaveLength(2);
  });

  test("routes server events with their ids; ignores bad JSON and unknown types", () => {
    const { client, events, latest } = setup();
    client.start();
    latest().open();
    client.ask("q1", "x");
    const ws = latest();
    ws.serverSends({ type: "sources", id: "q1", sources: [{ n: 1, doc_name: "a.pdf", page: 2, snippet: "s" }] });
    ws.serverSends({ type: "token", id: "q1", text: "Hi" });
    ws.serverSends("{not json");
    ws.serverSends({ type: "mystery", id: "q1" });
    ws.serverSends({ type: "pong" });
    ws.serverSends({ type: "done", id: "q1", metrics: { retrieval_ms: 1, ttft_ms: 2, total_ms: 3, tokens: 1 } });
    expect(events.map((e) => [e.type, e.id])).toEqual([
      ["sources", "q1"],
      ["token", "q1"],
      ["done", "q1"],
    ]);
  });

  test("socket drops mid-answer -> 'Connection lost' error for the in-flight id only", () => {
    const { client, events, latest } = setup();
    client.start();
    latest().open();
    client.ask("finished", "a");
    latest().serverSends({ type: "done", id: "finished", metrics: {} });
    client.ask("live", "b");
    latest().serverSends({ type: "token", id: "live", text: "par" });
    latest().drop();
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", id: "live", message: CONNECTION_LOST }]);
  });

  test("a cancelled answer gets no 'Connection lost' when the socket drops", () => {
    const { client, events, latest } = setup();
    client.start();
    latest().open();
    client.ask("q1", "a");
    client.cancel("q1");
    expect(latest().sent).toContainEqual({ type: "cancel", id: "q1" });
    latest().drop();
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  test("stop() closes for good (no reconnect)", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    client.stop();
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  test("wake() skips the backoff wait; stale socket events are ignored", () => {
    const { client, sockets, latest } = setup();
    client.start();
    const first = latest();
    first.drop();
    first.drop(); // duplicate close from the old socket: ignored
    expect(sockets).toHaveLength(1);
    client.wake();
    expect(sockets).toHaveLength(2);
  });
});
