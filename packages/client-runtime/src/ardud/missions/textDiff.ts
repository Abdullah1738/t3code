// Word-level diff for showing the owner what he changed in a draft, and what a
// suggestion changes. Small inputs only (drafts and suggestion bodies), so a
// plain LCS table is fine.

export type DiffSegmentKind = "same" | "added" | "removed";

export interface DiffSegment {
  readonly kind: DiffSegmentKind;
  readonly text: string;
}

/** Above this many tokens on either side the diff falls back to whole-text replace. */
const MAX_DIFF_TOKENS = 2_000;

/** Splits into words and the whitespace between them, so joining gives the input back. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function pushSegment(segments: DiffSegment[], kind: DiffSegmentKind, text: string): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    segments[segments.length - 1] = { kind, text: last.text + text };
    return;
  }
  segments.push({ kind, text });
}

/**
 * Word diff from `before` to `after`. Joining the `same` and `removed` texts
 * gives `before`; joining `same` and `added` gives `after`.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) return before === "" ? [] : [{ kind: "same", text: before }];
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length > MAX_DIFF_TOKENS || right.length > MAX_DIFF_TOKENS) {
    const segments: DiffSegment[] = [];
    pushSegment(segments, "removed", before);
    pushSegment(segments, "added", after);
    return segments;
  }

  // lengths[i][j] = LCS length of left[i..] and right[j..]
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        left[i] === right[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pushSegment(segments, "same", left[i] ?? "");
      i++;
      j++;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      pushSegment(segments, "removed", left[i] ?? "");
      i++;
    } else {
      pushSegment(segments, "added", right[j] ?? "");
      j++;
    }
  }
  while (i < left.length) pushSegment(segments, "removed", left[i++] ?? "");
  while (j < right.length) pushSegment(segments, "added", right[j++] ?? "");
  return segments;
}

export interface DiffStats {
  readonly addedWords: number;
  readonly removedWords: number;
}

function wordCount(text: string): number {
  return text.match(/[^\s]+/g)?.length ?? 0;
}

export function diffStats(segments: ReadonlyArray<DiffSegment>): DiffStats {
  let addedWords = 0;
  let removedWords = 0;
  for (const segment of segments) {
    if (segment.kind === "added") addedWords += wordCount(segment.text);
    if (segment.kind === "removed") removedWords += wordCount(segment.text);
  }
  return { addedWords, removedWords };
}

export type DiffLineKind = "added" | "removed" | "context";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** Reads a unified-style `diffText` ("- old" / "+ new" lines) for display. */
export function parseDiffLines(diffText: string): DiffLine[] {
  return diffText
    .split("\n")
    .filter((line, index, lines) => line !== "" || index < lines.length - 1)
    .map((line) => {
      if (line.startsWith("+")) return { kind: "added", text: line.slice(1).trimStart() };
      if (line.startsWith("-")) return { kind: "removed", text: line.slice(1).trimStart() };
      return { kind: "context", text: line };
    });
}
