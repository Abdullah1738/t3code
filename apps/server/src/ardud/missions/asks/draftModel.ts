/**
 * Drafts and draft notes. Every outward text (Linear, GitHub, Cliq, iMessage,
 * WhatsApp, email) is a draft until the owner approves it. Owner direction:
 * "save notes on how I want drafts to be", so writers load matching notes and
 * past approved examples every time, and the owner's edits teach new notes
 * (see draftLearning.ts). Sending is a later step; approving records
 * `approved` and stops.
 *
 * Routing: the mission's routing table picks the approver (owner or master)
 * when a draft opens; owner or master can re-route a waiting draft with a
 * reason. The approver decides, the owner can always decide, and a draft
 * routed to the owner waits for him like an ask (no default, no deadline).
 */
import {
  approverOf,
  isOwnerProvenance,
  type ApprovalRoute,
  type Approver,
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
  type OpenSystemDraftInput,
  type OwnerCondition,
  type RecordView,
  type ReportDraftSentInput,
  type RoleId,
  type SubMissionId,
  type SystemDraftDecision,
  type WorkItemId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import { routeApprover } from "../core/approvals.ts";
import {
  actorOf,
  callerActsAs,
  callerIsOwner,
  clipSummary,
  normalizeText,
  ok,
  refuse,
  spendCondition,
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

/**
 * Recent owner-approved texts for the same channel, same person first: the
 * house style by example. A master's approvals don't teach the owner's voice.
 */
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
        draft.decidedAt !== null &&
        draft.decidedBy !== null &&
        isOwnerProvenance(draft.decidedBy),
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

/** The sub-mission and work item a draft is about; routing rows can name either. */
export interface DraftAbout {
  readonly subMissionId: SubMissionId | null;
  readonly workItemId: WorkItemId | null;
}

const NOT_ABOUT: DraftAbout = { subMissionId: null, workItemId: null };

/**
 * Picks a draft's approver from the mission's routing table: first matching row, else the owner.
 * Channel, audience and person match as for core's `routeApprover`; a row that also names a
 * sub-mission or work item matches only drafts about it.
 */
export const routeDraftApprover = (
  routes: ReadonlyArray<ApprovalRoute> | undefined,
  draft: { readonly channel: DraftChannel; readonly audience: string },
  about: DraftAbout,
): { readonly approver: Approver; readonly routeId: string | null } => {
  const row = (routes ?? []).find((route) => {
    if (route.match._tag !== "draft") return false;
    const { subMissionId, workItemId } = route.match;
    if (subMissionId !== undefined && subMissionId !== about.subMissionId) return false;
    if (workItemId !== undefined && workItemId !== about.workItemId) return false;
    // `about` rides along so core's matcher can take over these fields once it knows them.
    const subject = { _tag: "draft", ...draft, person: draft.audience, ...about } as const;
    return routeApprover([route], subject).routeId !== null;
  });
  return row === undefined
    ? { approver: "owner", routeId: null }
    : { approver: row.approver, routeId: row.id };
};

const PULL_LABEL = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PULL_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;

/** `owner/repo` and number of a pull-request link (label `owner/repo#N` or a GitHub URL). */
export const pullRequestKeyOf = (
  link: MissionLink,
): { readonly repository: string; readonly number: number } | null => {
  if (link.kind !== "pull-request") return null;
  const found = PULL_LABEL.exec(link.label) ?? (link.url === null ? null : PULL_URL.exec(link.url));
  if (found === null || found[1] === undefined || found[2] === undefined) return null;
  return { repository: found[1], number: Number(found[2]) };
};

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
  /** What the mission's routing table says (see `routeApprover`). */
  readonly route: { readonly approver: Approver; readonly routeId: string | null };
  /** The role the caller drafts as and the model its binding last ran on. */
  readonly writtenBy: NonNullable<Draft["writtenBy"]>;
  /** What it is about; missing means nothing in particular. */
  readonly about?: DraftAbout;
  readonly view?: RecordView;
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
    approver: command.route.approver,
    routeNote: null,
    summary: null,
    flags: [],
    writtenBy: command.writtenBy,
    requestedBy: null,
    head: null,
    staleReason: null,
    revision: 0,
    revisedAt: command.now,
    ...(command.about ?? NOT_ABOUT),
    ...(command.view === undefined ? {} : { view: command.view }),
  };
  const asks = command.route.approver === "master" ? " (for the master)" : "";
  return ok({
    record,
    events: [
      {
        kind: "draft.opened",
        actor: actorOf(caller.provenance),
        provenance: caller.provenance,
        summary: clipSummary(`Draft for ${audience} (${command.channel})${asks}: ${text}`),
        subject: draftRef(record),
        payload: {
          appliedNoteIds: record.appliedNoteIds,
          source: command.source,
          approver: command.route.approver,
          routeId: command.route.routeId,
          subMissionId: record.subMissionId ?? null,
          workItemId: record.workItemId ?? null,
        },
      },
    ],
  });
};

