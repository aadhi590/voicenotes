export type Segment = { type: "text"; value: string } | { type: "cite"; n: number };

// [1]  [1, 2]  [1,2,3]   — adjacent markers like [1][2] are simply two matches.
const CITE_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Split an answer into text and citation segments. A marker whose numbers are not all
 * within 1..sourceCount is kept as plain text (the model cited something that doesn't exist).
 */
export function parseCitations(text: string, sourceCount: number): Segment[] {
  const segments: Segment[] = [];
  const pushText = (value: string): void => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.type === "text") {
      segments[segments.length - 1] = { type: "text", value: last.value + value };
    } else {
      segments.push({ type: "text", value });
    }
  };

  let cursor = 0;
  for (const match of text.matchAll(CITE_RE)) {
    const start = match.index ?? 0;
    pushText(text.slice(cursor, start));
    const nums = match[1].split(",").map((s) => Number(s.trim()));
    if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)) {
      for (const n of nums) segments.push({ type: "cite", n });
    } else {
      pushText(match[0]);
    }
    cursor = start + match[0].length;
  }
  pushText(text.slice(cursor));
  return segments;
}

/** Distinct citation numbers in first-appearance order. */
export function citedNumbers(segments: Segment[]): number[] {
  const seen = new Set<number>();
  for (const s of segments) if (s.type === "cite") seen.add(s.n);
  return [...seen];
}
