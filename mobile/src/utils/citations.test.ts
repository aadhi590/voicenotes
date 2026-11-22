import { citedNumbers, parseCitations } from "./citations";

describe("parseCitations", () => {
  test("single marker mid-sentence", () => {
    expect(parseCitations("The quantum is 4 ms [1].", 3)).toEqual([
      { type: "text", value: "The quantum is 4 ms " },
      { type: "cite", n: 1 },
      { type: "text", value: "." },
    ]);
  });

  test("grouped marker [1, 2] and [2,3]", () => {
    expect(parseCitations("A [1, 2] B [2,3]", 3)).toEqual([
      { type: "text", value: "A " },
      { type: "cite", n: 1 },
      { type: "cite", n: 2 },
      { type: "text", value: " B " },
      { type: "cite", n: 2 },
      { type: "cite", n: 3 },
    ]);
  });

  test("adjacent markers [1][2]", () => {
    expect(parseCitations("fact [1][2].", 2)).toEqual([
      { type: "text", value: "fact " },
      { type: "cite", n: 1 },
      { type: "cite", n: 2 },
      { type: "text", value: "." },
    ]);
  });

  test("out-of-range numbers stay plain text (merged with neighbours)", () => {
    expect(parseCitations("x [4] y [0] z [1, 9]", 3)).toEqual([{ type: "text", value: "x [4] y [0] z [1, 9]" }]);
    expect(parseCitations("only [1]", 0)).toEqual([{ type: "text", value: "only [1]" }]);
  });

  test("no citations", () => {
    expect(parseCitations("I couldn't find that in your notes.", 0)).toEqual([
      { type: "text", value: "I couldn't find that in your notes." },
    ]);
    expect(parseCitations("", 2)).toEqual([]);
  });

  test("markers at start and end", () => {
    expect(parseCitations("[2] starts and ends [1]", 2)).toEqual([
      { type: "cite", n: 2 },
      { type: "text", value: " starts and ends " },
      { type: "cite", n: 1 },
    ]);
  });

  test("non-citation brackets are untouched", () => {
    expect(parseCitations("array[i] and [note] and [1a]", 3)).toEqual([{ type: "text", value: "array[i] and [note] and [1a]" }]);
  });

  test("citedNumbers dedupes in first-appearance order", () => {
    expect(citedNumbers(parseCitations("a [2] b [1] c [2][1]", 2))).toEqual([2, 1]);
  });
});