/** The draft's decision epoch: 0 when written, +1 on every revision and reopen. */
export const revisionOf = (draft: Pick<Draft, "revision">): number => draft.revision ?? 0;

/** When the current epoch began; a decision's evidence must not predate it. */
export const epochOf = (draft: Pick<Draft, "revisedAt" | "createdAt">): string =>
  draft.revisedAt ?? draft.createdAt;

/** Starts a new epoch: whatever was said about the earlier text or decision no longer counts. */
const nextEpoch = (draft: Draft, now: string): Pick<Draft, "revision" | "revisedAt"> => ({
  revision: revisionOf(draft) + 1,
  revisedAt: now,
});

/**
 * Who may act on a draft as its approver: the owner always, the master when
 * routed to it, or when the owner stated a condition about it (verified by the caller).
 */
const approverCheck = (
  draft: Draft,
  provenance: MissionProvenance,
  callerIsMaster: boolean,
  verb: string,
  onOwnerCondition: boolean = false,
): Outcome<null> => {
  if (isOwnerProvenance(provenance)) {
    return onOwnerCondition
      ? refuse("invalid", "The owner decides directly; owner conditions are for the master.")
      : ok(null);
  }
  if (approverOf(draft) === "owner" && !onOwnerCondition) {
    return refuse(
      "provenance-required",
      `Draft ${draft.id} is routed to the owner; he ${verb} it.`,
    );
  }
  if (!callerIsMaster) {
    return refuse("forbidden", `Only the mission's master or the owner ${verb} draft ${draft.id}.`);
  }
  return ok(null);
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
  /** Owner app session, the verified iMessage inbound, or the master's own call. */
  readonly provenance: MissionProvenance;
  /** The caller is the draft mission's master. */
  readonly callerIsMaster: boolean;
  /**
   * Discuss: the master decides on a condition the owner stated about this draft.
   * The caller has verified it against the owner's request already.
   */
  readonly onOwnerCondition?: OwnerCondition;
  readonly now: string;
}

