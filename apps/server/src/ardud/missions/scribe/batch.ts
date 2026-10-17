import type {
  MissionLink,
  Note,
  NoteSeverity,
  NoteType,
  SuggestionTargetKind,
} from "@t3tools/contracts";

import { checkCitation, checkSource, type CitationFailure } from "./citation.ts";
import { checkEvidence, type PullRequestFact } from "./evidence.ts";
import { checkReplaces, scribeNoteId, stableHash } from "./notes.ts";
import type { TranscriptEvent } from "./transcriptText.ts";

/**
 * Turn one scribe batch (what the model wrote about one slice of one lane)
 * into stored notes. Code, not the model, decides `citation`, `evidence` and
 * whether `replaces` holds. Failed citations are kept with `citation: failed`
 * so the pass rate is measurable; the inbox never shows them.
 *
 * Pure: the scribe proof scripts import it directly.
 */

/** One note as the runner posts it, before any checks. */
export interface ScribeNoteDraft {
  readonly type: NoteType;
  readonly summary: string;
  readonly quote: string;
  /** Event the quote came from, per the model. */
  readonly event: number;
  readonly fromEvent: number;
  readonly toEvent: number;
  readonly basis: "observed" | "claimed";
  readonly severity: NoteSeverity;
  readonly confidence: number;
  readonly replaces: string | null;
}

/** A possible process improvement the scribe spotted; the editor decides what to show. */
export interface ScribeCandidateDraft {
  readonly targetKind: SuggestionTargetKind;
  readonly title: string;
  readonly proposal: string;
  readonly why: string;
  readonly quote: string;
  readonly event: number;
}

export interface ScribeBatchInput {
  readonly missionId: string;
  readonly laneId: string | null;
  readonly subMissionId: string | null;
  readonly threadId: string;
  /** Inclusive range of turn item ordinals the scribe read. */
  readonly fromEvent: number;
  readonly toEvent: number;
  readonly notes: ReadonlyArray<ScribeNoteDraft>;
  readonly candidates: ReadonlyArray<ScribeCandidateDraft>;
  /** Notes the runner dropped for bad shape before posting. */
  readonly droppedCount: number;
  readonly usage: { readonly input: number; readonly output: number };
  readonly model: string | null;
}

export interface ScribeCandidate extends ScribeCandidateDraft {
  readonly id: string;
  readonly missionId: string;
  readonly laneId: string | null;
  readonly threadId: string;
  readonly citation: "verified" | "failed";
  readonly createdAt: string;
}

export interface BatchStats {
  readonly notes: number;
  readonly verified: number;
  readonly failed: number;
  readonly failures: Readonly<Record<string, number>>;
  readonly mismatch: number;
  readonly dropped: number;
  readonly replaceRejected: number;
  readonly candidates: number;
  readonly candidatesFailed: number;
}

export interface AssembledBatch {
  readonly notes: ReadonlyArray<Note>;
  readonly candidates: ReadonlyArray<ScribeCandidate>;
  readonly stats: BatchStats;
}

export interface BatchContext {
  /** Transcript events of the batch range (more is fine; the range limits matches). */
  readonly events: ReadonlyArray<TranscriptEvent>;
  /** PR facts of the lane thread, for claim-of-done evidence. */
  readonly pullRequests: ReadonlyArray<PullRequestFact>;
  /** Notes already stored for the mission, for `replaces` checks. */
  readonly knownNotes: ReadonlyMap<string, Pick<Note, "id" | "missionId" | "replacesNoteId">>;
  readonly now: string;
}

const SUMMARY_MAX = 400;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;

const toMissionLink = (link: {
  readonly kind: MissionLink["kind"];
  readonly label: string;
  readonly url: string | null;
  readonly ref: string | null;
}): MissionLink => ({ kind: link.kind, label: link.label, url: link.url, ref: link.ref });

