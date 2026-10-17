import type { Note, NoteSeverity, NoteType } from "@t3tools/contracts";

/**
 * Note bookkeeping that doesn't need storage: deterministic ids (so a retried
 * batch posts the same notes, not new ones), `replaces` chains and the FYI
 * ranking the inbox shows.
 *
 * Pure and type-import only: the scribe proof scripts import it directly.
 */

/** 64-bit FNV-1a as 16 hex chars. Stable across runs and machines. */
export const stableHash = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * Id of a scribe note. The same note from the same slice always gets the same
 * id: mission, thread, type and the first source's range and quote.
 */
export const scribeNoteId = (input: {
  readonly missionId: string;
  readonly type: string;
  readonly sources: ReadonlyArray<{
    readonly threadId: string;
    readonly quote: string;
    readonly fromEvent: number;
    readonly toEvent: number;
  }>;
}): string => {
  const parts = input.sources.map(
    (source) =>
      `${source.threadId}|${source.fromEvent}|${source.toEvent}|${source.quote.replace(/\s+/gu, " ").trim()}`,
  );
  return `note-${stableHash([input.missionId, input.type, ...parts].join("\n"))}`;
};

export type ReplaceProblem = "self" | "unknown" | "other-mission" | "cycle";

/**
 * Whether `note` may replace `replacesNoteId`. The replaced note must exist,
 * belong to the same mission and not sit later in the same chain.
 */
export const checkReplaces = (
  note: { readonly id: string; readonly missionId: string; readonly replacesNoteId: string | null },
  byId: ReadonlyMap<string, Pick<Note, "id" | "missionId" | "replacesNoteId">>,
): ReplaceProblem | null => {
  if (note.replacesNoteId === null) return null;
  if (note.replacesNoteId === note.id) return "self";
  const target = byId.get(note.replacesNoteId);
  if (target === undefined) return "unknown";
  if (target.missionId !== note.missionId) return "other-mission";
  const seen = new Set<string>([note.id]);
  let cursor: string | null = target.replacesNoteId;
  while (cursor !== null) {
    if (seen.has(cursor)) return "cycle";
    seen.add(cursor);
    cursor = byId.get(cursor)?.replacesNoteId ?? null;
  }
  return null;
};

/** Notes nothing else replaces: the current version of every chain. */
export const currentNotes = <N extends Pick<Note, "id" | "replacesNoteId">>(
  notes: ReadonlyArray<N>,
): ReadonlyArray<N> => {
  const replaced = new Set(
    notes.flatMap((note) => (note.replacesNoteId === null ? [] : [note.replacesNoteId])),
  );
  return notes.filter((note) => !replaced.has(note.id));
};

/** The chain ending at `noteId`, newest first. Stops at a cycle or a missing link. */
export const noteChain = <N extends Pick<Note, "id" | "replacesNoteId">>(
  noteId: string,
  notes: ReadonlyArray<N>,
): ReadonlyArray<N> => {
  const byId = new Map(notes.map((note) => [note.id as string, note]));
  const chain: N[] = [];
  const seen = new Set<string>();
  let cursor: string | null = noteId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const note = byId.get(cursor);
    if (note === undefined) break;
    chain.push(note);
    cursor = note.replacesNoteId;
  }
  return chain;
};

const SEVERITY_WEIGHT: Record<NoteSeverity, number> = {
  critical: 40,
  high: 30,
  medium: 20,
  low: 10,
};

const TYPE_WEIGHT: Record<NoteType, number> = {
  "owner-must-know": 100,
  blocker: 12,
  "rule-break": 10,
  deviation: 8,
  risk: 7,
  "claim-of-done": 6,
  decision: 5,
  "open-question": 4,
  assumption: 3,
};

/** Rank score for the FYI tab; higher first. Owner-must-know always leads. */
export const fyiScore = (
  note: Pick<Note, "type" | "severity" | "confidence" | "evidence" | "basis">,
): number =>
  TYPE_WEIGHT[note.type] +
  SEVERITY_WEIGHT[note.severity] +
  Math.round(note.confidence * 10) +
  (note.evidence === "mismatch" ? 25 : 0) +
  (note.basis === "observed" ? 2 : 0);

/**
 * The FYI list: current, citation-verified, not acked by the owner, ranked by
 * score then recency, capped. `editorOrder` (note ids the editor picked, in
 * order) wins over the score when given.
 */
export const rankFyi = <N extends Note>(
  notes: ReadonlyArray<N>,
  options: { readonly limit: number; readonly editorOrder?: ReadonlyArray<string> },
): ReadonlyArray<N> => {
  const eligible = currentNotes(notes).filter(
    (note) => note.citation === "verified" && !note.ackedBy.some((actor) => actor._tag === "owner"),
  );
  const editorRank = new Map((options.editorOrder ?? []).map((id, index) => [id, index]));
  const sorted = [...eligible].toSorted((a, b) => {
    const ra = editorRank.get(a.id);
    const rb = editorRank.get(b.id);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    const byOwner = Number(b.type === "owner-must-know") - Number(a.type === "owner-must-know");
    if (byOwner !== 0) return byOwner;
    const byScore = fyiScore(b) - fyiScore(a);
    if (byScore !== 0) return byScore;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return sorted.slice(0, options.limit);
};
