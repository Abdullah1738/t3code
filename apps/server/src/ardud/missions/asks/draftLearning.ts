/**
 * Edit learning: when the owner edits a draft before approving it, compare
 * before and after, and once the same kind of edit repeats, propose a draft
 * note ("you removed the opening pleasantry 4 times: add 'no opener'?"). It is
 * only ever a suggestion (author owner-corrections, acceptor owner); nothing
 * becomes a note until he accepts it.
 */
import {
  DraftNoteScope,
  MissionId,
  TrimmedNonEmptyString,
  type Draft,
  type DraftChannel,
  type DraftNote,
  type DraftNoteId,
  type MissionProvenance,
  type MissionRecordRef,
  type Suggestion,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { describeScope, draftRef, notesFor, ownerEdits, saveDraftNote } from "./draftModel.ts";
import { normalizeText, refuse, type Outcome, type Transition } from "./shared.ts";
import { BAR_RULES, barOf, type SuggestionProposal } from "./suggestionModel.ts";

// ---------------------------------------------------------------------------
// Word diff (for the card's diff text and for the editor's review)

export interface WordDiffPart {
  readonly op: "same" | "removed" | "added";
  readonly text: string;
}

const WORD_LIMIT = 600;

const tokens = (text: string) => text.split(/(\s+)/).filter((token) => token.length > 0);

/** Word-level diff by longest common subsequence; long texts fall back to a whole replace. */
export const wordDiff = (before: string, after: string): WordDiffPart[] => {
  const left = tokens(before);
  const right = tokens(after);
  if (left.length > WORD_LIMIT || right.length > WORD_LIMIT) {
    return [
      { op: "removed", text: before },
      { op: "added", text: after },
    ];
  }
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const parts: WordDiffPart[] = [];
  const push = (op: WordDiffPart["op"], text: string) => {
    const last = parts.at(-1);
    if (last !== undefined && last.op === op)
      parts[parts.length - 1] = { op, text: last.text + text };
    else parts.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push("same", left[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push("removed", left[i]!);
      i += 1;
    } else {
      push("added", right[j]!);
      j += 1;
    }
  }
  while (i < left.length) push("removed", left[i++]!);
  while (j < right.length) push("added", right[j++]!);
  return parts;
};

/** Compact `[-removed-]{+added+}` rendering for a suggestion card. */
export const renderWordDiff = (parts: ReadonlyArray<WordDiffPart>): string =>
  parts
    .map((part) => {
      if (part.op === "same") return part.text;
      const [, lead = "", body = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.text) ?? [];
      return part.op === "removed" ? `${lead}[-${body}-]${trail}` : `${lead}{+${body}+}${trail}`;
    })
    .join("");

// ---------------------------------------------------------------------------
// Edit patterns

export type EditPattern =
  | "removed-opener"
  | "removed-sign-off"
  | "removed-exclamations"
  | "removed-emoji"
  | "removed-hedges"
  | "shortened";

/** The note each pattern proposes, and how the card explains it. */
export const EDIT_PATTERNS: Readonly<
  Record<EditPattern, { readonly note: string; readonly observed: string }>
> = {
  "removed-opener": {
    note: "No opener or pleasantry; start with the point.",
    observed: "removed the opening pleasantry",
  },
  "removed-sign-off": {
    note: "No sign-off line.",
    observed: "removed the sign-off",
  },
  "removed-exclamations": {
    note: "No exclamation marks.",
    observed: "removed the exclamation marks",
  },
  "removed-emoji": { note: "No emoji.", observed: "removed the emoji" },
  "removed-hedges": {
    note: "No hedging or apologising (just, I think, maybe, sorry).",
    observed: "cut hedging words",
  },
  shortened: {
    note: "Keep it short: cut to what they need.",
    observed: "cut the draft by a third or more",
  },
};

const OPENER =
  /^(hi|hey|hello|dear|good (morning|afternoon|evening)|hope (you|this|all|everything)|i hope|thanks for|thank you for|happy to|great question|quick (note|update|one)|just (a|wanted|checking|following))\b/i;
const SIGN_OFF =
  /^(thanks|thank you|thx|cheers|best|regards|kind regards|best regards|let me know( if| what)?|hope (this|that) helps|happy to help|talk soon|speak soon)\b/i;
const HEDGES = /\b(just|i think|maybe|perhaps|sorry|i guess|kind of|sort of|hopefully)\b/gi;
const EMOJI = /\p{Extended_Pictographic}/gu;

const lines = (text: string) =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const firstSentence = (text: string) =>
  lines(text)[0]
    ?.split(/(?<=[.!?])\s/)[0]
    ?.trim() ?? "";
const lastLine = (text: string) => lines(text).at(-1) ?? "";
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** Which known edits turn `before` into `after`. */
export const editPatterns = (before: string, after: string): EditPattern[] => {
  const found: EditPattern[] = [];
  if (OPENER.test(firstSentence(before)) && !OPENER.test(firstSentence(after))) {
    found.push("removed-opener");
  }
  const beforeLines = lines(before);
  if (
    beforeLines.length > 1 &&
    SIGN_OFF.test(lastLine(before)) &&
    !SIGN_OFF.test(lastLine(after))
  ) {
    found.push("removed-sign-off");
  }
  if (count(before, /!/g) > 0 && count(after, /!/g) === 0) found.push("removed-exclamations");
  if (count(before, EMOJI) > 0 && count(after, EMOJI) === 0) found.push("removed-emoji");
  if (count(before, HEDGES) >= 1 && count(after, HEDGES) < count(before, HEDGES)) {
    found.push("removed-hedges");
  }
  const beforeLength = normalizeText(before).length;
  if (beforeLength >= 80 && normalizeText(after).length <= beforeLength * 0.67) {
    found.push("shortened");
  }
  return found;
};

// ---------------------------------------------------------------------------
// Suggestions from repeated edits

/** What an accepted draft-note suggestion writes. Kept in the suggestion's `after`. */
export const DraftNoteChange = Schema.Struct({
  missionId: Schema.NullOr(MissionId),
  scope: DraftNoteScope,
  text: TrimmedNonEmptyString,
  /** false retires the target note. */
  active: Schema.optional(Schema.Boolean),
});
export type DraftNoteChange = typeof DraftNoteChange.Type;

const decodeDraftNoteChange = Schema.decodeUnknownResult(DraftNoteChange);

export interface EditLearningInput {
  readonly missionId: MissionId;
  /** Every draft in the mission (edited approvals are the evidence). */
  readonly drafts: ReadonlyArray<Draft>;
  readonly notes: ReadonlyArray<DraftNote>;
  /** Every suggestion on record: for the author's bar and to skip repeats. */
  readonly suggestions: ReadonlyArray<Suggestion>;
}

interface Observation {
  readonly pattern: EditPattern;
  readonly draft: Draft;
}

const coveredBy = (text: string, notes: ReadonlyArray<DraftNote>) =>
  notes.some((note) => normalizeText(note.text) === normalizeText(text));

const changeOf = (suggestion: Suggestion): DraftNoteChange | null => {
  const decoded = decodeDraftNoteChange(suggestion.after);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

/**
 * Accepting a draft-note suggestion: the same note save the owner makes by
 * hand, carrying his acceptance as provenance and `source: "suggestion"`.
 */
export const draftNoteFromSuggestion = (input: {
  readonly id: DraftNoteId;
  readonly after: unknown;
  readonly target: MissionRecordRef | null;
  readonly provenance: MissionProvenance;
  readonly notes: ReadonlyArray<DraftNote>;
  readonly now: string;
}): Outcome<Transition<DraftNote>> => {
  const decoded = decodeDraftNoteChange(input.after);
  if (Result.isFailure(decoded)) {
    return refuse("invalid", "The accepted change is not a draft note (scope and text).");
  }
  const change = decoded.success;
  const existing =
    input.target === null
      ? null
      : (input.notes.find((note) => note.id === input.target?.id) ?? null);
  if (input.target !== null && existing === null) {
    return refuse("not-found", `Draft note ${input.target.id} is gone.`);
  }
  return saveDraftNote({
    id: existing?.id ?? input.id,
    existing,
    missionId: change.missionId,
    scope: change.scope,
    text: change.text,
    active: change.active ?? true,
    source: "suggestion",
    provenance: input.provenance,
    notes: input.notes,
    now: input.now,
  });
};

/**
 * Proposals for draft notes the owner's edits keep implying. Each pattern is
 * proposed once per scope: on one channel it scopes to that channel, across
 * channels it scopes to all drafts. A pattern already covered by an active
 * note, or already open as a suggestion, is skipped; after a dismissal only
 * edits made since it count again.
 */
export const learnFromEdits = (input: EditLearningInput): SuggestionProposal[] => {
  const bar = barOf(input.suggestions, "owner-corrections", "draft-note");
  const repeats = BAR_RULES[bar].editRepeats;
  const mine = input.suggestions.filter(
    (suggestion) =>
      suggestion.author === "owner-corrections" &&
      suggestion.targetKind === "draft-note" &&
      (suggestion.missionId === null || suggestion.missionId === input.missionId),
  );
  const observations: Observation[] = ownerEdits(
    input.drafts.filter((draft) => draft.missionId === input.missionId),
  ).flatMap((edit) =>
    editPatterns(edit.before, edit.after).map((pattern) => ({ pattern, draft: edit.draft })),
  );

  const proposals: SuggestionProposal[] = [];
  for (const pattern of Object.keys(EDIT_PATTERNS) as EditPattern[]) {
    const { note } = EDIT_PATTERNS[pattern];
    const sameNote = mine.filter((suggestion) => {
      const change = changeOf(suggestion);
      return change !== null && normalizeText(change.text) === normalizeText(note);
    });
    if (sameNote.some((suggestion) => suggestion.status === "open")) continue;
    const lastDismissed = sameNote
      .filter((suggestion) => suggestion.status === "dismissed")
      .map((suggestion) => suggestion.decidedAt ?? suggestion.createdAt)
      .toSorted()
      .at(-1);
    const seen = observations.filter(
      (observation) =>
        observation.pattern === pattern &&
        (lastDismissed === undefined || (observation.draft.decidedAt ?? "") > lastDismissed),
    );
    const channels = new Set(seen.map((observation) => observation.draft.channel));
    const candidates: Array<{ scope: DraftNoteScope; evidence: Observation[] }> =
      channels.size > 1 && seen.length >= repeats
        ? [{ scope: { _tag: "all" }, evidence: seen }]
        : [...channels].map((channel: DraftChannel) => ({
            scope: { _tag: "channel", channel },
            evidence: seen.filter((observation) => observation.draft.channel === channel),
          }));
    for (const { scope, evidence } of candidates) {
      if (evidence.length < repeats) continue;
      const active = notesFor(
        {
          missionId: input.missionId,
          channel: scope._tag === "channel" ? scope.channel : evidence[0]!.draft.channel,
          audience: evidence[0]!.draft.audience,
        },
        input.notes,
      );
      if (coveredBy(note, active)) continue;
      const change: DraftNoteChange = { missionId: input.missionId, scope, text: note };
      const refs: MissionRecordRef[] = evidence.map((observation) => draftRef(observation.draft));
      proposals.push({
        missionId: input.missionId,
        targetKind: "draft-note",
        target: null,
        title: `Add draft note for ${describeScope(scope)}: "${note}"`,
        before: null,
        after: change,
        diffText: `+ ${describeScope(scope)}: ${note}`,
        why: `You ${EDIT_PATTERNS[pattern].observed} in ${evidence.length} of your edits to ${describeScope(scope)}.`,
        evidence: refs,
        acceptor: "owner",
      });
    }
  }
  return proposals;
};
