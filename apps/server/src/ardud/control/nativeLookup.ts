import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

// The startup EXPLAIN and the request must compile the same lookup predicates.
export const importedThreadQuery = (sql: SqlClient.SqlClient, nativeId: string) => sql<{
  readonly thread_id: string;
}>`
  SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = ${nativeId}
`;

export const providerThreadQuery = (
  sql: SqlClient.SqlClient,
  nativeId: string,
  driver?: string,
) => sql<{
  readonly thread_id: string;
}>`
  SELECT DISTINCT pt.thread_id
  FROM orchestration_v2_projection_provider_threads pt
  WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${nativeId}
    AND pt.thread_id IS NOT NULL
    AND (${driver ?? null} IS NULL
      OR COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = ${driver ?? null})
`;

const probe = "native-index-check";

const providerIndexCheck = Effect.fn("NativeLookup.providerIndexCheck")(function* (
  sql: SqlClient.SqlClient,
) {
  const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'orchestration_v2_projection_provider_threads'
      AND name = 'ardud_idx_provider_threads_native_id'
  `;
  const plans = yield* Effect.forEach(
    [undefined, "opencode", "claudeAgent", "codex"],
    (driver) =>
      sql<{
        readonly detail: string;
      }>`EXPLAIN QUERY PLAN ${providerThreadQuery(sql, probe, driver)}`.pipe(
        Effect.map((rows) => ({ driver: driver ?? null, details: rows.map((row) => row.detail) })),
      ),
    { concurrency: 1 },
  );
  return {
    indexPresent: indexes.length > 0,
    usesIndex: plans.every((plan) =>
      plan.details.some((detail) =>
        /SEARCH pt USING (?:COVERING )?INDEX ardud_idx_provider_threads_native_id \(<expr>=\?\)/.test(
          detail,
        ),
      ),
    ),
    indexes,
    plans,
  };
});

const importIndexCheck = Effect.fn("NativeLookup.importIndexCheck")(function* (
  sql: SqlClient.SqlClient,
) {
  const indexes = yield* sql<{ readonly name: string; readonly sql: string | null }>`
    SELECT m.name, m.sql FROM sqlite_master m
    JOIN pragma_index_list('ardud_opencode_import') il ON il.name = m.name
    JOIN pragma_index_info(m.name) ii ON ii.seqno = 0
    WHERE m.type = 'index' AND m.tbl_name = 'ardud_opencode_import'
      AND il.[unique] = 1 AND ii.name = 'native_session_id'
  `;
  const rows = yield* sql<{
    readonly detail: string;
  }>`EXPLAIN QUERY PLAN ${importedThreadQuery(sql, probe)}`;
  const details = rows.map((row) => row.detail);
  return {
    indexPresent: indexes.length > 0,
    usesIndex: indexes.some((index) =>
      details.some(
        (detail) =>
          detail.includes(`INDEX ${index.name} `) && detail.includes("(native_session_id=?)"),
      ),
    ),
    indexes,
    plans: [{ details }],
  };
});

export const logNativeLookupIndexCheck = Effect.fn("NativeLookup.logIndexCheck")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const boards = yield* BoardsDatabase.client;
  const inspect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      NodeSqliteClient.identityReadOnly,
      Effect.match({
        onFailure: (error) => ({ indexPresent: false, usesIndex: false, error }),
        onSuccess: (result) => result,
      }),
    );
  const state = yield* inspect(providerIndexCheck(sql));
  const imports = yield* inspect(importIndexCheck(boards));
  const details = { state, boards: imports };
  if (!state.indexPresent || !state.usesIndex || !imports.indexPresent || !imports.usesIndex) {
    yield* Effect.logError("Native session lookup index verification", details);
  } else {
    yield* Effect.logInfo("Native session lookup index verification", details);
  }
  return details;
});
