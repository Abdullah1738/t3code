/**
 * Drafts and draft notes. Every outward text (Linear, GitHub, Cliq, iMessage,
 * WhatsApp, email) is a draft until the owner approves it. Owner direction:
 * "save notes on how I want drafts to be", so writers load matching notes and
 * past approved examples every time, and the owner's edits teach new notes
 * (see draftLearning.ts). Sending is a later step; approving records
 * `approved` and stops.
 */
import {
  isOwnerProvenance,
  type DecideDraftInput,
  type Draft,
  type DraftChannel,
  type DraftId,
  type DraftNote,
  type DraftNoteId,
  type DraftNoteScope,
  type MissionId,
  type MissionLink,
  type MissionProvenance,
  type MissionRecordRef,
  type RoleId,
} from "@t3tools/contracts";

import {
  actorOf,
  callerActsAs,
  callerIsOwner,
  clipSummary,
  normalizeText,
  ok,
  refuse,
  type MissionCaller,
  type Outcome,
  type Transition,
} from "./shared.ts";

export const draftRef = (draft: Pick<Draft, "id" | "audience" | "channel">): MissionRecordRef => ({
  kind: "draft",
  id: draft.id,
  label: `${draft.channel} to ${draft.audience}`,
});

export const draftNoteRef = (note: Pick<DraftNote, "id" | "text">): MissionRecordRef => ({
  kind: "draft-note",
  id: note.id,
  label: note.text,
});

/** Where a draft is going; notes match on channel and person. */
export interface DraftAddress {
  readonly missionId: MissionId;
  readonly channel: DraftChannel;
  readonly audience: string;
}

const scopeRank = (scope: DraftNoteScope): number =>
  scope._tag === "all" ? 0 : scope._tag === "channel" ? 1 : 2;

export const scopeMatches = (scope: DraftNoteScope, address: DraftAddress): boolean => {
  switch (scope._tag) {
    case "all":
      return true;
    case "channel":
      return scope.channel === address.channel;
    case "person":
      return normalizeText(scope.name) === normalizeText(address.audience);
  }
};

export const describeScope = (scope: DraftNoteScope): string => {
  switch (scope._tag) {
    case "all":
      return "all drafts";
    case "channel":
      return `${scope.channel} drafts`;
    case "person":
      return `drafts to ${scope.name}`;
  }
};

/**
 * Active notes for a draft, broadest first so a person note reads last and
 * wins where it disagrees with a channel or global note.
 */
export const notesFor = (address: DraftAddress, notes: ReadonlyArray<DraftNote>): DraftNote[] =>
  notes
    .filter(
      (note) =>
        note.active &&
        (note.missionId === null || note.missionId === address.missionId) &&
        scopeMatches(note.scope, address),
    )
    .toSorted(
      (left, right) =>
        scopeRank(left.scope) - scopeRank(right.scope) ||
        left.createdAt.localeCompare(right.createdAt),
    );

export interface DraftExample {
  readonly draftId: DraftId;
  readonly audience: string;
  readonly text: string;
  readonly edited: boolean;
}

/** Recent approved texts for the same channel, same person first: the house style by example. */
export const draftExamples = (
  address: DraftAddress,
  drafts: ReadonlyArray<Draft>,
  limit = 3,
): DraftExample[] =>
  drafts
    .filter(
      (draft) =>
        draft.channel === address.channel &&
        (draft.status === "approved" || draft.status === "sent") &&
        draft.decidedAt !== null,
    )
    .toSorted((left, right) => {
      const person =
        Number(normalizeText(right.audience) === normalizeText(address.audience)) -
        Number(normalizeText(left.audience) === normalizeText(address.audience));
      return person || (right.decidedAt ?? "").localeCompare(left.decidedAt ?? "");
    })
    .slice(0, limit)
    .map((draft) => ({
      draftId: draft.id,
      audience: draft.audience,
      text: draft.approvedText ?? draft.text,
      edited: draft.approvedText !== null && draft.approvedText !== draft.text,
    }));

