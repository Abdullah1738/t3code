// Pure helpers for the owner inbox (Decide / Approve / Knocks / Suggestions /
// FYI). Shared by web and mobile; no React, no I/O.
//
// Owner rule for asks, verbatim: "Always wait for my answer. If a master can't
// decide wait on it. Anything the answer blocks should wait on it, and
// anything it doesn't and all other lanes should continue freely". So nothing
// here preselects an option, picks a default or computes a deadline.

import type {
  AnswerAskInput,
  Approval,
  Ask,
  DecideDraftInput,
  DecideKnockInput,
  DecideSuggestionInput,
  Draft,
  DraftChannel,
  DraftNote,
  DraftNoteScope,
  InboxTab,
  Knock,
  MissionId,
  MissionInbox,
  MissionRecordRef,
  Note,
  NoteType,
  Suggestion,
  SuggestionAuthor,
  SuggestionStats,
  SuggestionTargetKind,
} from "@t3tools/contracts";

import type { AddDraftNoteInput, MissionForkEntry, MissionInboxHistory } from "./source.ts";
import { diffStats, diffWords, type DiffSegment, type DiffStats } from "./textDiff.ts";
import { actorLabel, refLabel } from "./viewModel.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Tabs, entries and selection

export const INBOX_TABS: ReadonlyArray<InboxTab> = [
  "decide",
  "approve",
  "knocks",
  "suggestions",
  "fyi",
];

export const INBOX_TAB_LABEL: Record<InboxTab, string> = {
  decide: "Decide",
  approve: "Approve",
  knocks: "Knocks",
  suggestions: "Suggestions",
  fyi: "FYI",
};

export function isInboxTab(value: unknown): value is InboxTab {
  return typeof value === "string" && (INBOX_TABS as ReadonlyArray<string>).includes(value);
}

/** The first tab with something in it, in tab order; Decide when all are empty. */
export function defaultInboxTab(inbox: Pick<MissionInbox, "counts">): InboxTab {
  return INBOX_TABS.find((tab) => inbox.counts[tab] > 0) ?? "decide";
}

export type InboxEntry =
  | { readonly kind: "ask"; readonly key: string; readonly record: Ask }
  | { readonly kind: "draft"; readonly key: string; readonly record: Draft }
  | { readonly kind: "approval"; readonly key: string; readonly record: Approval }
  | { readonly kind: "knock"; readonly key: string; readonly record: Knock }
  | { readonly kind: "suggestion"; readonly key: string; readonly record: Suggestion }
  | { readonly kind: "note"; readonly key: string; readonly record: Note };

/**
 * The items one tab lists, in display order. Approve mixes drafts and crw
 * approvals newest first; FYI keeps the source's ranking.
 */
export function inboxEntries(inbox: MissionInbox, tab: InboxTab): InboxEntry[] {
  switch (tab) {
    case "decide":
      return inbox.asks.map((record) => ({ kind: "ask", key: `ask:${record.id}`, record }));
    case "approve":
      return [
        ...inbox.drafts.map((record): InboxEntry => ({
          kind: "draft",
          key: `draft:${record.id}`,
          record,
        })),
        ...inbox.approvals.map((record): InboxEntry => ({
          kind: "approval",
          key: `approval:${record.id}`,
          record,
        })),
      ].sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
    case "knocks":
      return inbox.knocks.map((record) => ({ kind: "knock", key: `knock:${record.id}`, record }));
    case "suggestions":
      return inbox.suggestions.map((record) => ({
        kind: "suggestion",
        key: `suggestion:${record.id}`,
        record,
      }));
    case "fyi":
      return inbox.fyi.map((record) => ({ kind: "note", key: `note:${record.id}`, record }));
  }
}

/** j/k movement. Starts at the first item when nothing is selected; clamps at the ends. */
export function moveSelection(
  keys: ReadonlyArray<string>,
  current: string | null,
  delta: number,
): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  if (index === -1) return keys[delta < 0 ? keys.length - 1 : 0] ?? null;
  const next = Math.min(keys.length - 1, Math.max(0, index + delta));
  return keys[next] ?? null;
}

