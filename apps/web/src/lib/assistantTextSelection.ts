import type { AssistantCitation } from "@t3tools/contracts";
import {
  type AssistantTextSelector,
  createAssistantTextSelector,
  findAssistantCitationText,
  rawTextOffset,
} from "@t3tools/shared/assistantTextSelection";

/** Live DOM state for an open comment, never part of a saved citation. */
export type AssistantCitationSourceAnchor = {
  source: HTMLElement;
  range: Range;
  viewport: HTMLElement;
};

export function findAssistantCitationSourceAnchor(
  document: Document,
  citation: AssistantCitation,
): AssistantCitationSourceAnchor | null {
  const source = [
    ...document.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
  ].find(
    (element) =>
      element.dataset.assistantCitationSource === citation.messageId &&
      element.dataset.assistantCitationEnvironment === citation.environmentId &&
      element.dataset.assistantCitationThread === citation.threadId,
  );
  const viewport = source?.closest<HTMLElement>("[data-assistant-citation-viewport]");
  if (!source || !viewport) return null;
  const range = resolveAssistantCitationRange(source, citation);
  return range ? { source, range, viewport } : null;
}

const CONTROL_SELECTOR = "button, input, textarea, select, [role=button], [contenteditable]";
const EXCLUDED_SELECTOR = `${CONTROL_SELECTOR}, [hidden], [aria-hidden=true], script, style, template, noscript, svg`;
const BLOCK_SELECTOR =
  "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

type TextChunk = { node: Text; start: number; end: number };

/**
 * Uses DOM text order, with a line break between HTML blocks and at <br>.
 * Inline markup, including code and links, contributes its displayed text.
 * Controls and subtrees marked hidden/aria-hidden do not contribute. No layout
 * reads, CSS-generated content, or soft-wrap line breaks enter the stream, so
 * reflow cannot move it.
 */
function readAssistantText(root: HTMLElement) {
  const parts: string[] = [];
  const chunks: TextChunk[] = [];
  let length = 0;
  let separator = false;

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node as Text;
      if (text.length === 0) return;
      if (separator && length > 0) {
        parts.push("\n");
        length += 1;
      }
      separator = false;
      chunks.push({ node: text, start: length, end: length + text.length });
      parts.push(text.data);
      length += text.length;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches(EXCLUDED_SELECTOR)) return;
    const block = element.matches(BLOCK_SELECTOR);
    if (block || element.tagName === "BR") separator = true;
    for (const child of element.childNodes) visit(child);
    if (block) separator = true;
  };

  visit(root);
  return { text: parts.join(""), chunks };
}

function excludedAncestor(node: Node): Element | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest(EXCLUDED_SELECTOR) ?? null;
}

function isUsableRange(root: HTMLElement, range: Range): boolean {
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer) ||
    excludedAncestor(range.startContainer) !== null ||
    excludedAncestor(range.endContainer) !== null
  ) {
    return false;
  }
  // Interior controls are allowed; readAssistantText omits them from the stream.
  return true;
}

function isUnselectable(text: Text): boolean {
  const element = text.parentElement;
  const view = element?.ownerDocument?.defaultView;
  return !!element && !!view && view.getComputedStyle(element).userSelect === "none";
}

function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === 3) {
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    // Triple-click ranges run through unselectable rows (tool calls, timestamps,
    // author headings) into the next response; that text is not selected.
    return start < end && !isUnselectable(text) ? text : null;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child !== null;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const boundary = selectedTextBoundary(range, child, last);
    if (boundary !== null) return boundary;
  }
  return null;
}

/** Captures the ordered native range, including selections dragged backwards. */
export function captureAssistantTextSelection(
  viewport: HTMLElement,
  selection: Selection | null,
): { source: HTMLElement; selector: AssistantTextSelector; range: Range } | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = selectedTextBoundary(range, range.commonAncestorContainer, false);
  const last = selectedTextBoundary(range, range.commonAncestorContainer, true);
  if (first === null || last === null) return null;
  const source = first.parentElement?.closest<HTMLElement>("[data-assistant-citation-source]");
  if (!source || !viewport.contains(source)) return null;

  // Paragraph selection can end at the next block's offset 0 or a parent
  // boundary. Validate the text actually selected, not that empty endpoint.
  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  if (!isUsableRange(source, range)) return null;

  const stream = readAssistantText(source);
  let rawStart: number | null = null;
  let rawEnd = 0;
  for (const chunk of stream.chunks) {
    if (!range.intersectsNode(chunk.node)) continue;
    const start = range.startContainer === chunk.node ? range.startOffset : 0;
    const end = range.endContainer === chunk.node ? range.endOffset : chunk.node.length;
    if (start === end) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === null) return null;
  const selector = createAssistantTextSelector(stream.text, rawStart, rawEnd);
  return selector === null ? null : { source, selector, range };
}

/** Resolves against the current DOM without changing the user's selection. */
export function resolveAssistantCitationRange(
  root: HTMLElement,
  selector: AssistantTextSelector,
): Range | null {
  if (excludedAncestor(root) !== null) return null;
  const stream = readAssistantText(root);
  const match = findAssistantCitationText(stream.text, selector);
  if (match === null) return null;

  const start = rawTextOffset(stream.text, match.start);
  const end = rawTextOffset(stream.text, match.end);
  const first = stream.chunks.find((chunk) => chunk.end > start);
  const last = stream.chunks.findLast((chunk) => chunk.start < end);
  if (first === undefined || last === undefined) return null;

  const range = root.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, end - last.start));
  return isUsableRange(root, range) ? range : null;
}
