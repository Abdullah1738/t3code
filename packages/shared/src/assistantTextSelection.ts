import { ASSISTANT_CITATION_CONTEXT_LENGTH } from "@t3tools/contracts";

export type AssistantTextSelector = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly suffix: string;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Keeps the exact captured text while storing normalized UTF-16 positions and context. */
export function createAssistantTextSelector(
  text: string,
  rawStart: number,
  rawEnd: number,
): AssistantTextSelector | null {
  const quote = text.slice(rawStart, rawEnd);
  if (quote.trim().length === 0) return null;

  const normalized = normalizeWhitespace(text);
  let start = normalizeWhitespace(text.slice(0, rawStart)).length;
  // A selection starting inside a whitespace run includes its normalized space.
  if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) {
    start -= 1;
  }
  const end = normalizeWhitespace(text.slice(0, rawEnd)).length;
  let prefixStart = Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH);
  let suffixEnd = Math.min(normalized.length, end + ASSISTANT_CITATION_CONTEXT_LENGTH);
  // A split pair becomes a replacement character when the context enters a URL.
  if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
  return {
    text: quote,
    start,
    end,
    prefix: normalized.slice(prefixStart, start),
    suffix: normalized.slice(end, suffixEnd),
  };
}

/**
 * Matches case-sensitive text after collapsing each JS whitespace run to one
 * space, without trimming. All positions and context lengths use UTF-16 units
 * in that normalized stream, not markdown offsets or Unicode code points.
 * `selector.text` can retain the original line breaks and code indentation.
 * Repeated quotes require one match for all supplied context. Even matching
 * saved offsets cannot break a context tie, since those offsets may have drifted.
 */
export function findAssistantCitationText(
  text: string,
  selector: AssistantTextSelector,
): { start: number; end: number } | null {
  const normalized = normalizeWhitespace(text);
  const quote = normalizeWhitespace(selector.text);
  if (quote.trim().length === 0) return null;

  const prefix = normalizeWhitespace(selector.prefix);
  const suffix = normalizeWhitespace(selector.suffix);
  const matchesContext = (start: number, end: number) =>
    normalized.slice(Math.max(0, start - prefix.length), start) === prefix &&
    normalized.slice(end, end + suffix.length) === suffix;

  let match =
    Number.isSafeInteger(selector.start) &&
    Number.isSafeInteger(selector.end) &&
    selector.start >= 0 &&
    selector.end - selector.start === quote.length &&
    normalized.slice(selector.start, selector.end) === quote &&
    matchesContext(selector.start, selector.end)
      ? { start: selector.start, end: selector.end }
      : null;
  let onlyQuote: { start: number; end: number } | null = null;
  let quoteCount = 0;

  for (
    let start = normalized.indexOf(quote);
    start !== -1;
    start = normalized.indexOf(quote, start + 1)
  ) {
    const end = start + quote.length;
    quoteCount += 1;
    onlyQuote = { start, end };
    if (!matchesContext(start, end)) continue;
    if (match !== null && match.start !== start) return null;
    match = { start, end };
  }

  return match ?? (quoteCount === 1 ? onlyQuote : null);
}

/** Maps a position in the whitespace-normalized stream back to `text`. */
export function rawTextOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const whitespace = /\s/.test(match[0][0]!);
    const length = whitespace ? 1 : match[0].length;
    if (normalizedOffset <= offset + length) {
      return (
        match.index +
        (whitespace && normalizedOffset > offset ? match[0].length : normalizedOffset - offset)
      );
    }
    offset += length;
  }
  return text.length;
}

/**
 * Builds a selector when a client knows the selected text but not where it sits,
 * such as native selection menus that report offsets per rendered block.
 * A unique occurrence gets full position and context. Otherwise the selector keeps
 * only the quote, so later lookups succeed only where the quote is unambiguous.
 */
export function locateAssistantTextSelector(
  text: string,
  selectedText: string,
): AssistantTextSelector | null {
  const quote = selectedText.trim();
  if (quote.length === 0) return null;
  const normalized = normalizeWhitespace(text);
  const normalizedQuote = normalizeWhitespace(quote);
  const start = normalized.indexOf(normalizedQuote);
  if (start !== -1 && normalized.indexOf(normalizedQuote, start + 1) === -1) {
    const selector = createAssistantTextSelector(
      text,
      rawTextOffset(text, start),
      rawTextOffset(text, start + normalizedQuote.length),
    );
    if (selector !== null) return { ...selector, text: quote };
  }
  return { text: quote, start: 0, end: normalizedQuote.length, prefix: "", suffix: "" };
}
