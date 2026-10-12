import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { locateAssistantTextSelector } from "@t3tools/shared/assistantTextSelection";

import { type MarkdownNode, parseMarkdownDocument } from "./markdownDocument";

const INLINE_PARENTS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

function appendRenderedText(node: MarkdownNode, parts: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
      parts.push(node.value);
      return;
    case "code":
      parts.push("\n", node.value, "\n");
      return;
    case "break":
      parts.push("\n");
      return;
  }
  if (!("children" in node)) return;
  const inline = INLINE_PARENTS.has(node.type);
  if (!inline) parts.push("\n");
  for (const child of node.children as ReadonlyArray<MarkdownNode>)
    appendRenderedText(child, parts);
  if (!inline) parts.push("\n");
}

/**
 * The text a reader sees in rendered assistant Markdown, one block per line. Native selection
 * only reports the selected text, so this is the stream a citation's position and context come
 * from.
 */
export function assistantMarkdownText(markdown: string): string {
  const parts: string[] = [];
  appendRenderedText(parseMarkdownDocument(markdown), parts);
  return parts.join("").trim();
}

export function createMobileAssistantCitation(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The Markdown rendered by the view the text was selected in. */
  readonly markdown: string;
  readonly selectedText: string;
}): AssistantCitation | "too-long" | null {
  const selector = locateAssistantTextSelector(
    assistantMarkdownText(input.markdown),
    input.selectedText,
  );
  if (selector === null) return null;
  if (selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return "too-long";
  return {
    version: 1,
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
    ...selector,
  };
}

/**
 * Inserts a citation the way web does: apart from the text before it and followed by a space.
 * Returns null when the draft would pass the input limit the editor enforces on typing and paste.
 */
export function insertAssistantCitation(
  text: string,
  selection: { readonly start: number; readonly end: number },
  citation: AssistantCitation,
) {
  const source = serializeAssistantCitation(citation);
  const leading = selection.start > 0 && !/\s/.test(text[selection.start - 1]!) ? " " : "";
  const end = text[selection.end] === " " ? selection.end + 1 : selection.end;
  const start = selection.start + leading.length;
  const next = `${text.slice(0, selection.start)}${leading}${source} ${text.slice(end)}`;
  if (next.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return null;
  return {
    text: next,
    citation: { source, start, end: start + source.length },
    caret: start + source.length + 1,
  };
}
