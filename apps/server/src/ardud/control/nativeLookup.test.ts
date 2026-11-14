import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { logNativeLookupIndexCheck } from "./nativeLookup.ts";

const providerTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (
    thread_id TEXT, driver TEXT, payload_json TEXT NOT NULL
  )`;
});
const importTable = (sql: SqlClient.SqlClient, primary = true) =>
  sql.unsafe(`
  CREATE TABLE ardud_opencode_import (
    native_session_id TEXT ${primary ? "PRIMARY KEY" : ""},
    thread_id TEXT NOT NULL UNIQUE, imported_at TEXT NOT NULL
  )`);
const nativeIndex = (sql: SqlClient.SqlClient) => sql`
  CREATE INDEX ardud_idx_provider_threads_native_id
  ON orchestration_v2_projection_provider_threads (json_extract(payload_json, '$.nativeThreadRef.nativeId'))
`;
const capture = (onLog?: () => void) => {
  const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logger = Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (Array.isArray(message) && message[0] === "Native session lookup index verification") {
          logs.push({ level: logLevel, message });
          onLog?.();
        }
      }),
    ],
    { mergeWithExisting: false },
  );
  return { logs, logger };
};

describe("startup native lookup index verification", () => {
  it.effect("logs one successful check after ExecutionIdentity ensures the indexes", () => {
    const { logs, logger } = capture();
    return Effect.gen(function* () {
      yield* providerTable;
      const layer = Layer.fresh(ExecutionIdentity.layer);
      yield* Layer.build(layer);
      assert.lengthOf(logs, 1);
      assert.strictEqual(logs[0]?.level, "Info");
      const result = yield* logNativeLookupIndexCheck();
      assert.strictEqual(result.state.indexPresent, true);
      assert.strictEqual(result.state.usesIndex, true);
      assert.strictEqual(result.boards.indexPresent, true);
      assert.strictEqual(result.boards.usesIndex, true);
      if ("plans" in result.state) {
        assert.deepStrictEqual(
          result.state.plans.map((plan) => plan.driver),
          [null, "opencode", "claudeAgent", "codex"],
        );
        for (const plan of result.state.plans) {
          assert.include(
            plan.details.join("\n"),
            "USING INDEX ardud_idx_provider_threads_native_id",
          );
          assert.notInclude(plan.details.join("\n"), "SCAN pt");
        }
      } else assert.fail("state plans missing");
      assert.deepStrictEqual(logs[1], {
        level: "Info",
        message: ["Native session lookup index verification", result],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), logger)),
    );
  });

  it.effect.each(["state", "boards"] as const)(
    "logs an error when the %s lookup index is missing",
    (missing) => {
      const { logs, logger } = capture();
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* providerTable;
        yield* importTable(sql, missing !== "boards");
        if (missing !== "state") yield* nativeIndex(sql);
        const result = yield* logNativeLookupIndexCheck();
        assert.strictEqual(result[missing].indexPresent, false);
        assert.strictEqual(result[missing].usesIndex, false);
        assert.lengthOf(logs, 1);
        assert.deepStrictEqual(logs[0], {
          level: "Error",
          message: ["Native session lookup index verification", result],
        });
      }).pipe(
        Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), logger)),
      );
    },
  );

  it.effect(
    "logs an error when an index with the expected name covers the wrong expression",
    () => {
      const { logs, logger } = capture();
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* providerTable;
        yield* importTable(sql);
        yield* sql`CREATE INDEX ardud_idx_provider_threads_native_id
        ON orchestration_v2_projection_provider_threads (thread_id)`;
        const result = yield* logNativeLookupIndexCheck();
        assert.strictEqual(result.state.indexPresent, true);
        assert.strictEqual(result.state.usesIndex, false);
        assert.strictEqual(logs[0]?.level, "Error");
      }).pipe(
        Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), logger)),
      );
    },
  );

  it.effect("explains a missing index without reading provider payloads", () => {
    const { logs, logger } = capture();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* providerTable;
      yield* importTable(sql);
      // Executing the native lookup would fail on this row's malformed JSON.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        VALUES ('thread', 'codex', 'malformed-json')`;
      const result = yield* logNativeLookupIndexCheck();
      assert.strictEqual(result.state.indexPresent, false);
      assert.strictEqual(result.state.usesIndex, false);
      assert.isTrue("plans" in result.state);
      assert.strictEqual(result.boards.usesIndex, true);
      assert.strictEqual(logs[0]?.level, "Error");
    }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), logger)));
  });

  it.effect("checks the separate boards connection once it is ready", () =>
    Effect.gen(function* () {
      const logged = yield* Deferred.make<void>();
      const { logs, logger } = capture(() => {
        Deferred.doneUnsafe(logged, Effect.void);
      });
      yield* Effect.gen(function* () {
        const primary = yield* SqlClient.SqlClient;
        yield* providerTable;
        // A broken legacy mapping must not hide a healthy mapping in boards.
        yield* importTable(primary, false);
        const boardsContext = yield* Layer.build(
          Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })),
        );
        const boards = Context.get(boardsContext, SqlClient.SqlClient);
        yield* importTable(boards);
        const ready = yield* Deferred.make<void>();
        yield* Layer.build(
          ExecutionIdentity.layer.pipe(
            Layer.provide(
              Layer.succeed(BoardsDatabase.BoardsDatabase, {
                sql: boards,
                ready: Deferred.await(ready),
                path: "boards-fixture",
              }),
            ),
          ),
        );
        assert.lengthOf(logs, 0);
        yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(logged);
        assert.lengthOf(logs, 1);
        assert.strictEqual(logs[0]?.level, "Info");
      }).pipe(Effect.provide(logger));
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
