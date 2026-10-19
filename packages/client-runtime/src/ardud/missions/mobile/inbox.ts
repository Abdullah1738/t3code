import type {
  AnswerAskInput,
  Approval,
  Ask,
  DecideApprovalInput,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  Draft,
  DraftChannel,
  InboxTab,
  Knock,
  MissionActor,
  MissionInbox,
  Note,
  NoteSeverity,
  NoteType,
  Suggestion,
  SuggestionAuthor,
  SuggestionTargetKind,
} from "@t3tools/contracts";

import { formatRelative, refLabel } from "../viewModel.ts";

// Inbox logic for the owner's phone: which segment to show, what each card
// says, and turning a filled-in card into a mutation input. Everything here is
// pure so the screens stay a thin layer over it.

/** A form either produces a mutation input or says, in the owner's words, what is missing. */
export type FormResult<T> =
  | { readonly ok: true; readonly input: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(input: T): FormResult<T> => ({ ok: true, input });
const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });

/** Reads the owner-facing detail of a rejected mutation. */
export function missionErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
  }
  return "Something went wrong. Try again.";
}

/** "you", or the role, lane, thread, component or person the actor names. */
export function actorLabel(actor: MissionActor): string {
  switch (actor._tag) {
    case "owner":
      return "you";
    case "role":
      return actor.roleId;
    case "lane":
      return actor.laneId;
    case "thread":
      return actor.threadId;
    case "system":
      return actor.component;
    case "person":
      return actor.name;
  }
}

// ---------------------------------------------------------------------------
// Segments

export const INBOX_TABS: ReadonlyArray<InboxTab> = [
  "decide",
  "approve",
  "knocks",
  "suggestions",
  "fyi",
];

export const INBOX_TAB_LABEL: Readonly<Record<InboxTab, string>> = {
  decide: "Decide",
  approve: "Approve",
  knocks: "Knocks",
  suggestions: "Suggestions",
  fyi: "FYI",
};

export interface InboxSegment {
  readonly tab: InboxTab;
  readonly label: string;
  readonly count: number;
}

export function inboxSegments(inbox: Pick<MissionInbox, "counts"> | undefined): InboxSegment[] {
  return INBOX_TABS.map((tab) => ({
    tab,
    label: INBOX_TAB_LABEL[tab],
    count: inbox?.counts[tab] ?? 0,
  }));
}

/**
 * The segment to show. An explicit pick wins; otherwise the first segment with
 * something in it, so opening the inbox lands on work rather than on an empty
 * Decide list.
 */
export function resolveInboxTab(
  requested: InboxTab | null,
  inbox: Pick<MissionInbox, "counts"> | undefined,
): InboxTab {
  if (requested !== null) return requested;
  if (!inbox) return "decide";
  return INBOX_TABS.find((tab) => inbox.counts[tab] > 0) ?? "decide";
}

export const INBOX_EMPTY_LABEL: Readonly<Record<InboxTab, string>> = {
  decide: "Nothing to decide.",
  approve: "Nothing to approve.",
  knocks: "No knocks.",
  suggestions: "No suggestions.",
  fyi: "Nothing to read.",
};

// ---------------------------------------------------------------------------
// Asks

export interface AskOptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** The master's pick. Shown as advice only; it is never preselected. */
  readonly recommended: boolean;
}

export interface AskView {
  readonly question: string;
  readonly context: string;
  readonly urgent: boolean;
  readonly askedBy: string;
  readonly askedAt: string;
  readonly options: ReadonlyArray<AskOptionView>;
  readonly recommendation: { readonly label: string | null; readonly reason: string } | null;
  /** "Blocks CRP-13215, risk#124", or `null` when nothing waits on the answer. */
  readonly blocksLine: string | null;
  readonly costOfWaiting: string;
}

export function askView(ask: Ask, nowMs: number): AskView {
  const recommendedId = ask.recommendation?.optionId ?? null;
  const recommendedOption = ask.options.find((option) => option.id === recommendedId);
  return {
    question: ask.question,
    context: ask.context,
    urgent: ask.urgency === "p0",
    askedBy: actorLabel(ask.askedBy),
    askedAt: formatRelative(ask.createdAt, nowMs),
    options: ask.options.map((option) => ({
      id: option.id,
      label: option.label,
      detail: option.detail,
      recommended: option.id === recommendedId,
    })),
    recommendation: ask.recommendation
      ? { label: recommendedOption?.label ?? null, reason: ask.recommendation.reason }
      : null,
    blocksLine:
      ask.blocks.length > 0 ? `Blocks ${ask.blocks.map((ref) => refLabel(ref)).join(", ")}` : null,
    costOfWaiting: ask.costOfWaiting,
  };
}

export interface AskAnswerForm {
  readonly optionId: string | null;
  readonly text: string;
}

/** Every ask starts unanswered. There is no default option and no deadline. */
export const EMPTY_ASK_ANSWER: AskAnswerForm = { optionId: null, text: "" };

