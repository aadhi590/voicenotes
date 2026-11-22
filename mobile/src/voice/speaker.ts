import * as Speech from "expo-speech";

import { SentenceSplitter, stripCitations } from "./sentences";

export interface SpeechEngine {
  speak(text: string, options: { language: string; onDone: () => void; onStopped: () => void; onError: () => void }): void;
  stop(): void;
}

const expoEngine: SpeechEngine = {
  speak: (text, options) => Speech.speak(text, options),
  stop: () => {
    void Speech.stop();
  },
};

/**
 * One TTS speaker, tied to a question id. Sentences are spoken in order; anything fed for an id
 * other than the active one is dropped, so after barge-in no late sentence from the old answer
 * is ever spoken. A generation counter ignores callbacks from utterances that were stopped.
 */
export class Speaker {
  private activeId: string | null = null;
  private queue: string[] = [];
  private speaking = false;
  private generation = 0;
  private readonly splitter = new SentenceSplitter();

  constructor(
    private readonly onSpeakingChange: (speaking: boolean) => void,
    private readonly engine: SpeechEngine = expoEngine,
  ) {}

  /** Start a new answer: stops anything playing and forgets the previous id. */
  begin(id: string): void {
    this.stop();
    this.activeId = id;
  }

  /** Streamed text for `id`; complete sentences are queued. */
  feed(id: string, text: string): void {
    if (id !== this.activeId) return;
    this.splitter.push(text).forEach((s) => this.enqueue(s));
  }

  /** The answer finished: speak the remainder. */
  finish(id: string): void {
    if (id !== this.activeId) return;
    const rest = this.splitter.flush();
    if (rest) this.enqueue(rest);
  }

  /** Barge-in / stop: silence immediately and drop everything queued. */
  stop(): void {
    this.generation += 1;
    this.activeId = null;
    this.queue = [];
    this.splitter.reset();
    const wasSpeaking = this.speaking;
    this.setSpeaking(false);
    if (wasSpeaking) this.engine.stop();
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  private enqueue(sentence: string): void {
    const clean = stripCitations(sentence);
    if (!clean) return;
    this.queue.push(clean);
    if (!this.speaking) this.next();
  }

  private next(): void {
    const sentence = this.queue.shift();
    if (sentence === undefined) {
      this.setSpeaking(false);
      return;
    }
    this.setSpeaking(true);
    const gen = this.generation;
    const advance = (): void => {
      if (gen === this.generation) this.next();
    };
    this.engine.speak(sentence, { language: "en", onDone: advance, onStopped: advance, onError: advance });
  }

  private setSpeaking(value: boolean): void {
    if (value === this.speaking) return;
    this.speaking = value;
    this.onSpeakingChange(value);
  }
}
