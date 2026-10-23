import type {
  CallId,
  DraftNoteId,
  MissionId,
  MissionRecordRef,
  SubMissionId,
} from "@t3tools/contracts";
import {
  addDraftNoteInput,
  askSectionChangeText,
  discussRequestInput,
  discussSectionText,
  openRequestInput,
  parseShareInput,
  replyRequestInput,
  viewSectionRequest,
  type DraftNoteScopeChoice,
  type MissionViewsState,
  type OwnerRequest,
  type RequestDraftImage,
  type ViewSectionChange,
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

/** "Fine" accepts the call. Discuss is a request about the call (`discussRecord`). */
export function reactToCall(callId: string, reaction: "ok") {
  return runMissionAction(
    missionsSource.reactToCall({ callId: callId as CallId, reaction }),
    "Could not record your reaction",
  );
}

/**
 * Discuss on any Needs-you card: the owner's words open a request about the
 * record, or add to the one already open about it. The record keeps waiting.
 */
export function discussRecord(
  missionId: MissionId,
  subject: MissionRecordRef,
  text: string,
  images: ReadonlyArray<RequestDraftImage> = [],
) {
  return submitMissionInput(
    discussRequestInput(missionId, subject, text, images),
    async (input) => {
      await missionsSource.openRequest(input);
    },
    "Couldn't send it to the master",
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

// --- Layout (views record) ---

/** One section-menu or Views-tab change, sent as the views RPC it maps to. */
export function changeSection(views: MissionViewsState, key: string, change: ViewSectionChange) {
  const request = viewSectionRequest(views.snapshot, key, change);
  if (request === null) return Promise.resolve(true);
  return runMissionAction(missionsSource.changeView(request), "Couldn't change the layout");
}

/**
 * Discuss or "Ask the master to change" on a section or tab: an owner request
 * the master answers in Your requests. Layout entries are not mission records,
 * so the request carries the section's name in its text, not a subject.
 */
export function askAboutSection(
  missionId: MissionId,
  title: string,
  kind: "discuss" | "change",
  text: string,
) {
  const body =
    kind === "discuss" ? discussSectionText(title, text) : askSectionChangeText(title, text);
  return submitMissionInput(
    text.trim() === ""
      ? { ok: false, error: "Write what you want first." }
      : openRequestInput(missionId, body),
    (input) => missionsSource.openRequest(input),
    kind === "discuss" ? "Couldn't open the discussion" : "Couldn't ask the master",
  );
}

// --- Your requests ---

/** Resolves to the new request, or null when it couldn't be sent. */
export async function openRequest(
  missionId: MissionId,
  text: string,
  images: ReadonlyArray<RequestDraftImage> = [],
) {
  const created: { request: OwnerRequest | null } = { request: null };
  const sent = await submitMissionInput(
    openRequestInput(missionId, text, images),
    async (input) => {
      created.request = await missionsSource.openRequest(input);
    },
    "Couldn't send it to the master",
  );
  return sent ? created.request : null;
}

export function replyRequest(
  requestId: string,
  text: string,
  images: ReadonlyArray<RequestDraftImage> = [],
) {
  return submitMissionInput(
    replyRequestInput(requestId, text, images),
    (input) => missionsSource.replyRequest(input),
    "Couldn't send the reply",
  );
}

/** A non-empty note is the owner's closing words: the master wakes once with them. */
export function settleRequest(requestId: string, note?: string) {
  return runMissionAction(missionsSource.settleRequest({ requestId, note }), "Couldn't settle it");
}

export function reopenRequest(requestId: string, note?: string) {
  return runMissionAction(missionsSource.reopenRequest({ requestId, note }), "Couldn't reopen it");
}

/** Quiet: a failed read mark only leaves the unread dot on. */
export function markRequestRead(requestId: string) {
  void missionsSource.markRequestRead({ requestId }).catch(() => undefined);
}