export const scribeCandidateId = (input: {
  readonly missionId: string;
  readonly threadId: string;
  readonly targetKind: string;
  readonly quote: string;
}): string =>
  `cand-${stableHash([input.missionId, input.threadId, input.targetKind, input.quote.replace(/\s+/gu, " ").trim()].join("\n"))}`;

export const assembleBatch = (input: ScribeBatchInput, context: BatchContext): AssembledBatch => {
  const batch = { threadId: input.threadId, fromEvent: input.fromEvent, toEvent: input.toEvent };
  const known = new Map(context.knownNotes);
  const notes: Note[] = [];
  const failures: Record<string, number> = {};
  let replaceRejected = 0;
  const countFailure = (failure: CitationFailure | null) => {
    if (failure !== null) failures[failure] = (failures[failure] ?? 0) + 1;
  };

  for (const draft of input.notes) {
    const summary = clip(draft.summary.trim(), SUMMARY_MAX);
    if (summary.length === 0) continue;
    const sources = [
      {
        threadId: input.threadId,
        quote: draft.quote,
        fromEvent: Math.min(draft.fromEvent, draft.event),
        toEvent: Math.max(draft.toEvent, draft.event),
      },
    ];
    const id = scribeNoteId({ missionId: input.missionId, type: draft.type, sources });
    if (notes.some((note) => note.id === id)) continue;

    const citation = checkCitation(sources, context.events, batch);
    countFailure(citation.failure);
    const matched = citation.sources[0]?.matchedEvent ?? null;
    // "Observed" only when the quote really sits in tool output.
    const basis =
      draft.basis === "observed" &&
      matched !== null &&
      context.events.some((event) => event.event === matched && event.observed)
        ? "observed"
        : "claimed";

    const evidence =
      draft.type === "claim-of-done"
        ? checkEvidence(`${summary}\n${draft.quote}`, {
            pullRequests: context.pullRequests,
            events: context.events,
          })
        : null;

    let replacesNoteId = draft.replaces;
    if (replacesNoteId !== null) {
      const problem = checkReplaces({ id, missionId: input.missionId, replacesNoteId }, known);
      if (problem !== null) {
        replaceRejected += 1;
        replacesNoteId = null;
      }
    }

    const note = {
      id,
      missionId: input.missionId,
      subMissionId: input.subMissionId,
      laneId: input.laneId,
      type: draft.type,
      summary,
      sources,
      basis,
      severity: draft.severity,
      confidence: clamp01(draft.confidence),
      author: "scribe",
      citation: citation.citation,
      evidence: evidence?.evidence ?? "not-applicable",
      evidenceLinks: (evidence?.links ?? []).map(toMissionLink),
      replacesNoteId,
      ackedBy: [],
      createdAt: context.now,
    } as unknown as Note;
    notes.push(note);
    known.set(id, note);
  }

  const candidates: ScribeCandidate[] = [];
  for (const draft of input.candidates) {
    const id = scribeCandidateId({
      missionId: input.missionId,
      threadId: input.threadId,
      targetKind: draft.targetKind,
      quote: draft.quote,
    });
    if (candidates.some((candidate) => candidate.id === id)) continue;
    const check = checkSource(
      {
        threadId: input.threadId,
        quote: draft.quote,
        fromEvent: draft.event,
        toEvent: draft.event,
      },
      context.events,
      batch,
    );
    candidates.push({
      ...draft,
      id,
      missionId: input.missionId,
      laneId: input.laneId,
      threadId: input.threadId,
      citation: check.ok ? "verified" : "failed",
      createdAt: context.now,
    });
  }

  const verified = notes.filter((note) => note.citation === "verified").length;
  return {
    notes,
    candidates,
    stats: {
      notes: notes.length,
      verified,
      failed: notes.length - verified,
      failures,
      mismatch: notes.filter((note) => note.evidence === "mismatch").length,
      dropped: input.droppedCount,
      replaceRejected,
      candidates: candidates.length,
      candidatesFailed: candidates.filter((candidate) => candidate.citation === "failed").length,
    },
  };
};
