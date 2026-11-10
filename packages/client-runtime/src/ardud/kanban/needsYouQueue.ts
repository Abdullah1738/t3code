/**
 * The Needs-you queue as the page lists it: filtered, searched and cut into
 * its sections, with the order keyboard movement follows. Pure.
 */
import { kanbanAskChanges } from "@t3tools/contracts";

import type { NeedsYou, NeedsYouEntry, NeedsYouItem } from "./needsYou.ts";

export interface NeedsYouFilter {
  /** A board id; null shows every board. */
  readonly boardId: string | null;
  /** An ask kind as its asker labelled it; null shows every kind. */
  readonly kind: string | null;
  /** Only asks that hold their card. */
  readonly holds: boolean;
  readonly query: string;
}

export const EMPTY_NEEDS_YOU_FILTER: NeedsYouFilter = {
  boardId: null,
  kind: null,
  holds: false,
  query: "",
};

export const needsYouFiltered = (filter: NeedsYouFilter): boolean =>
  filter.boardId !== null || filter.kind !== null || filter.holds || filter.query.trim() !== "";

/** Board names by id, so a search for "crpko" finds that board's asks. */
export type BoardNames = ReadonlyMap<string, string>;

const haystack = (item: NeedsYouItem, boards: BoardNames): string =>
  [
    item.ask.title,
    item.ask.text,
    item.ask.context,
    item.cardTitle,
    boards.get(item.boardId),
    `#${item.cardNumber}`,
    item.kind,
    item.ask.action?.summary,
    item.ask.action?.command,
    item.ask.draft?.text,
    ...kanbanAskChanges(item.ask).map((change) => change.label),
    ...(item.ask.options ?? []).map((option) => option.label),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();

export function needsYouMatches(
  item: NeedsYouItem,
  filter: NeedsYouFilter,
  boards: BoardNames,
): boolean {
  if (filter.boardId !== null && item.boardId !== filter.boardId) return false;
  if (filter.kind !== null && item.kind !== filter.kind) return false;
  if (filter.holds && !item.blocking) return false;
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack(item, boards);
  return words.every((word) => text.includes(word));
}

/** Why an ask sits in "New for you": something changed on it since he last looked. */
export type NeedsYouMark = "reply" | "updated" | "failed";

export type NeedsYouSectionId =
  | "fresh"
  | "holds"
  | "open"
  | "expired"
  | "agent"
  | "evaluator"
  | "notices";

export interface NeedsYouSection {
  readonly id: NeedsYouSectionId;
  readonly label: string;
  readonly entries: ReadonlyArray<NeedsYouEntry>;
  /** Asks in the section, a batch counted by its asks. */
  readonly count: number;
}

export const needsYouBatchKey = (entry: Extract<NeedsYouEntry, { _tag: "batch" }>): string =>
  `batch:${entry.boardId}:${entry.batchKey}`;

export const needsYouEntryKey = (entry: NeedsYouEntry): string =>
  entry._tag === "ask" ? entry.item.key : needsYouBatchKey(entry);

const SECTION_LABELS: Record<NeedsYouSectionId, string> = {
  fresh: "New for you",
  holds: "Holds a card",
  open: "Not blocking",
  expired: "Out of date",
  agent: "Waiting on agents",
  evaluator: "With the evaluator",
  notices: "Notices, nothing needed",
};

const single = (items: ReadonlyArray<NeedsYouItem>): ReadonlyArray<NeedsYouEntry> =>
  items.map((item) => ({ _tag: "ask" as const, item }));

const entryCount = (entries: ReadonlyArray<NeedsYouEntry>): number =>
  entries.reduce((sum, entry) => sum + (entry._tag === "batch" ? entry.items.length : 1), 0);

/**
 * The sections of the queue, top to bottom. `marks` moves an ask to "New for
 * you" until he opens it. A batch keeps only its matching asks and unfolds
 * into single asks when fewer than two are left. `hidden` drops asks whose
 * answer is on its way.
 */
export function needsYouSections(
  needsYou: NeedsYou,
  filter: NeedsYouFilter,
  boards: BoardNames,
  marks: ReadonlyMap<string, NeedsYouMark> = new Map(),
  hidden: ReadonlySet<string> = new Set(),
): ReadonlyArray<NeedsYouSection> {
  const keep = (item: NeedsYouItem) =>
    !hidden.has(item.key) && needsYouMatches(item, filter, boards);

  const mine: Array<NeedsYouEntry> = [];
  for (const entry of needsYou.entries) {
    if (entry._tag === "ask") {
      if (keep(entry.item)) mine.push(entry);
      continue;
    }
    const items = entry.items.filter(keep);
    if (items.length >= 2) mine.push({ ...entry, items });
    else for (const item of items) mine.push({ _tag: "ask", item });
  }
  const marked = (entry: NeedsYouEntry) =>
    entry._tag === "ask"
      ? marks.has(entry.item.key)
      : entry.items.some((item) => marks.has(item.key));
  const blocking = (entry: NeedsYouEntry) =>
    entry._tag === "ask" ? entry.item.blocking : entry.items.some((item) => item.blocking);

  const fresh = mine.filter(marked);
  const rest = mine.filter((entry) => !marked(entry));
  const lists: ReadonlyArray<readonly [NeedsYouSectionId, ReadonlyArray<NeedsYouEntry>]> = [
    ["fresh", fresh],
    ["holds", rest.filter(blocking)],
    ["open", rest.filter((entry) => !blocking(entry))],
    ["expired", single(needsYou.expired.filter(keep))],
    ["agent", single(needsYou.waitingOnAgent.filter(keep))],
    ["evaluator", single(needsYou.withEvaluator.filter(keep))],
    ["notices", single(needsYou.notices.filter(keep))],
  ];
  return lists
    .filter(([, entries]) => entries.length > 0)
    .map(([id, entries]) => ({
      id,
      label: SECTION_LABELS[id],
      entries,
      count: entryCount(entries),
    }));
}

/**
 * The keys J and K step through, in the order the list shows them: a batch,
 * then its asks while it is unfolded.
 */
export function needsYouFocusOrder(
  sections: ReadonlyArray<NeedsYouSection>,
  openBatches: ReadonlySet<string>,
): ReadonlyArray<string> {
  const order: Array<string> = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry._tag === "ask") {
        order.push(entry.item.key);
        continue;
      }
      const key = needsYouBatchKey(entry);
      order.push(key);
      if (openBatches.has(key)) for (const item of entry.items) order.push(item.key);
    }
  }
  return order;
}

