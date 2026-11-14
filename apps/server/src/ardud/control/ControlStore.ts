/**
 * Fork-owned tables the control API reads and writes. DDL is the shared fork
 * contract (tmp/memory/shared-contracts.md): identical in every fork module
 * that touches these tables, created idempotently, never a numbered migration.
 */
import {
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { importedThreadQuery, providerThreadQuery } from "./nativeLookup.ts";

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
  readonly ownerShell: (threadId: string) => Effect.Effect<OwnerShell | null, ControlStoreError>;
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
  /** Indexed count for slow-lookup diagnostics only. */
  readonly threadRunCount: (threadId: string) => Effect.Effect<number, ControlStoreError>;
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
  readonly pendingRequestRecords: (threadIds: ReadonlyArray<string>) => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: string;
      readonly request: OrchestrationV2RuntimeRequest;
      readonly item: OrchestrationV2TurnItem | null;
    }>,
    ControlStoreError
  >;
  readonly threadCandidatePage: (
    options: ThreadCandidateFilter & {
      readonly after?: ThreadCandidateCursor;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<ControlThreadRow>, ControlStoreError>;
  readonly threadCandidateCount: (
    filter: ThreadCandidateFilter,
  ) => Effect.Effect<number, ControlStoreError>;
}

export interface ThreadCandidateFilter {
  readonly since: number | null;
  readonly location: "active" | "archive";
  readonly includeSubagents: boolean;
  readonly parentThreadId: string | null;
  readonly projectId: string | null;
  readonly creationSources?: ReadonlyArray<string>;
}

export interface OwnerShell {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly status: OrchestrationV2Run["status"] | "idle";
  readonly pending: boolean;
  readonly archived: boolean;
  readonly deleted: boolean;
}

export interface ThreadCandidateCursor {
  readonly updatedAt: string;
  readonly threadId: string;
}

export interface ControlThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly relationshipToParent: string | null;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string | null;
  readonly creationSource: string | null;
}

export class ControlStore extends Context.Service<ControlStore, ControlStoreShape>()(
  "t3/ardud/control/ControlStore",
) {}

