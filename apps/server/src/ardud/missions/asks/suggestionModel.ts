/**
 * Suggestions: one engine for every author (scribe, editor, master, governor,
 * owner-corrections, code-check). Nothing self-applies: a suggestion opens,
 * a person with decision rights accepts, accepts edited or dismisses it, and
 * only then does the owning service apply `after`. Authors whose suggestions
 * keep getting dismissed meet a higher bar and get fewer cards shown.
 */
import {
  isOwnerProvenance,
  type DecideSuggestionInput,
  type MissionId,
  type MissionLink,
  type MissionProvenance,
  type MissionRecordRef,
  type RecordView,
  type Suggestion,
  type SuggestionAuthor,
  type SuggestionId,
  type SuggestionStats,
  type SuggestionTargetKind,
} from "@t3tools/contracts";

import {
  actorOf,
  callerIsOwner,
  clipSummary,
  ok,
  refuse,
  type MissionCaller,
  type Outcome,
  type Transition,
} from "./shared.ts";

export type SuggestionBar = SuggestionStats["bar"];
export type SuggestionAcceptor = Suggestion["acceptor"];
export type SuggestionEvidence = MissionRecordRef | MissionLink;

/** What an author proposes. The service fills `author` from the caller, never from input. */
export interface SuggestionProposal {
  readonly missionId: MissionId | null;
  readonly targetKind: SuggestionTargetKind;
  readonly target: MissionRecordRef | null;
  readonly title: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly diffText: string;
  readonly why: string;
  readonly evidence: ReadonlyArray<SuggestionEvidence>;
  readonly acceptor: SuggestionAcceptor;
  readonly view?: RecordView;
}

/** Decided suggestions needed before an author's bar can move. */
export const MIN_DECIDED_FOR_BAR = 5;

export interface BarRule {
  /** Evidence items a new suggestion must cite. */
  readonly minEvidence: number;
  /** Open suggestions the author may have for one target kind at once. */
  readonly maxOpen: number;
  /** Repeats an owner-edit pattern needs before it becomes a note suggestion. */
  readonly editRepeats: number;
}

export const BAR_RULES: Readonly<Record<SuggestionBar, BarRule>> = {
  normal: { minEvidence: 1, maxOpen: 5, editRepeats: 3 },
  raised: { minEvidence: 2, maxOpen: 2, editRepeats: 5 },
  high: { minEvidence: 3, maxOpen: 1, editRepeats: 8 },
};

export const barFor = (accepted: number, dismissed: number): SuggestionBar => {
  const decided = accepted + dismissed;
  if (decided < MIN_DECIDED_FOR_BAR) return "normal";
  const rate = accepted / decided;
  if (rate < 0.2) return "high";
  if (rate < 0.4) return "raised";
  return "normal";
};

const statsKey = (author: SuggestionAuthor, targetKind: SuggestionTargetKind) =>
  `${author}|${targetKind}`;

/** Acceptance per author and target kind; "edited" counts as accepted. */
export const suggestionStats = (suggestions: ReadonlyArray<Suggestion>): SuggestionStats[] => {
  const groups = new Map<
    string,
    {
      author: SuggestionAuthor;
      targetKind: SuggestionTargetKind;
      shown: number;
      accepted: number;
      dismissed: number;
    }
  >();
  for (const suggestion of suggestions) {
    const key = statsKey(suggestion.author, suggestion.targetKind);
    const group = groups.get(key) ?? {
      author: suggestion.author,
      targetKind: suggestion.targetKind,
      shown: 0,
      accepted: 0,
      dismissed: 0,
    };
    group.shown += 1;
    if (suggestion.status === "accepted" || suggestion.status === "edited") group.accepted += 1;
    if (suggestion.status === "dismissed") group.dismissed += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, bar: barFor(group.accepted, group.dismissed) }))
    .toSorted((left, right) =>
      statsKey(left.author, left.targetKind).localeCompare(
        statsKey(right.author, right.targetKind),
      ),
    );
};

export const barOf = (
  suggestions: ReadonlyArray<Suggestion>,
  author: SuggestionAuthor,
  targetKind: SuggestionTargetKind,
): SuggestionBar =>
  suggestionStats(
    suggestions.filter(
      (suggestion) => suggestion.author === author && suggestion.targetKind === targetKind,
    ),
  )[0]?.bar ?? "normal";

export const suggestionRef = (suggestion: Pick<Suggestion, "id" | "title">): MissionRecordRef => ({
  kind: "suggestion",
  id: suggestion.id,
  label: suggestion.title,
});