export const decideDraft = (command: DecideDraftCommand): Outcome<DraftDecision> => {
  const { draft, input, provenance } = command;
  const condition = command.onOwnerCondition ?? null;
  const allowed = approverCheck(
    draft,
    provenance,
    command.callerIsMaster,
    "decides",
    condition !== null,
  );
  if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
  if (provenance._tag === "owner-imessage" && provenance.inboundId !== input.inboundId) {
    return refuse("provenance-invalid", "The verified inbound does not match this decision.");
  }
  if (input.draftId !== draft.id) return refuse("invalid", "Decision is for a different draft.");
  if (draft.status !== "pending") {
    return refuse("conflict", `Draft ${draft.id} is ${draft.status}.`);
  }
  if (condition !== null && (draft.spentConditionIds ?? []).includes(condition.requestId)) {
    return refuse(
      "provenance-invalid",
      `Owner request ${condition.requestId} decided draft ${draft.id} before it was reopened; it does not decide it again.`,
    );
  }
  // An approval in the app or by a master binds to the text the decider read;
  // an iMessage approval binds through the revision epoch instead.
  if (
    input.action === "approve" &&
    input.revision === undefined &&
    provenance._tag !== "owner-imessage"
  ) {
    return refuse(
      "invalid",
      `Approving draft ${draft.id} needs the revision you read (now ${revisionOf(draft)}).`,
    );
  }
  if (input.revision !== undefined && input.revision !== revisionOf(draft)) {
    return refuse(
      "conflict",
      `Draft ${draft.id} changed since revision ${input.revision} (now ${revisionOf(draft)}); decide what it says now.`,
    );
  }
  const decided = {
    decidedBy: provenance,
    decidedAt: command.now,
    ...conditionOf(draft, condition),
  };
  const withCondition = (payload: Record<string, unknown>) =>
    condition === null ? payload : { ...payload, onOwnerCondition: condition };
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
          decisionEvent(
            record,
            provenance,
            changed ? "Approved with edits" : "Approved",
            withCondition({ action: "approve", edited: changed }),
          ),
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
          decisionEvent(
            record,
            provenance,
            `Rewrite: ${note}`,
            withCondition({ action: "rewrite", note }),
          ),
        ],
      });
    }
    case "drop": {
      const record: Draft = { ...draft, ...decided, status: "dropped" };
      return ok({
        record,
        edit: null,
        events: [decisionEvent(record, provenance, "Dropped", withCondition({ action: "drop" }))],
      });
    }
  }
};

/** Sets the owner condition a decision rests on, and clears a stale one. */
const conditionOf = (
  draft: Draft,
  condition: OwnerCondition | null,
): Pick<Draft, "onOwnerCondition"> =>
  condition !== null
    ? { onOwnerCondition: condition }
    : (draft.onOwnerCondition ?? null) === null
      ? {}
      : { onOwnerCondition: null };

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
  /** Replaces the draft's view when given. */
  readonly view?: RecordView;
  /** The caller is the draft mission's master: it may revise any writer's draft. */
  readonly callerIsMaster?: boolean;
  readonly now: string;
}

/**
 * The writer (or the mission's master, say after talking it over with the
 * owner) revises a draft; it goes back to its approver with `previousText` set.
 */
export const reviseDraft = (command: ReviseDraftCommand): Outcome<Transition<Draft>> => {
  const { draft, caller } = command;
  if (callerIsOwner(caller)) {
    return refuse("forbidden", "The owner edits while approving; revisions come from the writer.");
  }
  if (
    draft.writerRoleId !== null &&
    !callerActsAs(caller, { _tag: "role", roleId: draft.writerRoleId }) &&
    command.callerIsMaster !== true
  ) {
    return refuse("forbidden", "Only the draft's writer or the mission's master revises it.");
  }
  const requestedBy = draft.requestedBy ?? null;
  if (
    requestedBy !== null &&
    !(caller.provenance._tag === "system" && caller.provenance.component === requestedBy)
  ) {
    return refuse(
      "forbidden",
      `Draft ${draft.id} belongs to ${requestedBy}; it opens a new draft for the head instead.`,
    );
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
    previousText: draft.text,
    status: "pending",
    appliedNoteIds: applied.map((note) => note.id),
    decidedBy: null,
    decidedAt: null,
    ...conditionOf(draft, null),
    ...nextEpoch(draft, command.now),
    ...(command.view === undefined ? {} : { view: command.view }),
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
          epoch: revisionOf(record),
          previousText: draft.text,
          rewriteNote: draft.rewriteNote,
          appliedNoteIds: record.appliedNoteIds,
        },
      },
    ],
  });
};

/**
 * The way back out: un-approve (before it is sent) or un-drop a draft. The
 * owner or the mission's master reopens any decided draft, including one
 * routed to the owner: reopening only puts it back in front of its approver,
 * so it needs no owner proof. Approving it again still does.
 */
