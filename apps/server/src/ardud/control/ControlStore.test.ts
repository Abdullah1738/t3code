import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

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
          payload_json: JSON.stringify({
            id: "request-reader",
            nodeId: "node",
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
          }),
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
          records: store.pendingRequestRecords(["t-detached"]),
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
        assert.lengthOf(result.records, 1);
        assert.strictEqual(result.records[0]?.request.id, "request-reader");
        assert.isNull(result.records[0]?.item);

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

const candidateFilter: ControlStore.ThreadCandidateFilter = {
  since: null,
  location: "active",
  includeSubagents: true,
  parentThreadId: null,
  projectId: null,
};

it.effect(
  "candidate pages and totals never fetch thread payloads or sort the full thread table",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (
                typeof query === "string" &&
                query.includes("ardud_control_thread_candidates_desc_idx")
              )
                statements.push(query);
            };
            return span;
          },
        });
        const first = yield* store
          .threadCandidatePage({ ...candidateFilter, limit: 1 })
          .pipe(Effect.withTracer(tracer));
        assert.lengthOf(first, 1);
        assert.equal(
          yield* store.threadCandidateCount(candidateFilter).pipe(Effect.withTracer(tracer)),
          2,
        );
        const second = yield* store
          .threadCandidatePage({ ...candidateFilter, after: first[0]!, limit: 1 })
          .pipe(Effect.withTracer(tracer));
        assert.lengthOf(second, 1);
        assert.notEqual(first[0]?.threadId, second[0]?.threadId);
        assert.lengthOf(
          yield* store.threadCandidatePage({ ...candidateFilter, after: second[0]!, limit: 1 }),
          0,
        );
        // Covering-index access matters more than a small fixture's wall-clock time: a
        // payload read here reproduces the 13 s scan on large history rows.
        const info = yield* sql<{
          cid: number;
          name: string;
        }>`PRAGMA table_info(orchestration_v2_projection_threads)`;
        const payloadColumn = info.find((column) => column.name === "payload_json")!.cid;
        const root = (yield* sql<{
          rootpage: number;
        }>`SELECT rootpage FROM sqlite_schema WHERE name = 'orchestration_v2_projection_threads'`)[0]!
          .rootpage;
        assert.lengthOf(statements, 3);
        for (const query of statements) {
          const bindings = Array.from({ length: (query.match(/\?/g) ?? []).length }, () => null);
          const plan = yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${query}`,
            bindings,
          );
          assert.isTrue(
            plan.some((row) => row.detail.includes("ardud_control_thread_candidates_desc_idx")),
          );
          assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
          const code = yield* sql.unsafe<{ opcode: string; p1: number; p2: number; p3: number }>(
            `EXPLAIN ${query}`,
            bindings,
          );
          const tableCursors = code
            .filter((op) => op.opcode === "OpenRead" && op.p2 === root)
            .map((op) => op.p1);
          assert.isFalse(
            code.some(
              (op) =>
                op.opcode === "Column" && tableCursors.includes(op.p1) && op.p2 === payloadColumn,
            ),
            query,
          );
          if (query.includes("ORDER BY")) assert.match(query, /LIMIT \?/);
        }
      }),
    ),
);

it.effect("candidate cursor pages handle tied dates, filters and a capped page size", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ControlStore.ControlStore;
      const timestamp = "2026-03-01T00:00:00.000Z";
      for (let i = 0; i < 270; i++) {
        const id = `page-${String(i).padStart(3, "0")}`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
          ...threadRow(id, null),
          updated_at: timestamp,
          payload_json: JSON.stringify({
            archivedAt: null,
            creationSource: "provider",
            lineage: {
              relationshipToParent: "subagent",
              parentThreadId: "parent",
              rootThreadId: "root",
            },
          }),
        })}`;
      }
      const filter = {
        ...candidateFilter,
        since: Date.parse(timestamp) - 1,
        parentThreadId: "parent",
        creationSources: ["provider"],
      };
      assert.equal(yield* store.threadCandidateCount(filter), 270);
      assert.equal(
        yield* store.threadCandidateCount({ ...filter, since: Date.parse(timestamp) }),
        0,
      );
      assert.equal(yield* store.threadCandidateCount({ ...filter, creationSources: [] }), 0);
      assert.equal(yield* store.threadCandidateCount({ ...filter, projectId: "absent" }), 0);
      assert.equal(yield* store.threadCandidateCount({ ...filter, location: "archive" }), 0);
      assert.equal(
        yield* store.threadCandidateCount({
          ...filter,
          parentThreadId: null,
          includeSubagents: false,
        }),
        0,
      );
      const ids: string[] = [];
      let after: ControlStore.ThreadCandidateCursor | undefined;
      do {
        const page = yield* store.threadCandidatePage({
          ...filter,
          ...(after === undefined ? {} : { after }),
          limit: 500,
        });
        assert.isAtMost(page.length, 128);
        ids.push(...page.map((row) => row.threadId));
        const last = page.at(-1);
        after =
          last === undefined ? undefined : { threadId: last.threadId, updatedAt: last.updatedAt };
      } while (after !== undefined);
      assert.lengthOf(ids, 270);
      assert.equal(new Set(ids).size, 270);
      assert.equal(ids[0], "page-269");
      assert.equal(ids.at(-1), "page-000");
    }),
  ),
);

