/**
 * Fork-owned tables the control API reads and writes. DDL is the shared fork
 * contract (tmp/memory/shared-contracts.md): identical in every fork module
 * that touches these tables, created idempotently, never a numbered migration.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

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
   * The thread a native session id belongs to: the importer's mapping first,
   * then provider threads whose native ref names it. Null when the id is
   * unknown or when two threads claim it (never the newest one).
   */
  readonly threadIdForNativeSession: (
    nativeSessionId: string,
    driver?: string,
  ) => Effect.Effect<string | null, ControlStoreError>;
  /**
   * Current native id per thread (its active provider thread), for listings.
   * A migrated thread reports its new id. Threads with no active binding fall
   * back to their newest OpenCode session id.
   */
  readonly nativeSessionIds: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, ControlStoreError>;
  /** Current qualified native binding per thread. */
  readonly nativeBindings: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyMap<
      string,
      { readonly driver: string; readonly providerInstanceId: string; readonly nativeId: string }
    >,
    ControlStoreError
  >;
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
  const controlSql = yield* BoardsDatabase.client;
  const fail = (operation: string) => (cause: unknown) =>
    new ControlStoreError({ operation, cause });

  yield* BoardsDatabase.initialize(
    Effect.gen(function* () {
      yield* controlSql`
    CREATE TABLE IF NOT EXISTS ardud_thread_origin (
      thread_id   TEXT PRIMARY KEY,
      origin      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-thread-origin")));
      yield* controlSql`
    CREATE TABLE IF NOT EXISTS ardud_opencode_import (
      native_session_id TEXT PRIMARY KEY,
      thread_id         TEXT NOT NULL UNIQUE,
      imported_at       TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-opencode-import")));
    }),
  );

  const getOrigins: ControlStoreShape["getOrigins"] = (threadIds) =>
    Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        controlSql<{ readonly thread_id: string; readonly origin: string }>`
          SELECT thread_id, origin FROM ardud_thread_origin WHERE thread_id IN ${controlSql.in(ids)}
        `,
      { concurrency: 1 },
    ).pipe(
      NodeSqliteClient.readOnly,
      Effect.map((pages) => new Map(pages.flat().map((row) => [row.thread_id, row.origin]))),
      Effect.mapError(fail("read-origins")),
    );

  const getOrigin: ControlStoreShape["getOrigin"] = (threadId) =>
    getOrigins([threadId]).pipe(Effect.map((origins) => origins.get(threadId) ?? null));

  const setOrigin: ControlStoreShape["setOrigin"] = Effect.fn("ControlStore.setOrigin")(
    function* (threadId, origin) {
      if (origin === null) {
        yield* controlSql`DELETE FROM ardud_thread_origin WHERE thread_id = ${threadId}`;
        return;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* controlSql`
        INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
        VALUES (${threadId}, ${origin}, ${now})
        ON CONFLICT(thread_id) DO UPDATE SET origin = excluded.origin
      `;
    },
    Effect.mapError(fail("write-origin")),
  );

  const threadIdForNativeSession: ControlStoreShape["threadIdForNativeSession"] = Effect.fn(
    "ControlStore.threadIdForNativeSession",
  )(
    function* (nativeId, driver) {
      const imported =
        driver === undefined || driver === "opencode"
          ? yield* controlSql<{ readonly thread_id: string }>`
              SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = ${nativeId}
            `
          : [];
      const live = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT pt.thread_id
        FROM orchestration_v2_projection_provider_threads pt
        WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${nativeId}
          AND pt.thread_id IS NOT NULL
          AND (${driver ?? null} IS NULL
            OR COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = ${driver ?? null})
      `;
      const threadIds = new Set([
        ...imported.map((row) => row.thread_id),
        ...live.map((row) => row.thread_id),
      ]);
      // Two app threads claim this id: refuse rather than pick one.
      return threadIds.size === 1 ? [...threadIds][0]! : null;
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(fail("read-native-session")),
  );

  const nativeBindings: ControlStoreShape["nativeBindings"] = (threadIds) =>
    Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        sql<{
          readonly thread_id: string;
          readonly driver: string | null;
          readonly provider_instance_id: string | null;
          readonly native_id: string | null;
        }>`
          SELECT t.thread_id,
            COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) AS driver,
            COALESCE(pt.provider_instance_id, json_extract(pt.payload_json, '$.providerInstanceId')) AS provider_instance_id,
            json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id
          FROM orchestration_v2_projection_threads t
          JOIN orchestration_v2_projection_provider_threads pt
            ON pt.provider_thread_id = t.active_provider_thread_id
          WHERE t.thread_id IN ${sql.in(ids)}
        `,
      { concurrency: 1 },
    ).pipe(
      NodeSqliteClient.readOnly,
      Effect.map((pages) => {
        const out = new Map<
          string,
          {
            readonly driver: string;
            readonly providerInstanceId: string;
            readonly nativeId: string;
          }
        >();
        for (const row of pages.flat()) {
          if (row.driver !== null && row.provider_instance_id !== null && row.native_id !== null) {
            out.set(row.thread_id, {
              driver: row.driver,
              providerInstanceId: row.provider_instance_id,
              nativeId: row.native_id,
            });
          }
        }
        return out;
      }),
      Effect.mapError(fail("read-native-bindings")),
    );

  // Current OpenCode-style session id per thread, read from the active binding
  // only. A thread with no active native id (detached, or not yet created)
  // reports nothing: its old ses_ stays reachable through aliases and by-native,
  // never as the current id.
  const nativeSessionIds: ControlStoreShape["nativeSessionIds"] = (threadIds) =>
    nativeBindings(threadIds).pipe(
      Effect.map((bindings) => {
        const out = new Map<string, string>();
        for (const [threadId, binding] of bindings) out.set(threadId, binding.nativeId);
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
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(fail("read-live-threads")),
    );

  const pendingRequestThreadIds: ControlStoreShape["pendingRequestThreadIds"] = () =>
    sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending'
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(fail("read-pending-request-threads")),
    );

  return ControlStore.of({
    getOrigin,
    getOrigins,
    setOrigin,
    threadIdForNativeSession,
    nativeSessionIds,
    nativeBindings,
    liveThreadIds,
    pendingRequestThreadIds,
  });
});

export const layer = Layer.effect(ControlStore, make);
