/** Remove citation markers ([1], [1, 2], [1][2]) so TTS doesn't read "bracket one". */
export function stripCitations(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Words ending in "." that do NOT end a sentence.
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "fig", "approx", "no", "p", "pp", "eq"]);

function isAbbreviation(textBeforeDot: string): boolean {
  const word = (textBeforeDot.match(/([A-Za-z.]+)$/)?.[1] ?? "").toLowerCase();
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  return /^[a-z]$/.test(word); // single initial like "J." in "J. Smith"
}

/**
 * Incremental sentence splitter for streamed text. A sentence ends at . ? ! followed by
 * whitespace (decimals like 4.5 never match because a digit follows the dot). Abbreviations
 * such as "e.g." are not treated as sentence ends. flush() returns whatever is left (on DONE).
 */
export class SentenceSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const sentences: string[] = [];
    let start = 0;
    const re = /[.?!]+(?=\s)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      if (match[0] === "." && isAbbreviation(this.buffer.slice(start, match.index))) continue;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence) sentences.push(sentence);
      start = end;
    }
    this.buffer = this.buffer.slice(start);
    return sentences;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }

  reset(): void {
    this.buffer = "";
  }
}