const CHUNK = 400;
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

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

  const threadRunCount: ControlStoreShape["threadRunCount"] = Effect.fn(
    "ControlStore.threadRunCount",
  )(
    (threadId) =>
      sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    NodeSqliteClient.readOnly,
    Effect.mapError(fail("count-thread-runs")),
  );

  const getOrigin: ControlStoreShape["getOrigin"] = (threadId) =>
    getOrigins([threadId]).pipe(Effect.map((origins) => origins.get(threadId) ?? null));

  const ownerShell: ControlStoreShape["ownerShell"] = Effect.fn("ControlStore.ownerShell")(
    function* (threadId) {
      // Ownership needs no transcript, provider enrichment, error history or run
      // payload. Each status probe is bounded by the thread/status or ordinal index.
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly project_id: string;
        readonly title: string;
        readonly status: OwnerShell["status"];
        readonly pending: number;
        readonly archived: number;
        readonly deleted: number;
      }>`
        SELECT t.thread_id, t.project_id, t.title,
          COALESCE(
            (SELECT status FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
              WHERE thread_id = t.thread_id AND status IN ('preparing','starting','running')
              ORDER BY ordinal DESC LIMIT 1),
            (SELECT status FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
              WHERE thread_id = t.thread_id AND status = 'waiting' ORDER BY ordinal DESC LIMIT 1),
            (SELECT status FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
              WHERE thread_id = t.thread_id AND status = 'queued' ORDER BY ordinal DESC LIMIT 1),
            (SELECT status FROM orchestration_v2_projection_runs
              WHERE thread_id = t.thread_id ORDER BY ordinal DESC LIMIT 1),
            'idle') AS status,
          EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = t.thread_id AND status = 'pending') AS pending,
          t.archived_at IS NOT NULL AS archived, t.deleted_at IS NOT NULL AS deleted
        FROM orchestration_v2_projection_threads t WHERE t.thread_id = ${threadId}
      `;
      const row = rows[0];
      return row === undefined
        ? null
        : {
            threadId: row.thread_id,
            projectId: row.project_id,
            title: row.title,
            status: row.status,
            pending: row.pending !== 0,
            archived: row.archived !== 0,
            deleted: row.deleted !== 0,
          };
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(fail("read-owner-shell")),
  );

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
          ? yield* importedThreadQuery(controlSql, nativeId)
          : [];
      const live = yield* providerThreadQuery(sql, nativeId, driver);
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

  const decodeRequest = Schema.decodeUnknownEffect(
    Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
  );
  const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
  const pendingRequestRecords: ControlStoreShape["pendingRequestRecords"] = Effect.fn(
    "ControlStore.pendingRequestRecords",
  )(function* (threadIds) {
    const pages = yield* Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        sql<{
          readonly thread_id: string;
          readonly payload_json: string;
        }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'pending' AND thread_id IN ${sql.in(ids)}
        ORDER BY thread_id ASC, created_at ASC, runtime_request_id ASC
      `,
    ).pipe(NodeSqliteClient.readOnly, Effect.mapError(fail("read-pending-request-records")));
    const requests = yield* Effect.forEach(pages.flat(), (row) =>
      decodeRequest(row.payload_json).pipe(
        Effect.map((request) => ({ threadId: row.thread_id, request })),
      ),
    ).pipe(Effect.mapError(fail("decode-pending-request-records")));
    if (requests.length === 0) return [];
    // Constant ID sets push into every history-union branch. A correlated
    // subquery instead materializes the entire archive before filtering.
    const itemRows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
      SELECT thread_id, payload_json FROM ardud_history_turn_items
      WHERE node_id IN (SELECT value FROM json_each(${encodeIds([...new Set(requests.map(({ request }) => request.nodeId))])}))
        AND thread_id IN (SELECT value FROM json_each(${encodeIds([...new Set(requests.map(({ threadId }) => threadId))])}))
        AND type IN ('approval_request', 'user_input_request')
        AND json_extract(payload_json, '$.requestId') IN (SELECT value FROM json_each(${encodeIds(requests.map(({ request }) => request.id))}))
      ORDER BY +ordinal ASC, turn_item_id ASC
    `.pipe(NodeSqliteClient.readOnly, Effect.mapError(fail("read-pending-request-items")));
    // Unary + prevents a thread-wide ordinal-index walk in place of the
    // selective node lookup; only the matching items need sorting.
    const items = new Map<string, Map<string, OrchestrationV2TurnItem>>();
    yield* Effect.forEach(itemRows, (row) =>
      Effect.gen(function* () {
        const item = yield* decodeItem(row.payload_json);
        if (item.type !== "approval_request" && item.type !== "user_input_request") return;
        const byRequest = items.get(row.thread_id) ?? new Map<string, OrchestrationV2TurnItem>();
        if (!byRequest.has(item.requestId)) byRequest.set(item.requestId, item);
        items.set(row.thread_id, byRequest);
      }),
    ).pipe(Effect.mapError(fail("decode-pending-request-items")));
    return requests.map(({ threadId, request }) => ({
      threadId,
      request,
      item: items.get(threadId)?.get(request.id) ?? null,
    }));
  });

  const candidatePredicate = (filter: ThreadCandidateFilter) => sql`
    deleted_at IS NULL
    AND (json_extract(payload_json, '$.archivedAt') IS NOT NULL) = ${filter.location === "archive" ? 1 : 0}
    ${
      filter.since === null
        ? sql``
        : sql`AND CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER) > ${filter.since}`
    }
    ${filter.includeSubagents || filter.parentThreadId !== null ? sql`` : sql`AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'`}
    ${filter.parentThreadId === null ? sql`` : sql`AND json_extract(payload_json, '$.lineage.parentThreadId') = ${filter.parentThreadId}`}
    ${filter.projectId === null ? sql`` : sql`AND project_id = ${filter.projectId}`}
    ${filter.creationSources === undefined ? sql`` : filter.creationSources.length === 0 ? sql`AND 0` : sql`AND json_extract(payload_json, '$.creationSource') IN ${sql.in(filter.creationSources)}`}
  `;

  const threadCandidatePage: ControlStoreShape["threadCandidatePage"] = Effect.fn(
    "ControlStore.threadCandidatePage",
  )(
    function* (options) {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly project_id: string;
        readonly updated_at: string;
        readonly archived: number;
        readonly relationship_to_parent: string | null;
        readonly parent_thread_id: string | null;
        readonly root_thread_id: string | null;
        readonly creation_source: string | null;
      }>`
        SELECT thread_id, project_id, updated_at,
          json_extract(payload_json, '$.archivedAt') IS NOT NULL AS archived,
          json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
          json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
          json_extract(payload_json, '$.lineage.rootThreadId') AS root_thread_id,
          json_extract(payload_json, '$.creationSource') AS creation_source
        FROM orchestration_v2_projection_threads INDEXED BY ardud_control_thread_candidates_desc_idx
        WHERE ${candidatePredicate(options)}
          ${
            options.after === undefined
              ? sql``
              : sql`AND CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER) <= ${DateTime.toEpochMillis(DateTime.makeUnsafe(options.after.updatedAt))}
            AND (CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER) < ${DateTime.toEpochMillis(DateTime.makeUnsafe(options.after.updatedAt))} OR thread_id < ${options.after.threadId})`
          }
        ORDER BY CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER) DESC, thread_id DESC
        LIMIT ${Math.max(1, Math.min(128, Math.trunc(options.limit)))}
      `;
      return rows.map((row): ControlThreadRow => ({
        threadId: row.thread_id,
        projectId: row.project_id,
        updatedAt: row.updated_at,
        archived: Boolean(row.archived),
        relationshipToParent: row.relationship_to_parent,
        parentThreadId: row.parent_thread_id,
        rootThreadId: row.root_thread_id,
        creationSource: row.creation_source,
      }));
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(fail("read-thread-candidate-page")),
  );

  const threadCandidateCount: ControlStoreShape["threadCandidateCount"] = Effect.fn(
    "ControlStore.threadCandidateCount",
  )(
    (filter) =>
      sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total
      FROM orchestration_v2_projection_threads INDEXED BY ardud_control_thread_candidates_desc_idx
      WHERE ${candidatePredicate(filter)}
    `.pipe(Effect.map((rows) => rows[0]?.total ?? 0)),
    NodeSqliteClient.readOnly,
    Effect.mapError(fail("count-thread-candidates")),
  );

  return ControlStore.of({
    threadCandidatePage,
    threadCandidateCount,
    getOrigin,
    getOrigins,
    setOrigin,
    threadIdForNativeSession,
    threadRunCount,
    ownerShell,
    nativeSessionIds,
    nativeBindings,
    liveThreadIds,
    pendingRequestThreadIds,
    pendingRequestRecords,
  });
});

export const layer = Layer.effect(ControlStore, make);
