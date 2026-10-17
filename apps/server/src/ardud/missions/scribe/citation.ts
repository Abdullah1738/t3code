import type { TranscriptEvent } from "./transcriptText.ts";

/**
 * Citation checker. Code, not a model, decides whether a scribe note's quote
 * is really in the transcript: after collapsing whitespace, the quote must be
 * a substring of one event's raw text inside the cited inclusive range, and
 * that range must sit inside the slice the scribe was shown. A note with any
 * failing source is stored with `citation: failed` and kept out of the FYI
 * ranking.
 *
 * Pure and type-import only: the scribe proof scripts import it directly.
 */

export const MIN_QUOTE_CHARS = 12;
export const MAX_QUOTE_CHARS = 600;

export interface CitedSource {
  readonly threadId: string;
  readonly quote: string;
  readonly fromEvent: number;
  readonly toEvent: number;
}

export type CitationFailure =
  | "no-sources"
  | "quote-too-short"
  | "quote-too-long"
  | "range-invalid"
  | "range-outside-batch"
  | "wrong-thread"
  | "events-missing"
  | "quote-not-found";

export interface SourceCheck {
  readonly ok: boolean;
  readonly failure: CitationFailure | null;
  /** Event the quote was found in, when it was found. */
  readonly matchedEvent: number | null;
}

export interface CitationCheck {
  readonly citation: "verified" | "failed";
  readonly sources: ReadonlyArray<SourceCheck>;
  /** First failure, for counting and debugging. */
  readonly failure: CitationFailure | null;
}

/** The slice of one thread the scribe read, inclusive. */
export interface BatchRange {
  readonly threadId: string;
  readonly fromEvent: number;
  readonly toEvent: number;
}

/** Collapse every whitespace run to one space and trim. */
export const normalizeText = (text: string): string => text.replace(/\s+/gu, " ").trim();

const fail = (failure: CitationFailure): SourceCheck => ({
  ok: false,
  failure,
  matchedEvent: null,
});

export const checkSource = (
  source: CitedSource,
  events: ReadonlyArray<TranscriptEvent>,
  batch: BatchRange | null,
): SourceCheck => {
  const quote = normalizeText(source.quote);
  if (quote.replace(/\s/gu, "").length < MIN_QUOTE_CHARS) return fail("quote-too-short");
  if (quote.length > MAX_QUOTE_CHARS) return fail("quote-too-long");
  if (
    !Number.isInteger(source.fromEvent) ||
    !Number.isInteger(source.toEvent) ||
    source.fromEvent < 0 ||
    source.toEvent < source.fromEvent
  ) {
    return fail("range-invalid");
  }
  if (batch !== null) {
    if (source.threadId !== batch.threadId) return fail("wrong-thread");
    if (source.fromEvent < batch.fromEvent || source.toEvent > batch.toEvent) {
      return fail("range-outside-batch");
    }
  }
  const inRange = events.filter(
    (event) =>
      event.threadId === source.threadId &&
      event.event >= source.fromEvent &&
      event.event <= source.toEvent,
  );
  if (inRange.length === 0) return fail("events-missing");
  for (const event of inRange) {
    if (normalizeText(event.text).includes(quote)) {
      return { ok: true, failure: null, matchedEvent: event.event };
    }
  }
  return fail("quote-not-found");
};

/** Check every source of one note. No sources is a failure: no note without a citation. */
export const checkCitation = (
  sources: ReadonlyArray<CitedSource>,
  events: ReadonlyArray<TranscriptEvent>,
  batch: BatchRange | null,
): CitationCheck => {
  if (sources.length === 0) {
    return { citation: "failed", sources: [], failure: "no-sources" };
  }
  const checks = sources.map((source) => checkSource(source, events, batch));
  const firstFailure = checks.find((check) => !check.ok)?.failure ?? null;
  return {
    citation: firstFailure === null ? "verified" : "failed",
    sources: checks,
    failure: firstFailure,
  };
};