const sameTarget = (left: MissionRecordRef | null, right: MissionRecordRef | null) =>
  left === null || right === null
    ? left === right
    : left.kind === right.kind && left.id === right.id;

const stableJson = (value: unknown): string => JSON.stringify(value ?? null);

export interface ProposeSuggestionCommand {
  readonly id: SuggestionId;
  readonly proposal: SuggestionProposal;
  /** Resolved by the service from the caller (role kind, system component). */
  readonly author: SuggestionAuthor;
  readonly caller: MissionCaller;
  /** Every suggestion on record, for stats, dedupe and the open cap. */
  readonly existing: ReadonlyArray<Suggestion>;
  readonly now: string;
}

/**
 * Whose inbox a suggestion lands in (plan 1.7 as amended 17 Oct). The master
 * decides anything in its control surface; the owner decides draft notes,
 * rules (his own words) and anything about the master's own behaviour,
 * including the master's suggestions about itself. Either may decide any
 * suggestion; this only picks who is asked.
 */
export const acceptorFor = (input: {
  readonly targetKind: SuggestionTargetKind;
  readonly target: MissionRecordRef | null;
  readonly author: SuggestionAuthor;
  /** What the author asked for, if anything. Owner requests always stand. */
  readonly requested: SuggestionAcceptor | undefined;
  /** The mission's master role, when the suggestion belongs to a mission. */
  readonly masterRoleId: string | null;
}): SuggestionAcceptor => {
  if (input.requested === "owner") return "owner";
  if (input.author === "master") return "owner";
  if (input.targetKind === "draft-note" || input.targetKind === "rule") return "owner";
  const aboutMaster =
    (input.targetKind === "role" || input.targetKind === "role-model") &&
    input.target !== null &&
    input.masterRoleId !== null &&
    input.target.id === input.masterRoleId;
  return aboutMaster ? "owner" : "master";
};

export const proposeSuggestion = (
  command: ProposeSuggestionCommand,
): Outcome<Transition<Suggestion>> => {
  const { proposal, author, existing } = command;
  if (callerIsOwner(command.caller)) {
    return refuse(
      "forbidden",
      "The owner edits records directly; suggestions come from the swarm.",
    );
  }
  const title = proposal.title.trim();
  if (title.length === 0) return refuse("invalid", "A suggestion needs a title.");
  if (proposal.why.trim().length === 0) return refuse("invalid", "Say why.");
  if (author === "master" && proposal.acceptor === "master") {
    return refuse("invalid", "A master cannot accept its own suggestion; the owner decides it.");
  }
  const sameKind = existing.filter(
    (suggestion) => suggestion.author === author && suggestion.targetKind === proposal.targetKind,
  );
  const bar = barOf(sameKind, author, proposal.targetKind);
  const rule = BAR_RULES[bar];
  if (proposal.evidence.length < rule.minEvidence) {
    return refuse(
      "invalid",
      `${author} ${proposal.targetKind} suggestions are at a ${bar} bar after recent dismissals: cite at least ${rule.minEvidence} pieces of evidence.`,
    );
  }
  const open = sameKind.filter((suggestion) => suggestion.status === "open");
  if (open.length >= rule.maxOpen) {
    return refuse(
      "conflict",
      `${author} already has ${open.length} open ${proposal.targetKind} suggestions (cap ${rule.maxOpen} at a ${bar} bar). Wait for decisions.`,
    );
  }
  const duplicate = existing.find(
    (suggestion) =>
      suggestion.status === "open" &&
      suggestion.targetKind === proposal.targetKind &&
      sameTarget(suggestion.target, proposal.target) &&
      stableJson(suggestion.after) === stableJson(proposal.after),
  );
  if (duplicate !== undefined) {
    return refuse("conflict", `Same change already suggested as ${duplicate.id}.`);
  }
  const record: Suggestion = {
    id: command.id,
    missionId: proposal.missionId,
    targetKind: proposal.targetKind,
    target: proposal.target,
    title,
    before: proposal.before ?? null,
    after: proposal.after,
    diffText: proposal.diffText,
    why: proposal.why.trim(),
    evidence: [...proposal.evidence],
    author,
    acceptor: proposal.acceptor,
    status: "open",
    dismissReason: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: command.now,
    ...(proposal.view === undefined ? {} : { view: proposal.view }),
  };
  return ok({
    record,
    events: [
      {
        kind: "suggestion.opened",
        actor: actorOf(command.caller.provenance),
        provenance: command.caller.provenance,
        summary: clipSummary(`Suggestion (${author}): ${title}`),
        subject: suggestionRef(record),
        payload: { author, targetKind: proposal.targetKind, bar },
      },
    ],
  });
};