/**
 * Where focus goes after the focused ask left the queue (answered, replied
 * on): the first ask that still needs him, else whatever is first.
 */
export function needsYouNextFocus(
  sections: ReadonlyArray<NeedsYouSection>,
  openBatches: ReadonlySet<string>,
): string | null {
  const mine = sections.filter(
    (section) => section.id === "fresh" || section.id === "holds" || section.id === "open",
  );
  return (
    needsYouFocusOrder(mine, openBatches)[0] ?? needsYouFocusOrder(sections, openBatches)[0] ?? null
  );
}

/** One step through the list from `current`; stays at the ends. */
export function needsYouStep(
  order: ReadonlyArray<string>,
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index < 0) return order[0]!;
  return order[Math.max(0, Math.min(order.length - 1, index + delta))]!;
}

/** The kinds present in the queue, most common first, for the kind filter. */
export function needsYouKinds(
  needsYou: NeedsYou,
): ReadonlyArray<{ readonly kind: string; readonly count: number }> {
  const counts = new Map<string, number>();
  for (const list of [
    needsYou.items,
    needsYou.expired,
    needsYou.waitingOnAgent,
    needsYou.withEvaluator,
    needsYou.notices,
  ]) {
    for (const item of list) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** A kind as a short label: "flake-triage" reads "Flake triage". */
export const askKindLabel = (kind: string): string => {
  const words = kind.replace(/[-_]+/g, " ").trim();
  return words === "" ? "Ask" : words.charAt(0).toUpperCase() + words.slice(1);
};

/** How long an ask has waited: "5d 9h", "3h", "12m", "now". */
export function askAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return minutes > 0 ? `${minutes}m` : "now";
}
