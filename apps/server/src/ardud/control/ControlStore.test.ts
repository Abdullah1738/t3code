import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { controlDDL } from "../persistence/boardsSchema.ts";
import * as ControlStore from "./ControlStore.ts";

const providerRow = (
  providerThreadId: string,
  threadId: string,
  driver: string,
  nativeId: string | null,
  updatedAt: string,
) => ({
  provider_thread_id: providerThreadId,
  thread_id: threadId,
  owner_node_id: null,
  provider: driver,
  provider_session_id: null,
  status: "idle",
  first_run_ordinal: 1,
  last_run_ordinal: 1,
  updated_at: updatedAt,
  driver,
  provider_instance_id: driver,
  payload_json: JSON.stringify({
    id: providerThreadId,
    driver,
    providerInstanceId: driver,
    appThreadId: threadId,
    nativeThreadRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
  }),
});

const threadRow = (threadId: string, activeProviderThreadId: string | null) => ({
  thread_id: threadId,
  project_id: "project",
  title: threadId,
  default_provider: "opencode",
  runtime_mode: "full-access",
  interaction_mode: "default",
  active_provider_thread_id: activeProviderThreadId,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  provider_instance_id: "opencode",
  payload_json: JSON.stringify({
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    activeProviderThreadId,
    modelSelection: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
  }),
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A migrated thread whose Claude binding has lost its native id. The old
  // OpenCode row was written later, so only the active binding can answer.
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
    threadRow("t-detached", "pt-detached-claude"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow(
      "pt-detached-old",
      "t-detached",
      "opencode",
      "ses_detached_old",
      "2026-01-02T00:00:00.000Z",
    ),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow(
      "pt-detached-claude",
      "t-detached",
      "claudeAgent",
      null,
      "2026-01-01T00:00:00.000Z",
    ),
  )}`;
  // A healthy migrated thread for contrast: its active Claude id is current.
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
    threadRow("t-moved", "pt-moved-claude"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow("pt-moved-old", "t-moved", "opencode", "ses_moved_old", "2026-01-02T00:00:00.000Z"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow(
      "pt-moved-claude",
      "t-moved",
      "claudeAgent",
      "claude-moved-uuid",
      "2026-01-01T00:00:00.000Z",
    ),
  )}`;
});

