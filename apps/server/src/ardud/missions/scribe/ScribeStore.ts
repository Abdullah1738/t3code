import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { BatchStats, ScribeCandidate } from "./batch.ts";
import { type PullRequestFact, pullRequestFacts } from "./evidence.ts";
import type { OpenItem, ReportKind } from "./reports.ts";
import { type TranscriptEvent, transcriptEvent } from "./transcriptText.ts";

/**
 * Scribe-owned tables (high-volume or scribe-only state), created idempotently
 * in the server's own sqlite. Never add these to persistence/Migrations.ts
 * (upstream owns that list). Notes and suggestions themselves live in core's
 * record store; these tables hold cursors, batch metrics, raw improvement
 * candidates, the editor's latest pass and report checkpoints.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_scribe_cursor (
    mission_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (mission_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_scribe_batch (
    batch_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_event INTEGER NOT NULL,
    to_event INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    stats_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_scribe_batch_mission
    ON ardud_mission_scribe_batch (mission_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_scribe_candidate (
    candidate_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    suggestion_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_scribe_candidate_mission
    ON ardud_mission_scribe_candidate (mission_id, status)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_scribe_editor (
    mission_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_scribe_report (
    report_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    covers_from TEXT NOT NULL,
    covers_to TEXT NOT NULL,
    open_json TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_scribe_report_kind
    ON ardud_mission_scribe_report (mission_id, kind, covers_to)`,
] as const;

export class ScribeStoreError extends Schema.TaggedError<ScribeStoreError>()("ScribeStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Scribe store failed to ${this.operation}.`;
  }
}

export interface BatchRecord {
  readonly batchId: string;
  readonly missionId: string;
  readonly threadId: string;
  readonly fromEvent: number;
  readonly toEvent: number;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stats: BatchStats;
  readonly createdAt: string;
}

export type CandidateStatus = "open" | "merged" | "dropped";

export interface CandidateRecord {
  readonly candidate: ScribeCandidate;
  readonly status: CandidateStatus;
  readonly suggestionId: string | null;
  readonly updatedAt: string;
}

export interface ReportRecord {
  readonly reportId: string;
  readonly missionId: string;
  readonly kind: ReportKind;
  readonly coversFrom: string;
  readonly coversTo: string;
  /** Items left open at the end of this report; the next one closes them out. */
  readonly open: ReadonlyArray<OpenItem>;
  readonly text: string;
  readonly createdAt: string;
}

/** What `ingest` writes beside core's records, in the same transaction. */
export interface BatchWrite {
  readonly batch: BatchRecord;
  readonly candidates: ReadonlyArray<ScribeCandidate>;
  readonly cursor: number;
}

interface CursorRow {
  readonly cursor: number;
}
interface ItemRow {
  readonly ordinal: number;
  readonly type: string;
  readonly payload_json: string;
}
interface BatchRow {
  readonly batch_id: string;
  readonly mission_id: string;
  readonly thread_id: string;
  readonly from_event: number;
  readonly to_event: number;
  readonly model: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly stats_json: string;
  readonly created_at: string;
}
interface CandidateRow {
  readonly payload_json: string;
  readonly status: string;
  readonly suggestion_id: string | null;
  readonly updated_at: string;
}
interface ReportRow {
  readonly report_id: string;
  readonly mission_id: string;
  readonly kind: string;
  readonly covers_from: string;
  readonly covers_to: string;
  readonly open_json: string;
  readonly text: string;
  readonly created_at: string;
}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownOption(JsonText);
/** JSON text for a stored column. */
export const toJson = Schema.encodeSync(JsonText);

const parse = <A>(text: string, fallback: A): A => {
  const decoded = decodeJsonText(text);
  return decoded._tag === "Some" ? (decoded.value as A) : fallback;
};

const batchFromRow = (row: BatchRow): BatchRecord => ({
  batchId: row.batch_id,
  missionId: row.mission_id,
  threadId: row.thread_id,
  fromEvent: Number(row.from_event),
  toEvent: Number(row.to_event),
  model: row.model,
  inputTokens: Number(row.input_tokens),
  outputTokens: Number(row.output_tokens),
  stats: parse<BatchStats>(row.stats_json, {
    notes: 0,
    verified: 0,
    failed: 0,
    failures: {},
    mismatch: 0,
    dropped: 0,
    replaceRejected: 0,
    candidates: 0,
    candidatesFailed: 0,
  }),
  createdAt: row.created_at,
});

const reportFromRow = (row: ReportRow): ReportRecord => ({
  reportId: row.report_id,
  missionId: row.mission_id,
  kind: row.kind === "daily" ? "daily" : "update",
  coversFrom: row.covers_from,
  coversTo: row.covers_to,
  open: parse<ReadonlyArray<OpenItem>>(row.open_json, []),
  text: row.text,
  createdAt: row.created_at,
});

