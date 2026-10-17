import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MissionError,
  MissionId,
  Note,
  type MissionActor,
  type MissionProvenance,
} from "@t3tools/contracts";

import { MissionStore, type MissionCommit } from "../store/MissionStore.ts";
import { assembleBatch, type BatchStats, type ScribeBatchInput } from "./batch.ts";
import { currentNotes, rankFyi } from "./notes.ts";
import { type BuiltReport, buildReport, type ReportKind } from "./reports.ts";
import { ScribeStore, type ScribeStoreError } from "./ScribeStore.ts";

/**
 * Server side of the scribe: hands the runner its lanes and cursors, checks
 * every posted batch (citations, claim evidence, `replaces`) and stores the
 * notes in core's record store. A batch at or behind the lane cursor is a
 * duplicate and writes nothing, so a retried post is harmless.
 *
 * Each verified note is its own commit with a `note.recorded` event, so the
 * timeline and feed show one line per note. Notes whose quote did not check
 * out are kept (they feed the pass rate) under a single event per batch. The
 * batch row and the new cursor ride on the last commit; if the server dies
 * part-way, the retry skips note ids it already stored and finishes the batch.
 */

const decodeNote = Schema.decodeUnknownEffect(Note);

export const SCRIBE_ACTOR: MissionActor = { _tag: "system", component: "scribe" };
export const SCRIBE_PROVENANCE: MissionProvenance = { _tag: "system", component: "scribe" };

const OPEN_NOTES_LIMIT = 30;

export interface ScribeLane {
  readonly name: string;
  readonly threadId: string;
  readonly missionId: string;
  readonly laneId: string | null;
  readonly subMissionId: string | null;
  readonly purpose: string;
  readonly missionTitle: string;
  readonly subMissionTitle: string | null;
  readonly cursor: number;
}

export interface OpenNoteLine {
  readonly id: string;
  readonly type: string;
  readonly severity: string;
  readonly summary: string;
}

export interface IngestResult {
  readonly duplicate: boolean;
  readonly accepted: number;
  readonly failed: number;
  readonly cursor: number;
  readonly stats: BatchStats | null;
}