/**
 * Keeps the selection steady when the list changes. When the selected item
 * leaves (answered, approved), the item that took its place is selected, so
 * the owner can work down the list without reaching for the mouse.
 */
export function keepSelection(
  previousKeys: ReadonlyArray<string>,
  nextKeys: ReadonlyArray<string>,
  current: string | null,
): string | null {
  if (current === null) return null;
  if (nextKeys.includes(current)) return current;
  if (nextKeys.length === 0) return null;
  const previousIndex = previousKeys.indexOf(current);
  if (previousIndex === -1) return nextKeys[0] ?? null;
  // Skip forward past items that also left, to the first survivor after it.
  for (let index = previousIndex + 1; index < previousKeys.length; index++) {
    const key = previousKeys[index];
    if (key !== undefined && nextKeys.includes(key)) return key;
  }
  return nextKeys[nextKeys.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Decide (asks)

/** "waiting 12m", "waiting 38h", "waiting 3d". Hours up to two days, like the status files. */
export function waitingLabel(createdAt: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(createdAt));
  if (elapsed < HOUR_MS) return `waiting ${Math.max(1, Math.round(elapsed / MINUTE_MS))}m`;
  if (elapsed < 48 * HOUR_MS) return `waiting ${Math.round(elapsed / HOUR_MS)}h`;
  return `waiting ${Math.floor(elapsed / (24 * HOUR_MS))}d`;
}

/** What waits on the answer, and that nothing else does. */
export function blocksLine(blocks: ReadonlyArray<MissionRecordRef>): string {
  if (blocks.length === 0) return "Blocks nothing. The mission keeps running.";
  return `Blocks ${blocks.map(refLabel).join(", ")} only. Everything else keeps running.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lowercases a leading word ("Not needed" -> "not needed") but leaves "CRP-1" or "Kafka" alone when unclear. */
function continueSentence(text: string): string {
  const trimmed = text.trim();
  const [first = "", second = ""] = trimmed;
  const lowered = /[A-Z]/.test(first) && /[a-z]/.test(second) && !/^[A-Z][a-z]+[A-Z]/.test(trimmed);
  const body = lowered ? first.toLowerCase() + trimmed.slice(1) : trimmed;
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

/**
 * The recommendation as advice: "Master recommends “Hold” because …".
 * `null` when the asker gave none. It is never applied without an answer.
 */
export function recommendationLine(ask: Ask, masterRoleId: string | null): string | null {
  const recommendation = ask.recommendation;
  if (recommendation === null) return null;
  const who = capitalize(actorLabel(ask.askedBy, masterRoleId));
  const option = ask.options.find((candidate) => candidate.id === recommendation.optionId);
  const reason = recommendation.reason.trim();
  if (!option) return reason === "" ? null : `${who} suggests: ${continueSentence(reason)}`;
  return reason === ""
    ? `${who} recommends “${option.label}”.`
    : `${who} recommends “${option.label}” because ${continueSentence(reason)}`;
}

export interface AskOptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** The asker's recommendation. Shown as a hint only; never selected for the owner. */
  readonly recommended: boolean;
  /** Number key that picks it (1-9), or null past nine. */
  readonly shortcut: number | null;
}

export interface AskView {
  readonly askedBy: string;
  readonly waiting: string;
  readonly blocks: string;
  readonly recommendation: string | null;
  readonly options: ReadonlyArray<AskOptionView>;
  readonly urgent: boolean;
}

export function askView(ask: Ask, nowMs: number, masterRoleId: string | null): AskView {
  return {
    askedBy: actorLabel(ask.askedBy, masterRoleId),
    waiting: waitingLabel(ask.createdAt, nowMs),
    blocks: blocksLine(ask.blocks),
    recommendation: recommendationLine(ask, masterRoleId),
    options: ask.options.map((option, index) => ({
      id: option.id,
      label: option.label,
      detail: option.detail,
      recommended: ask.recommendation?.optionId === option.id,
      shortcut: index < 9 ? index + 1 : null,
    })),
    urgent: ask.urgency === "p0",
  };
}

/** An answer needs an option, some text, or both. */
export function answerAskInput(
  ask: Pick<Ask, "id" | "options">,
  answer: { readonly optionId: string | null; readonly text: string },
): Result<AnswerAskInput> {
  const text = answer.text.trim();
  if (answer.optionId !== null && !ask.options.some((option) => option.id === answer.optionId)) {
    return err("That option is no longer on the ask.");
  }
  if (answer.optionId === null && text === "") return err("Pick an option or write an answer.");
  return ok({ askId: ask.id, optionId: answer.optionId, text } as AnswerAskInput);
}

// ---------------------------------------------------------------------------
// Forks (Discuss first, Ask the mission)

export const FORK_KIND_LABEL: Record<MissionForkEntry["fork"]["kind"], string> = {
  discuss: "Discuss",
  "dev-question": "Dev question",
  "owner-question": "Your question",
};

/** The open fork about one record (a call, an ask), if the owner already started one. */
export function openForkFor(
  forks: ReadonlyArray<MissionForkEntry>,
  ref: Pick<MissionRecordRef, "kind" | "id">,
): MissionForkEntry | null {
  return (
    forks.find(
      (entry) =>
        entry.fork.status === "open" &&
        entry.fork.origin !== null &&
        "id" in entry.fork.origin &&
        entry.fork.origin.kind === ref.kind &&
        entry.fork.origin.id === ref.id,
    ) ?? null
  );
}

export function forkTitle(entry: MissionForkEntry): string {
  if (entry.question) return entry.question;
  const origin = entry.fork.origin;
  if (origin === null) return "Side question";
  return "id" in origin ? refLabel(origin) : origin.label;
}

export function splitForks(forks: ReadonlyArray<MissionForkEntry>): {
  readonly open: ReadonlyArray<MissionForkEntry>;
  readonly closed: ReadonlyArray<MissionForkEntry>;
} {
  return {
    open: forks.filter((entry) => entry.fork.status === "open"),
    closed: forks.filter((entry) => entry.fork.status !== "open"),
  };
}

// ---------------------------------------------------------------------------
// Approve: drafts and draft notes

export const DRAFT_CHANNEL_LABEL: Record<DraftChannel, string> = {
  linear: "Linear",
  github: "GitHub",
  cliq: "Cliq",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  email: "Email",
  telegram: "Telegram",
  other: "Other",
};

export const DRAFT_CHANNELS = Object.keys(DRAFT_CHANNEL_LABEL) as ReadonlyArray<DraftChannel>;

export function draftNoteScopeLabel(scope: DraftNoteScope): string {
  switch (scope._tag) {
    case "all":
      return "All drafts";
    case "channel":
      return `${DRAFT_CHANNEL_LABEL[scope.channel]} drafts`;
    case "person":
      return `To ${scope.name}`;
  }
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Whether a note covers a draft to this audience on this channel. Ignores `active`. */
export function draftNoteCovers(
  note: Pick<DraftNote, "scope">,
  draft: Pick<Draft, "channel" | "audience">,
): boolean {
  switch (note.scope._tag) {
    case "all":
      return true;
    case "channel":
      return note.scope.channel === draft.channel;
    case "person":
      return sameName(note.scope.name, draft.audience);
  }
}

export interface DraftNotesForDraft {
  /** Notes the writer says it applied. */
  readonly applied: ReadonlyArray<DraftNote>;
  /** Active notes that cover this draft but the writer did not list. */
  readonly skipped: ReadonlyArray<DraftNote>;
  /** Applied ids the client no longer knows (deleted notes). */
  readonly unknownIds: ReadonlyArray<string>;
}

export function draftNotesFor(
  draft: Pick<Draft, "appliedNoteIds" | "channel" | "audience">,
  notes: ReadonlyArray<DraftNote>,
): DraftNotesForDraft {
  const byId = new Map(notes.map((note) => [note.id as string, note]));
  const applied: DraftNote[] = [];
  const unknownIds: string[] = [];
  for (const id of draft.appliedNoteIds) {
    const note = byId.get(id);
    if (note) applied.push(note);
    else unknownIds.push(id);
  }
  const appliedIds = new Set<string>(draft.appliedNoteIds);
  const skipped = notes.filter(
    (note) => note.active && !appliedIds.has(note.id) && draftNoteCovers(note, draft),
  );
  return { applied, skipped, unknownIds };
}

export interface DraftNoteGroup {
  readonly key: string;
  readonly label: string;
  readonly notes: ReadonlyArray<DraftNote>;
}

/** All drafts first, then channels, then people (A-Z); active notes first in each. */
export function groupDraftNotes(notes: ReadonlyArray<DraftNote>): DraftNoteGroup[] {
  const groups = new Map<string, { label: string; rank: number; notes: DraftNote[] }>();
  for (const note of notes) {
    const key =
      note.scope._tag === "all"
        ? "all"
        : note.scope._tag === "channel"
          ? `channel:${note.scope.channel}`
          : `person:${note.scope.name.trim().toLowerCase()}`;
    const rank = note.scope._tag === "all" ? 0 : note.scope._tag === "channel" ? 1 : 2;
    const group = groups.get(key) ?? { label: draftNoteScopeLabel(note.scope), rank, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        left.rank - right.rank ||
        left.label.localeCompare(right.label) ||
        leftKey.localeCompare(rightKey),
    )
    .map(([key, group]) => ({
      key,
      label: group.label,
      notes: [...group.notes].sort(
        (left, right) =>
          Number(right.active) - Number(left.active) ||
          right.updatedAt.localeCompare(left.updatedAt),
      ),
    }));
}

export type DraftNoteScopeChoice =
  | { readonly kind: "all" }
  | { readonly kind: "channel"; readonly channel: DraftChannel }
  | { readonly kind: "person"; readonly name: string };

export function addDraftNoteInput(
  missionId: MissionId | null,
  scope: DraftNoteScopeChoice,
  text: string,
): Result<AddDraftNoteInput> {
  const trimmed = text.trim();
  if (trimmed === "") return err("Write the note first.");
  switch (scope.kind) {
    case "all":
      return ok({ missionId, scope: { _tag: "all" }, text: trimmed });
    case "channel":
      return ok({ missionId, scope: { _tag: "channel", channel: scope.channel }, text: trimmed });
    case "person": {
      const name = scope.name.trim();
      if (name === "") return err("Say who the note is for.");
      return ok({ missionId, scope: { _tag: "person", name }, text: trimmed });
    }
  }
}

export interface TextEdit {
  readonly changed: boolean;
  readonly segments: ReadonlyArray<DiffSegment>;
  readonly stats: DiffStats;
}

/** What the owner changed between the writer's text and his own. */
export function textEdit(original: string, edited: string): TextEdit {
  const changed = original.trim() !== edited.trim();
  const segments = changed ? diffWords(original, edited) : [];
  return { changed, segments, stats: diffStats(segments) };
}

/** The owner's edits to a decided draft, or `null` when he approved it as written. */
export function draftOwnerEdit(draft: Pick<Draft, "text" | "approvedText">): TextEdit | null {
  if (draft.approvedText === null) return null;
  const edit = textEdit(draft.text, draft.approvedText);
  return edit.changed ? edit : null;
}

export type DraftDecision =
  | { readonly action: "approve" }
  | { readonly action: "edit-approve"; readonly editedText: string }
  | { readonly action: "rewrite"; readonly note: string }
  | { readonly action: "drop" };

export function decideDraftInput(
  draft: Pick<Draft, "id" | "text">,
  decision: DraftDecision,
): Result<DecideDraftInput> {
  switch (decision.action) {
    case "approve":
      return ok({ draftId: draft.id, action: "approve" });
    case "edit-approve": {
      const editedText = decision.editedText.trim();
      if (editedText === "") return err("The edited draft is empty.");
      // An unchanged edit is a plain approve; no diff to learn from.
      return editedText === draft.text.trim()
        ? ok({ draftId: draft.id, action: "approve" })
        : ok({ draftId: draft.id, action: "approve", editedText });
    }
    case "rewrite": {
      const rewriteNote = decision.note.trim();
      if (rewriteNote === "") return err("Say what the rewrite should change.");
      return ok({ draftId: draft.id, action: "rewrite", rewriteNote });
    }
    case "drop":
      return ok({ draftId: draft.id, action: "drop" });
  }
}

export const DRAFT_STATUS_LABEL: Record<Draft["status"], string> = {
  pending: "Waiting",
  approved: "Approved",
  "rewrite-requested": "Rewrite asked",
  dropped: "Dropped",
  sent: "Sent",
  "send-failed": "Send failed",
};

export const APPROVAL_STATUS_LABEL: Record<Approval["status"], string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  "stale-closed": "Closed as stale",
};

/** crw approvals that closed themselves as stale, newest first, for the closed list. */
export function staleApprovals(history: Pick<MissionInboxHistory, "approvals">): Approval[] {
  return history.approvals
    .filter((approval) => approval.status === "stale-closed")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

// ---------------------------------------------------------------------------
// Knocks

export function decideKnockInput(
  knock: Pick<Knock, "id" | "summary">,
  decision:
    | { readonly action: "forward"; readonly editedText?: string }
    | { readonly action: "drop" },
): Result<DecideKnockInput> {
  if (decision.action === "drop") return ok({ knockId: knock.id, action: "drop" });
  const edited = decision.editedText?.trim();
  if (edited === "") return err("The forwarded text is empty.");
  return edited === undefined || edited === knock.summary.trim()
    ? ok({ knockId: knock.id, action: "forward" })
    : ok({ knockId: knock.id, action: "forward", editedText: edited });
}

// ---------------------------------------------------------------------------
// Suggestions

export const SUGGESTION_AUTHOR_LABEL: Record<SuggestionAuthor, string> = {
  scribe: "Scribe",
  editor: "Editor",
  master: "Master",
  governor: "Governor",
  "owner-corrections": "Your corrections",
  "code-check": "Code check",
};

export const SUGGESTION_TARGET_LABEL: Record<SuggestionTargetKind, string> = {
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

export interface AcceptanceView {
  readonly shown: number;
  readonly accepted: number;
  readonly dismissed: number;
  /** accepted / (accepted + dismissed); null before anything was decided. */
  readonly rate: number | null;
  readonly bar: SuggestionStats["bar"];
  /** "6 of 9 accepted (67%)" or "none decided yet". */
  readonly label: string;
}

const BAR_RANK: Record<SuggestionStats["bar"], number> = { normal: 0, raised: 1, high: 2 };

function acceptanceOf(rows: ReadonlyArray<SuggestionStats>): AcceptanceView {
  let shown = 0;
  let accepted = 0;
  let dismissed = 0;
  let bar: SuggestionStats["bar"] = "normal";
  for (const row of rows) {
    shown += row.shown;
    accepted += row.accepted;
    dismissed += row.dismissed;
    if (BAR_RANK[row.bar] > BAR_RANK[bar]) bar = row.bar;
  }
  const decided = accepted + dismissed;
  const rate = decided === 0 ? null : accepted / decided;
  const label =
    rate === null
      ? "none decided yet"
      : `${accepted} of ${decided} accepted (${Math.round(rate * 100)}%)`;
  return { shown, accepted, dismissed, rate, bar, label };
}

/** The author's record overall, and on this kind of target. */
export function suggestionTrackRecord(
  stats: ReadonlyArray<SuggestionStats>,
  suggestion: Pick<Suggestion, "author" | "targetKind">,
): { readonly author: AcceptanceView; readonly kind: AcceptanceView | null } {
  const byAuthor = stats.filter((row) => row.author === suggestion.author);
  const byKind = byAuthor.filter((row) => row.targetKind === suggestion.targetKind);
  return {
    author: acceptanceOf(byAuthor),
    kind: byKind.length === 0 ? null : acceptanceOf(byKind),
  };
}

/** Editable text for "accept edited": strings as is, structured values as JSON. */
export function suggestionAfterText(suggestion: Pick<Suggestion, "after">): string {
  return typeof suggestion.after === "string"
    ? suggestion.after
    : (JSON.stringify(suggestion.after, null, 2) ?? "");
}

export type SuggestionDecision =
  | { readonly action: "accept" }
  | { readonly action: "accept-edited"; readonly editedText: string }
  | { readonly action: "dismiss"; readonly reason: string };

export function decideSuggestionInput(
  suggestion: Pick<Suggestion, "id" | "after">,
  decision: SuggestionDecision,
): Result<DecideSuggestionInput> {
  switch (decision.action) {
    case "accept":
      return ok({ suggestionId: suggestion.id, action: "accept" });
    case "dismiss": {
      const dismissReason = decision.reason.trim();
      if (dismissReason === "") return err("Say why, so the author learns from it.");
      return ok({ suggestionId: suggestion.id, action: "dismiss", dismissReason });
    }
    case "accept-edited": {
      const text = decision.editedText.trim();
      if (text === "") return err("The edited value is empty.");
      if (typeof suggestion.after === "string") {
        return text === suggestion.after.trim()
          ? ok({ suggestionId: suggestion.id, action: "accept" })
          : ok({ suggestionId: suggestion.id, action: "accept-edited", editedAfter: text });
      }
      let editedAfter: unknown;
      try {
        editedAfter = JSON.parse(text);
      } catch {
        return err("That is not valid JSON.");
      }
      return JSON.stringify(editedAfter) === JSON.stringify(suggestion.after)
        ? ok({ suggestionId: suggestion.id, action: "accept" })
        : ok({ suggestionId: suggestion.id, action: "accept-edited", editedAfter });
    }
  }
}

// ---------------------------------------------------------------------------
// FYI

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
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

export type EvidenceTone = "good" | "bad" | "missing";

export interface FyiView {
  readonly heading: string;
  readonly severity: Note["severity"];
  /** "Observed" (seen in code or tools) or "Claimed" (only said by an agent). */
  readonly basis: string;
  readonly evidence: { readonly label: string; readonly tone: EvidenceTone } | null;
  /** "Quote checked" when the scribe's citation was verified against the source. */
  readonly citation: string | null;
  readonly quote: string | null;
  /** First source event (coord seq), for the source link. */
  readonly sourceEvent: number | null;
}

const EVIDENCE_VIEW: Record<Note["evidence"], FyiView["evidence"]> = {
  matched: { label: "Evidence matches", tone: "good" },
  mismatch: { label: "Evidence does not match", tone: "bad" },
  missing: { label: "No evidence found", tone: "missing" },
  "not-applicable": null,
};

export function fyiView(note: Note): FyiView {
  const source = note.sources[0];
  return {
    heading: NOTE_TYPE_LABEL[note.type],
    severity: note.severity,
    basis: note.basis === "observed" ? "Observed" : "Claimed, not observed",
    evidence: EVIDENCE_VIEW[note.evidence],
    citation:
      note.citation === "verified"
        ? "Quote checked"
        : note.citation === "failed"
          ? "Quote did not match the source"
          : null,
    quote: source?.quote.trim() || null,
    sourceEvent: source?.fromEvent ?? null,
  };
}

// ---------------------------------------------------------------------------
// Keyboard

/** What a key press does in the inbox list. */
export type InboxKeyAction =
  | { readonly type: "move"; readonly delta: 1 | -1 }
  | { readonly type: "pick-option"; readonly optionId: string }
  | { readonly type: "edit" };

export interface InboxKeyInput {
  readonly key: string;
  /** Ctrl, Meta or Alt held: leave the key to the browser and the app. */
  readonly modified: boolean;
  /** Focus is in a text field: typing never triggers inbox actions. */
  readonly typing: boolean;
  readonly selected: InboxEntry | null;
}

/**
 * j/k move, 1-9 pick that option on the selected ask, e opens the editor on
 * the selected draft or knock. A number only picks; the owner still sends.
 */
export function inboxKeyAction(input: InboxKeyInput): InboxKeyAction | null {
  if (input.modified || input.typing) return null;
  if (input.key === "j") return { type: "move", delta: 1 };
  if (input.key === "k") return { type: "move", delta: -1 };
  const selected = input.selected;
  if (selected === null) return null;
  if (input.key === "e") {
    return selected.kind === "draft" || selected.kind === "knock" ? { type: "edit" } : null;
  }
  if (selected.kind === "ask" && /^[1-9]$/.test(input.key)) {
    const option = selected.record.options[Number(input.key) - 1];
    return option ? { type: "pick-option", optionId: option.id } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inbox screen state

/**
 * What the inbox screen remembers between renders. Shared by web and mobile
 * so both clients move, pick and edit the same way.
 */
export interface InboxUiState {
  readonly selectedKey: string | null;
  /** Draft or knock whose editor is open. */
  readonly editingKey: string | null;
  /** Option the owner picked per ask key. Only the owner sets these; nothing is preset. */
  readonly picked: Readonly<Record<string, string>>;
}

export const INITIAL_INBOX_UI: InboxUiState = { selectedKey: null, editingKey: null, picked: {} };

export type InboxUiEvent =
  | { readonly type: "select"; readonly key: string | null }
  | { readonly type: "key"; readonly action: InboxKeyAction; readonly keys: ReadonlyArray<string> }
  | { readonly type: "pick"; readonly key: string; readonly optionId: string | null }
  | { readonly type: "edit"; readonly key: string | null }
  /** The visible list changed (a decision landed, the tab or mission filter changed). */
  | {
      readonly type: "entries-changed";
      readonly previousKeys: ReadonlyArray<string>;
      readonly nextKeys: ReadonlyArray<string>;
    }
  /** The item was decided: forget its pick and close its editor. */
  | { readonly type: "done"; readonly key: string }
  /** Another tab or mission filter: nothing carries over except picks. */
  | { readonly type: "scope-changed" };

function withoutPick(picked: Readonly<Record<string, string>>, key: string) {
  if (!(key in picked)) return picked;
  const next = { ...picked };
  delete next[key];
  return next;
}

export function inboxUiReducer(state: InboxUiState, event: InboxUiEvent): InboxUiState {
  switch (event.type) {
    case "select":
      return state.selectedKey === event.key ? state : { ...state, selectedKey: event.key };
    case "key": {
      const action = event.action;
      if (action.type === "move") {
        const selectedKey = moveSelection(event.keys, state.selectedKey, action.delta);
        return selectedKey === state.selectedKey ? state : { ...state, selectedKey };
      }
      if (state.selectedKey === null) return state;
      if (action.type === "edit") return { ...state, editingKey: state.selectedKey };
      return { ...state, picked: { ...state.picked, [state.selectedKey]: action.optionId } };
    }
    case "pick":
      return {
        ...state,
        selectedKey: event.key,
        picked:
          event.optionId === null
            ? withoutPick(state.picked, event.key)
            : { ...state.picked, [event.key]: event.optionId },
      };
    case "edit":
      return {
        ...state,
        editingKey: event.key,
        selectedKey: event.key ?? state.selectedKey,
      };
    case "entries-changed": {
      const selectedKey = keepSelection(event.previousKeys, event.nextKeys, state.selectedKey);
      const editingKey =
        state.editingKey !== null && event.nextKeys.includes(state.editingKey)
          ? state.editingKey
          : null;
      return selectedKey === state.selectedKey && editingKey === state.editingKey
        ? state
        : { ...state, selectedKey, editingKey };
    }
    case "scope-changed":
      return state.selectedKey === null && state.editingKey === null
        ? state
        : { ...state, selectedKey: null, editingKey: null };
    case "done":
      return {
        ...state,
        editingKey: state.editingKey === event.key ? null : state.editingKey,
        picked: withoutPick(state.picked, event.key),
      };
  }
}