export interface SubmitDraftCommand {
  readonly id: DraftId;
  readonly missionId: MissionId;
  readonly audience: string;
  readonly channel: DraftChannel;
  readonly target: MissionLink;
  readonly text: string;
  readonly source: Draft["source"];
  /** The writer role the caller drafts as, when it holds one. */
  readonly writerRoleId: RoleId | null;
  readonly caller: MissionCaller;
  readonly notes: ReadonlyArray<DraftNote>;
  /** Drafts already in the mission, for dedupe. */
  readonly existing: ReadonlyArray<Draft>;
  readonly now: string;
}

const awaitingOwner = (draft: Draft) =>
  draft.status === "pending" || draft.status === "rewrite-requested";

export const submitDraft = (command: SubmitDraftCommand): Outcome<Transition<Draft>> => {
  const { caller } = command;
  if (callerIsOwner(caller)) {
    return refuse("forbidden", "Drafts come from writers; the owner sends his own words directly.");
  }
  if (
    command.writerRoleId !== null &&
    !callerActsAs(caller, { _tag: "role", roleId: command.writerRoleId })
  ) {
    return refuse("forbidden", "The caller does not hold the writer role it drafts as.");
  }
  const text = command.text.trim();
  if (text.length === 0) return refuse("invalid", "A draft needs text.");
  const audience = command.audience.trim();
  if (audience.length === 0) return refuse("invalid", "Say who the draft is for.");
  const duplicate = command.existing.find(
    (draft) =>
      draft.missionId === command.missionId &&
      awaitingOwner(draft) &&
      draft.channel === command.channel &&
      sameTarget(draft.target, command.target) &&
      normalizeText(draft.text) === normalizeText(text),
  );
  if (duplicate !== undefined) {
    return refuse("conflict", `Same draft already waiting as ${duplicate.id}.`);
  }
  const address = { missionId: command.missionId, channel: command.channel, audience };
  const applied = notesFor(address, command.notes);
  const record: Draft = {
    id: command.id,
    missionId: command.missionId,
    audience,
    channel: command.channel,
    target: command.target,
    text,
    approvedText: null,
    writerRoleId: command.writerRoleId,
    source: command.source,
    appliedNoteIds: applied.map((note) => note.id),
    status: "pending",
    rewriteNote: null,
    decidedBy: null,
    decidedAt: null,
    sentAt: null,
    createdAt: command.now,
  };
  return ok({
    record,
    events: [
      {
        kind: "draft.opened",
        actor: actorOf(caller.provenance),
        provenance: caller.provenance,
        summary: clipSummary(`Draft for ${audience} (${command.channel}): ${text}`),
        subject: draftRef(record),
        payload: { appliedNoteIds: record.appliedNoteIds, source: command.source },
      },
    ],
  });
};

const sameTarget = (left: MissionLink, right: MissionLink) =>
  left.kind === right.kind &&
  (left.url ?? left.ref ?? left.label) === (right.url ?? right.ref ?? right.label);

/** Before and after of an owner edit; draftLearning turns repeats into note suggestions. */
export interface DraftEdit {
  readonly draftId: DraftId;
  readonly before: string;
  readonly after: string;
}

export interface DraftDecision extends Transition<Draft> {
  readonly edit: DraftEdit | null;
}

export interface DecideDraftCommand {
  readonly draft: Draft;
  readonly input: DecideDraftInput;
  /** Owner app session, or the verified iMessage inbound. */
  readonly provenance: MissionProvenance;
  readonly now: string;
}