export class ScribeStore extends Context.Service<
  ScribeStore,
  {
    readonly cursor: (
      missionId: string,
      threadId: string,
    ) => Effect.Effect<number | null, ScribeStoreError>;
    /** Records batch metrics, candidates and the new cursor in one transaction. */
    readonly writeBatch: (write: BatchWrite) => Effect.Effect<void, ScribeStoreError>;
    readonly batches: (
      missionId: string,
      sinceIso: string | null,
    ) => Effect.Effect<ReadonlyArray<BatchRecord>, ScribeStoreError>;
    readonly candidates: (
      missionId: string,
      status: CandidateStatus | null,
    ) => Effect.Effect<ReadonlyArray<CandidateRecord>, ScribeStoreError>;
    readonly setCandidateStatus: (
      candidateId: string,
      status: CandidateStatus,
      suggestionId: string | null,
      at: string,
    ) => Effect.Effect<void, ScribeStoreError>;
    readonly editorState: (
      missionId: string,
    ) => Effect.Effect<
      { readonly payload: unknown; readonly updatedAt: string } | null,
      ScribeStoreError
    >;
    readonly saveEditorState: (
      missionId: string,
      payload: unknown,
      at: string,
    ) => Effect.Effect<void, ScribeStoreError>;
    readonly lastReport: (
      missionId: string,
      kind: ReportKind,
    ) => Effect.Effect<ReportRecord | null, ScribeStoreError>;
    readonly reportsBetween: (
      missionId: string,
      kind: ReportKind,
      fromIso: string,
      toIso: string,
    ) => Effect.Effect<ReadonlyArray<ReportRecord>, ScribeStoreError>;
    readonly saveReport: (report: ReportRecord) => Effect.Effect<void, ScribeStoreError>;
    /** Settled turn items of one thread in an inclusive ordinal range (read-only). */
    readonly transcript: (
      threadId: string,
      fromEvent: number,
      toEvent: number,
    ) => Effect.Effect<ReadonlyArray<TranscriptEvent>, ScribeStoreError>;
    /** PR facts Robob already tracks for a thread. */
    readonly pullRequests: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestFact>, ScribeStoreError>;
    /** Last ordinal of the thread's runs requested before `beforeIso`; 0 if none. */
    readonly startCursor: (
      threadId: string,
      beforeIso: string,
    ) => Effect.Effect<number, ScribeStoreError>;
  }