export interface ScribeStats {
  readonly batches: number;
  readonly notes: number;
  readonly verified: number;
  readonly failed: number;
  /** Share of posted notes whose citation checked out; null before any note. */
  readonly citationPassRate: number | null;
  readonly mismatch: number;
  readonly dropped: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ScribeError = MissionError | ScribeStoreError;

export interface ReportRequest {
  readonly missionId: string;
  readonly kind: ReportKind;
  /** End of the window; defaults to now. */
  readonly to?: string | undefined;
  /** Start of the window; defaults to the last report of this kind, else 4h/24h back. */
  readonly from?: string | undefined;
  /** Keep the report so the next one closes out what it left open. */
  readonly save: boolean;
}

const WINDOW_HOURS: Record<ReportKind, number> = { update: 4, daily: 24 };
/** Notes read for ranking and reports: the newest this many per mission. */
const NOTE_WINDOW = 5000;
/** Events read for "You asked" (owner messages in the window). */
const EVENT_WINDOW = 500;
/** Longest `replaces` chain followed when validating a new note. */
const CHAIN_DEPTH = 50;

const clipLine = (text: string, max = 400): string => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

export const summarizeStats = (
  batches: ReadonlyArray<{
    readonly stats: BatchStats;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }>,
): ScribeStats => {
  const sum = (pick: (stats: BatchStats) => number) =>
    batches.reduce((total, batch) => total + pick(batch.stats), 0);
  const notes = sum((stats) => stats.notes);
  const verified = sum((stats) => stats.verified);
  return {
    batches: batches.length,
    notes,
    verified,
    failed: sum((stats) => stats.failed),
    citationPassRate: notes === 0 ? null : verified / notes,
    mismatch: sum((stats) => stats.mismatch),
    dropped: sum((stats) => stats.dropped),
    inputTokens: batches.reduce((total, batch) => total + batch.inputTokens, 0),
    outputTokens: batches.reduce((total, batch) => total + batch.outputTokens, 0),
  };
};

export class ScribeService extends Context.Service<
  ScribeService,
  {
    /** Lane threads (and the master's thread) the runner should read, with cursors. */
    readonly lanes: (missionId: string) => Effect.Effect<ReadonlyArray<ScribeLane>, ScribeError>;
    /** Current verified notes from one thread, newest first, for the scribe's running state. */
    readonly openNotes: (
      missionId: string,
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<OpenNoteLine>, ScribeError>;
    readonly ingest: (input: ScribeBatchInput) => Effect.Effect<IngestResult, ScribeError>;
    /** Ranked FYI notes (editor order first when the editor has run). */
    readonly fyi: (
      missionId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Note>, ScribeError>;
    readonly stats: (
      missionId: string,
      sinceIso: string | null,
    ) => Effect.Effect<ScribeStats, ScribeError>;
    /** Build the 4h update or the daily summary from mission data. */
    readonly report: (request: ReportRequest) => Effect.Effect<BuiltReport, ScribeError>;
  }
>()("t3/ardud/missions/scribe/ScribeService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const scribe = yield* ScribeStore;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const requireMission = (missionId: string) =>
    store.get("mission", missionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new MissionError({ code: "not-found", detail: `mission ${missionId}` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const recentNotes = (missionId: string) =>
    store.list("note", { missionId: MissionId.make(missionId), limit: NOTE_WINDOW });

  /** The notes a batch touches: its own ids plus every `replaces` chain it points into. */
  const knownNotesFor = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const byId = new Map<string, Note>();
      let next = [...new Set(ids)];
      for (let depth = 0; next.length > 0 && depth < CHAIN_DEPTH; depth += 1) {
        const found = yield* store.list("note", { ids: next });
        for (const note of found) byId.set(note.id, note);
        next = found
          .map((note) => note.replacesNoteId)
          .filter((id): id is NonNullable<typeof id> => id !== null && !byId.has(id));
      }
      return byId;
    });

  const cursorFor = (missionId: string, threadId: string, startAt: string) =>
    scribe
      .cursor(missionId, threadId)
      .pipe(
        Effect.flatMap((stored) =>
          stored === null ? scribe.startCursor(threadId, startAt) : Effect.succeed(stored),
        ),
      );

  const lanes = (missionId: string) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const id = MissionId.make(missionId);
      const subMissions = yield* store.list("sub-mission", { missionId: id });
      const titleOf = (id: string | null) =>
        id === null ? null : (subMissions.find((sub) => sub.id === id)?.title ?? null);
      const out: ScribeLane[] = [];
      const seen = new Set<string>();
      for (const lane of yield* store.list("lane", { missionId: id })) {
        if (lane.threadId === null || lane.status === "retired" || seen.has(lane.threadId))
          continue;
        seen.add(lane.threadId);
        out.push({
          name: lane.name,
          threadId: lane.threadId,
          missionId,
          laneId: lane.id,
          subMissionId: lane.subMissionId,
          purpose: lane.purpose,
          missionTitle: mission.title,
          subMissionTitle: titleOf(lane.subMissionId),
          cursor: yield* cursorFor(missionId, lane.threadId, lane.createdAt),
        });
      }
      // The master thread is read too: its decisions and owner messages matter most.
      if (mission.masterRoleId !== null) {
        const bindings = yield* store.list("role-binding", { status: ["bound"] });
        const master = bindings.find(
          (binding) => binding.roleId === mission.masterRoleId && binding.endedAt === null,
        );
        if (master !== undefined && !seen.has(master.threadId)) {
          out.push({
            name: "master",
            threadId: master.threadId,
            missionId,
            laneId: null,
            subMissionId: null,
            purpose: `Master coordinator of ${mission.title}`,
            missionTitle: mission.title,
            subMissionTitle: null,
            cursor: yield* cursorFor(missionId, master.threadId, master.boundAt),
          });
        }
      }
      return out;
    });

  const openNotes = (missionId: string, threadId: string) =>
    recentNotes(missionId).pipe(
      Effect.map((notes) =>
        currentNotes(notes)
          .filter(
            (note) =>
              note.citation === "verified" &&
              note.sources.some((source) => source.threadId === threadId),
          )
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, OPEN_NOTES_LIMIT)
          .map((note) => ({
            id: note.id,
            type: note.type,
            severity: note.severity,
            summary: note.summary,
          })),
      ),
    );

  const ingest = (input: ScribeBatchInput) =>
    Effect.gen(function* () {
      if (!(input.fromEvent <= input.toEvent)) {
        return yield* new MissionError({
          code: "invalid",
          detail: `batch range ${input.fromEvent}..${input.toEvent}`,
        });
      }
      yield* requireMission(input.missionId);
      const missionId = MissionId.make(input.missionId);
      const cursor = (yield* scribe.cursor(input.missionId, input.threadId)) ?? 0;
      if (input.toEvent <= cursor) {
        return { duplicate: true, accepted: 0, failed: 0, cursor, stats: null } as IngestResult;
      }
      const at = yield* now;
      const events = yield* scribe.transcript(input.threadId, input.fromEvent, input.toEvent);
      const pullRequests = yield* scribe.pullRequests(input.threadId);
      // First pass only to learn the ids and `replaces` targets this batch touches.
      const draftIds = assembleBatch(input, {
        events,
        pullRequests,
        knownNotes: new Map(),
        now: at,
      }).notes.map((note) => note.id as string);
      const replaces = input.notes.flatMap((note) =>
        note.replaces === null ? [] : [note.replaces],
      );
      const known = yield* knownNotesFor([...draftIds, ...replaces]);
      const assembled = assembleBatch(input, { events, pullRequests, knownNotes: known, now: at });

      const fresh: Note[] = [];
      for (const draft of assembled.notes) {
        if (known.has(draft.id)) continue;
        fresh.push(
          yield* decodeNote(draft).pipe(
            Effect.mapError(
              (cause) => new MissionError({ code: "invalid", detail: `note: ${cause.message}` }),
            ),
          ),
        );
      }

      const commits: MissionCommit[] = fresh
        .filter((note) => note.citation === "verified")
        .map((note) => ({
          event: {
            missionId,
            kind: "note.recorded",
            actor: SCRIBE_ACTOR,
            provenance: SCRIBE_PROVENANCE,
            summary: clipLine(`${note.type}: ${note.summary}`),
            subject: { kind: "note", id: note.id },
            payload: {
              laneId: note.laneId,
              severity: note.severity,
              citation: note.citation,
              evidence: note.evidence,
              replacesNoteId: note.replacesNoteId,
            },
            at,
          },
          upserts: [{ _tag: "note", record: note }],
        }));
      const failed = fresh.filter((note) => note.citation !== "verified");
      if (failed.length > 0) {
        commits.push({
          event: {
            missionId,
            kind: "note.recorded",
            actor: SCRIBE_ACTOR,
            provenance: SCRIBE_PROVENANCE,
            summary: `Scribe kept ${failed.length} note(s) whose quote did not match the transcript; they stay out of FYI.`,
            subject: null,
            payload: { citation: "failed", noteIds: failed.map((note) => note.id) },
            at,
          },
          upserts: failed.map((note) => ({ _tag: "note" as const, record: note })),
        });
      }

      const batchWrite = scribe
        .writeBatch({
          batch: {
            batchId: `${input.missionId}|${input.threadId}|${input.fromEvent}|${input.toEvent}`,
            missionId: input.missionId,
            threadId: input.threadId,
            fromEvent: input.fromEvent,
            toEvent: input.toEvent,
            model: input.model,
            inputTokens: input.usage.input,
            outputTokens: input.usage.output,
            stats: assembled.stats,
            createdAt: at,
          },
          candidates: assembled.candidates,
          cursor: input.toEvent,
        })
        // Same contract as core's store: storage faults are defects.
        .pipe(Effect.orDie);

      const last = commits.pop();
      for (const commit of commits) yield* store.commit(commit);
      if (last === undefined) yield* batchWrite;
      else yield* store.commit({ ...last, alongside: batchWrite });

      return {
        duplicate: false,
        accepted: assembled.stats.verified,
        failed: assembled.stats.failed,
        cursor: input.toEvent,
        stats: assembled.stats,
      } as IngestResult;
    });

  const fyi = (missionId: string, limit: number) =>
    Effect.gen(function* () {
      const notes = yield* recentNotes(missionId);
      const editor = yield* scribe.editorState(missionId);
      const order = (editor?.payload as { readonly fyiOrder?: ReadonlyArray<string> } | null)
        ?.fyiOrder;
      return rankFyi(notes, { limit, ...(order === undefined ? {} : { editorOrder: order }) });
    });

  const stats = (missionId: string, sinceIso: string | null) =>
    scribe.batches(missionId, sinceIso).pipe(Effect.map(summarizeStats));

  const report = (request: ReportRequest) =>
    Effect.gen(function* () {
      const { missionId, kind } = request;
      const mission = yield* requireMission(missionId);
      const to = request.to ?? (yield* now);
      const id = MissionId.make(missionId);
      const previous = yield* scribe.lastReport(missionId, kind);
      const usablePrevious = previous !== null && previous.coversTo < to ? previous : null;
      const from =
        request.from ??
        usablePrevious?.coversTo ??
        DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(to), { hours: WINDOW_HOURS[kind] }),
        );
      if (from >= to) {
        return yield* new MissionError({
          code: "invalid",
          detail: `report window ${from} to ${to}`,
        });
      }
      const [subMissions, milestones, lanes, asks, calls, approvals, workItems, notes] =
        yield* Effect.all([
          store.list("sub-mission", { missionId: id }),
          store.list("milestone", { missionId: id }),
          store.list("lane", { missionId: id }),
          store.list("ask", { missionId: id }),
          store.list("call", { missionId: id }),
          store.list("approval", { missionId: id }),
          store.list("work-item", { missionId: id }),
          recentNotes(missionId),
        ]);
      const suggestions = yield* store.list("suggestion", { missionId: id });
      // Newest first from core; reports only need the window's owner messages.
      const events = (yield* store.recentEvents(id, EVENT_WINDOW)).toReversed();
      const editor = yield* scribe.editorState(missionId);
      const editorLine = (editor?.payload as { readonly bottomLine?: unknown } | null)?.bottomLine;
      const batches = yield* scribe.batches(missionId, from);
      const usage = batches.length === 0 ? null : summarizeStats(batches);
      const updates =
        kind === "daily" ? yield* scribe.reportsBetween(missionId, "update", from, to) : [];
      const built = buildReport({
        kind,
        from,
        to,
        mission,
        subMissions,
        milestones,
        lanes,
        asks,
        calls,
        approvals,
        workItems,
        notes,
        suggestions,
        events,
        previous: usablePrevious,
        updates,
        bottomLine:
          typeof editorLine === "string" && editor !== null
            ? { text: editorLine, at: editor.updatedAt }
            : null,
        usage,
      });
      if (request.save) {
        yield* scribe.saveReport({
          reportId: `${missionId}|${kind}|${to}`,
          missionId,
          kind,
          coversFrom: from,
          coversTo: to,
          open: built.open,
          text: built.text,
          createdAt: yield* now,
        });
      }
      return built;
    });

  return ScribeService.of({ lanes, openNotes, ingest, fyi, stats, report });
});

export const layer = Layer.effect(ScribeService, make);
