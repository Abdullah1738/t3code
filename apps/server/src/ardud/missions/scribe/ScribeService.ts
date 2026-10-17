import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MissionError, Note, type MissionActor, type MissionProvenance } from "@t3tools/contracts";

import { assembleBatch, type BatchStats, type ScribeBatchInput } from "./batch.ts";
import { currentNotes, rankFyi } from "./notes.ts";
import { MissionRecords } from "./ports.ts";
import { ScribeStore, type ScribeStoreError } from "./ScribeStore.ts";

/**
 * Server side of the scribe: hands the runner its lanes and cursors, checks
 * every posted batch (citations, claim evidence, `replaces`) and stores the
 * notes in core's record store. A batch at or behind the lane cursor is a
 * duplicate and writes nothing, so a retried post is harmless.
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
  }
>()("t3/ardud/missions/scribe/ScribeService") {}

const make = Effect.gen(function* () {
  const records = yield* MissionRecords;
  const store = yield* ScribeStore;
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const requireMission = (missionId: string) =>
    records
      .get("mission", missionId)
      .pipe(
        Effect.flatMap((mission) =>
          mission === null
            ? Effect.fail(new MissionError({ code: "not-found", detail: `mission ${missionId}` }))
            : Effect.succeed(mission),
        ),
      );

  const cursorFor = (missionId: string, threadId: string, startAt: string) =>
    store
      .cursor(missionId, threadId)
      .pipe(
        Effect.flatMap((stored) =>
          stored === null ? store.startCursor(threadId, startAt) : Effect.succeed(stored),
        ),
      );

  const lanes = (missionId: string) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const subMissions = yield* records.list("sub-mission", { missionId });
      const titleOf = (id: string | null) =>
        id === null ? null : (subMissions.find((sub) => sub.id === id)?.title ?? null);
      const out: ScribeLane[] = [];
      const seen = new Set<string>();
      for (const lane of yield* records.list("lane", { missionId })) {
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
        const bindings = yield* records.list("role-binding", {});
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
    records.list("note", { missionId }).pipe(
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
      const cursor = (yield* store.cursor(input.missionId, input.threadId)) ?? 0;
      if (input.toEvent <= cursor) {
        return { duplicate: true, accepted: 0, failed: 0, cursor, stats: null } as IngestResult;
      }
      const at = yield* now;
      const events = yield* store.transcript(input.threadId, input.fromEvent, input.toEvent);
      const pullRequests = yield* store.pullRequests(input.threadId);
      const existing = yield* records.list("note", { missionId: input.missionId });
      const assembled = assembleBatch(input, {
        events,
        pullRequests,
        knownNotes: new Map(existing.map((note) => [note.id as string, note])),
        now: at,
      });
      const known = new Set(existing.map((note) => note.id as string));
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
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const note of fresh) {
              yield* records.upsert(
                { _tag: "note", record: note },
                note.citation === "verified"
                  ? [
                      {
                        kind: "note.recorded",
                        actor: SCRIBE_ACTOR,
                        provenance: SCRIBE_PROVENANCE,
                        summary: clipLine(`${note.type}: ${note.summary}`),
                        subject: { kind: "note", id: note.id },
                        payload: {
                          laneId: note.laneId,
                          severity: note.severity,
                          evidence: note.evidence,
                          replacesNoteId: note.replacesNoteId,
                        },
                      },
                    ]
                  : [],
              );
            }
            yield* store.writeBatch({
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
            });
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(
                new MissionError({ code: "conflict", detail: `ingest: ${cause.message}` }),
              ),
          }),
        );
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
      const notes = yield* records.list("note", { missionId });
      const editor = yield* store.editorState(missionId);
      const order = (editor?.payload as { readonly fyiOrder?: ReadonlyArray<string> } | null)
        ?.fyiOrder;
      return rankFyi(notes, { limit, ...(order === undefined ? {} : { editorOrder: order }) });
    });

  const stats = (missionId: string, sinceIso: string | null) =>
    store.batches(missionId, sinceIso).pipe(Effect.map(summarizeStats));

  return ScribeService.of({ lanes, openNotes, ingest, fyi, stats });
});

export const layer = Layer.effect(ScribeService, make);
