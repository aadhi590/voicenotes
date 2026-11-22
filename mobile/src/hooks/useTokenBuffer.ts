import { useSyncExternalStore } from "react";

export const FLUSH_INTERVAL_MS = 50;

/**
 * Accumulates streamed tokens in a plain string (no React state) and publishes the text to
 * subscribers at most once per FLUSH_INTERVAL_MS. The first token after a quiet period is
 * published immediately (leading edge) so time-to-first-token isn't delayed by the throttle.
 *
 * Only components that subscribe (the StreamingBubble) re-render on a flush.
 */
export class TokenBuffer {
  private pending = "";
  private published = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  /** Total publishes since creation (read by the dev perf overlay). */
  flushCount = 0;

  constructor(private readonly intervalMs: number = FLUSH_INTERVAL_MS) {}

  append(token: string): void {
    if (!token) return;
    this.pending += token;
    if (this.timer === null) {
      this.publish(); // leading edge
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
  }

  /** Final flush (DONE / CANCEL). Returns the complete text. */
  finish(): string {
    this.stopTimer();
    this.publish();
    return this.published;
  }

  /** Clear everything (new question / after the answer moved into the message list). */
  reset(): void {
    this.stopTimer();
    this.pending = "";
    this.publish();
  }

  getSnapshot = (): string => this.published;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private tick(): void {
    // Nothing new for a whole interval: stop ticking; the next token restarts with a leading flush.
    if (this.pending === this.published) this.stopTimer();
    else this.publish();
  }

  private publish(): void {
    if (this.pending === this.published) return; // only notify when the text actually changed
    this.published = this.pending;
    this.flushCount += 1;
    this.listeners.forEach((listener) => listener());
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Subscribe a component to a TokenBuffer's throttled text. */
export function useTokenBuffer(buffer: TokenBuffer): string {
  return useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot);
}
