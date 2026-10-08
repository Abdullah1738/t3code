import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { BoardRow, CompletedFrom } from "./BoardModel.ts";

/**
 * Fork tables for the session board, created idempotently in the server's own
 * sqlite. Never add these to persistence/Migrations.ts (upstream owns that list).
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_board_rows (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT,
    title TEXT NOT NULL,
    prompt_at INTEGER,
    pending INTEGER NOT NULL,
    reviewed INTEGER NOT NULL,
    backlog INTEGER NOT NULL,
    scheduled INTEGER NOT NULL,
    completed_from TEXT,
    deleted INTEGER NOT NULL,
    work_revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_board_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Shared with the other fork workers; identical DDL (tmp/memory/shared-contracts.md).
  `CREATE TABLE IF NOT EXISTS ardud_thread_origin (
    thread_id   TEXT PRIMARY KEY,
    origin      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_opencode_import (
    native_session_id TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL UNIQUE,
    imported_at       TEXT NOT NULL
  )`,
];

export class BoardStoreError extends Schema.TaggedError<BoardStoreError>()("BoardStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Session board storage failed during ${this.operation}.`;
  }
}

interface RowRecord {
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly prompt_at: number | null;
  readonly pending: number;
  readonly reviewed: number;
  readonly backlog: number;
  readonly scheduled: number;
  readonly completed_from: string | null;
  readonly deleted: number;
  readonly work_revision: number;
  readonly updated_at: number;
}

const completedFromOf = (value: string | null): CompletedFrom | null =>
  value === "waiting" || value === "backlog" || value === "scheduled" ? value : null;

const fromRecord = (record: RowRecord): BoardRow => ({
  threadId: record.thread_id,
  projectId: record.project_id,
  title: record.title,
  promptAt: record.prompt_at,
  pending: record.pending === 1,
  reviewed: record.reviewed === 1,
  backlog: record.backlog === 1,
  scheduled: record.scheduled === 1,
  completedFrom: completedFromOf(record.completed_from),
  deleted: record.deleted === 1,
  workRevision: record.work_revision,
  updatedAt: record.updated_at,
});

const toRecord = (row: BoardRow): RowRecord => ({
  thread_id: row.threadId,
  project_id: row.projectId,
  title: row.title,
  prompt_at: row.promptAt,
  pending: row.pending ? 1 : 0,
  reviewed: row.reviewed ? 1 : 0,
  backlog: row.backlog ? 1 : 0,
  scheduled: row.scheduled ? 1 : 0,
  completed_from: row.completedFrom,
  deleted: row.deleted ? 1 : 0,
  work_revision: row.workRevision,
  updated_at: row.updatedAt,
});

export interface BoardMeta {
  readonly activatedAt: number;
  readonly revision: number;
}

export class BoardStore extends Context.Service<
  BoardStore,
  {
    readonly load: Effect.Effect<
      { readonly meta: BoardMeta; readonly rows: ReadonlyArray<BoardRow> },
      BoardStoreError
    >;
    /** Writes rows and the new revision in one transaction. */
    readonly save: (
      rows: ReadonlyArray<BoardRow>,
      revision: number,
    ) => Effect.Effect<void, BoardStoreError>;
    readonly origins: (
      threadIds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, BoardStoreError>;
    readonly rememberOrigins: (
      entries: ReadonlyArray<{ readonly threadId: string; readonly origin: string }>,
    ) => Effect.Effect<number, BoardStoreError>;
    readonly setOrigin: (input: {
      readonly threadId: string;
      readonly origin: string;
    }) => Effect.Effect<void, BoardStoreError>;
    readonly importedThreads: (
      sessionIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, BoardStoreError>;
    /** Which of these t3 threads exist and are not deleted. */
    readonly existingThreads: (
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>, BoardStoreError>;
    /** Threads whose latest prompt came from a scheduled task, with that task's id. */
    readonly scheduledThreads: (
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>, BoardStoreError>;
  }
>()("t3/ardud/board/BoardStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) => new BoardStoreError({ operation, cause });

  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.mapError(fail("create tables")),
  );

  const load = Effect.gen(function* () {
    const rows = yield* sql<RowRecord>`SELECT * FROM ardud_board_rows`;
    const metaRows = yield* sql<{ readonly key: string; readonly value: string }>`
      SELECT key, value FROM ardud_board_meta
    `;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    let activatedAt = Number(meta.get("activated_at"));
    if (!Number.isFinite(activatedAt)) {
      activatedAt = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO ardud_board_meta (key, value) VALUES ('activated_at', ${String(activatedAt)})
        ON CONFLICT (key) DO NOTHING
      `;
    }
    const revision = Number(meta.get("revision") ?? 0);
    return {
      meta: { activatedAt, revision: Number.isSafeInteger(revision) ? revision : 0 },
      rows: rows.map(fromRecord),
    };
  }).pipe(Effect.mapError(fail("load")));

  const save = (rows: ReadonlyArray<BoardRow>, revision: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const row of rows) {
            const record = toRecord(row);
            yield* sql`
              INSERT INTO ardud_board_rows ${sql.insert({ ...record })}
              ON CONFLICT (thread_id) DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                prompt_at = excluded.prompt_at,
                pending = excluded.pending,
                reviewed = excluded.reviewed,
                backlog = excluded.backlog,
                scheduled = excluded.scheduled,
                completed_from = excluded.completed_from,
                deleted = excluded.deleted,
                work_revision = excluded.work_revision,
                updated_at = excluded.updated_at
            `;
          }
          yield* sql`
            INSERT INTO ardud_board_meta (key, value) VALUES ('revision', ${String(revision)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value
          `;
        }),
      )
      .pipe(Effect.mapError(fail("save")));

  // Bounded IN lists keep each statement well under sqlite's variable limit.
  const chunked = <A, E>(
    ids: ReadonlyArray<string>,
    read: (chunk: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<A>, E>,
  ) =>
    Effect.gen(function* () {
      const results: A[] = [];
      for (let index = 0; index < ids.length; index += 500) {
        results.push(...(yield* read(ids.slice(index, index + 500))));
      }
      return results;
    });

  interface OriginRecord {
    readonly thread_id: string;
    readonly origin: string;
  }
  const origins = (threadIds?: ReadonlyArray<string>) =>
    (threadIds === undefined
      ? sql<OriginRecord>`SELECT thread_id, origin FROM ardud_thread_origin`
      : chunked(
          threadIds,
          (chunk) => sql<OriginRecord>`
            SELECT thread_id, origin FROM ardud_thread_origin
            WHERE thread_id IN ${sql.in(chunk)}
          `,
        )
    ).pipe(
      Effect.map(
        (rows: ReadonlyArray<OriginRecord>) =>
          new Map(rows.map((row) => [row.thread_id, row.origin] as const)),
      ),
      Effect.mapError(fail("read origins")),
    );

  const rememberOrigins = (
    entries: ReadonlyArray<{ readonly threadId: string; readonly origin: string }>,
  ) =>
    Effect.gen(function* () {
      if (entries.length === 0) return 0;
      const now = DateTime.formatIso(yield* DateTime.now);
      let written = 0;
      yield* sql.withTransaction(
        Effect.forEach(
          entries,
          (entry) =>
            sql`
              INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
              VALUES (${entry.threadId}, ${entry.origin}, ${now})
              ON CONFLICT (thread_id) DO NOTHING
              RETURNING thread_id
            `.pipe(Effect.tap((rows) => Effect.sync(() => (written += rows.length)))),
          { discard: true },
        ),
      );
      return written;
    }).pipe(Effect.mapError(fail("write origins")));

  const setOrigin = (input: { readonly threadId: string; readonly origin: string }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
        VALUES (${input.threadId}, ${input.origin}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET origin = excluded.origin
      `;
    }).pipe(Effect.mapError(fail("write origin")));

  const importedThreads = (sessionIds: ReadonlyArray<string>) =>
    chunked(
      sessionIds,
      (chunk) => sql<{ readonly native_session_id: string; readonly thread_id: string }>`
        SELECT native_session_id, thread_id FROM ardud_opencode_import
        WHERE native_session_id IN ${sql.in(chunk)}
      `,
    ).pipe(
      Effect.map((rows) => new Map(rows.map((row) => [row.native_session_id, row.thread_id]))),
      Effect.mapError(fail("read import mapping")),
    );

  // Read-only look at the upstream message projection: a scheduled task's
  // prompt carries its task id.
  const scheduledThreads = (threadIds: ReadonlyArray<string>) =>
    chunked(
      threadIds,
      (chunk) => sql<{ readonly thread_id: string; readonly task_id: string }>`
        SELECT thread_id, task_id FROM (
          SELECT thread_id, json_extract(payload_json, '$.scheduledTaskId') AS task_id,
            ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY updated_at DESC, message_id DESC) AS rank
          FROM orchestration_v2_projection_messages
          WHERE thread_id IN ${sql.in(chunk)} AND role = 'user'
        )
        WHERE rank = 1 AND task_id IS NOT NULL
      `,
    ).pipe(
      Effect.map((rows) => new Map(rows.map((row) => [row.thread_id, String(row.task_id)]))),
      Effect.mapError(fail("read scheduled prompts")),
    );

  const existingThreads = (threadIds: ReadonlyArray<string>) =>
    chunked(
      threadIds,
      (chunk) => sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in(chunk)} AND deleted_at IS NULL
      `,
    ).pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
      Effect.mapError(fail("read threads")),
    );

  return BoardStore.of({
    existingThreads,
    load,
    save,
    origins,
    rememberOrigins,
    setOrigin,
    importedThreads,
    scheduledThreads,
  });
});

export const layer = Layer.effect(BoardStore, make);
