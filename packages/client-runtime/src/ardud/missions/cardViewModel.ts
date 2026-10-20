import type {
  Approval,
  Draft,
  MissionHealth,
  MissionId,
  MissionListSnapshot,
  Note,
  SubMissionId,
} from "@t3tools/contracts";

import {
  inboxEntries,
  NOTE_TYPE_LABEL,
  SUGGESTION_TARGET_LABEL,
  type InboxEntry,
} from "./inboxViewModel.ts";
import type { MissionInboxSnapshot } from "./source.ts";
import { formatDayLabel, refLabel } from "./viewModel.ts";

// Wording for the card frame: kickers, flags and the sub-mission link. Pure,
// so the views track can reuse it when a template binds the same fields.

export const APPROVAL_KICKER: Record<Approval["kind"], string> = {
  merge: "Merge",
  deploy: "Deploy",
  release: "Release",
  other: "Approval",
};

/** "Review feedback" for drafts a review system opened, "Draft" otherwise. */
export function draftKicker(draft: Pick<Draft, "requestedBy">): string {
  return draft.requestedBy ? "Review feedback" : "Draft";
}

/** The draft's title: its one-line summary, else who it goes to. */
export function draftTitle(draft: Pick<Draft, "summary" | "audience">): string {
  const summary = draft.summary?.trim() ?? "";
  return summary === "" ? `To ${draft.audience}` : summary;
}

export function noteKicker(note: Pick<Note, "type">): string {
  return NOTE_TYPE_LABEL[note.type];
}

export type CardFlagTone = "neutral" | "warning" | "error";

export interface CardFlag {
  readonly label: string;
  readonly tone: CardFlagTone;
}

/** Severity, basis and evidence state of a note as chips; quiet ones are left out. */
export function noteFlags(
  note: Pick<Note, "severity" | "basis" | "evidence" | "citation">,
): CardFlag[] {
  const flags: CardFlag[] = [];
  if (note.severity === "critical") flags.push({ label: "Critical", tone: "error" });
  if (note.severity === "high") flags.push({ label: "High", tone: "warning" });
  if (note.basis !== "observed") flags.push({ label: "Claimed", tone: "neutral" });
  if (note.evidence === "mismatch") flags.push({ label: "Evidence differs", tone: "error" });
  if (note.evidence === "missing") flags.push({ label: "No evidence", tone: "warning" });
  if (note.citation === "failed") flags.push({ label: "Quote differs", tone: "error" });
  return flags;
}

export interface CardSubMissionView {
  readonly missionId: MissionId;
  readonly subMissionId: SubMissionId;
  /** 1-based priority rank. */
  readonly rank: number;
  readonly title: string;
}

/** Rank and title of a record's sub-mission, from the sidebar list. */
export function cardSubMission(
  list: MissionListSnapshot | undefined,
  missionId: MissionId | null,
  subMissionId: SubMissionId | null | undefined,
): CardSubMissionView | null {
  if (!list || missionId === null || !subMissionId) return null;
  const mission = list.missions.find((candidate) => candidate.id === missionId);
  const sub = mission?.subMissions.find((candidate) => candidate.id === subMissionId);
  if (!sub) return null;
  return { missionId, subMissionId: sub.id, rank: sub.order + 1, title: sub.title };
}

export interface EntryHeadline {
  readonly kicker: string;
  readonly title: string;
  /** When it started waiting. */
  readonly since: string;
}

/** Kicker, title and age of any inbox entry, for one-line rows (pinned strip, lists). */
export function entryHeadline(entry: InboxEntry): EntryHeadline {
  const since = entry.record.createdAt;
  switch (entry.kind) {
    case "ask":
      return {
        kicker: entry.record.urgency === "p0" ? "Urgent decision" : "Decision",
        title: entry.record.question,
        since,
      };
    case "draft":
      return { kicker: draftKicker(entry.record), title: draftTitle(entry.record), since };
    case "approval":
      return { kicker: APPROVAL_KICKER[entry.record.kind], title: entry.record.title, since };
    case "knock":
      return { kicker: "Knock", title: entry.record.summary, since };
    case "suggestion":
      return {
        kicker: SUGGESTION_TARGET_LABEL[entry.record.targetKind],
        title: entry.record.title,
        since,
      };
    case "note":
      return { kicker: noteKicker(entry.record), title: entry.record.summary, since };
  }
}