describe("ControlStore message pages", () => {
  it.effect("filters before newest-N paging and keeps totals and lastAssistant independent", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const at = "2026-03-01T00:00:00.000Z";
        const rows = [
          {
            id: "m01",
            role: "assistant",
            runId: "r1",
            text: "older answer",
            createdAt: at,
            updatedAt: at,
          },
          { id: "m02", role: "system", runId: "r1", text: "hidden", createdAt: at, updatedAt: at },
          {
            id: "m03",
            role: "user",
            runId: "r1",
            text: "updated prompt",
            createdAt: at,
            updatedAt: "2026-03-02T00:00:00.000Z",
          },
          {
            id: "m04",
            role: "assistant",
            runId: "r2",
            text: "latest answer",
            createdAt: "2026-03-02T00:00:00Z",
            updatedAt: "2026-03-02T00:00:00Z",
          },
          {
            id: "m05",
            role: "user",
            runId: null,
            text: "newest prompt",
            createdAt: "2026-03-02T00:00:00.000Z",
            updatedAt: "2026-03-02T00:00:00.000Z",
          },
          {
            id: "m06",
            role: "assistant",
            runId: "r2",
            text: "\u2003\n",
            createdAt: "2026-03-03T00:00:00Z",
            updatedAt: "2026-03-03T00:00:00Z",
          },
        ];
        for (const row of rows) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: row.id,
            thread_id: "t-moved",
            run_id: row.runId,
            node_id: null,
            role: row.role,
            streaming: 0,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            payload_json: JSON.stringify({
              id: row.id,
              threadId: "t-moved",
              runId: row.runId,
              nodeId: null,
              role: row.role,
              text: row.text,
              phase: "answer",
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }),
          })}`;
        }
        // Cursor ids from another thread must behave like an unknown cursor.
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        SELECT 'foreign', 'other', run_id, node_id, role, streaming, created_at, updated_at, payload_json
        FROM orchestration_v2_projection_messages WHERE message_id = 'm06'`;
        const base = {
          threadId: "t-moved",
          role: null,
          runId: null,
          since: undefined,
          afterMessageId: null,
          limit: 2,
        };
        const cases = [
          { input: {}, ids: ["m05", "m06"], total: 5 },
          { input: { limit: null }, ids: ["m01", "m03", "m04", "m05", "m06"], total: 5 },
          { input: { role: "user", limit: 1 }, ids: ["m05"], total: 2 },
          { input: { role: "all" }, ids: ["m05", "m06"], total: 5 },
          { input: { role: "system" }, ids: [], total: 0 },
          { input: { role: "unknown" }, ids: [], total: 0 },
          { input: { runId: "r1" }, ids: ["m01", "m03"], total: 2 },
          { input: { runId: "missing" }, ids: [], total: 0 },
          {
            input: { since: Date.parse(at), limit: null },
            ids: ["m03", "m04", "m05", "m06"],
            total: 4,
          },
          { input: { since: Date.parse("2026-03-02T00:00:00Z") }, ids: ["m06"], total: 1 },
          {
            input: { afterMessageId: "m02", limit: null },
            ids: ["m03", "m04", "m05", "m06"],
            total: 4,
          },
          { input: { afterMessageId: "m04" }, ids: ["m05", "m06"], total: 2 },
          { input: { afterMessageId: "m06" }, ids: [], total: 0 },
          { input: { afterMessageId: "missing" }, ids: ["m05", "m06"], total: 5 },
          { input: { afterMessageId: "foreign" }, ids: ["m05", "m06"], total: 5 },
          {
            input: {
              afterMessageId: "m01",
              since: Date.parse(at),
              role: "user",
              runId: "r1",
              limit: 1,
            },
            ids: ["m03"],
            total: 1,
          },
        ];
        for (const row of cases) {
          const page = yield* store.messagePage({ ...base, ...row.input });
          assert.deepStrictEqual(
            page.messages.map((message) => message.id),
            row.ids,
            JSON.stringify(row.input),
          );
          assert.equal(page.total, row.total);
          assert.equal(
            page.lastAssistant?.messageId ?? null,
            row.input.runId === "missing" ? null : row.input.runId === "r1" ? "m01" : "m04",
          );
          assert.equal(page.state, "idle");
        }
      }),
    ),
  );

  it.effect("decodes only the selected page, even with unrelated invalid historical payloads", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const at = "2026-03-01T00:00:00.000Z";
        for (const id of ["old", "new"]) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: "t-moved",
            run_id: null,
            node_id: null,
            role: "user",
            streaming: 0,
            created_at: id === "old" ? "2026-02-01T00:00:00Z" : at,
            updated_at: at,
            payload_json:
              id === "old"
                ? JSON.stringify({})
                : JSON.stringify({
                    id,
                    threadId: "t-moved",
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "new",
                    attachments: [],
                    streaming: false,
                    createdBy: "user",
                    creationSource: "web",
                    createdAt: at,
                    updatedAt: at,
                  }),
          })}`;
        }
        const page = yield* store.messagePage({
          threadId: "t-moved",
          role: "user",
          runId: null,
          since: undefined,
          afterMessageId: null,
          limit: 1,
        });
        assert.equal(page.total, 2);
        assert.deepStrictEqual(
          page.messages.map((message) => message.id),
          ["new"],
        );
        assert.isNull(page.lastAssistant);
      }),
    ),
  );

  it.effect("preserves locale ordering for cursor and page boundary ties", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const at = "2026-03-01T00:00:00.000Z";
        const expected = ["msg_a", "msg_B", "msg_e", "msg_é", "msg_Z", "msg-a", "msg:a"];
        for (const id of expected.toReversed()) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: "t-moved",
            run_id: null,
            node_id: null,
            role: "user",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json: JSON.stringify({
              id,
              threadId: "t-moved",
              runId: null,
              nodeId: null,
              role: "user",
              text: id,
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: at,
              updatedAt: at,
            }),
          })}`;
        }
        const input = {
          threadId: "t-moved",
          role: "user",
          runId: null,
          since: undefined,
          afterMessageId: null,
          limit: null,
        };
        for (const limit of [null, 1, 3]) {
          const page = yield* store.messagePage({ ...input, limit });
          assert.deepStrictEqual(
            page.messages.map((m) => m.id),
            limit === null ? expected : expected.slice(-limit),
          );
          assert.equal(page.total, 7);
        }
        for (let i = 0; i < expected.length; i++) {
          const page = yield* store.messagePage({ ...input, afterMessageId: expected[i]! });
          assert.deepStrictEqual(
            page.messages.map((m) => m.id),
            expected.slice(i + 1),
          );
          assert.equal(page.total, expected.length - i - 1);
        }
      }),
    ),
  );

  it.effect("selects the locale-newest assistant across a 32-message tie boundary", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const at = "2026-03-01T00:00:00.000Z";
        for (const id of [
          ...Array.from({ length: 32 }, (_, i) => `msg_a${String(i).padStart(2, "0")}`),
          "msg_Z",
        ]) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: "t-moved",
            run_id: "answer-run",
            node_id: null,
            role: "assistant",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json: JSON.stringify({
              id,
              threadId: "t-moved",
              runId: "answer-run",
              nodeId: null,
              role: "assistant",
              text: id,
              phase: "answer",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: at,
              updatedAt: at,
            }),
          })}`;
        }
        const page = yield* store.messagePage({
          threadId: "t-moved",
          role: "user",
          runId: "answer-run",
          since: Date.parse(at),
          afterMessageId: null,
          limit: 1,
        });
        assert.equal(page.total, 0);
        assert.deepStrictEqual(
          yield* store.lastAssistant("t-moved", "answer-run"),
          page.lastAssistant,
        );
        assert.isNull(yield* store.lastAssistant("t-moved", "missing-run"));
        assert.deepStrictEqual(page.lastAssistant, {
          messageId: "msg_Z",
          runId: "answer-run",
          text: "msg_Z",
        });
      }),
    ),
  );

  it.effect("last-assistant reads one newest payload and skips 200 older invalid payloads", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        for (let n = 0; n < 201; n++) {
          const id = `bounded-${n}`;
          const at = DateTime.formatIso(
            DateTime.makeUnsafe(Date.parse("2026-03-01T00:00:00Z") + n * 1000),
          );
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: "t-moved",
            run_id: "bounded",
            node_id: null,
            role: "assistant",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json:
              n === 200
                ? JSON.stringify({
                    id,
                    threadId: "t-moved",
                    runId: "bounded",
                    nodeId: null,
                    role: "assistant",
                    text: "newest",
                    attachments: [],
                    streaming: false,
                    createdBy: "agent",
                    creationSource: "provider",
                    createdAt: at,
                    updatedAt: at,
                  })
                : "invalid older payload",
          })}`;
        }
        for (const runId of [null, "bounded"]) {
          assert.deepStrictEqual(yield* store.lastAssistant("t-moved", runId), {
            text: "newest",
            messageId: "bounded-200",
            runId: "bounded",
          });
        }
      }),
    ),
  );

  it.effect("last-assistant SQL matches text, run and timestamp edge cases", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const fixtures = [
          ["old", "answer-run", "old", "2026-03-01T00:00:00Z"],
          ["A", "answer-run", " upper ", "2026-03-02T00:00:00Z"],
          ["a", "answer-run", "lower", "2026-03-02T04:00:00+04:00"],
          ["nul", "nul-run", "\u0000answer", "2026-03-03T00:00:00Z"],
          ["blank", "answer-run", "\u00a0\u2003\ufeff", "2026-03-04T00:00:00Z"],
        ];
        for (const [id, runId, text, at] of fixtures) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: "t-moved",
            run_id: runId,
            node_id: null,
            role: "assistant",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json: JSON.stringify({
              id,
              threadId: "t-moved",
              runId,
              nodeId: null,
              role: "assistant",
              text,
              createdBy: "agent",
              creationSource: "provider",
              attachments: [],
              streaming: false,
              createdAt: at,
              updatedAt: at,
            }),
          })}`;
        }
        for (const runId of [null, "answer-run", "nul-run", "missing"]) {
          const page = yield* store.messagePage({
            threadId: "t-moved",
            role: "user",
            runId,
            since: undefined,
            afterMessageId: null,
            limit: 1,
          });
          assert.deepStrictEqual(yield* store.lastAssistant("t-moved", runId), page.lastAssistant);
        }
      }),
    ),
  );

  it.effect("matches run priority and pending request state without decoding history", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ControlStore.ControlStore;
        const input = {
          threadId: "t-moved",
          role: null,
          runId: null,
          since: undefined,
          afterMessageId: null,
          limit: 1,
        };
        for (const [ordinal, status] of [
          [1, "running"],
          [2, "waiting"],
          [3, "queued"],
          [4, "completed"],
        ] as const) {
          yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
            run_id: `state-${ordinal}`,
            thread_id: input.threadId,
            ordinal,
            provider: "codex",
            status,
            requested_at: "2026-01-01",
            completed_at: null,
            payload_json: "invalid unused payload",
          })}`;
        }
        for (const [id, state] of [
          ["state-1", "running"],
          ["state-2", "waiting"],
          ["state-3", "queued"],
          ["state-4", "idle"],
        ]) {
          const page = yield* store.messagePage(input);
          assert.equal(page.runId, id);
          assert.equal(page.state, state);
          yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${id}`;
        }
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
          runtime_request_id: "pending",
          thread_id: input.threadId,
          node_id: "node",
          provider_turn_id: null,
          kind: "user_input",
          status: "pending",
          created_at: "2026-01-01",
          resolved_at: null,
          payload_json: "invalid unused payload",
        })}`;
        assert.equal((yield* store.messagePage(input)).state, "needs-input");
      }),
    ),
  );
});

it.effect("resume detects compaction only inside the requested sequence range", () =>
  Effect.gen(function* () {
    const store = yield* ControlStore.ControlStore;
    const sql = yield* SqlClient.SqlClient;
    assert.isFalse(yield* store.hasCompactedEvents(0, 100));
    yield* sql`CREATE TABLE ardud_history_compacted_events (revision INTEGER PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE)`;
    yield* sql`INSERT INTO ardud_history_compacted_events (sequence) VALUES (10), (30)`;
    assert.isFalse(yield* store.hasCompactedEvents(10, 29));
    assert.isTrue(yield* store.hasCompactedEvents(9, 10));
    assert.isTrue(yield* store.hasCompactedEvents(10, 30));
    assert.isFalse(yield* store.hasCompactedEvents(30, 100));
  }).pipe(Effect.provide(ControlStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
