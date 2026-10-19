/**
 * Calls: decisions a master makes on its own, recorded so the owner can see
 * them in the direction check and react (ok, discuss, overruled).
 */
import {
  isOwnerProvenance,
  type Call,
  type CallId,
  type DirectionCheckItem,
  type MissionActor,
  type MissionId,
  type MissionProvenance,
  type MissionRecordRef,
  type SubMissionId,
} from "@t3tools/contracts";

import {
  callerActsAs,
  callerIsOwner,
  clipSummary,
  ok,
  refuse,
  type MissionCaller,
  type Outcome,
  type Transition,
} from "./shared.ts";

export interface MakeCallCommand {
  readonly id: CallId;
  readonly missionId: MissionId;
  readonly subMissionId: SubMissionId | null;
  readonly caller: MissionCaller;
  /** The role or lane making the call; must be one the caller holds. */
  readonly decidedBy: MissionActor;
  readonly title: string;
  readonly decision: string;
  readonly reason: string;
  readonly alternatives: ReadonlyArray<string>;
  readonly reversible: boolean;
  readonly subject: MissionRecordRef | null;
  readonly now: string;
}

export const callRef = (call: Pick<Call, "id" | "title">): MissionRecordRef => ({
  kind: "call",
  id: call.id,
  label: call.title,
});

export const makeCall = (command: MakeCallCommand): Outcome<Transition<Call>> => {
  if (callerIsOwner(command.caller)) {
    return refuse("forbidden", "Calls are the master's own decisions; the owner reacts to them.");
  }
  if (!callerActsAs(command.caller, command.decidedBy)) {
    return refuse("forbidden", "The caller does not hold the identity it decides as.");
  }
  const title = command.title.trim();
  const decision = command.decision.trim();
  if (title.length === 0 || decision.length === 0) {
    return refuse("invalid", "A call needs a title and the decision.");
  }
  const record: Call = {
    id: command.id,
    missionId: command.missionId,
    subMissionId: command.subMissionId,
    decidedBy: command.decidedBy,
    title,
    decision,
    reason: command.reason.trim(),
    alternatives: command.alternatives.map((alternative) => alternative.trim()).filter(Boolean),
    reversible: command.reversible,
    subject: command.subject,
    ownerReaction: null,
    createdAt: command.now,
  };
  return ok({
    record,
    events: [
      {
        kind: "call.made",
        actor: command.decidedBy,
        provenance: command.caller.provenance,
        summary: clipSummary(`Call: ${title} - ${decision}`),
        subject: callRef(record),
        payload: { reversible: command.reversible, alternatives: record.alternatives },
      },
    ],
  });
};

export type CallReaction = NonNullable<Call["ownerReaction"]>;

export interface ReactToCallCommand {
  readonly call: Call;
  /** null clears an earlier reaction (the way back out). */
  readonly reaction: CallReaction | null;
  readonly note: string;
  readonly provenance: MissionProvenance;
  readonly now: string;
}

/**
 * The owner's reaction. The master reads `discuss` and `overruled` from the
 * call's timeline event.
 */
export const reactToCall = (command: ReactToCallCommand): Outcome<Transition<Call>> => {
  const { call, reaction, provenance } = command;
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner reacts to calls.");
  }
  if (reaction === "overruled" && command.note.trim().length === 0) {
    return refuse("invalid", "Say what to do instead when overruling a call.");
  }
  if (call.ownerReaction === reaction) {
    return refuse("conflict", `Call ${call.id} is already ${reaction ?? "unreacted"}.`);
  }
  const record: Call = { ...call, ownerReaction: reaction };
  return ok({
    record,
    events: [
      {
        kind: "call.reacted",
        actor: { _tag: "owner" },
        provenance,
        summary: clipSummary(
          reaction === null
            ? `Cleared reaction on call: ${call.title}`
            : `Owner ${reaction === "ok" ? "is ok with" : reaction === "discuss" ? "wants to discuss" : "overruled"} call: ${call.title}${command.note.trim() ? ` - ${command.note.trim()}` : ""}`,
        ),
        subject: callRef(call),
        payload: {
          reaction,
          previousReaction: call.ownerReaction,
          note: command.note.trim(),
        },
      },
    ],
  });
};

/**
 * Calls the owner has not reacted to, made since he last looked. They lead the
 * mission overview's direction check, newest first.
 */
export const directionCheck = (
  calls: ReadonlyArray<Call>,
  ownerLastLookedAt: string | null,
): DirectionCheckItem[] =>
  calls
    .filter(
      (call) =>
        call.ownerReaction === null &&
        (ownerLastLookedAt === null || call.createdAt > ownerLastLookedAt),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((call) => ({
      ref: callRef(call),
      summary: clipSummary(`${call.title}: ${call.decision}`),
      reason: [
        call.reason,
        call.reversible ? "reversible" : "not reversible",
        call.alternatives.length > 0 ? `instead of ${call.alternatives.join(" / ")}` : "",
      ]
        .filter((part) => part.length > 0)
        .join("; "),
      at: call.createdAt,
    }));
