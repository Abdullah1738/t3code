import { Platform } from "react-native";

export type MarkdownSpacing = "chat" | "document";

// The gaps a reader sees between blocks.
const GAPS = {
  chat: { paragraph: 8, headingTop: 8, headingBottom: 8, listItem: 0 },
  document: { paragraph: 10, headingTop: 22, headingBottom: 6, listItem: 6 },
} as const;

/** The margins to hand the native renderer for `spacing`'s gaps. */
export function markdownMargins(spacing: MarkdownSpacing) {
  const gaps = GAPS[spacing];
  // iOS folds a block's top margin into the gap the block above leaves, and
  // Android adds the two, so a document heading there takes the difference.
  // Chat keeps the margins it always had.
  const headingTop =
    spacing === "document" && Platform.OS !== "ios"
      ? gaps.headingTop - gaps.paragraph
      : gaps.headingTop;
  return { ...gaps, headingTop };
}

const LEADING_HEADING = /^\s*#{1,6}(?:\s|$)/;

/**
 * The renderer gives a document's first heading its top margin, which would
 * open a card with a gap, so the view pulls itself up by this much.
 */
export function markdownLeadingSpace(markdown: string, spacing: MarkdownSpacing): number {
  return spacing === "document" && LEADING_HEADING.test(markdown)
    ? markdownMargins(spacing).headingTop
    : 0;
}

/**
 * The space above a piece of a document that continues the piece before it,
 * which is an item gap only when the piece carries on that piece's list.
 */
export function markdownGapBefore(markdown: string, continuesList: boolean): number {
  const gaps = GAPS.document;
  if (LEADING_HEADING.test(markdown)) return gaps.headingTop;
  return continuesList ? gaps.listItem : gaps.paragraph;
}
