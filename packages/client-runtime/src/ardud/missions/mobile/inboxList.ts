import type {
  InboxTab,
  MissionId,
  MissionListSnapshot,
  MissionRecordRef,
} from "@t3tools/contracts";

import {
  entryHeadline,
  entryRow,
  groupEntriesByMission,
  ownerWaitingEntries,
  type InboxEntryGroup,
} from "../cardViewModel.ts";
import { inboxEntries, type InboxEntry } from "../inboxViewModel.ts";
import type { MissionInboxSnapshot } from "../source.ts";
import { ageView, refKey } from "../viewModel.ts";
import { INBOX_TABS, INBOX_TAB_LABEL } from "./inbox.ts";
import type { RequestThread } from "./requests.ts";

// The phone inbox as a list: one chip row to filter, rows grouped by mission,
// and a key per row that the item screen opens. Discussions about an item stay
// on that item, so unread answers show on its row and count toward needs-you.

export type InboxFilter = "all" | InboxTab;

export interface InboxChip {
  readonly value: InboxFilter;
  readonly label: string;
  readonly count: number;
}

/** "All" plus every tab that has something in it. */
export function inboxChips(inbox: MissionInboxSnapshot): InboxChip[] {
  const waiting = ownerWaitingEntries(inbox).length;
  return [
    { value: "all", label: "All", count: waiting },
    ...INBOX_TABS.filter((tab) => inbox.counts[tab] > 0).map((tab) => ({
      value: tab,
      label: INBOX_TAB_LABEL[tab],
      count: inbox.counts[tab],
    })),
  ];
}

/** A filter the inbox can no longer show falls back to "all". */
export function resolveInboxFilter(
  requested: string | null | undefined,
  inbox: MissionInboxSnapshot,
): InboxFilter {
  if (requested && (INBOX_TABS as ReadonlyArray<string>).includes(requested)) {
    const tab = requested as InboxTab;
    if (inbox.counts[tab] > 0) return tab;
  }
  return "all";
}

/** "all" is what waits on the owner: decisions, approvals and knocks. */
export function filteredEntries(inbox: MissionInboxSnapshot, filter: InboxFilter): InboxEntry[] {
  return filter === "all" ? ownerWaitingEntries(inbox) : inboxEntries(inbox, filter);
}

export function entriesForMission(
  entries: ReadonlyArray<InboxEntry>,
  missionId: MissionId | null,
): InboxEntry[] {
  return missionId === null
    ? [...entries]
    : entries.filter((entry) => entry.record.missionId === missionId);
}

/** The record a Discuss thread is about. */
export function entrySubject(entry: InboxEntry): MissionRecordRef {
  return {
    kind: entry.kind,
    id: entry.record.id,
    label: entryHeadline(entry).title.slice(0, 120),
  } as MissionRecordRef;
}

export interface InboxRowView {
  readonly key: string;
  readonly kind: InboxEntry["kind"];
  /** The kind tag: "Decision", "Draft", "Knock". */
  readonly tag: string;
  readonly title: string;
  /** Sub-mission rank and title, or what the item is about. Never who asked. */
  readonly place: { readonly rank: number | null; readonly title: string } | null;
  readonly age: string | null;
  readonly urgent: boolean;
  /** A discussion about this item has an answer the owner has not read. */
  readonly unreadDiscussion: boolean;
}

export function inboxRow(
  entry: InboxEntry,
  list: MissionListSnapshot | undefined,
  nowMs: number,
  discussions: ReadonlyArray<RequestThread> = [],
): InboxRowView {
  const row = entryRow(entry, list);
  // Questions never name who is asking (owner, 19 Oct).
  const place = row.sub
    ? { rank: row.sub.rank, title: row.sub.title }
    : entry.kind !== "ask" && row.about
      ? { rank: null, title: row.about }
      : null;
  const subject = refKey(entrySubject(entry));
  return {
    key: row.key,
    kind: entry.kind,
    tag: row.kicker,
    title: row.title,
    place,
    age: ageView(row.since, nowMs)?.label ?? null,
    urgent: entry.kind === "ask" && entry.record.urgency === "p0",
    unreadDiscussion: discussions.some(
      (thread) => thread.unread && thread.subject !== null && refKey(thread.subject) === subject,
    ),
  };
}

export interface InboxSectionView {
  readonly missionId: MissionId | null;
  readonly title: string | null;
  readonly group: InboxEntryGroup;
}

export function inboxSections(
  entries: ReadonlyArray<InboxEntry>,
  list: MissionListSnapshot | undefined,
): InboxSectionView[] {
  return groupEntriesByMission(entries, list).map((group) => ({
    missionId: group.missionId,
    title: group.title,
    group,
  }));
}

/** Any inbox item by its row key, whichever tab it sits in. */
export function findEntry(inbox: MissionInboxSnapshot, key: string): InboxEntry | null {
  for (const tab of INBOX_TABS) {
    const found = inboxEntries(inbox, tab).find((entry) => entry.key === key);
    if (found) return found;
  }
  return null;
}

/**
 * Answered discussions the owner has not read, about records that are not
 * already waiting in the inbox. They count toward needs-you on top of the
 * waiting items.
 */
export function discussionsNeedingYou(
  waiting: ReadonlyArray<InboxEntry>,
  threads: ReadonlyArray<RequestThread>,
): number {
  const waitingKeys = new Set(waiting.map((entry) => refKey(entrySubject(entry))));
  return threads.filter(
    (thread) =>
      thread.unread && thread.subject !== null && !waitingKeys.has(refKey(thread.subject)),
  ).length;
}
