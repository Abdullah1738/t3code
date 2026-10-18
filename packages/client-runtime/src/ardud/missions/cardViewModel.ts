import type {
  Approval,
  Draft,
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

/** Items routed to the master that the owner can still decide: drafts, approvals, suggestions. */
export function masterRoutedEntries(inbox: MissionInboxSnapshot): InboxEntry[] {
  return [
    ...inboxEntries(inbox, "approve", "master"),
    ...inboxEntries(inbox, "suggestions", "master"),
  ];
}