export const reopenDraft = (
  draft: Draft,
  provenance: MissionProvenance,
  callerIsMaster: boolean,
  now: string,
): Outcome<Transition<Draft>> => {
  if (!isOwnerProvenance(provenance) && !callerIsMaster) {
    return refuse("forbidden", `Only the mission's master or the owner reopens draft ${draft.id}.`);
  }
  if ((draft.staleReason ?? null) !== null) {
    return refuse(
      "conflict",
      `Draft ${draft.id} was closed as stale (${draft.staleReason}); its head moved, so it no longer counts.`,
    );
  }
  if (draft.status !== "approved" && draft.status !== "dropped") {
    return refuse(
      "conflict",
      `Draft ${draft.id} is ${draft.status}; only approved or dropped reopen.`,
    );
  }
  // The owner request a decision rested on is spent: reopening takes that
  // decision back, so the same condition cannot decide the draft again.
  const spent = draft.onOwnerCondition ?? null;
  const record: Draft = {
    ...draft,
    status: "pending",
    approvedText: null,
    decidedBy: null,
    decidedAt: null,
    ...conditionOf(draft, null),
    ...(spent === null
      ? {}
      : { spentConditionIds: spendCondition(draft.spentConditionIds, spent.requestId) }),
    ...nextEpoch(draft, now),
  };
  return ok({
    record,
    events: [
      decisionEvent(record, provenance, "Reopened", {
        action: "reopen",
        previousStatus: draft.status,
        previousApprovedText: draft.approvedText,
        epoch: revisionOf(record),
        at: now,
      }),
    ],
  });
};

export interface RouteDraftCommand {
  readonly draft: Draft;
  readonly approver: Approver;
  readonly reason: string;
  readonly provenance: MissionProvenance;
  readonly callerIsMaster: boolean;
}

/**
 * Owner or master sends one waiting draft to the other approver. The reason
 * lands on the record and the timeline; routing to the current approver is a
 * no-op.
 */
export const routeDraft = (command: RouteDraftCommand): Outcome<Transition<Draft>> => {
  const { draft, provenance } = command;
  if (!isOwnerProvenance(provenance) && !command.callerIsMaster) {
    return refuse("forbidden", "Only the owner or the mission's master re-routes a draft.");
  }
  if (!awaitingOwner(draft)) {
    return refuse(
      "conflict",
      `Draft ${draft.id} is ${draft.status}; only waiting drafts re-route.`,
    );
  }
  const reason = command.reason.trim();
  if (reason.length === 0) return refuse("invalid", "Say why the draft moves.");
  const from = approverOf(draft);
  if (from === command.approver) return ok({ record: draft, events: [] });
  const record: Draft = { ...draft, approver: command.approver, routeNote: reason };
  return ok({
    record,
    events: [
      {
        kind: "draft.routed",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(
          `Routed to the ${command.approver}: draft for ${draft.audience} (${draft.channel}) (${reason})`,
        ),
        subject: draftRef(record),
        payload: { approver: command.approver, from, reason },
      },
    ],
  });
};

export interface DraftAnnotation {
  readonly summary: string | null;
  readonly flags: ReadonlyArray<string>;
}

export const annotationOf = (draft: Draft): DraftAnnotation => ({
  summary: draft.summary ?? null,
  flags: draft.flags ?? [],
});

const chips = (flags: ReadonlyArray<string>) =>
  flags.length === 0 ? "" : ` [${flags.join(", ")}]`;

/**
 * Owner or master sets a waiting draft's short summary and flag chips (already cleaned, see
 * `cleanAnnotation`). Same values are a no-op.
 */
export const annotateDraft = (command: {
  readonly draft: Draft;
  readonly annotation: DraftAnnotation;
  readonly provenance: MissionProvenance;
  readonly callerIsMaster: boolean;
}): Outcome<Transition<Draft>> => {
  const { draft, annotation, provenance } = command;
  if (!isOwnerProvenance(provenance) && !command.callerIsMaster) {
    return refuse("forbidden", "Only the owner or the mission's master annotates a draft.");
  }
  if (!awaitingOwner(draft)) {
    return refuse("conflict", `Draft ${draft.id} is ${draft.status}; only waiting drafts change.`);
  }
  const previous = annotationOf(draft);
  if (
    previous.summary === annotation.summary &&
    previous.flags.length === annotation.flags.length &&
    previous.flags.every((flag, index) => flag === annotation.flags[index])
  ) {
    return ok({ record: draft, events: [] });
  }
  const record: Draft = { ...draft, summary: annotation.summary, flags: [...annotation.flags] };
  return ok({
    record,
    events: [
      {
        kind: "draft.annotated",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(
          `Annotated: draft for ${draft.audience} (${draft.channel})${chips(annotation.flags)}`,
        ),
        subject: draftRef(record),
        payload: { summary: annotation.summary, flags: annotation.flags, previous },
      },
    ],
  });
};

