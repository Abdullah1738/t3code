import type {
  Approval,
  Draft,
  MissionId,
  MissionListSnapshot,
  Note,
  SubMissionId,
} from "@t3tools/contracts";

import { NOTE_TYPE_LABEL } from "./inboxViewModel.ts";

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
