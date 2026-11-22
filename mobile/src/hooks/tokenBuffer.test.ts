import { act, renderHook } from "@testing-library/react-native";

import { FLUSH_INTERVAL_MS, TokenBuffer, useTokenBuffer } from "./useTokenBuffer";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const TOKENS = 200;
const DURATION_MS = 1000;
const STEP_MS = DURATION_MS / TOKENS; // a token every 5 ms
const MAX_UPDATES = DURATION_MS / FLUSH_INTERVAL_MS + 1; // 20 throttled + 1 leading

function stream(buffer: TokenBuffer): string {
  let expected = "";
  for (let i = 0; i < TOKENS; i += 1) {
    const token = `t${i} `;
    expected += token;
    buffer.append(token);
    jest.advanceTimersByTime(STEP_MS);
  }
  return expected;
}

describe("TokenBuffer", () => {
  test("200 tokens in 1s -> <= ~20 publishes, exact final text", () => {
    const buffer = new TokenBuffer();
    const listener = jest.fn();
    buffer.subscribe(listener);

    const expected = stream(buffer);
    const final = buffer.finish();

    expect(final).toBe(expected);
    expect(buffer.getSnapshot()).toBe(expected);
    expect(listener.mock.calls.length).toBeLessThanOrEqual(MAX_UPDATES + 1); // + the final flush
    expect(listener.mock.calls.length).toBeGreaterThan(5); // it really streams, not one dump
  });

  test("first token is published immediately (leading edge), then throttled", () => {
    const buffer = new TokenBuffer();
    buffer.append("Hello");
    expect(buffer.getSnapshot()).toBe("Hello");
    buffer.append(" world");
    expect(buffer.getSnapshot()).toBe("Hello"); // waits for the interval
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(buffer.getSnapshot()).toBe("Hello world");
  });

  test("no publish when nothing changed; the timer stops when idle", () => {
    const buffer = new TokenBuffer();
    const listener = jest.fn();
    buffer.subscribe(listener);
    buffer.append("a");
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 10);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("reset clears the text and notifies once", () => {
    const buffer = new TokenBuffer();
    buffer.append("abc");
    const listener = jest.fn();
    buffer.subscribe(listener);
    buffer.reset();
    expect(buffer.getSnapshot()).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
    buffer.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("useTokenBuffer (React)", () => {
  // @testing-library/react-native v14: renderHook and act are async.
  test("200 tokens in 1s cause <= ~20 re-renders and the final text is exact", async () => {
    const buffer = new TokenBuffer();
    let renders = 0;
    const { result } = await renderHook(() => {
      renders += 1;
      return useTokenBuffer(buffer);
    });
    const initialRenders = renders;

    let expected = "";
    await act(async () => {
      expected = stream(buffer);
      buffer.finish();
    });

    expect(result.current).toBe(expected);
    expect(renders - initialRenders).toBeLessThanOrEqual(MAX_UPDATES + 1);
  });
});