const STALE_STATES: ReadonlySet<Draft["status"]> = new Set(["pending", "rewrite-requested"]);

const staleClose = (
  draft: Draft,
  reason: string,
  provenance: MissionProvenance,
  now: string,
): Transition<Draft> => {
  const record: Draft = {
    ...draft,
    status: "dropped",
    staleReason: reason,
    decidedBy: null,
    decidedAt: now,
  };
  return {
    record,
    events: [
      {
        kind: "draft.stale-closed",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(
          `Closed as stale: draft for ${draft.audience} (${draft.channel}) (${reason})`,
        ),
        subject: draftRef(record),
        payload: { reason, head: draft.head ?? null, previousStatus: draft.status },
      },
    ],
  };
};

const requesterCheck = (provenance: MissionProvenance, requestedBy: string): Outcome<null> =>
  provenance._tag === "system" && provenance.component === requestedBy
    ? ok(null)
    : refuse("forbidden", `Only ${requestedBy} opens or closes its own drafts.`);

const shortHead = (head: string) => head.slice(0, 12);

export interface OpenSystemDraftCommand {
  readonly input: OpenSystemDraftInput;
  readonly annotation: DraftAnnotation;
  readonly provenance: MissionProvenance;
  /** The same id, when it exists already. */
  readonly current: Draft | null;
  /** The mission's drafts, to stale-close the ones for an older head. */
  readonly existing: ReadonlyArray<Draft>;
  readonly route: { readonly approver: Approver; readonly routeId: string | null };
  readonly notes: ReadonlyArray<DraftNote>;
  /** What it is about (the work item its pull request belongs to); missing means nothing. */
  readonly about?: DraftAbout;
  readonly now: string;
}

export interface SystemDraftOpened {
  readonly record: Draft;
  /** Older drafts for the same target from the same system, closed as stale. */
  readonly closed: ReadonlyArray<Draft>;
  readonly events: ReadonlyArray<Transition<Draft>["events"][number]>;
}

/**
 * A system (crw) opens a draft for one exact head. Same id and head is a no-op, the same id
 * for another head is refused, and opening a new head stale-closes the system's waiting drafts
 * for that target, so an older head never reads as decided.
 */