>()("t3/ardud/missions/scribe/ScribeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new ScribeStoreError({ operation, cause });

  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.mapError(fail("create tables")),
  );

  const cursor = (missionId: string, threadId: string) =>
    sql<CursorRow>`
      SELECT cursor FROM ardud_mission_scribe_cursor
      WHERE mission_id = ${missionId} AND thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0] ? Number(rows[0].cursor) : null)),
      Effect.mapError(fail("read cursor")),
    );

  const writeBatch = (write: BatchWrite) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { batch } = write;
          yield* sql`
            INSERT INTO ardud_mission_scribe_batch ${sql.insert({
              batch_id: batch.batchId,
              mission_id: batch.missionId,
              thread_id: batch.threadId,
              from_event: batch.fromEvent,
              to_event: batch.toEvent,
              model: batch.model,
              input_tokens: batch.inputTokens,
              output_tokens: batch.outputTokens,
              stats_json: toJson(batch.stats),
              created_at: batch.createdAt,
            })}
            ON CONFLICT (batch_id) DO NOTHING
          `;
          for (const candidate of write.candidates) {
            yield* sql`
              INSERT INTO ardud_mission_scribe_candidate ${sql.insert({
                candidate_id: candidate.id,
                mission_id: candidate.missionId,
                thread_id: candidate.threadId,
                status: candidate.citation === "verified" ? "open" : "dropped",
                suggestion_id: null,
                payload_json: toJson(candidate),
                created_at: candidate.createdAt,
                updated_at: candidate.createdAt,
              })}
              ON CONFLICT (candidate_id) DO NOTHING
            `;
          }
          yield* sql`
            INSERT INTO ardud_mission_scribe_cursor ${sql.insert({
              mission_id: batch.missionId,
              thread_id: batch.threadId,
              cursor: write.cursor,
              updated_at: batch.createdAt,
            })}
            ON CONFLICT (mission_id, thread_id) DO UPDATE SET
              cursor = MAX(ardud_mission_scribe_cursor.cursor, excluded.cursor),
              updated_at = excluded.updated_at
          `;
        }),
      )
      .pipe(Effect.mapError(fail("write batch")));

  const batches = (missionId: string, sinceIso: string | null) =>
    sql<BatchRow>`
      SELECT * FROM ardud_mission_scribe_batch
      WHERE mission_id = ${missionId} AND created_at >= ${sinceIso ?? ""}
      ORDER BY created_at, batch_id
    `.pipe(
      Effect.map((rows) => rows.map(batchFromRow)),
      Effect.mapError(fail("read batches")),
    );

  const candidates = (missionId: string, status: CandidateStatus | null) =>
    (status === null
      ? sql<CandidateRow>`
          SELECT payload_json, status, suggestion_id, updated_at FROM ardud_mission_scribe_candidate
          WHERE mission_id = ${missionId} ORDER BY created_at, candidate_id
        `
      : sql<CandidateRow>`
          SELECT payload_json, status, suggestion_id, updated_at FROM ardud_mission_scribe_candidate
          WHERE mission_id = ${missionId} AND status = ${status} ORDER BY created_at, candidate_id
        `
    ).pipe(
      Effect.map((rows) =>
        rows.map((row): CandidateRecord => ({
          candidate: parse<ScribeCandidate>(row.payload_json, {} as ScribeCandidate),
          status: row.status as CandidateStatus,
          suggestionId: row.suggestion_id,
          updatedAt: row.updated_at,
        })),
      ),
      Effect.mapError(fail("read candidates")),
    );

  const setCandidateStatus = (
    candidateId: string,
    status: CandidateStatus,
    suggestionId: string | null,
    at: string,
  ) =>
    sql`
      UPDATE ardud_mission_scribe_candidate
      SET status = ${status}, suggestion_id = ${suggestionId}, updated_at = ${at}
      WHERE candidate_id = ${candidateId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("update candidate")));

  const editorState = (missionId: string) =>
    sql<{ readonly payload_json: string; readonly updated_at: string }>`
      SELECT payload_json, updated_at FROM ardud_mission_scribe_editor WHERE mission_id = ${missionId}
    `.pipe(
      Effect.map((rows) =>
        rows[0]
          ? { payload: parse<unknown>(rows[0].payload_json, null), updatedAt: rows[0].updated_at }
          : null,
      ),
      Effect.mapError(fail("read editor state")),
    );

  const saveEditorState = (missionId: string, payload: unknown, at: string) =>
    sql`
      INSERT INTO ardud_mission_scribe_editor ${sql.insert({
        mission_id: missionId,
        payload_json: toJson(payload),
        updated_at: at,
      })}
      ON CONFLICT (mission_id) DO UPDATE SET
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(fail("save editor state")));

  const lastReport = (missionId: string, kind: ReportKind) =>
    sql<ReportRow>`
      SELECT * FROM ardud_mission_scribe_report
      WHERE mission_id = ${missionId} AND kind = ${kind}
      ORDER BY covers_to DESC, created_at DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] ? reportFromRow(rows[0]) : null)),
      Effect.mapError(fail("read last report")),
    );

  const reportsBetween = (missionId: string, kind: ReportKind, fromIso: string, toIso: string) =>
    sql<ReportRow>`
      SELECT * FROM ardud_mission_scribe_report
      WHERE mission_id = ${missionId} AND kind = ${kind}
        AND covers_to > ${fromIso} AND covers_to <= ${toIso}
      ORDER BY covers_to
    `.pipe(
      Effect.map((rows) => rows.map(reportFromRow)),
      Effect.mapError(fail("read reports")),
    );

  const saveReport = (report: ReportRecord) =>
    sql`
      INSERT INTO ardud_mission_scribe_report ${sql.insert({
        report_id: report.reportId,
        mission_id: report.missionId,
        kind: report.kind,
        covers_from: report.coversFrom,
        covers_to: report.coversTo,
        open_json: toJson(report.open),
        text: report.text,
        created_at: report.createdAt,
      })}
      ON CONFLICT (report_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("save report")));

  const transcript = (threadId: string, fromEvent: number, toEvent: number) =>
    sql<ItemRow>`
      SELECT ordinal, type, payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND ordinal >= ${fromEvent} AND ordinal <= ${toEvent}
        AND type != 'reasoning'
      ORDER BY ordinal
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          transcriptEvent({
            threadId,
            ordinal: Number(row.ordinal),
            type: row.type,
            payload: row.payload_json,
          }),
        ),
      ),
      Effect.mapError(fail("read transcript")),
    );

  const pullRequests = (threadId: string) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) =>
        rows[0] ? pullRequestFacts(parse<unknown>(rows[0].payload_json, {})) : [],
      ),
      Effect.mapError(fail("read thread pull requests")),
    );

  const startCursor = (threadId: string, beforeIso: string) =>
    sql<{ readonly last: number | null }>`
      SELECT MAX(i.ordinal) AS last
      FROM orchestration_v2_projection_turn_items i
      JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.thread_id = ${threadId} AND r.requested_at < ${beforeIso}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.last ?? 0)),
      Effect.mapError(fail("read start cursor")),
    );

  return ScribeStore.of({
    cursor,
    writeBatch,
    batches,
    candidates,
    setCandidateStatus,
    editorState,
    saveEditorState,
    lastReport,
    reportsBetween,
    saveReport,
    transcript,
    pullRequests,
    startCursor,
  });
});

export const layer = Layer.effect(ScribeStore, make);