/** Tapping the picked option again clears the pick. */
export function toggleAskOption(form: AskAnswerForm, optionId: string): AskAnswerForm {
  return { ...form, optionId: form.optionId === optionId ? null : optionId };
}

export function askAnswerInput(ask: Ask, form: AskAnswerForm): FormResult<AnswerAskInput> {
  if (ask.status !== "open") return fail("This ask is already closed.");
  const text = form.text.trim();
  if (form.optionId !== null && !ask.options.some((option) => option.id === form.optionId)) {
    return fail("Pick one of the listed options.");
  }
  if (form.optionId === null && text === "") return fail("Pick an option or write an answer.");
  return ok({ askId: ask.id, optionId: form.optionId, text });
}

export function canSubmitAskAnswer(ask: Ask, form: AskAnswerForm): boolean {
  return askAnswerInput(ask, form).ok;
}

// ---------------------------------------------------------------------------
// Drafts

export const DRAFT_CHANNEL_LABEL: Readonly<Record<DraftChannel, string>> = {
  linear: "Linear",
  github: "GitHub",
  cliq: "Cliq",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  email: "Email",
  telegram: "Telegram",
  other: "Other",
};

const DRAFT_SOURCE_LABEL: Readonly<Record<Draft["source"]["kind"], string>> = {
  lane: "written by a lane",
  master: "written by the master",
  editor: "written by the editor",
};

/** "Draft for Pavan on risk#124" */
export function draftHeadline(draft: Draft): string {
  return `Draft for ${draft.audience} on ${draft.target.label}`;
}

/** "GitHub · written by the master · 2h ago" */
export function draftMeta(draft: Draft, nowMs: number): string {
  return [
    DRAFT_CHANNEL_LABEL[draft.channel],
    DRAFT_SOURCE_LABEL[draft.source.kind],
    formatRelative(draft.createdAt, nowMs),
  ].join(" · ");
}

export type DraftForm =
  | { readonly action: "approve"; readonly editedText?: string }
  | { readonly action: "rewrite"; readonly note: string }
  | { readonly action: "drop" };

export function draftDecisionInput(draft: Draft, form: DraftForm): FormResult<DecideDraftInput> {
  if (draft.status !== "pending") return fail("This draft is already decided.");
  switch (form.action) {
    case "approve": {
      if (form.editedText === undefined) return ok({ draftId: draft.id, action: "approve" });
      const edited = form.editedText.trim();
      if (edited === "") return fail("The draft can't be empty.");
      // An untouched edit is a plain approval, so the record does not claim an edit.
      if (edited === draft.text.trim()) return ok({ draftId: draft.id, action: "approve" });
      return ok({ draftId: draft.id, action: "approve", editedText: edited });
    }
    case "rewrite": {
      const note = form.note.trim();
      if (note === "") return fail("Say what the rewrite should change.");
      return ok({ draftId: draft.id, action: "rewrite", rewriteNote: note });
    }
    case "drop":
      return ok({ draftId: draft.id, action: "drop" });
  }
}

// ---------------------------------------------------------------------------
// Approvals (crw merges, deploys, releases)

const APPROVAL_KIND_LABEL: Readonly<Record<Approval["kind"], string>> = {
  merge: "Merge",
  deploy: "Deploy",
  release: "Release",
  other: "Approval",
};

/** "Merge · requested by crw · 5m ago" */
export function approvalMeta(approval: Approval, nowMs: number): string {
  return [
    APPROVAL_KIND_LABEL[approval.kind],
    `requested by ${approval.requestedBy}`,
    formatRelative(approval.createdAt, nowMs),
  ].join(" · ");
}

export function approvalDecisionInput(
  approval: Approval,
  action: "approve" | "reject",
  note: string,
): FormResult<DecideApprovalInput> {
  if (approval.status !== "pending") return fail("This approval is already decided.");
  const trimmed = note.trim();
  return ok({
    approvalId: approval.id,
    action,
    ...(trimmed === "" ? {} : { note: trimmed }),
  });
}

// ---------------------------------------------------------------------------
// Knocks (outside threads trying to reach the mission)

const KNOCK_PATH_LABEL: Readonly<Record<string, string>> = {
  "control-api": "the control API",
  "thread-send": "a thread send",
  "queued-send": "a queued send",
  "coord-shim": "the coord shim",
};

/** `"Batch-fix Crpko tickets" wants to tell the Crpko Engineering master` */
export function knockHeadline(knock: Knock, missionTitle: string | null): string {
  const master = missionTitle ? `the ${missionTitle} master` : "the master";
  return `"${knock.fromTitle}" wants to tell ${master}`;
}

/** "Stopped at a thread send · 12m ago" */
export function knockMeta(knock: Knock, nowMs: number): string {
  const path = KNOCK_PATH_LABEL[knock.path] ?? knock.path;
  return `Stopped at ${path} · ${formatRelative(knock.createdAt, nowMs)}`;
}