export const openSystemDraft = (command: OpenSystemDraftCommand): Outcome<SystemDraftOpened> => {
  const { input, provenance } = command;
  const allowed = requesterCheck(provenance, input.requestedBy);
  if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
  if (command.current !== null) {
    const current = command.current;
    if (current.requestedBy !== input.requestedBy || current.missionId !== input.missionId) {
      return refuse("conflict", `Draft id ${current.id} is taken by another draft.`);
    }
    if (current.head !== input.head) {
      return refuse(
        "conflict",
        `Draft ${current.id} is for head ${shortHead(current.head ?? "none")}; open head ${shortHead(input.head)} under a new id.`,
      );
    }
    return ok({ record: current, closed: [], events: [] });
  }
  // One waiting system draft per target: a new head or a re-draft replaces the older ones.
  const closed = command.existing
    .filter(
      (draft) =>
        draft.missionId === input.missionId &&
        draft.requestedBy === input.requestedBy &&
        STALE_STATES.has(draft.status) &&
        sameTarget(draft.target, input.target),
    )
    .map((draft) =>
      staleClose(
        draft,
        draft.head === input.head
          ? `replaced by ${input.draftId}`
          : `head moved to ${shortHead(input.head)}`,
        provenance,
        command.now,
      ),
    );
  const address = { missionId: input.missionId, channel: input.channel, audience: input.audience };
  const applied = notesFor(address, command.notes);
  const record: Draft = {
    id: input.draftId,
    missionId: input.missionId,
    audience: input.audience,
    channel: input.channel,
    target: input.target,
    text: input.text,
    approvedText: null,
    writerRoleId: null,
    // Draft sources predate system drafts; `requestedBy` says which system wrote it.
    source: { kind: "editor", ref: null },
    appliedNoteIds: applied.map((note) => note.id),
    status: "pending",
    rewriteNote: null,
    decidedBy: null,
    decidedAt: null,
    sentAt: null,
    createdAt: command.now,
    approver: command.route.approver,
    routeNote: null,
    summary: command.annotation.summary,
    flags: [...command.annotation.flags],
    writtenBy: { roleId: null, model: null },
    requestedBy: input.requestedBy,
    head: input.head,
    staleReason: null,
    revision: 0,
    revisedAt: command.now,
    ...(command.about ?? NOT_ABOUT),
    ...(input.view === undefined ? {} : { view: input.view }),
  };
  const asks = command.route.approver === "master" ? " (for the master)" : "";
  return ok({
    record,
    closed: closed.map((transition) => transition.record),
    events: [
      {
        kind: "draft.opened",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(
          `Draft for ${input.audience} (${input.channel}, head ${shortHead(input.head)})${asks}: ${input.text}`,
        ),
        subject: draftRef(record),
        payload: {
          appliedNoteIds: record.appliedNoteIds,
          source: record.source,
          approver: command.route.approver,
          routeId: command.route.routeId,
          subMissionId: record.subMissionId ?? null,
          workItemId: record.workItemId ?? null,
          requestedBy: input.requestedBy,
          head: input.head,
          staleClosed: closed.map((transition) => transition.record.id),
        },
      },
      ...closed.flatMap((transition) => transition.events),
    ],
  });
};

/** The requesting system closes its own waiting draft as stale. Already stale is a no-op. */
export const closeStaleDraft = (command: {
  readonly draft: Draft;
  readonly requestedBy: string;
  readonly reason: string;
  readonly provenance: MissionProvenance;
  readonly now: string;
}): Outcome<Transition<Draft>> => {
  const { draft } = command;
  const allowed = requesterCheck(command.provenance, command.requestedBy);
  if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
  if (draft.requestedBy !== command.requestedBy) {
    return refuse("forbidden", `Draft ${draft.id} was not opened by ${command.requestedBy}.`);
  }
  if ((draft.staleReason ?? null) !== null) return ok({ record: draft, events: [] });
  if (!STALE_STATES.has(draft.status)) {
    return refuse("conflict", `Draft ${draft.id} is ${draft.status}; a decided draft stays.`);
  }
  const reason = command.reason.trim();
  if (reason.length === 0) return refuse("invalid", "Say why the draft is stale.");
  return ok(staleClose(draft, reason, command.provenance, command.now));
};

/**
 * What a system may act on for one draft at one head. Only a decision on exactly that head
 * counts; a stale draft or any other head reads as `stale`.
 */
export const systemDraftDecision = (draft: Draft, head: string): SystemDraftDecision => {
  const delivery =
    draft.status === "sent" ? "sent" : draft.status === "send-failed" ? "send-failed" : "unsent";
  const base = {
    draftId: draft.id,
    head,
    text: null,
    edited: false,
    rewriteNote: null,
    revision: revisionOf(draft),
    delivery,
  } as const;
  if ((draft.staleReason ?? null) !== null || draft.head !== head) {
    return { ...base, state: "stale", decidedAt: null };
  }
  switch (draft.status) {
    case "pending":
      return { ...base, state: "pending", decidedAt: null };
    case "approved":
    case "sent":
    case "send-failed": {
      const edited = draft.approvedText !== null && draft.approvedText !== draft.text;
      return {
        ...base,
        state: "approved",
        text: draft.approvedText ?? draft.text,
        edited,
        decidedAt: draft.decidedAt,
      };
    }
    case "rewrite-requested":
      return {
        ...base,
        state: "rewrite-requested",
        rewriteNote: draft.rewriteNote,
        decidedAt: draft.decidedAt,
      };
    case "dropped":
      return { ...base, state: "dropped", decidedAt: draft.decidedAt };
  }
};

