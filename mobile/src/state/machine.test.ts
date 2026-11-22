import { BUSY_MESSAGE, type MachineEvent, type MachineState, initialMachineState, reducer } from "./machine";

const metrics = { retrieval_ms: 1, ttft_ms: 200, total_ms: 400, tokens: 12 };
const src = [{ n: 1, doc_name: "os.pdf", page: 2, snippet: "time quantum" }];

const run = (events: MachineEvent[], from: MachineState = initialMachineState): MachineState =>
  events.reduce(reducer, from);

describe("assistant state machine", () => {
  test("happy path: idle -ASK-> thinking -SOURCES-> thinking -TOKEN-> streaming -DONE-> idle", () => {
    let s = reducer(initialMachineState, { type: "ASK", id: "a", question: "q?" });
    expect(s).toMatchObject({ status: "thinking", activeId: "a", question: "q?", sources: [] });

    s = reducer(s, { type: "SOURCES", id: "a", sources: src });
    expect(s).toMatchObject({ status: "thinking", sources: src });

    s = reducer(s, { type: "TOKEN", id: "a" });
    expect(s.status).toBe("streaming");

    s = reducer(s, { type: "DONE", id: "a", metrics });
    expect(s).toMatchObject({ status: "idle", activeId: null, lastMetrics: metrics });
  });

  test("TOKEN while already streaming returns the same object (no re-render per token)", () => {
    const streaming = run([{ type: "ASK", id: "a", question: "q" }, { type: "TOKEN", id: "a" }]);
    expect(reducer(streaming, { type: "TOKEN", id: "a" })).toBe(streaming);
  });

  test("DONE straight from thinking (no tokens) goes idle", () => {
    const s = run([{ type: "ASK", id: "a", question: "q" }, { type: "DONE", id: "a", metrics }]);
    expect(s.status).toBe("idle");
  });

  test.each(["thinking", "streaming"] as const)("CANCEL from %s is immediate and optimistic", (phase) => {
    const events: MachineEvent[] = [{ type: "ASK", id: "a", question: "q" }];
    if (phase === "streaming") events.push({ type: "TOKEN", id: "a" });
    const s = run([...events, { type: "CANCEL" }]);
    expect(s).toMatchObject({ status: "idle", activeId: null });
  });

  test("cancel then late events for that id are ignored", () => {
    const cancelled = run([
      { type: "ASK", id: "a", question: "q" },
      { type: "TOKEN", id: "a" },
      { type: "CANCEL" },
    ]);
    const late: MachineEvent[] = [
      { type: "TOKEN", id: "a" },
      { type: "SOURCES", id: "a", sources: src },
      { type: "DONE", id: "a", metrics },
      { type: "CANCELLED", id: "a" },
      { type: "ERROR", id: "a", message: "late" },
    ];
    for (const event of late) expect(reducer(cancelled, event)).toBe(cancelled);
  });

  test("CANCEL when idle is a no-op", () => {
    expect(reducer(initialMachineState, { type: "CANCEL" })).toBe(initialMachineState);
  });

  test("barge-in: ASK while streaming switches to the new id and drops the old id's events", () => {
    let s = run([{ type: "ASK", id: "a", question: "first" }, { type: "TOKEN", id: "a" }]);
    s = reducer(s, { type: "ASK", id: "b", question: "second" });
    expect(s).toMatchObject({ status: "thinking", activeId: "b", question: "second", sources: [] });

    expect(reducer(s, { type: "TOKEN", id: "a" })).toBe(s);
    expect(reducer(s, { type: "DONE", id: "a", metrics })).toBe(s);
    expect(reducer(s, { type: "SOURCES", id: "a", sources: src })).toBe(s);

    s = run([{ type: "TOKEN", id: "b" }, { type: "DONE", id: "b", metrics }], s);
    expect(s.status).toBe("idle");
  });

  test("barge-in also works from thinking", () => {
    const s = run([{ type: "ASK", id: "a", question: "1" }, { type: "ASK", id: "b", question: "2" }]);
    expect(s).toMatchObject({ status: "thinking", activeId: "b" });
  });

  test("stale-id events never move the machine", () => {
    const s = run([{ type: "ASK", id: "a", question: "q" }]);
    expect(reducer(s, { type: "TOKEN", id: "zzz" })).toBe(s);
    expect(reducer(s, { type: "DONE", id: "zzz", metrics })).toBe(s);
    expect(reducer(s, { type: "ERROR", id: "zzz", message: "x" })).toBe(s);
  });

  test("ERROR for the active id -> error; a null-id error applies too", () => {
    const thinking = run([{ type: "ASK", id: "a", question: "q" }]);
    expect(reducer(thinking, { type: "ERROR", id: "a", message: "boom" })).toMatchObject({
      status: "error",
      activeId: null,
      error: "boom",
      question: "q", // kept for Retry
    });
    expect(reducer(thinking, { type: "ERROR", id: null, message: "conn" }).status).toBe("error");
  });

  test("rate-limit errors become the friendly busy message", () => {
    const s = run([
      { type: "ASK", id: "a", question: "q" },
      { type: "ERROR", id: "a", message: "The AI service is busy (rate limit reached). Please try again." },
    ]);
    expect(s.error).toBe(BUSY_MESSAGE);
  });

  test("error -> RESET -> idle, and error -> ASK -> thinking", () => {
    const err = run([{ type: "ASK", id: "a", question: "q" }, { type: "ERROR", id: "a", message: "x" }]);
    expect(reducer(err, { type: "RESET" })).toMatchObject({ status: "idle", error: null });
    expect(reducer(err, { type: "ASK", id: "b", question: "again" })).toMatchObject({ status: "thinking", activeId: "b", error: null });
  });

  test("full voice loop: idle -> recording -> transcribing -> (TRANSCRIBED) -> thinking -> streaming -> idle", () => {
    let s = run([{ type: "START_RECORDING" }, { type: "STOP_RECORDING" }]);
    expect(s.status).toBe("transcribing");
    s = run([{ type: "TRANSCRIBED", text: "what is rr" }, { type: "ASK", id: "v1", question: "what is rr" }], s);
    expect(s).toMatchObject({ status: "thinking", activeId: "v1" });
    s = run([{ type: "TOKEN", id: "v1" }, { type: "DONE", id: "v1", metrics }], s);
    expect(s.status).toBe("idle");
  });

  test("voice barge-in: CANCEL then START_RECORDING; the old answer's late events are dropped", () => {
    const streaming = run([{ type: "ASK", id: "old", question: "q" }, { type: "TOKEN", id: "old" }]);
    // START_RECORDING alone is refused mid-answer: the store must cancel first.
    expect(reducer(streaming, { type: "START_RECORDING" })).toBe(streaming);
    const recording = run([{ type: "CANCEL" }, { type: "START_RECORDING" }], streaming);
    expect(recording).toMatchObject({ status: "recording", activeId: null });
    for (const late of [
      { type: "TOKEN", id: "old" },
      { type: "DONE", id: "old", metrics },
      { type: "ERROR", id: "old", message: "x" },
    ] as MachineEvent[]) {
      expect(reducer(recording, late)).toBe(recording);
    }
  });

  test("discarded recording / failed STT: RESET from recording or transcribing -> idle", () => {
    expect(run([{ type: "START_RECORDING" }, { type: "RESET" }]).status).toBe("idle");
    expect(run([{ type: "START_RECORDING" }, { type: "STOP_RECORDING" }, { type: "RESET" }]).status).toBe("idle");
  });

  test("typed ASK while transcribing supersedes the voice turn; a late TRANSCRIBED is ignored", () => {
    const s = run([{ type: "START_RECORDING" }, { type: "STOP_RECORDING" }, { type: "ASK", id: "t", question: "typed" }]);
    expect(s).toMatchObject({ status: "thinking", activeId: "t" });
    expect(reducer(s, { type: "TRANSCRIBED", text: "late" })).toBe(s);
  });

  test("voice states exist: idle -> recording -> transcribing -> idle", () => {
    const s1 = reducer(initialMachineState, { type: "START_RECORDING" });
    expect(s1.status).toBe("recording");
    const s2 = reducer(s1, { type: "STOP_RECORDING" });
    expect(s2.status).toBe("transcribing");
    expect(reducer(s2, { type: "TRANSCRIBED", text: "hi" }).status).toBe("idle");
    const busy = reducer(initialMachineState, { type: "ASK", id: "a", question: "q" });
    expect(reducer(busy, { type: "START_RECORDING" })).toBe(busy); // not mid-answer
  });
});