export type KnockForm =
  | { readonly action: "forward"; readonly editedText?: string }
  | { readonly action: "drop" };

/** Forwarding goes to the mission's master; the source picks the master role. */
export function knockDecisionInput(knock: Knock, form: KnockForm): FormResult<DecideKnockInput> {
  if (knock.status !== "pending") return fail("This knock is already handled.");
  if (form.action === "drop") return ok({ knockId: knock.id, action: "drop" });
  if (form.editedText === undefined) return ok({ knockId: knock.id, action: "forward" });
  const edited = form.editedText.trim();
  if (edited === "") return fail("The message can't be empty.");
  if (edited === knock.summary.trim()) return ok({ knockId: knock.id, action: "forward" });
  return ok({ knockId: knock.id, action: "forward", editedText: edited });
}

// ---------------------------------------------------------------------------
// Suggestions (rules, roles, models, schedules)

export const SUGGESTION_TARGET_LABEL: Readonly<Record<SuggestionTargetKind, string>> = {
  role: "Role",
  "role-model": "Role model",
  rule: "Rule",
  "review-policy": "Review policy",
  "criticality-guide": "Criticality guide",
  pool: "Pool",
  "sub-mission-order": "Sub-mission order",
  lane: "Lane",
  schedule: "Schedule",
  "draft-note": "Draft note",
};

export const SUGGESTION_AUTHOR_LABEL: Readonly<Record<SuggestionAuthor, string>> = {
  scribe: "Scribe",
  editor: "Editor",
  master: "Master",
  governor: "Governor",
  "owner-corrections": "From your corrections",
  "code-check": "Code check",
};

/** "Scribe · Schedule · cell-triage" */
export function suggestionMeta(suggestion: Suggestion): string {
  return [
    SUGGESTION_AUTHOR_LABEL[suggestion.author],
    SUGGESTION_TARGET_LABEL[suggestion.targetKind],
    ...(suggestion.target ? [refLabel(suggestion.target)] : []),
  ].join(" · ");
}

/** Who else may accept it. Owner-only suggestions say so. */
export function suggestionAcceptorLine(suggestion: Suggestion): string {
  return suggestion.acceptor === "owner"
    ? "Only you can accept this."
    : "The master may accept this if you don't.";
}

/** The proposed value as editable text: strings as they are, anything else as JSON. */
export function suggestionAfterText(suggestion: Suggestion): string {
  if (typeof suggestion.after === "string") return suggestion.after;
  return JSON.stringify(suggestion.after, null, 2) ?? "";
}

export type SuggestionForm =
  | { readonly action: "accept" }
  | { readonly action: "accept-edited"; readonly afterText: string }
  | { readonly action: "dismiss"; readonly reason: string };

export function suggestionDecisionInput(
  suggestion: Suggestion,
  form: SuggestionForm,
): FormResult<DecideSuggestionInput> {
  if (suggestion.status !== "open") return fail("This suggestion is already decided.");
  switch (form.action) {
    case "accept":
      return ok({ suggestionId: suggestion.id, action: "accept" });
    case "dismiss": {
      const reason = form.reason.trim();
      return ok({
        suggestionId: suggestion.id,
        action: "dismiss",
        ...(reason === "" ? {} : { dismissReason: reason }),
      });
    }
    case "accept-edited": {
      const text = form.afterText.trim();
      if (text === "") return fail("The change can't be empty.");
      let editedAfter: unknown = text;
      if (typeof suggestion.after !== "string") {
        try {
          editedAfter = JSON.parse(text);
        } catch {
          return fail("That isn't valid JSON. Fix it, or accept the suggestion as it is.");
        }
      }
      if (JSON.stringify(editedAfter) === JSON.stringify(suggestion.after)) {
        return ok({ suggestionId: suggestion.id, action: "accept" });
      }
      return ok({ suggestionId: suggestion.id, action: "accept-edited", editedAfter });
    }
  }
}

// ---------------------------------------------------------------------------
// FYI notes

export const NOTE_TYPE_LABEL: Readonly<Record<NoteType, string>> = {
  decision: "Decision",
  assumption: "Assumption",
  deviation: "Deviation",
  risk: "Risk",
  blocker: "Blocker",
  "owner-must-know": "You should know",
  "rule-break": "Rule break",
  "claim-of-done": "Claimed done",
  "open-question": "Open question",
};

export const NOTE_SEVERITY_LABEL: Readonly<Record<NoteSeverity, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** "You should know · High · claimed, not checked · 3h ago" */
export function noteMeta(note: Note, nowMs: number): string {
  return [
    NOTE_TYPE_LABEL[note.type],
    NOTE_SEVERITY_LABEL[note.severity],
    note.basis === "claimed" ? "claimed, not checked" : "observed",
    formatRelative(note.createdAt, nowMs),
  ].join(" · ");
}