export const decideDraft = (command: DecideDraftCommand): Outcome<DraftDecision> => {
  const { draft, input, provenance } = command;
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner approves, rewrites or drops drafts.");
  }
  if (provenance._tag === "owner-imessage" && provenance.inboundId !== input.inboundId) {
    return refuse("provenance-invalid", "The verified inbound does not match this decision.");
  }
  if (input.draftId !== draft.id) return refuse("invalid", "Decision is for a different draft.");
  if (draft.status !== "pending") {
    return refuse("conflict", `Draft ${draft.id} is ${draft.status}.`);
  }
  const decided = { decidedBy: provenance, decidedAt: command.now };
  switch (input.action) {
    case "approve": {
      const edited = input.editedText?.trim();
      const changed = edited !== undefined && edited.length > 0 && edited !== draft.text;
      if (edited !== undefined && edited.length === 0) {
        return refuse("invalid", "Edited text is empty; drop the draft instead.");
      }
      const record: Draft = {
        ...draft,
        ...decided,
        status: "approved",
        approvedText: changed ? edited : null,
      };
      return ok({
        record,
        edit: changed ? { draftId: draft.id, before: draft.text, after: edited } : null,
        events: [
          decisionEvent(record, provenance, changed ? "Approved with edits" : "Approved", {
            action: "approve",
            edited: changed,
          }),
        ],
      });
    }
    case "rewrite": {
      const note = input.rewriteNote?.trim() ?? "";
      if (note.length === 0) return refuse("invalid", "Say what to change for the rewrite.");
      const record: Draft = {
        ...draft,
        ...decided,
        status: "rewrite-requested",
        rewriteNote: note,
      };
      return ok({
        record,
        edit: null,
        events: [
          decisionEvent(record, provenance, `Rewrite: ${note}`, { action: "rewrite", note }),
        ],
      });
    }
    case "drop": {
      const record: Draft = { ...draft, ...decided, status: "dropped" };
      return ok({
        record,
        edit: null,
        events: [decisionEvent(record, provenance, "Dropped", { action: "drop" })],
      });
    }
  }
};

const decisionEvent = (
  record: Draft,
  provenance: MissionProvenance,
  verb: string,
  payload: Record<string, unknown>,
) => ({
  kind: "draft.decided" as const,
  actor: actorOf(provenance),
  provenance,
  summary: clipSummary(`${verb}: draft for ${record.audience} (${record.channel})`),
  subject: draftRef(record),
  payload,
});

export interface ReviseDraftCommand {
  readonly draft: Draft;
  readonly text: string;
  readonly caller: MissionCaller;
  readonly notes: ReadonlyArray<DraftNote>;
  readonly now: string;
}

/** The writer answers a rewrite request; the draft goes back to the owner. */
export const reviseDraft = (command: ReviseDraftCommand): Outcome<Transition<Draft>> => {
  const { draft, caller } = command;
  if (callerIsOwner(caller)) {
    return refuse("forbidden", "The owner edits while approving; revisions come from the writer.");
  }
  if (
    draft.writerRoleId !== null &&
    !callerActsAs(caller, { _tag: "role", roleId: draft.writerRoleId })
  ) {
    return refuse("forbidden", "Only the draft's writer revises it.");
  }
  if (draft.status !== "rewrite-requested" && draft.status !== "pending") {
    return refuse("conflict", `Draft ${draft.id} is ${draft.status}.`);
  }
  const text = command.text.trim();
  if (text.length === 0) return refuse("invalid", "A draft needs text.");
  if (text === draft.text) return refuse("conflict", "The revision is the same text.");
  const applied = notesFor(draft, command.notes);
  const record: Draft = {
    ...draft,
    text,
    status: "pending",
    appliedNoteIds: applied.map((note) => note.id),
    decidedBy: null,
    decidedAt: null,
  };
  return ok({
    record,
    events: [
      {
        kind: "draft.opened",
        actor: actorOf(caller.provenance),
        provenance: caller.provenance,
        summary: clipSummary(`Revised draft for ${draft.audience} (${draft.channel}): ${text}`),
        subject: draftRef(record),
        payload: {
          revision: true,
          previousText: draft.text,
          rewriteNote: draft.rewriteNote,
          appliedNoteIds: record.appliedNoteIds,
        },
      },
    ],
  });
};

