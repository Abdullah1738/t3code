/**
 * Fork-owned tables the control API reads and writes. DDL is the shared fork
 * contract (tmp/memory/shared-contracts.md): identical in every fork module
 * that touches these tables, created idempotently, never a numbered migration.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ControlStoreError extends Schema.TaggedError<ControlStoreError>()(
  "ControlStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ThreadOriginRow {
  readonly threadId: string;
  readonly origin: string;
  readonly createdAt: string;
}

export interface ControlStoreShape {
  readonly getOrigin: (threadId: string) => Effect.Effect<string | null, ControlStoreError>;
  readonly getOrigins: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, ControlStoreError>;
  readonly setOrigin: (
    threadId: ThreadId | string,
    origin: string | null,
  ) => Effect.Effect<void, ControlStoreError>;
  /**
   * The thread an OpenCode session id belongs to: the importer's mapping
   * first, then any provider thread whose native ref names the session.
   */
  readonly threadIdForNativeSession: (
    nativeSessionId: string,
  ) => Effect.Effect<string | null, ControlStoreError>;
  /** Native OpenCode session ids per thread, for listings. */
  readonly nativeSessionIds: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, ControlStoreError>;
  /**
   * Threads that may be non-idle: a run that has not ended, or a pending
   * runtime request. A superset of what the shell calls active, read from
   * the partial recovery indexes so listings skip the full shell snapshot.
   */
  readonly liveThreadIds: () => Effect.Effect<ReadonlyArray<string>, ControlStoreError>;
  /** Threads with a pending runtime request (approval or user input). */
  readonly pendingRequestThreadIds: () => Effect.Effect<ReadonlyArray<string>, ControlStoreError>;
}

export class ControlStore extends Context.Service<ControlStore, ControlStoreShape>()(
  "t3/ardud/control/ControlStore",
) {}

const CHUNK = 400;

const chunks = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += CHUNK) {
    out.push(values.slice(index, index + CHUNK));
  }
  return out;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new ControlStoreError({ operation, cause });

  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_thread_origin (
      thread_id   TEXT PRIMARY KEY,
      origin      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-thread-origin")));
  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_opencode_import (
      native_session_id TEXT PRIMARY KEY,
      thread_id         TEXT NOT NULL UNIQUE,
      imported_at       TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-opencode-import")));

  const getOrigins: ControlStoreShape["getOrigins"] = (threadIds) =>
    Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        sql<{ readonly thread_id: string; readonly origin: string }>`
          SELECT thread_id, origin FROM ardud_thread_origin WHERE thread_id IN ${sql.in(ids)}
        `,
      { concurrency: 1 },
    ).pipe(
      Effect.map((pages) => new Map(pages.flat().map((row) => [row.thread_id, row.origin]))),
      Effect.mapError(fail("read-origins")),
    );

  const getOrigin: ControlStoreShape["getOrigin"] = (threadId) =>
    getOrigins([threadId]).pipe(Effect.map((origins) => origins.get(threadId) ?? null));

  const setOrigin: ControlStoreShape["setOrigin"] = (threadId, origin) =>
    Effect.gen(function* () {
      if (origin === null) {
        yield* sql`DELETE FROM ardud_thread_origin WHERE thread_id = ${threadId}`;
        return;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
        VALUES (${threadId}, ${origin}, ${now})
        ON CONFLICT(thread_id) DO UPDATE SET origin = excluded.origin
      `;
    }).pipe(Effect.mapError(fail("write-origin")));

  const threadIdForNativeSession: ControlStoreShape["threadIdForNativeSession"] = (nativeId) =>
    Effect.gen(function* () {
      const imported = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = ${nativeId}
      `;
      if (imported[0] !== undefined) return imported[0].thread_id;
      const live = yield* sql<{ readonly thread_id: string | null }>`
        SELECT thread_id FROM orchestration_v2_projection_provider_threads
        WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${nativeId}
          AND thread_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      return live[0]?.thread_id ?? null;
    }).pipe(Effect.mapError(fail("read-native-session")));

  const nativeSessionIds: ControlStoreShape["nativeSessionIds"] = (threadIds) =>
    Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        sql<{ readonly thread_id: string; readonly native_id: string | null }>`
          SELECT thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN ${sql.in(ids)}
            AND json_extract(payload_json, '$.ownerNodeId') IS NULL
          ORDER BY updated_at ASC
        `,
      { concurrency: 1 },
    ).pipe(
      Effect.map((pages) => {
        const out = new Map<string, string>();
        for (const row of pages.flat()) {
          if (row.native_id !== null && row.native_id.startsWith("ses")) {
            out.set(row.thread_id, row.native_id);
          }
        }
        return out;
      }),
      Effect.mapError(fail("read-native-sessions")),
    );

  const liveThreadIds: ControlStoreShape["liveThreadIds"] = () =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_runs
      WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      UNION
      SELECT thread_id FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending'
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(fail("read-live-threads")),
    );

  const pendingRequestThreadIds: ControlStoreShape["pendingRequestThreadIds"] = () =>
    sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending'
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(fail("read-pending-request-threads")),
    );

  return ControlStore.of({
    getOrigin,
    getOrigins,
    setOrigin,
    threadIdForNativeSession,
    nativeSessionIds,
    liveThreadIds,
    pendingRequestThreadIds,
  });
});

export const layer = Layer.effect(ControlStore, make);