/** What accepting asks the owning service to apply. */
export interface SuggestionApplication {
  readonly suggestion: Suggestion;
  readonly targetKind: SuggestionTargetKind;
  readonly target: MissionRecordRef | null;
  readonly after: unknown;
}

export interface SuggestionDecision extends Transition<Suggestion> {
  /** Present on accept and accept-edited; the service applies it after commit. */
  readonly apply: SuggestionApplication | null;
}

export interface DecideSuggestionCommand {
  readonly suggestion: Suggestion;
  readonly input: DecideSuggestionInput;
  readonly caller: MissionCaller;
  /** The caller holds the mission's master role (resolved by the service). */
  readonly callerIsMaster: boolean;
  readonly now: string;
}

/**
 * The owner or the mission's master decides any suggestion (owner rule,
 * 17 Oct 2026: nothing is owner only). `acceptor` only says whose inbox it
 * lands in; the decision event records who decided.
 */
const mayDecide = (command: DecideSuggestionCommand): boolean =>
  callerIsOwner(command.caller) || command.callerIsMaster;

export const decideSuggestion = (command: DecideSuggestionCommand): Outcome<SuggestionDecision> => {
  const { suggestion, input, caller } = command;
  if (input.suggestionId !== suggestion.id)
    return refuse("invalid", "Decision is for a different suggestion.");
  if (!mayDecide(command)) {
    return refuse("forbidden", "Only the owner or the mission's master decides this suggestion.");
  }
  if (suggestion.status !== "open") {
    return refuse("conflict", `Suggestion ${suggestion.id} is ${suggestion.status}.`);
  }
  const decided = { decidedBy: caller.provenance, decidedAt: command.now };
  if (input.action === "dismiss") {
    const record: Suggestion = {
      ...suggestion,
      ...decided,
      status: "dismissed",
      dismissReason: input.dismissReason?.trim() || null,
    };
    return ok({
      record,
      apply: null,
      events: [decisionEvent(record, caller.provenance, { action: "dismiss" })],
    });
  }
  if (input.action === "accept-edited" && input.editedAfter === undefined) {
    return refuse("invalid", "Accept edited needs the edited change.");
  }
  const after = input.action === "accept-edited" ? input.editedAfter : suggestion.after;
  const record: Suggestion = {
    ...suggestion,
    ...decided,
    after,
    status: input.action === "accept-edited" ? "edited" : "accepted",
  };
  return ok({
    record,
    apply: { suggestion: record, targetKind: record.targetKind, target: record.target, after },
    events: [
      decisionEvent(record, caller.provenance, {
        action: input.action,
        ...(input.action === "accept-edited" ? { proposedAfter: suggestion.after } : {}),
      }),
    ],
  });
};

const decisionEvent = (
  record: Suggestion,
  provenance: MissionProvenance,
  payload: Record<string, unknown>,
) => ({
  kind: "suggestion.decided" as const,
  actor: actorOf(provenance),
  provenance,
  summary: clipSummary(`Suggestion ${record.status}: ${record.title}`),
  subject: suggestionRef(record),
  payload,
});

/** The owning service reports what applying did (or why it could not yet). */
export const recordOutcome = (suggestion: Suggestion, outcome: string): Suggestion => ({
  ...suggestion,
  outcome: outcome.trim() || null,
});

/** Owner takes a dismissal back; the card returns to the open list. */
export const reopenSuggestion = (
  suggestion: Suggestion,
  provenance: MissionProvenance,
  now: string,
  callerIsMaster = false,
): Outcome<Transition<Suggestion>> => {
  if (!isOwnerProvenance(provenance) && !callerIsMaster) {
    return refuse(
      "forbidden",
      "Only the owner or the mission's master reopens a dismissed suggestion.",
    );
  }
  if (suggestion.status !== "dismissed") {
    return refuse(
      "conflict",
      `Suggestion ${suggestion.id} is ${suggestion.status}; only dismissals reopen.`,
    );
  }
  const record: Suggestion = {
    ...suggestion,
    status: "open",
    dismissReason: null,
    decidedBy: null,
    decidedAt: null,
  };
  return ok({
    record,
    events: [
      {
        kind: "suggestion.opened",
        actor: actorOf(provenance),
        provenance,
        summary: clipSummary(`Reopened suggestion: ${suggestion.title}`),
        subject: suggestionRef(record),
        payload: { reopened: true, at: now },
      },
    ],
  });
};
