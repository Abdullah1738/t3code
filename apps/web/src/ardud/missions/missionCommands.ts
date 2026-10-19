import type {
  CallId,
  DraftNoteId,
  ForkId,
  MissionId,
  MissionRecordRef,
  SubMissionId,
} from "@t3tools/contracts";
import {
  addDraftNoteInput,
  askSectionChangeInput,
  askTheMissionInput,
  discussSectionInput,
  openRequestInput,
  parseShareInput,
  replyRequestInput,
  type DraftNoteScopeChoice,
  type OwnerRequest,
  type SectionChange,
  type SectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { requestConfirmDialog } from "../../confirmDialog";
import { runMissionAction, submitMissionInput } from "./missionActions";
import { missionsSource } from "./missionsStore";

// Owner actions outside the inbox and rooms (those live in useInboxScreen and
// useRoomScreen). Each resolves true when the source accepted the change, so a
// component only clears its own form state; validation and failure toasts
// happen here.

export function setMissionFocus(missionId: MissionId, subMissionId: SubMissionId | null) {
  return runMissionAction(
    missionsSource.setMissionFocus({ missionId, subMissionId }),
    "Could not change focus",
  );
}

/** Pausing asks first; resuming does not. */
export async function toggleMissionPaused(input: {
  readonly missionId: MissionId;
  readonly title: string;
  readonly paused: boolean;
}): Promise<boolean> {
  if (!input.paused) {
    const confirmed = await (requestConfirmDialog(
      `Pause ${input.title}? Lanes stop at their next safe point and nothing new starts until you resume.`,
    ) ?? Promise.resolve(true));
    if (!confirmed) return false;
  }
  return runMissionAction(
    missionsSource.setMissionPaused({ missionId: input.missionId, paused: !input.paused }),
    input.paused ? "Could not resume the mission" : "Could not pause the mission",
  );
}

export function reorderSubMissions(missionId: MissionId, order: ReadonlyArray<SubMissionId>) {
  return runMissionAction(
    missionsSource.reorderSubMissions({ missionId, order }),
    "Could not reorder sub-missions",
  );
}

/** "Fine" accepts the call; "Discuss" also opens a Discuss fork of the master. */
export function reactToCall(callId: string, reaction: "ok" | "discuss") {
  return runMissionAction(
    missionsSource.reactToCall({ callId: callId as CallId, reaction }),
    "Could not record your reaction",
  );
}

/** Discuss on a record that is not a call: a Discuss fork about that record. */
export function discussRecord(missionId: MissionId, ref: MissionRecordRef) {
  return runMissionAction(
    missionsSource.openFork({ missionId, kind: "discuss", origin: ref }),
    "Couldn't open the discussion",
  );
}

export function markMissionSeen(missionId: MissionId) {
  return runMissionAction(missionsSource.markMissionSeen({ missionId }), "Could not mark as seen");
}

/** Parses "40", "40%" or "0.4"; an empty field clears the share. */
export function setIntendedShare(missionId: MissionId, subMissionId: SubMissionId, text: string) {
  const parsed = parseShareInput(text);
  return submitMissionInput(
    parsed.ok ? { ok: true, value: { missionId, subMissionId, share: parsed.share } } : parsed,
    (input) => missionsSource.setIntendedEffort(input),
    "Couldn't change the share",
  );
}

export function setDraftNoteActive(draftNoteId: DraftNoteId, active: boolean) {
  return runMissionAction(
    missionsSource.setDraftNoteActive({ draftNoteId, active }),
    active ? "Couldn't turn the note on" : "Couldn't turn the note off",
  );
}

export function addDraftNote(
  missionId: MissionId | null,
  scope: DraftNoteScopeChoice,
  text: string,
) {
  return submitMissionInput(
    addDraftNoteInput(missionId, scope, text),
    (input) => missionsSource.addDraftNote(input),
    "Couldn't add the note",
  );
}

/** "Ask the mission": opens an owner-question fork of the master. */
export function askTheMission(missionId: MissionId, question: string) {
  return submitMissionInput(
    askTheMissionInput(missionId, question),
    (input) => missionsSource.openFork(input),
    "Couldn't ask the mission",
  );
}

export function closeFork(forkId: ForkId) {
  return runMissionAction(missionsSource.archiveFork({ forkId }), "Couldn't close the discussion");
}

// --- Overview sections ---

export function changeSection(missionId: MissionId, key: string, change: SectionChange) {
  return runMissionAction(
    missionsSource.changeSection({ missionId, key, change }),
    "Couldn't change the section",
  );
}

export function discussSection(missionId: MissionId, section: SectionEntry) {
  return runMissionAction(
    missionsSource.openFork(discussSectionInput(missionId, section)),
    "Couldn't open the discussion",
  );
}

export function askSectionChange(missionId: MissionId, section: SectionEntry, text: string) {
  return submitMissionInput(
    askSectionChangeInput(missionId, section, text),
    (input) => missionsSource.openFork(input),
    "Couldn't ask the master",
  );
}

// --- Your requests ---

/** Resolves to the new request, or null when it couldn't be sent. */
export async function openRequest(missionId: MissionId, text: string) {
  const created: { request: OwnerRequest | null } = { request: null };
  const sent = await submitMissionInput(
    openRequestInput(missionId, text),
    async (input) => {
      created.request = await missionsSource.openRequest(input);
    },
    "Couldn't send it to the master",
  );
  return sent ? created.request : null;
}

export function replyRequest(requestId: string, text: string) {
  return submitMissionInput(
    replyRequestInput(requestId, text),
    (input) => missionsSource.replyRequest(input),
    "Couldn't send the reply",
  );
}

export function settleRequest(requestId: string) {
  return runMissionAction(missionsSource.settleRequest({ requestId }), "Couldn't settle it");
}

export function reopenRequest(requestId: string) {
  return runMissionAction(missionsSource.reopenRequest({ requestId }), "Couldn't reopen it");
}

/** Quiet: a failed read mark only leaves the unread dot on. */
export function markRequestRead(requestId: string) {
  void missionsSource.markRequestRead({ requestId }).catch(() => undefined);
}
