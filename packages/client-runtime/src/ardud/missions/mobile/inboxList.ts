// @effect-diagnostics globalDate:off - Snoozed items come back on the reader's clock.
import type {
  InboxComment,
  InboxMark,
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
  approvalOutcomeLabel,
  DRAFT_STATUS_LABEL,
  draftSentText,
  inboxEntries,
  inboxTabCounts,
  knockOutcomeLabel,
  snoozedEntries,
  SUGGESTION_STATUS_LABEL,
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

/** "All" plus every tab that has something in it. Snoozed items count nowhere. */
export function inboxChips(inbox: MissionInboxSnapshot, nowMs = Date.now()): InboxChip[] {
  const waiting = ownerWaitingEntries(inbox, nowMs).length;
  const counts = inboxTabCounts(inbox, "owner", nowMs);
  return [
    { value: "all", label: "All", count: waiting },
    ...INBOX_TABS.filter((tab) => counts[tab] > 0).map((tab) => ({
      value: tab,
      label: INBOX_TAB_LABEL[tab],
      count: counts[tab],
    })),
  ];
}

/** A filter the inbox can no longer show falls back to "all". */
export function resolveInboxFilter(
  requested: string | null | undefined,
  inbox: MissionInboxSnapshot,
  nowMs = Date.now(),
): InboxFilter {
  if (requested && (INBOX_TABS as ReadonlyArray<string>).includes(requested)) {
    const tab = requested as InboxTab;
    if (inboxTabCounts(inbox, "owner", nowMs)[tab] > 0) return tab;
  }
  return "all";
}

/** "all" is what waits on the owner: decisions, approvals and knocks. */
export function filteredEntries(
  inbox: MissionInboxSnapshot,
  filter: InboxFilter,
  nowMs = Date.now(),
): InboxEntry[] {
  return filter === "all"
    ? ownerWaitingEntries(inbox, nowMs)
    : inboxEntries(inbox, filter, "owner", nowMs);
}

const WAITING_TABS: ReadonlyArray<InboxTab> = ["decide", "approve", "knocks"];

/** What the owner snoozed under this filter, soonest back first. */
export function snoozedFor(
  inbox: MissionInboxSnapshot,
  filter: InboxFilter,
  nowMs = Date.now(),
): InboxEntry[] {
  return snoozedEntries(inbox, nowMs, filter === "all" ? WAITING_TABS : [filter]);
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

/** Any inbox item by its row key, whichever tab, whoever it is routed to, snoozed or not. */
export function findEntry(
  inbox: MissionInboxSnapshot,
  key: string,
  nowMs = Date.now(),
): InboxEntry | null {
  for (const route of ["owner", "master"] as const) {
    for (const tab of INBOX_TABS) {
      const found = inboxEntries(inbox, tab, route, nowMs).find((entry) => entry.key === key);
      if (found) return found;
    }
  }
  return snoozedEntries(inbox, nowMs).find((entry) => entry.key === key) ?? null;
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
  /** The owner's comments, including notes given with the decision. */
  readonly comments: ReadonlyArray<InboxComment>;
  /** A draft's text as it went out, when that differs from what was approved. */
  readonly sent: string | null;
}

/** What was decided in the last day, newest first, with any condition quote and comments. */
export function decidedRows(
  history: Pick<MissionInboxHistory, "asks" | "drafts" | "approvals" | "knocks" | "suggestions">,
  nowMs: number,
  marks: ReadonlyArray<InboxMark> = [],
): DecidedRowView[] {
  const age = (at: string | null | undefined, fallback: string) =>
    ageView(at ?? fallback, nowMs)?.label ?? null;
  const commentsBy = new Map(marks.map((mark) => [mark.id, mark.comments]));
  const comments = (key: string) => commentsBy.get(key) ?? [];
  const rows: Array<DecidedRowView & { readonly at: string }> = [
    ...history.asks.map((ask) => ({
      key: `ask:${ask.id}`,
      title: ask.question,
      outcome: ask.status === "answered" ? "Answered" : "Closed",
      at: ask.answer?.answeredAt ?? ask.createdAt,
      age: age(ask.answer?.answeredAt, ask.createdAt),
      condition: ask.answer ? (ownerConditionOf(ask.answer)?.quote ?? null) : null,
      comments: comments(`ask:${ask.id}`),
      sent: null,
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
      comments: comments(`draft:${draft.id}`),
      sent: draftSentText(draft),
    })),
    ...history.approvals.map((approval) => ({
      key: `approval:${approval.id}`,
      title: approval.title,
      outcome: approvalOutcomeLabel(approval),
      at: approval.decidedAt ?? approval.createdAt,
      age: age(approval.decidedAt, approval.createdAt),
      condition: ownerConditionOf(approval)?.quote ?? null,
      comments: comments(`approval:${approval.id}`),
      sent: null,
    })),
    ...history.knocks.map((knock) => ({
      key: `knock:${knock.id}`,
      title: knock.summary,
      outcome: knockOutcomeLabel(knock),
      at: knock.decidedAt ?? knock.createdAt,
      age: age(knock.decidedAt, knock.createdAt),
      condition: null,
      comments: comments(`knock:${knock.id}`),
      sent: null,
    })),
    ...history.suggestions.map((suggestion) => ({
      key: `suggestion:${suggestion.id}`,
      title: suggestion.title,
      outcome: SUGGESTION_STATUS_LABEL[suggestion.status],
      at: suggestion.decidedAt ?? suggestion.createdAt,
      age: age(suggestion.decidedAt, suggestion.createdAt),
      condition: null,
      comments: comments(`suggestion:${suggestion.id}`),
      sent: null,
    })),
  ];
  return rows
    .sort((left, right) => right.at.localeCompare(left.at))
    .map(({ at: _at, ...row }) => row);
}
