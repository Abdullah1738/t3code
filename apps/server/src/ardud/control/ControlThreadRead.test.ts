import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ControlStore from "./ControlStore.ts";
import * as ControlThreadRead from "./ControlThreadRead.ts";
import { runSummary, shellSummary } from "./model.ts";

const threadId = ThreadId.make("owner-fixture");
const date = DateTime.makeUnsafe("2026-11-14T00:00:00Z");
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shell = { ...liveThreadShell(threadId), status: "completed" as const, activeRunId: null };
  const store = yield* ControlStore.make;
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: threadId,
    project_id: shell.projectId,
    title: shell.title,
    default_provider: "codex",
    provider_instance_id: "codex",
    runtime_mode: "full-access",
    interaction_mode: "default",
    active_provider_thread_id: null,
    created_at: DateTime.formatIso(date),
    updated_at: DateTime.formatIso(date),
    archived_at: null,
    deleted_at: null,
    payload_json: yield* encodeThread(idleThreadProjection(shell).thread),
  })}`;
  const runs: Array<OrchestrationV2Run> = [];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let ordinal = 1; ordinal <= 2000; ordinal++) {
        const run: OrchestrationV2Run = {
          id: RunId.make(`run-${ordinal}`),
          threadId,
          ordinal,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: shell.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message-${ordinal}`),
          rootNodeId: NodeId.make(`node-${ordinal}`),
          activeAttemptId: null,
          status: "completed",
          queuePosition: null,
          requestedAt: date,
          startedAt: date,
          completedAt: date,
          checkpointId: null,
          contextHandoffId: null,
        };
        runs.push(run);
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: run.id,
          thread_id: threadId,
          ordinal,
          provider: "codex",
          provider_instance_id: "codex",
          provider_thread_id: null,
          status: run.status,
          requested_at: DateTime.formatIso(date),
          completed_at: DateTime.formatIso(date),
          payload_json: yield* encodeRun(run),
        })}`;
      }
    }),
  );
  yield* sql`INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at) VALUES ('ses_fixture', ${threadId}, '2026-11-14')`;
  const projection = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.provide(ProjectionStore.layer),
  );
  const recordReads: Array<{ fields: ReadonlyArray<string>; count: number }> = [];
  const reader = yield* ControlThreadRead.ControlThreadRead.pipe(
    Effect.provide(
      ControlThreadRead.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ControlStore.ControlStore, store),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) => projection.getThreadShell(id).pipe(Effect.orDie),
              getThreadRecords: (id, fields, filter) =>
                projection.getThreadRecords(id, fields, filter).pipe(
                  Effect.tap((records) =>
                    Effect.sync(() =>
                      recordReads.push({
                        fields,
                        count:
                          "runs" in records && Array.isArray(records.runs)
                            ? records.runs.length
                            : 0,
                      }),
                    ),
                  ),
                  Effect.orDie,
                ),
            }),
          ),
        ),
      ),
    ),
  );
  return { reader, store, projection, recordReads, runs, sql };
});

describe("native thread owner reads", () => {
  it.effect("logs slow stages and total run count with only an eight-character native prefix", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      let now = 0;
      const originalNow = performance.now;
      const reader = yield* ControlThreadRead.ControlThreadRead.pipe(
        Effect.provide(
          ControlThreadRead.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ControlStore.ControlStore, {
                  ...h.store,
                  ownerShell: (id) =>
                    Effect.sync(() => {
                      now += 2200;
                    }).pipe(Effect.andThen(h.store.ownerShell(id))),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              ),
            ),
          ),
        ),
      );
      yield* Effect.sync(() => {
        performance.now = () => now;
      }).pipe(
        Effect.andThen(reader.byNative("ses_fixture", { view: "owner", driver: "opencode" })),
        Effect.ensuring(
          Effect.sync(() => {
            performance.now = originalNow;
          }),
        ),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      assert.deepStrictEqual(warnings, [
        [
          "Slow native owner lookup",
          {
            durationMs: 2200,
            stages: { lookup: 0, getShell: 2200, readRecords: 0, summarize: 0 },
            driver: "opencode",
            view: "owner",
            nativeIdPrefix: "ses_fixt",
            runCount: 2000,
            loadedRunCount: 0,
          },
        ],
      ]);
      assert.notInclude(JSON.stringify(warnings), "ses_fixture");
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );
  it.effect(
    "returns shell identity and state within 500ms without reading history on 2,000 runs",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const shell = yield* h.projection.getThreadShell(threadId);
        const start = performance.now();
        const result = yield* h.reader.byNative("ses_fixture", { view: "owner" });
        const elapsed = performance.now() - start;
        assert.deepStrictEqual(result, {
          id: threadId,
          threadId,
          title: shell!.title,
          projectId: shell!.projectId,
          state: "idle",
          status: "completed",
          archived: false,
          deleted: false,
        });
        assert.deepStrictEqual(h.recordReads, []);
        assert.isBelow(elapsed, 500);
        assert.strictEqual(yield* h.store.threadRunCount(threadId), 2000);
      }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect("keeps the full response byte-for-byte and limits the run payload to five", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const shell = yield* h.projection.getThreadShell(threadId);
      const response = yield* h.reader.byNative("ses_fixture");
      const expected = {
        ...shellSummary(shell!, { origin: null, nativeSessionId: null }),
        native: null,
        changeMarker: 0,
        state: "idle",
        status: "completed",
        run: runSummary(h.runs.at(-1)!),
        recentRuns: h.runs.slice(-5).toReversed().map(runSummary),
        pendingRequests: [],
      };
      assert.strictEqual(JSON.stringify(response), JSON.stringify(expected));
      assert.strictEqual(
        JSON.stringify(yield* h.reader.detail(threadId)),
        JSON.stringify(expected),
      );
      assert.deepStrictEqual(
        h.recordReads.map((read) => read.count),
        [5, 5],
      );
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect(
    "status ignores settled request history and preserves pending input and old active runs",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const sql = h.sql;
        const at = DateTime.formatIso(date);
        // Invalid historical bodies make any accidental history decoding fail deterministically.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (let ordinal = 1; ordinal <= 2000; ordinal++) {
              yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
                runtime_request_id: `settled-${ordinal}`,
                thread_id: threadId,
                node_id: `settled-node-${ordinal}`,
                provider_turn_id: null,
                kind: "user_input",
                status: "resolved",
                created_at: at,
                resolved_at: at,
                payload_json: "{}",
              })}`;
              yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
                turn_item_id: `settled-item-${ordinal}`,
                thread_id: threadId,
                node_id: `settled-node-${ordinal}`,
                ordinal,
                type: "user_input_request",
                status: "completed",
                updated_at: at,
                payload_json: "{}",
              })}`;
            }
          }),
        );
        const active = { ...h.runs[0]!, status: "running" as const, completedAt: null };
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running', completed_at = NULL,
        payload_json = ${yield* encodeRun(active)} WHERE run_id = ${active.id}`;
        for (const [id, kind, type] of [
          ["approval", "command", "approval_request"],
          ["question", "user_input", "user_input_request"],
          ["missing-item", "user_input", null],
        ] as const) {
          yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
            runtime_request_id: id,
            thread_id: threadId,
            node_id: `node:${id}`,
            provider_turn_id: null,
            kind,
            status: "pending",
            created_at: at,
            resolved_at: null,
            payload_json: JSON.stringify({
              id,
              nodeId: `node:${id}`,
              providerTurnId: null,
              nativeRequestRef: null,
              kind,
              status: "pending",
              createdAt: at,
              resolvedAt: null,
              responseCapability: { type: "message" },
            }),
          })}`;
          if (type === null) continue;
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
            turn_item_id: `item:${id}`,
            thread_id: threadId,
            node_id: `node:${id}`,
            ordinal: 2001,
            type,
            status: "pending",
            updated_at: at,
            payload_json: JSON.stringify({
              id: `item:${id}`,
              threadId,
              nodeId: `node:${id}`,
              runId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2001,
              type,
              status: "pending",
              title: id,
              startedAt: null,
              completedAt: null,
              updatedAt: at,
              requestId: id,
              ...(type === "approval_request"
                ? { requestKind: "command", prompt: "pwd" }
                : { questions: [] }),
            }),
          })}`;
        }
        const detail = yield* h.reader.detail(threadId);
        const native = yield* h.reader.byNative("ses_fixture");
        assert.deepStrictEqual(native, detail);
        assert.strictEqual(detail.state, "needs-input");
        assert.deepStrictEqual(detail.run, runSummary(active));
        assert.deepStrictEqual(detail.recentRuns, h.runs.slice(-5).toReversed().map(runSummary));
        assert.deepStrictEqual(detail.pendingRequests, [
          {
            requestId: RuntimeRequestId.make("approval"),
            kind: "approval",
            requestKind: "command",
            status: "pending",
            createdAt: at,
            canRespond: true,
            prompt: "pwd",
            title: "approval",
            options: null,
          },
          {
            requestId: RuntimeRequestId.make("missing-item"),
            kind: "question",
            requestKind: "user_input",
            status: "pending",
            createdAt: at,
            canRespond: true,
          },
          {
            requestId: RuntimeRequestId.make("question"),
            kind: "question",
            requestKind: "user_input",
            status: "pending",
            createdAt: at,
            canRespond: true,
            title: "question",
            questions: [],
          },
        ]);
        assert.deepStrictEqual(
          h.recordReads.map(({ count }) => count),
          [6, 6],
        );
      }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect("refuses unknown and ambiguous owners", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      assert.strictEqual(
        (yield* h.reader.byNative("unknown", { view: "owner" }).pipe(Effect.flip)).code,
        "not_found",
      );
      yield* h.sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id)
        VALUES ('other', 'other-thread', NULL, 'codex', NULL, 'idle', 1, 1, '2026-11-14', '{"nativeThreadRef":{"nativeId":"ses_fixture"}}', 'codex', 'codex')`;
      assert.strictEqual(
        (yield* h.reader.byNative("ses_fixture", { view: "owner" }).pipe(Effect.flip)).code,
        "not_found",
      );
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect("uses indexed status probes and never reads history payloads for owners", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      yield* h.reader.byNative("ses_fixture", { view: "owner" }).pipe(Effect.withTracer(tracer));
      const query = statements.find((text) => text.includes("AS pending"));
      assert.isDefined(query);
      assert.isFalse(
        statements.some((text) => /turn_items|SELECT payload_json|COUNT\(\*\)/.test(text)),
      );
      const plan = yield* h.sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!}`, [
        threadId,
      ]);
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(
        details,
        "orchestration_v2_projection_runs_thread_status_idx (thread_id=? AND status=?)",
      );
      assert.include(details, "orchestration_v2_projection_runs_thread_ordinal_idx (thread_id=?)");
      assert.notMatch(details, /SCAN orchestration_v2_projection/);
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect(
    "prioritizes old active runs, waiting, queued, pending input and archived/deleted flags",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const rows = [
          ["completed", "idle"],
          ["queued", "queued"],
          ["waiting", "waiting"],
          ["starting", "running"],
          ["preparing", "running"],
          ["running", "running"],
        ] as const;
        for (const [status, state] of rows) {
          yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE run_id = 'run-1'`;
          const result = yield* h.reader.byNative("ses_fixture", { view: "owner" });
          assert.strictEqual(result.state, state);
        }
        yield* h.sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-14', deleted_at = '2026-11-14' WHERE thread_id = ${threadId}`;
        yield* h.sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, resolved_at, payload_json)
        VALUES ('pending', ${threadId}, 'node', NULL, 'user_input', 'pending', '2026-11-14', NULL, '{}')`;
        const result = yield* h.reader.byNative("ses_fixture", { view: "owner" });
        assert.strictEqual(result.state, "needs-input");
        assert.strictEqual(result.archived, true);
        assert.strictEqual(result.deleted, true);
        assert.strictEqual(
          (yield* h.reader.byNative("ses_fixture").pipe(Effect.flip)).code,
          "not_found",
        );
      }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );
});