/** The way back out: the owner un-approves (before it is sent) or un-drops a draft. */
export const reopenDraft = (
  draft: Draft,
  provenance: MissionProvenance,
  now: string,
): Outcome<Transition<Draft>> => {
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner reopens a draft.");
  }
  if (draft.status !== "approved" && draft.status !== "dropped") {
    return refuse(
      "conflict",
      `Draft ${draft.id} is ${draft.status}; only approved or dropped reopen.`,
    );
  }
  const record: Draft = {
    ...draft,
    status: "pending",
    approvedText: null,
    decidedBy: null,
    decidedAt: null,
  };
  return ok({
    record,
    events: [
      decisionEvent(record, provenance, "Reopened", {
        action: "reopen",
        previousStatus: draft.status,
        previousApprovedText: draft.approvedText,
        at: now,
      }),
    ],
  });
};

/** Owner-approved edit pairs on record: the raw material for edit learning. */
export const ownerEdits = (drafts: ReadonlyArray<Draft>): Array<DraftEdit & { draft: Draft }> =>
  drafts
    .filter(
      (draft) =>
        (draft.status === "approved" ||
          draft.status === "sent" ||
          draft.status === "send-failed") &&
        draft.approvedText !== null &&
        draft.approvedText !== draft.text,
    )
    .toSorted((left, right) => (left.decidedAt ?? "").localeCompare(right.decidedAt ?? ""))
    .map((draft) => ({
      draft,
      draftId: draft.id,
      before: draft.text,
      after: draft.approvedText ?? draft.text,
    }));

// ---------------------------------------------------------------------------
// Draft notes (owner-written or accepted from a suggestion)

export interface SaveDraftNoteCommand {
  readonly id: DraftNoteId;
  /** The note being changed, or null for a new one. */
  readonly existing: DraftNote | null;
  readonly missionId: MissionId | null;
  readonly scope: DraftNoteScope;
  readonly text: string;
  readonly active: boolean;
  readonly source: DraftNote["source"];
  readonly provenance: MissionProvenance;
  /** All notes, for dedupe. */
  readonly notes: ReadonlyArray<DraftNote>;
  readonly now: string;
}

const sameScope = (left: DraftNoteScope, right: DraftNoteScope) =>
  left._tag === right._tag &&
  (left._tag !== "channel" || (right._tag === "channel" && left.channel === right.channel)) &&
  (left._tag !== "person" ||
    (right._tag === "person" && normalizeText(left.name) === normalizeText(right.name)));

/**
 * Create, edit, retire or restore a note. Only the owner writes notes; an
 * accepted suggestion writes one with the owner's acceptance as provenance.
 */
export const saveDraftNote = (command: SaveDraftNoteCommand): Outcome<Transition<DraftNote>> => {
  const { provenance, existing } = command;
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner writes draft notes; agents suggest them.");
  }
  const text = command.text.trim();
  if (text.length === 0) return refuse("invalid", "A draft note needs text.");
  const duplicate = command.notes.find(
    (note) =>
      note.id !== command.id &&
      note.active &&
      command.active &&
      note.missionId === command.missionId &&
      sameScope(note.scope, command.scope) &&
      normalizeText(note.text) === normalizeText(text),
  );
  if (duplicate !== undefined) {
    return refuse("conflict", `Same note already saved as ${duplicate.id}.`);
  }
  const record: DraftNote = {
    id: command.id,
    missionId: command.missionId,
    scope: command.scope,
    text,
    source: existing?.source ?? command.source,
    active: command.active,
    createdAt: existing?.createdAt ?? command.now,
    updatedAt: command.now,
  };
  const action =
    existing === null
      ? "created"
      : existing.active && !command.active
        ? "retired"
        : !existing.active && command.active
          ? "restored"
          : "updated";
  return ok({
    record,
    events: [
      {
        kind: "draft-note.updated",
        actor: { _tag: "owner" },
        provenance,
        summary: clipSummary(`Draft note ${action} (${describeScope(command.scope)}): ${text}`),
        subject: draftNoteRef(record),
        payload: {
          action,
          previous: existing === null ? null : { text: existing.text, scope: existing.scope },
        },
      },
    ],
  });
};
