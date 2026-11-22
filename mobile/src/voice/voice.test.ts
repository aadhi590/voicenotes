import { isUselessTranscript, initialVad, normalizeDb, shouldDiscardRecording, vadStep, END_SILENCE_MS, MAX_RECORDING_MS } from "./silence";
import { SentenceSplitter, stripCitations } from "./sentences";
import { Speaker, type SpeechEngine } from "./speaker";

describe("SentenceSplitter", () => {
  test("emits complete sentences as they stream, keeps the rest buffered", () => {
    const s = new SentenceSplitter();
    expect(s.push("The quantum is 4 ms [1]. It is")).toEqual(["The quantum is 4 ms [1]."]);
    expect(s.push(" used in RR [1]! Done? ")).toEqual(["It is used in RR [1]!", "Done?"]);
    expect(s.push("Last bit")).toEqual([]);
    expect(s.flush()).toBe("Last bit");
    expect(s.flush()).toBeNull();
  });

  test("does not split on e.g. / i.e. / decimals like 4.5", () => {
    const s = new SentenceSplitter();
    expect(s.push("Use a short quantum, e.g. 4.5 ms, i.e. small. Next ")).toEqual([
      "Use a short quantum, e.g. 4.5 ms, i.e. small.",
    ]);
    expect(s.flush()).toBe("Next");
  });

  test("a sentence end split across tokens", () => {
    const s = new SentenceSplitter();
    expect(s.push("Light reactions make ATP")).toEqual([]);
    expect(s.push(".")).toEqual([]); // no following space yet
    expect(s.push(" The")).toEqual(["Light reactions make ATP."]);
  });
});

describe("stripCitations", () => {
  test("removes [1], [1, 2], [1][2] and tidies spacing", () => {
    expect(stripCitations("The quantum is 4 ms [1].")).toBe("The quantum is 4 ms.");
    expect(stripCitations("Both apply [1, 2] here [1][2].")).toBe("Both apply here.");
    expect(stripCitations("[3] Starts with a cite")).toBe("Starts with a cite");
    expect(stripCitations("No cites at all.")).toBe("No cites at all.");
  });
});

function fakeEngine() {
  const spoken: string[] = [];
  let pending: (() => void) | null = null;
  const engine: SpeechEngine = {
    speak: (text, opts) => {
      spoken.push(text);
      pending = opts.onDone;
    },
    stop: jest.fn(() => {
      pending = null;
    }),
  };
  const finishCurrent = (): void => {
    const cb = pending;
    pending = null;
    cb?.();
  };
  return { engine, spoken, finishCurrent };
}

describe("Speaker", () => {
  test("speaks sentences in order with citations stripped, flushes the rest on finish", () => {
    const { engine, spoken, finishCurrent } = fakeEngine();
    const states: boolean[] = [];
    const sp = new Speaker((v) => states.push(v), engine);
    sp.begin("a");
    sp.feed("a", "First [1]. Second [2]. Tail");
    expect(spoken).toEqual(["First."]); // one at a time
    finishCurrent();
    expect(spoken).toEqual(["First.", "Second."]);
    sp.finish("a");
    finishCurrent();
    expect(spoken).toEqual(["First.", "Second.", "Tail"]);
    finishCurrent();
    expect(states).toEqual([true, false]);
    expect(sp.isSpeaking).toBe(false);
  });

  test("barge-in: stop() silences now and old-id sentences are never spoken", () => {
    const { engine, spoken, finishCurrent } = fakeEngine();
    const sp = new Speaker(() => undefined, engine);
    sp.begin("old");
    sp.feed("old", "One. Two. Three. ");
    expect(spoken).toEqual(["One."]);

    sp.stop(); // mic tapped mid-speech
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(sp.isSpeaking).toBe(false);
    finishCurrent(); // late onDone from the stopped utterance: ignored

    sp.feed("old", "Four. "); // late tokens of the old answer
    sp.finish("old");
    sp.begin("new");
    sp.feed("old", "Five. "); // still the old id: dropped
    sp.feed("new", "Fresh answer. ");
    expect(spoken).toEqual(["One.", "Fresh answer."]);
  });

  test("feed for an id that was never begun is ignored", () => {
    const { engine, spoken } = fakeEngine();
    const sp = new Speaker(() => undefined, engine);
    sp.feed("x", "Hello there. ");
    expect(spoken).toEqual([]);
  });
});

describe("silence guard + end of utterance", () => {
  test("normalizeDb maps -60..0 dB to 0..1 and clamps", () => {
    expect(normalizeDb(-60)).toBe(0);
    expect(normalizeDb(0)).toBe(1);
    expect(normalizeDb(-30)).toBeCloseTo(0.5);
    expect(normalizeDb(-120)).toBe(0);
    expect(normalizeDb(undefined)).toBe(0);
  });

  test("auto-stops after 1.2s of silence only once speech was detected", () => {
    let st = initialVad;
    let stop = false;
    for (let t = 0; t <= 3000; t += 50) {
      ({ state: st, stop } = vadStep(st, -55, t)); // quiet room, no speech yet
      expect(stop).toBe(false);
    }
    ({ state: st, stop } = vadStep(st, -20, 3050)); // speech
    expect(stop).toBe(false);
    ({ state: st, stop } = vadStep(st, -55, 3050 + END_SILENCE_MS - 50));
    expect(stop).toBe(false);
    ({ state: st, stop } = vadStep(st, -55, 3050 + END_SILENCE_MS));
    expect(stop).toBe(true);
  });

  test("hard cap at 30s", () => {
    expect(vadStep(initialVad, -10, MAX_RECORDING_MS).stop).toBe(true);
  });

  test("discard: never loud enough, or shorter than 0.4s", () => {
    expect(shouldDiscardRecording(2000, -50)).toBe(true); // silent tap
    expect(shouldDiscardRecording(300, -10)).toBe(true); // too short
    expect(shouldDiscardRecording(2000, -20)).toBe(false);
  });

  test("filler transcripts are dropped only when the audio was quiet", () => {
    expect(isUselessTranscript("", -10)).toBe(true);
    expect(isUselessTranscript("  ", -10)).toBe(true);
    expect(isUselessTranscript("Thank you.", -38)).toBe(true);
    expect(isUselessTranscript("Thanks for watching!", -35)).toBe(true);
    expect(isUselessTranscript("Thank you.", -10)).toBe(false); // the user really said it
    expect(isUselessTranscript("What is round robin?", -38)).toBe(false);
  });
});
