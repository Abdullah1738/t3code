import {
  isOwnerProvenance,
  type ForkId,
  type MissionFork,
  type MissionId,
  type MissionLink,
  type MissionProvenance,
  type MissionRecordRef,
  type Note,
  type NoteId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import {
  actorOf,
  callerActsAs,
  callerIsOwner,
  clipSummary,
  ok,
  recordKey,
  refuse,
  type MissionCaller,
  type Outcome,
  type Transition,
} from "./shared.ts";

export type ForkKind = MissionFork["kind"];
export type ForkOrigin = MissionRecordRef | MissionLink;

export const forkRef = (fork: MissionFork): MissionRecordRef => ({
  kind: "fork",
  id: fork.id,
  label: `${fork.kind} fork`,
});

const originKey = (origin: ForkOrigin | null): string =>
  origin === null
    ? "none"
    : "kind" in origin && "id" in origin
      ? recordKey(origin)
      : `link:${origin.kind}:${origin.url ?? origin.ref ?? origin.label}`;

const originLabel = (origin: ForkOrigin | null): string =>
  origin === null ? "" : (origin.label ?? ("id" in origin ? `${origin.kind} ${origin.id}` : ""));

/** Title for the forked thread so it reads as a side conversation, not the master. */
export const forkTitle = (kind: ForkKind, origin: ForkOrigin | null, question?: string): string => {
  const label = originLabel(origin) || question?.trim() || "";
  const prefix =
    kind === "discuss" ? "Discuss" : kind === "dev-question" ? "Dev question" : "Question";
  const text = label.length > 0 ? `${prefix}: ${label}` : prefix;
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`;
};

/** An open fork for the same card and kind; Discuss twice opens the same fork. */
export const openForkFor = (
  forks: ReadonlyArray<MissionFork>,
  missionId: MissionId,
  kind: ForkKind,
  origin: ForkOrigin | null,
): MissionFork | undefined =>
  origin === null
    ? undefined
    : forks.find(
        (fork) =>
          fork.missionId === missionId &&
          fork.kind === kind &&
          fork.status === "open" &&
          originKey(fork.origin) === originKey(origin),
      );

export interface StartForkCommand {
  readonly missionId: MissionId;
  readonly kind: ForkKind;
  readonly origin: ForkOrigin | null;
  readonly caller: MissionCaller;
  /** Threads that hold the master role; the fork always starts from one of them. */
  readonly masterThreadId: ThreadId | null;
  readonly callerIsMaster: boolean;
}

/**
 * Who may fork the master: owner questions are the owner's own words, so only
 * he opens one. The owner or the master opens a Discuss fork (the master's
 * opening is never delivered as the owner); dev questions come from the
 * owner, the master or an answerer. Returns the thread to fork.
 */
export const checkStartFork = (command: StartForkCommand): Outcome<ThreadId> => {
  if (command.masterThreadId === null) {
    return refuse("not-found", "This mission has no master thread to fork.");
  }
  const owner = callerIsOwner(command.caller);
  if (command.kind === "owner-question" && !owner) {
    return refuse("provenance-required", "Owner questions come from the owner.");
  }
  if (command.kind === "discuss" && !owner && !command.callerIsMaster) {
    return refuse("forbidden", "Only the owner or the mission's master opens a Discuss fork.");
  }
  return ok(command.masterThreadId);
};

export interface OpenForkCommand extends StartForkCommand {
  readonly id: ForkId;
  readonly forkThreadId: ThreadId;
  /** What the fork asks, as the owner or master typed it. */
  readonly question?: string | undefined;
  readonly now: string;
}

export const openFork = (command: OpenForkCommand): Outcome<Transition<MissionFork>> => {
  const master = checkStartFork(command);
  if (Result.isFailure(master)) return Result.fail(master.failure);
  const record: MissionFork = {
    id: command.id,
    missionId: command.missionId,
    kind: command.kind,
    masterThreadId: master.success,
    forkThreadId: command.forkThreadId,
    origin: command.origin,
    status: "open",
    summaryLine: null,
    commitsMission: false,
    createdAt: command.now,
    closedAt: null,
    question: command.question?.trim() || null,
  };
  return ok({
    record,
    events: [
      {
        kind: "fork.opened",
        actor: actorOf(command.caller.provenance),
        provenance: command.caller.provenance,
        summary: clipSummary(forkTitle(command.kind, command.origin, command.question)),
        subject: forkRef(record),
        payload: { forkThreadId: command.forkThreadId, origin: command.origin },
      },
    ],
  });
};

export const SUMMARY_LINE_LIMIT = 240;

const oneLine = (text: string): Outcome<string> => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return refuse("invalid", "A fork ends with a one-line summary.");
  if (line.length > SUMMARY_LINE_LIMIT) {
    return refuse("invalid", `Keep the summary to one line (${SUMMARY_LINE_LIMIT} characters).`);
  }
  return ok(line);
};

/** What the master receives when a fork ends. */
export interface MasterDelivery {
  readonly threadId: ThreadId;
  readonly text: string;
  /** Discuss decisions arrive as the owner's message; other summaries as system. */
  readonly asOwner: boolean;
  readonly commitsMission: boolean;
}

export const masterLine = (fork: MissionFork): string => {
  const tag =
    fork.kind === "discuss"
      ? "Discussed"
      : fork.kind === "dev-question"
        ? "Dev question"
        : "Owner question";
  const origin = originLabel(fork.origin);
  const head = origin.length > 0 ? `[${tag}: ${origin}]` : `[${tag}]`;
  const tail = fork.commitsMission ? " This commits the mission; ack the note." : "";
  return `${head} ${fork.summaryLine ?? ""}${tail}`.trim();
};

export const deliveryFor = (fork: MissionFork, provenance: MissionProvenance): MasterDelivery => ({
  threadId: fork.masterThreadId,
  text: masterLine(fork),
  asOwner:
    fork.kind === "discuss" &&
    (provenance._tag === "owner-app" || provenance._tag === "owner-imessage"),
  commitsMission: fork.commitsMission,
});

export interface ForkClosing extends Transition<MissionFork> {
  readonly delivery: MasterDelivery;
  /** A note for the master to ack when the answer commits the mission. */
  readonly note: Note | null;
}

export interface CloseForkCommand {
  readonly fork: MissionFork;
  readonly summaryLine: string;
  /** The owner or the master can say a fork commits the mission. */
  readonly commitsMission: boolean;
  readonly caller: MissionCaller;
  readonly noteId: NoteId;
  readonly now: string;
}

const commitNote = (fork: MissionFork, id: NoteId, now: string): Note => ({
  id,
  missionId: fork.missionId,
  subMissionId: null,
  laneId: null,
  type: "decision",
  summary: clipSummary(masterLine({ ...fork, commitsMission: false })),
  sources: [],
  basis: "observed",
  severity: "high",
  confidence: 1,
  author: "editor",
  citation: "unchecked",
  evidence: "not-applicable",
  evidenceLinks: [],
  replacesNoteId: null,
  ackedBy: [],
  createdAt: now,
});

/**
 * End a fork with its one-line summary. The fork's own thread, the master or
 * the owner can close it; the owner or the master can mark it as committing
 * the mission, and the timeline names whoever did.
 */
export const closeFork = (command: CloseForkCommand): Outcome<ForkClosing> => {
  const { fork, caller } = command;
  if (fork.status !== "open")
    return refuse("conflict", `Fork ${fork.id} is already ${fork.status}.`);
  const owner = callerIsOwner(caller);
  const inFork = callerActsAs(caller, { _tag: "thread", threadId: fork.forkThreadId });
  const isMaster = callerActsAs(caller, { _tag: "thread", threadId: fork.masterThreadId });
  if (!owner && !inFork && !isMaster) {
    return refuse("forbidden", "Only the fork, its master or the owner can close it.");
  }
  if (command.commitsMission && !owner && !isMaster) {
    return refuse("forbidden", "Only the owner or the master says a fork commits the mission.");
  }
  const line = oneLine(command.summaryLine);
  if (Result.isFailure(line)) return Result.fail(line.failure);
  const record: MissionFork = {
    ...fork,
    status: "answered",
    summaryLine: line.success,
    commitsMission: command.commitsMission,
    closedAt: command.now,
  };
  return ok({
    record,
    delivery: deliveryFor(record, caller.provenance),
    note: record.commitsMission ? commitNote(record, command.noteId, command.now) : null,
    events: [
      {
        kind: "fork.closed",
        actor: actorOf(caller.provenance),
        provenance: caller.provenance,
        summary: clipSummary(masterLine(record)),
        subject: forkRef(record),
        payload: { summaryLine: line.success, commitsMission: record.commitsMission },
      },
    ],
  });
};

/** The owner or the master says an answered fork commits the mission after all. */
export const markForkCommits = (command: {
  readonly fork: MissionFork;
  readonly provenance: MissionProvenance;
  readonly callerIsMaster: boolean;
  readonly noteId: NoteId;
  readonly now: string;
}): Outcome<ForkClosing> => {
  const { fork, provenance } = command;
  if (!isOwnerProvenance(provenance) && !command.callerIsMaster) {
    return refuse("forbidden", "Only the owner or the master says a fork commits the mission.");
  }
  if (fork.status === "open") return refuse("conflict", "Close the fork with its summary first.");
  if (fork.commitsMission) return refuse("conflict", "This fork already commits the mission.");
  const record: MissionFork = { ...fork, commitsMission: true };
  return ok({
    record,
    // The summary line came from whoever closed the fork, so marking it later
    // never passes it to the master as the owner's words.
    delivery: { ...deliveryFor(record, provenance), asOwner: false },
    note: commitNote(record, command.noteId, command.now),
    events: [
      {
        kind: "fork.closed",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(masterLine(record)),
        subject: forkRef(record),
        payload: { commitsMission: true, markedLater: true },
      },
    ],
  });
};

/** Answered forks are archived; the owner or the master can reopen one to keep talking. */
export const archiveFork = (
  fork: MissionFork,
  provenance: MissionProvenance,
): Outcome<Transition<MissionFork>> => {
  if (fork.status !== "answered") return refuse("conflict", "Only answered forks are archived.");
  const record: MissionFork = { ...fork, status: "archived" };
  return ok({
    record,
    events: [
      {
        kind: "fork.closed",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(`Archived ${forkTitle(fork.kind, fork.origin)}`),
        subject: forkRef(record),
        payload: { archived: true },
      },
    ],
  });
};

export const reopenFork = (
  fork: MissionFork,
  provenance: MissionProvenance,
  callerIsMaster: boolean,
): Outcome<Transition<MissionFork>> => {
  if (!isOwnerProvenance(provenance) && !callerIsMaster) {
    return refuse("forbidden", "Only the owner or the mission's master reopens a fork.");
  }
  if (fork.status === "open") return refuse("conflict", "The fork is already open.");
  const record: MissionFork = { ...fork, status: "open", closedAt: null };
  return ok({
    record,
    events: [
      {
        kind: "fork.opened",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(`Reopened ${forkTitle(fork.kind, fork.origin)}`),
        subject: forkRef(record),
        payload: { reopened: true, previousSummary: fork.summaryLine },
      },
    ],
  });
};
