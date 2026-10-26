import type { ComposerContextId, ComposerContextKind } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  parseComposerContextHref,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

// Board links ride on the composer's context references, so the editor turns a
// pasted one into a chip and agents read the ids straight from the markdown.
// Threads use the app's own t3-thread links: their ids don't fit a context id.
export const KANBAN_LINK_KINDS = ["kanban-card", "kanban-discussion"] as const;

export type KanbanLinkKind = (typeof KANBAN_LINK_KINDS)[number];

export interface KanbanLink {
  readonly kind: KanbanLinkKind;
  readonly id: string;
}

const isLinkKind = (kind: string): kind is KanbanLinkKind =>
  (KANBAN_LINK_KINDS as ReadonlyArray<string>).includes(kind);

/** Markdown for a link to a card or discussion; ids are what the server made. */
export function kanbanLink(kind: KanbanLinkKind, id: string, label: string): string {
  return formatComposerContextReference({
    kind: kind as ComposerContextKind,
    contextId: id as ComposerContextId,
    label,
  });
}

export function kanbanLinkOf(kind: string, contextId: string): KanbanLink | null {
  return isLinkKind(kind) ? { kind, id: contextId } : null;
}

export function parseKanbanLink(href: string): KanbanLink | null {
  const parsed = parseComposerContextHref(href);
  return parsed ? kanbanLinkOf(parsed.kind, parsed.contextId) : null;
}

const THREAD_LINK = /\[([^\]\n]*)\]\(t3-thread:\/\/v1\/[^\s)]+\)/g;

/** Text with every context reference and thread link reduced to its label, for previews and titles. */
export function linkLabels(text: string): string {
  return replaceComposerContextReferences(text, (occurrence) => occurrence.label).replace(
    THREAD_LINK,
    "$1",
  );
}
