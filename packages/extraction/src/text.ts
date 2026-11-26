/**
 * Evidence matching. Both sides get the same normalization (NFKC per code point,
 * every whitespace run collapsed to one space, trimmed); after that, the quote
 * must be an exact, case-sensitive substring of the document text.
 *
 * Offsets are reported in the ORIGINAL text, so the UI can highlight the exact
 * passage in the stored parsed_text.
 */

const WHITESPACE = /\s/u;

interface NormalizedText {
  text: string;
  /** For each UTF-16 unit of `text`: start offset of its source code point in the original. */
  starts: number[];
  /** For each UTF-16 unit of `text`: end offset of its source code point in the original. */
  ends: number[];
}

function normalizeWithMap(original: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace: { start: number; end: number } | null = null;

  let i = 0;
  for (const codePoint of original) {
    const start = i;
    const end = i + codePoint.length;
    i = end;

    if (WHITESPACE.test(codePoint)) {
      // Collapse the run; leading whitespace is dropped entirely.
      if (text.length > 0 && pendingSpace === null) pendingSpace = { start, end };
      continue;
    }
    if (pendingSpace) {
      text += " ";
      starts.push(pendingSpace.start);
      ends.push(pendingSpace.end);
      pendingSpace = null;
    }
    const folded = codePoint.normalize("NFKC");
    for (let k = 0; k < folded.length; k++) {
      starts.push(start);
      ends.push(end);
    }
    text += folded;
  }
  return { text, starts, ends };
}

export function normalizeForMatch(text: string): string {
  return normalizeWithMap(text).text;
}

export interface Span {
  start: number;
  end: number;
}

/** Where `quote` occurs in `text` (first occurrence), or null if it does not. */
export function locateEvidence(text: string, quote: string): Span | null {
  const needle = normalizeForMatch(quote);
  if (needle === "") return null;
  const haystack = normalizeWithMap(text);
  const at = haystack.text.indexOf(needle);
  if (at === -1) return null;
  const last = at + needle.length - 1;
  return { start: haystack.starts[at]!, end: haystack.ends[last]! };
}
