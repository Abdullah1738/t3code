import type {
  InboxTab,
  MissionId,
  MissionInboxHistory,
  MissionListSnapshot,
  MissionRecordRef,
} from "@t3tools/contracts";

import {
  draftTitle,
  entryHeadline,
  entryRow,
  groupEntriesByMission,
  ownerWaitingEntries,
  type InboxEntryGroup,
} from "../cardViewModel.ts";
import {
  APPROVAL_STATUS_LABEL,
  DRAFT_STATUS_LABEL,
  inboxEntries,
  type InboxEntry,
} from "../inboxViewModel.ts";
import { ownerConditionOf } from "../requestsViewModel.ts";
import type { MissionInboxSnapshot, OwnerRequest } from "../source.ts";
import { ageView } from "../viewModel.ts";
import { INBOX_TABS, INBOX_TAB_LABEL } from "./inbox.ts";
import { discussionOn } from "./requests.ts";

// The phone inbox as a list: one chip row to filter, rows grouped by mission,
// and a key per row that the item screen opens. A discussion about an item
// stays on that item: its unread count sits on the row's discussion symbol and
// adds to no other count (owner, 19 Oct).

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
  /** The item's discussion: null before one is opened; `unread` is the symbol's counter. */
  readonly discussion: { readonly unread: number } | null;
}

export function inboxRow(
  entry: InboxEntry,
  list: MissionListSnapshot | undefined,
  nowMs: number,
  requests: ReadonlyArray<OwnerRequest> = [],
): InboxRowView {
  const row = entryRow(entry, list);
  // Questions never name who is asking (owner, 19 Oct).
  const place = row.sub
    ? { rank: row.sub.rank, title: row.sub.title }
    : entry.kind !== "ask" && row.about
      ? { rank: null, title: row.about }
      : null;
  const discussion = discussionOn(requests, entrySubject(entry));
  return {
    key: row.key,
    kind: entry.kind,
    tag: row.kicker,
    title: row.title,
    place,
    age: ageView(row.since, nowMs)?.label ?? null,
    urgent: entry.kind === "ask" && entry.record.urgency === "p0",
    discussion: discussion.request ? { unread: discussion.unread } : null,
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

/** Any inbox item by its row key, whichever tab and whoever it is routed to. */
export function findEntry(inbox: MissionInboxSnapshot, key: string): InboxEntry | null {
  for (const route of ["owner", "master"] as const) {
    for (const tab of INBOX_TABS) {
      const found = inboxEntries(inbox, tab, route).find((entry) => entry.key === key);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decided today

export interface DecidedRowView {
  readonly key: string;
  readonly title: string;
  readonly outcome: string;
  readonly age: string | null;
  /** The owner's words the master decided on, quoted from a discussion. */
  readonly condition: string | null;
}

const KNOCK_OUTCOME = { pending: "Waiting", forwarded: "Forwarded", dropped: "Dropped" } as const;
const SUGGESTION_OUTCOME = {
  open: "Open",
  accepted: "Accepted",
  edited: "Accepted, edited",
  dismissed: "Dismissed",
} as const;

/** What was decided in the last day, newest first, with any condition quote. */
export function decidedRows(
  history: Pick<MissionInboxHistory, "asks" | "drafts" | "approvals" | "knocks" | "suggestions">,
  nowMs: number,
): DecidedRowView[] {
  const age = (at: string | null | undefined, fallback: string) =>
    ageView(at ?? fallback, nowMs)?.label ?? null;
  const rows: Array<DecidedRowView & { readonly at: string }> = [
    ...history.asks.map((ask) => ({
      key: `ask:${ask.id}`,
      title: ask.question,
      outcome: ask.status === "answered" ? "Answered" : "Closed",
      at: ask.answer?.answeredAt ?? ask.createdAt,
      age: age(ask.answer?.answeredAt, ask.createdAt),
      condition: ask.answer ? (ownerConditionOf(ask.answer)?.quote ?? null) : null,
    })),
    ...history.drafts.map((draft) => ({
      key: `draft:${draft.id}`,
      title: draftTitle(draft),
      // ardud missions: views (a withdrawn draft says why)
      outcome: draft.withdrawNote
        ? `Withdrawn: ${draft.withdrawNote}`
        : DRAFT_STATUS_LABEL[draft.status],
      at: draft.decidedAt ?? draft.createdAt,
      age: age(draft.decidedAt, draft.createdAt),
      condition: ownerConditionOf(draft)?.quote ?? null,
    })),
    ...history.approvals.map((approval) => ({
      key: `approval:${approval.id}`,
      title: approval.title,
      outcome: APPROVAL_STATUS_LABEL[approval.status],
      at: approval.decidedAt ?? approval.createdAt,
      age: age(approval.decidedAt, approval.createdAt),
      condition: ownerConditionOf(approval)?.quote ?? null,
    })),
    ...history.knocks.map((knock) => ({
      key: `knock:${knock.id}`,
      title: knock.summary,
      outcome: KNOCK_OUTCOME[knock.status],
      at: knock.decidedAt ?? knock.createdAt,
      age: age(knock.decidedAt, knock.createdAt),
      condition: null,
    })),
    ...history.suggestions.map((suggestion) => ({
      key: `suggestion:${suggestion.id}`,
      title: suggestion.title,
      outcome: SUGGESTION_OUTCOME[suggestion.status],
      at: suggestion.decidedAt ?? suggestion.createdAt,
      age: age(suggestion.decidedAt, suggestion.createdAt),
      condition: null,
    })),
  ];
  return rows
    .sort((left, right) => right.at.localeCompare(left.at))
    .map(({ at: _at, ...row }) => row);
}
