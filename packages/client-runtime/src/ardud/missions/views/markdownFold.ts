// A capped markdown block on the board shows the start of its text and a way
// to read the rest. Reports run past 100k characters, so a folded block lays
// out only a prefix, and the longest ones open in a reader that renders the
// text in pieces instead of one native view tens of thousands of lines tall.

/** Above this many characters a folded report opens in the reader. */
export const VIEW_MARKDOWN_READER_CHARS = 40_000;

/** Generous on purpose: a folded prefix has to fill its cap at any width. */
const PREVIEW_CHARS_PER_LINE = 160;

const READER_CHUNK_CHARS = 6_000;

export type ViewMarkdownFold = "none" | "inline" | "reader";

/**
 * How a capped block offers the rest of its text: not at all when it fits,
 * by growing in place, or in the reader when it is long.
 */
export function viewMarkdownFold(input: {
  readonly chars: number;
  /** The block shows a prefix, so there is more text whatever it measures. */
  readonly cut: boolean;
  /** The laid-out height of what the block shows, unknown before layout. */
  readonly contentHeight: number | null;
  readonly capHeight: number | null;
}): ViewMarkdownFold {
  if (input.capHeight === null) return "none";
  // A point of slack: layout rounds, and a block exactly at its cap fits.
  const overflows =
    input.cut || (input.contentHeight !== null && input.contentHeight > input.capHeight + 1);
  if (!overflows) return "none";
  return input.chars > VIEW_MARKDOWN_READER_CHARS ? "reader" : "inline";
}

/** The start of `text` a block capped at `maxLines` lays out while folded. */
export function viewMarkdownPreview(
  text: string,
  maxLines: number,
): { readonly text: string; readonly cut: boolean } {
  const budget = Math.max(1, maxLines) * PREVIEW_CHARS_PER_LINE;
  if (text.length <= budget) return { text, cut: false };
  let end = cutAfter(markdownBreaks(text), 0, budget, text.length).offset;
  // With no clean break near the budget (one huge code block, text without
  // blank lines) the prefix ends at a line instead. It is clipped anyway, and
  // an unclosed fence just renders as code to the end.
  if (end > budget * 2) end = softCut(text, budget, budget * 2);
  return end >= text.length
    ? { text, cut: false }
    : { text: text.slice(0, end).trimEnd(), cut: true };
}

export interface ViewMarkdownChunk {
  readonly text: string;
  /** The piece starts with the next item of a list the piece before it ran. */
  readonly continuesList: boolean;
}

/**
 * `text` in pieces of about `target` characters, each starting where a new
 * top-level block starts so every piece renders as it would in the whole.
 */
export function viewMarkdownChunks(text: string, target = READER_CHUNK_CHARS): ViewMarkdownChunk[] {
  const breaks = markdownBreaks(text);
  const size = Math.max(1, target);
  const chunks: ViewMarkdownChunk[] = [];
  let start = 0;
  let continuesList = false;
  while (start < text.length) {
    const end = cutAfter(breaks, start, size, text.length);
    const chunk = text.slice(start, end.offset).trim();
    if (chunk !== "") chunks.push({ text: chunk, continuesList });
    start = end.offset;
    continuesList = !end.strong;
  }
  return chunks;
}

interface MarkdownBreak {
  readonly offset: number;
  /**
   * A heading or a block after a blank line starts cleanly. A list item
   * right under another only splits its list, so it is the fallback.
   */
  readonly strong: boolean;
}

// A backtick fence's info string can't hold a backtick, and a closing fence
// is the run alone on its line.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^#{1,6}(?:\s|$)/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** Line starts outside code fences where the text can be split. */
function markdownBreaks(text: string): MarkdownBreak[] {
  const breaks: MarkdownBreak[] = [];
  let fence: string | null = null;
  let afterBlank = false;
  // The last unindented line was a list item, so the next one continues the
  // list. Elsewhere "2024. A year" or a lone "-" is paragraph text.
  let inList = false;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    if (fence !== null) {
      // A fence closes on a run of its own character at least as long.
      const marker = FENCE_CLOSE.exec(line)?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      afterBlank = false;
    } else if (line.trim() === "") {
      afterBlank = true;
    } else {
      // Indented lines continue a list item or a code block, so never split there.
      const indented = line[0] === " " || line[0] === "\t";
      if (!indented) {
        const listItem = LIST_ITEM.test(line);
        if (offset > 0) {
          if (afterBlank || HEADING.test(line)) breaks.push({ offset, strong: true });
          else if (listItem && inList) breaks.push({ offset, strong: false });
        }
        inList = listItem;
      }
      fence = FENCE_OPEN.exec(line)?.[1] ?? null;
      afterBlank = false;
    }
    offset = lineEnd + 1;
  }
  return breaks;
}

/** The last line end, else the last space, between `min` and `max`. */
function softCut(text: string, min: number, max: number): number {
  const newline = text.lastIndexOf("\n", max - 1);
  if (newline >= min) return newline;
  const space = text.lastIndexOf(" ", max - 1);
  return space >= min ? space : max;
}

/**
 * Where a piece starting at `start` ends: a clean break between `target` and
 * twice that, a list item there, or else the next break of any kind. Text
 * with no break left (one long code block) stays whole rather than split
 * somewhere it would render differently.
 */
function cutAfter(
  breaks: readonly MarkdownBreak[],
  start: number,
  target: number,
  length: number,
): MarkdownBreak {
  const min = start + target;
  const max = start + target * 2;
  let weak: MarkdownBreak | undefined;
  for (const brk of breaks) {
    if (brk.offset < min) continue;
    if (brk.offset > max) return weak ?? brk;
    if (brk.strong) return brk;
    weak ??= brk;
  }
  return weak ?? { offset: length, strong: true };
}