/**
 * The requesting system reports how posting the approved text went. Only an approved draft at
 * exactly the reported revision takes a report; the same report again is a no-op, a failed send
 * may later succeed, and a sent draft stays sent.
 */
export const reportDraftSent = (command: {
  readonly draft: Draft;
  readonly input: ReportDraftSentInput;
  readonly provenance: MissionProvenance;
  readonly now: string;
}): Outcome<Transition<Draft>> => {
  const { draft, input, provenance } = command;
  const allowed = requesterCheck(provenance, input.requestedBy);
  if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
  if (draft.requestedBy !== input.requestedBy) {
    return refuse("forbidden", `Draft ${draft.id} was not opened by ${input.requestedBy}.`);
  }
  if ((draft.staleReason ?? null) !== null) {
    return refuse("conflict", `Draft ${draft.id} was closed as stale; there is nothing to send.`);
  }
  if (revisionOf(draft) !== input.revision) {
    return refuse(
      "conflict",
      `Draft ${draft.id} is at revision ${revisionOf(draft)}, not ${input.revision}; send what was approved now.`,
    );
  }
  const { outcome } = input;
  const unchanged = ok<Transition<Draft>>({ record: draft, events: [] });
  switch (draft.status) {
    case "sent":
      return outcome._tag === "sent" && draft.sentLink && sameTarget(draft.sentLink, outcome.link)
        ? unchanged
        : refuse("conflict", `Draft ${draft.id} was already sent; it stays sent.`);
    case "send-failed":
      if (outcome._tag === "send-failed" && draft.sendError === outcome.reason) return unchanged;
      break;
    case "approved":
      break;
    default:
      return refuse(
        "conflict",
        `Draft ${draft.id} is ${draft.status}; only an approved draft is sent.`,
      );
  }
  const record: Draft =
    outcome._tag === "sent"
      ? { ...draft, status: "sent", sentAt: command.now, sentLink: outcome.link, sendError: null }
      : { ...draft, status: "send-failed", sendError: outcome.reason };
  return ok({
    record,
    events: [
      {
        kind: outcome._tag === "sent" ? "draft.sent" : "draft.send-failed",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(
          outcome._tag === "sent"
            ? `Sent: draft for ${draft.audience} (${draft.channel}) at ${outcome.link.label}`
            : `Send failed: draft for ${draft.audience} (${draft.channel}) (${outcome.reason})`,
        ),
        subject: draftRef(record),
        payload: {
          revision: input.revision,
          head: draft.head ?? null,
          link: outcome._tag === "sent" ? outcome.link : null,
          reason: outcome._tag === "send-failed" ? outcome.reason : null,
          previousStatus: draft.status,
        },
      },
    ],
  });
};

/** Edit pairs the owner approved: the raw material for edit learning. */
export const ownerEdits = (drafts: ReadonlyArray<Draft>): Array<DraftEdit & { draft: Draft }> =>
  drafts
    .filter(
      (draft) =>
        draft.decidedBy !== null &&
        isOwnerProvenance(draft.decidedBy) &&
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
  /** The caller is a master (of the note's mission, or of any mission for a global note). */
  readonly callerIsMaster: boolean;
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
 * Create, edit, retire or restore a note. The owner and masters write notes;
 * other agents suggest them, and an accepted suggestion writes one with the
 * decider's provenance.
 */
export const saveDraftNote = (command: SaveDraftNoteCommand): Outcome<Transition<DraftNote>> => {
  const { provenance, existing } = command;
  if (!isOwnerProvenance(provenance) && !command.callerIsMaster) {
    return refuse(
      "forbidden",
      "Only the owner or a master writes draft notes; agents suggest them.",
    );
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
    writtenBy: actorOf(provenance),
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
        actor: actorOf(provenance),
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