export interface EntryRowView extends EntryHeadline {
  readonly key: string;
  /** The sub-mission it belongs to, when the record names one. */
  readonly sub: CardSubMissionView | null;
  /** What it is about when there is no sub-mission: a PR, a thread, a record. */
  readonly about: string | null;
}

/** One inbox list row: headline plus the sub-mission or subject on its second line. */
export function entryRow(entry: InboxEntry, list: MissionListSnapshot | undefined): EntryRowView {
  const headline = { key: entry.key, ...entryHeadline(entry) };
  switch (entry.kind) {
    case "ask":
    case "note": {
      const sub = cardSubMission(list, entry.record.missionId, entry.record.subMissionId);
      return { ...headline, sub, about: null };
    }
    case "draft":
      return { ...headline, sub: null, about: blankToNull(entry.record.target.label) };
    case "approval":
      return { ...headline, sub: null, about: blankToNull(entry.record.links[0]?.label) };
    case "knock":
      return { ...headline, sub: null, about: blankToNull(entry.record.fromTitle) };
    case "suggestion":
      return {
        ...headline,
        sub: null,
        about: entry.record.target ? blankToNull(refLabel(entry.record.target)) : null,
      };
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export interface InboxEntryGroup {
  /** Null for items that belong to no mission. */
  readonly missionId: MissionId | null;
  readonly title: string | null;
  readonly health: MissionHealth | null;
  readonly paused: boolean;
  readonly entries: readonly InboxEntry[];
}

/**
 * Inbox entries grouped by mission, in sidebar order. Missions missing from
 * the list follow in first-seen order; items without a mission come last.
 * Entries keep their order inside each group.
 */
export function groupEntriesByMission(
  entries: readonly InboxEntry[],
  list: MissionListSnapshot | undefined,
): InboxEntryGroup[] {
  const byMission = new Map<MissionId | null, InboxEntry[]>();
  for (const entry of entries) {
    const missionId = entry.record.missionId;
    const bucket = byMission.get(missionId);
    if (bucket) bucket.push(entry);
    else byMission.set(missionId, [entry]);
  }
  const groups: InboxEntryGroup[] = [];
  for (const mission of list?.missions ?? []) {
    const bucket = byMission.get(mission.id);
    if (!bucket) continue;
    byMission.delete(mission.id);
    groups.push({
      missionId: mission.id,
      title: mission.title,
      health: mission.health,
      paused: mission.status === "paused",
      entries: bucket,
    });
  }
  const unowned = byMission.get(null);
  byMission.delete(null);
  for (const [missionId, bucket] of byMission) {
    groups.push({ missionId, title: null, health: null, paused: false, entries: bucket });
  }
  if (unowned) {
    groups.push({ missionId: null, title: null, health: null, paused: false, entries: unowned });
  }
  return groups;
}

/**
 * What waits on the owner in one inbox, longest waiting first: decisions,
 * drafts and approvals routed to the owner, knocks. Its length is the
 * mission's needs-you count.
 */
export function ownerWaitingEntries(inbox: MissionInboxSnapshot): InboxEntry[] {
  return [
    ...inboxEntries(inbox, "decide"),
    ...inboxEntries(inbox, "approve"),
    ...inboxEntries(inbox, "knocks"),
  ].sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt));
}

/**
 * The inbox heading's line, from `ownerWaitingEntries` (oldest first):
 * "3 holds wait on you, the oldest since Wed 7 Oct." Null when nothing waits.
 */
export function inboxLead(
  waiting: ReadonlyArray<InboxEntry>,
): { readonly strong: string; readonly after: string } | null {
  const oldest = waiting[0];
  if (!oldest) return null;
  const since = formatDayLabel(oldest.record.createdAt);
  return waiting.length === 1
    ? { strong: "1 hold", after: ` waits on you, since ${since}.` }
    : { strong: `${waiting.length} holds`, after: ` wait on you, the oldest since ${since}.` };
}

/** Items routed to the master that the owner can still decide: drafts, approvals, suggestions. */
export function masterRoutedEntries(inbox: MissionInboxSnapshot): InboxEntry[] {
  return [
    ...inboxEntries(inbox, "approve", "master"),
    ...inboxEntries(inbox, "suggestions", "master"),
  ];
}