const run = <A, E>(body: Effect.Effect<A, E, ControlStore.ControlStore | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      return yield* body;
    }).pipe(Effect.provide(ControlStore.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("ControlStore native ids", () => {
  it.effect("keeps origins and import aliases in a separate database from provider bindings", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const controlSql = Context.get(context, SqlClient.SqlClient);
      yield* Effect.forEach(controlDDL, (ddl) => controlSql.unsafe(ddl), { discard: true });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed;
        yield* controlSql`INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at)
          VALUES ('ses_import', 't-moved', '2026-01-01T00:00:00.000Z')`;
        yield* Effect.gen(function* () {
          const store = yield* ControlStore.ControlStore;
          const identity = yield* ExecutionIdentity.ExecutionIdentity;
          yield* store.setOrigin("t-moved", "imessage");
          assert.strictEqual(yield* store.getOrigin("t-moved"), "imessage");
          assert.strictEqual((yield* store.getOrigins(["t-moved"])).get("t-moved"), "imessage");
          assert.strictEqual(yield* store.threadIdForNativeSession("ses_import"), "t-moved");
          assert.strictEqual(yield* store.threadIdForNativeSession("claude-moved-uuid"), "t-moved");
          assert.strictEqual(
            (yield* store.nativeSessionIds(["t-moved"])).get("t-moved"),
            "claude-moved-uuid",
          );
          assert.strictEqual(
            (yield* identity.resolve({ nativeId: "ses_import" })).robobThreadId,
            "t-moved",
          );
          assert.deepStrictEqual(
            (yield* identity.aliases("t-moved")).map((alias) => alias.nativeId).toSorted(),
            ["claude-moved-uuid", "ses_import", "ses_moved_old"],
          );
          assert.strictEqual(
            (yield* identity.currentNative(["t-moved"])).get("t-moved")?.nativeId,
            "claude-moved-uuid",
          );

          const rolledBack = yield* sql
            .withTransaction(
              store
                .setOrigin("t-moved", "automation")
                .pipe(Effect.andThen(Effect.fail("rollback"))),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(rolledBack));
          assert.strictEqual(yield* store.getOrigin("t-moved"), "automation");
          yield* store.setOrigin("t-moved", null);
          assert.isNull(yield* store.getOrigin("t-moved"));

          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
            providerRow(
              "pt-conflict",
              "t-detached",
              "opencode",
              "ses_import",
              "2026-01-01T00:00:00.000Z",
            ),
          )}`;
          assert.isNull(yield* store.threadIdForNativeSession("ses_import"));
          assert.strictEqual(
            (yield* identity.resolve({ nativeId: "ses_import" })).resolution,
            "ambiguous",
          );
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'pt-conflict'`;
          assert.strictEqual(
            (yield* identity.resolve({ nativeId: "ses_import" })).robobThreadId,
            "t-moved",
          );
          yield* controlSql`UPDATE ardud_opencode_import SET thread_id = 't-detached' WHERE native_session_id = 'ses_import'`;
          assert.strictEqual(
            (yield* identity.resolve({ nativeId: "ses_import" })).robobThreadId,
            "t-detached",
          );
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('ardud_thread_origin', 'ardud_opencode_import')`,
            [],
          );
        }).pipe(Effect.provide(Layer.mergeAll(ControlStore.layer, ExecutionIdentity.layer)));
      }).pipe(
        Effect.provideService(
          BoardsDatabase.BoardsDatabase,
          BoardsDatabase.BoardsDatabase.of({
            sql: controlSql,
            ready: Effect.void,
            path: ":memory:",
          }),
        ),
        Effect.provide(Sqlite.layerMemory),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reads origins, native bindings and live IDs while the writer is held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-control-reader-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        yield* seed;
        yield* store.setOrigin("t-moved", "imessage");
        yield* sql`INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at)
          VALUES ('ses_import', 't-moved', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: "run-reader",
          thread_id: "t-moved",
          ordinal: 1,
          provider: "opencode",
          status: "running",
          requested_at: "2026-01-01T00:00:00.000Z",
          completed_at: null,
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
          runtime_request_id: "request-reader",
          thread_id: "t-detached",
          node_id: "node",
          provider_turn_id: null,
          kind: "user_input",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          resolved_at: null,
          payload_json: "{}",
        })}`;

        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(held);
        const result = yield* Effect.all({
          origin: store.getOrigin("t-moved"),
          origins: store.getOrigins(["t-moved", "t-detached"]),
          native: store.nativeSessionIds(["t-moved", "t-detached"]),
          bindings: store.nativeBindings(["t-moved", "t-detached"]),
          imported: store.threadIdForNativeSession("ses_import", "opencode"),
          active: store.threadIdForNativeSession("claude-moved-uuid", "claudeAgent"),
          live: store.liveThreadIds(),
          pending: store.pendingRequestThreadIds(),
        }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer);
        assert.strictEqual(result.origin, "imessage");
        assert.strictEqual(result.origins.get("t-moved"), "imessage");
        assert.strictEqual(result.native.get("t-moved"), "claude-moved-uuid");
        assert.deepStrictEqual(result.bindings.get("t-moved"), {
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          nativeId: "claude-moved-uuid",
        });
        assert.strictEqual(result.imported, "t-moved");
        assert.strictEqual(result.active, "t-moved");
        assert.deepStrictEqual([...result.live].sort(), ["t-detached", "t-moved"]);
        assert.deepStrictEqual(result.pending, ["t-detached"]);

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.setOrigin("t-moved", "automation");
            assert.strictEqual(yield* store.getOrigin("t-moved"), "automation");
          }),
        );
        assert.strictEqual(yield* store.getOrigin("t-moved"), "automation");
      }).pipe(
        Effect.provide(
          ControlStore.layer.pipe(
            Layer.provideMerge(Sqlite.layerFromPath(path.join(dir, "state.sqlite"))),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reports no current session id for a thread whose active binding has none", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const current = yield* store.nativeSessionIds(["t-detached"]);
        // The old ses_ is history, never the current id.
        assert.isFalse(current.has("t-detached"));
        const bindings = yield* store.nativeBindings(["t-detached"]);
        assert.isFalse(bindings.has("t-detached"));
        // It stays reachable by its historical id.
        assert.strictEqual(yield* store.threadIdForNativeSession("ses_detached_old"), "t-detached");
      }),
    ),
  );

  it.effect("reports the migrated thread's active Claude id as current", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const current = yield* store.nativeSessionIds(["t-moved"]);
        assert.strictEqual(current.get("t-moved"), "claude-moved-uuid");
      }),
    ),
  );

  it.effect("refuses a native id that two threads claim instead of picking the newest", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const sql = yield* SqlClient.SqlClient;
        // A second thread claims the same OpenCode session id.
        yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
          threadRow("t-clash", "pt-clash"),
        )}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
          providerRow(
            "pt-clash",
            "t-clash",
            "opencode",
            "ses_detached_old",
            "2026-01-03T00:00:00.000Z",
          ),
        )}`;
        assert.isNull(yield* store.threadIdForNativeSession("ses_detached_old", "opencode"));
      }),
    ),
  );
});
