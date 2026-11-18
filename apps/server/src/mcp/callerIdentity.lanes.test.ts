import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { ensureShellLookupIndexes } from "../ardud/persistence/shellIndexes.ts";
import { initializeHistoryArchive } from "../ardud/persistence/HistoryArchive.ts";
import { historyReaderSql } from "../ardud/persistence/historyArchiveSql.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DateTime from "effect/DateTime";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadAccess from "./threadAccess.ts";
import { isLiveCallerShell } from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const importedPrefix =
  "thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:";
const callers = [
  { id: importedPrefix + "e5014a87-dc91-4e39-97f3-399cc0a681a3", status: "waiting" },
  { id: importedPrefix + "ba8d6a69-0d4e-49f8-b2ac-6662c0301b6c", status: "completed" },
  { id: "ardud-control:thread:d2908a76-ad89-4468-912b-ef74d53c1b22", status: "completed" },
] as const;

type WorkCase = {
  work: string;
  source?: "roster" | "item";
  description?: string;
  providerRows?: number;
  itemRows?: number;
  activeProvider?: boolean;
  fallback?: boolean;
  runShape?: "active-fork" | "queued" | "held-queue" | "rolled-back" | "usage-limit-queue";
  auxiliary?:
    | "runtime-request"
    | "secret-request"
    | "terminal-failure"
    | "blocking-failure"
    | "session-error";
};
const workCases: ReadonlyArray<WorkCase> = [
  { work: "idle" },
  {
    work: "active-fork-over-cap",
    source: "item",
    itemRows: 17,
    providerRows: 17,
    runShape: "active-fork",
  },
  { work: "queued-over-cap", source: "item", itemRows: 17, providerRows: 17, runShape: "queued" },
  { work: "held-queue", source: "roster", runShape: "held-queue" },
  { work: "rolled-back", source: "roster", runShape: "rolled-back" },
  { work: "usage-limit-queue", source: "roster", runShape: "usage-limit-queue" },
  ...(["runtime-request", "secret-request", "terminal-failure"] as const).map((auxiliary) => ({
    work: `queued-large-${auxiliary}`,
    runShape: auxiliary === "terminal-failure" ? ("held-queue" as const) : ("queued" as const),
    auxiliary,
    description: "界".repeat(24000),
  })),
  ...(["blocking-failure", "session-error"] as const).flatMap((auxiliary) =>
    [
      { suffix: "small", description: "Plan limit reached." },
      { suffix: "utf8-under", description: "界".repeat(20000) },
      { suffix: "utf8-over", description: "界".repeat(24000), fallback: true },
      { suffix: "utf8-4-over", description: "𐐀".repeat(18000), fallback: true },
    ].map(({ suffix, ...payload }) => ({
      work: `queued-${auxiliary}-${suffix}`,
      runShape: "usage-limit-queue" as const,
      auxiliary,
      source: "roster" as const,
      ...payload,
    })),
  ),
  { work: "native-subagent", source: "roster" },
  { work: "item-subagent", source: "item", itemRows: 1 },
  { work: "item-cap", source: "item", itemRows: 17, fallback: true },
  { work: "row-cap", providerRows: 17, fallback: true },
  { work: "payload-cap", source: "roster", description: "x".repeat(65536), fallback: true },
  ...(
    [
      { work: "utf8-2-under", description: "é".repeat(30000) },
      { work: "utf8-2-over", description: "é".repeat(35000), fallback: true },
      { work: "utf8-3-under", description: "界".repeat(20000) },
      { work: "utf8-3-over", description: "界".repeat(24000), fallback: true },
      { work: "utf8-4-under", description: "𐐀".repeat(15000) },
      { work: "utf8-4-over", description: "𐐀".repeat(18000), fallback: true },
    ] satisfies ReadonlyArray<WorkCase>
  ).flatMap((payload) =>
    (["roster", "item"] as const).map((source) => ({
      ...payload,
      work: `${payload.work}-${source}`,
      source,
      itemRows: 1,
    })),
  ),
  { work: "provider-history", source: "roster", providerRows: 17, activeProvider: true },
];

it.effect.each(callers.flatMap((caller) => workCases.map((work) => ({ ...caller, ...work }))))(
  "$id ($status, $work) resolves with all view readers held unless capped",
  ({
    id: rawId,
    status,
    source,
    description,
    providerRows = 1,
    itemRows = 0,
    activeProvider = false,
    fallback: expectedFallback = false,
    runShape,
    auxiliary,
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "caller-fallback-" });
      const filename = path.join(dir, "state.sqlite");
      const sqlLayer = SqliteClient.layer({
        filename,
        readerWorker: true,
        identityReaderProcess: true,
        foregroundReaderSlots: 2,
        backgroundReaderSlots: 1,
        readerInitializationSql: historyReaderSql(filename),
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations();
        yield* ensureShellLookupIndexes();
        yield* initializeHistoryArchive();
        yield* Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const id = ThreadId.make(rawId);
          const provider = ProviderInstanceId.make("claudeAgent");
          const base = {
            ...liveThreadShell(id),
            providerInstanceId: provider,
            modelSelection: { instanceId: provider, model: "claude-opus-5-5" },
          };
          const now = base.createdAt;
          const runId = RunId.make("run:caller-fallback");
          yield* store.apply({
            id: EventId.make("created"),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: {
              ...idleThreadProjection(base).thread,
              ...(runShape === "active-fork"
                ? {
                    forkedFrom: {
                      type: "run" as const,
                      threadId: ThreadId.make("fork-source"),
                      runId: RunId.make("fork-source-run"),
                    },
                  }
                : {}),
              activeProviderThreadId: activeProvider
                ? ProviderThreadId.make(`provider:${providerRows - 1}`)
                : null,
            },
          });
          yield* store.apply({
            id: EventId.make("run"),
            type: "run.created",
            threadId: id,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: id,
              ordinal: auxiliary === "terminal-failure" ? 2 : 1,
              providerInstanceId: provider,
              modelSelection: base.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("input"),
              rootNodeId: NodeId.make("root"),
              activeAttemptId: null,
              status:
                runShape === "active-fork"
                  ? "running"
                  : runShape === "usage-limit-queue" || auxiliary === "terminal-failure"
                    ? "failed"
                    : status,
              requestedAt: now,
              startedAt: now,
              completedAt:
                status === "completed" ||
                runShape === "usage-limit-queue" ||
                auxiliary === "terminal-failure"
                  ? now
                  : null,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
          if (runShape === "usage-limit-queue" || auxiliary === "terminal-failure")
            yield* store.apply({
              id: EventId.make("limit-error"),
              type: "turn-item.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("limit-error"),
                threadId: id,
                runId,
                nodeId: NodeId.make("root"),
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "failed",
                title:
                  auxiliary === "blocking-failure" || auxiliary === "terminal-failure"
                    ? description!
                    : "Usage limit",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "error",
                failure: {
                  class: "usage_limit",
                  message: "Plan limit reached.",
                  resetAt: null,
                  code: null,
                  retryable: null,
                },
              },
            });
          if (runShape !== undefined && runShape !== "active-fork") {
            const records = yield* store.getThreadRecords(id, ["runs"]);
            const original = records.runs[0]!;
            if (auxiliary === "terminal-failure")
              yield* store.apply({
                id: EventId.make("newer-completion"),
                type: "run.created",
                threadId: id,
                occurredAt: now,
                payload: {
                  ...original,
                  id: RunId.make("newer-completion"),
                  ordinal: 1,
                  status: "completed",
                  completedAt: DateTime.add(now, { seconds: 1 }),
                },
              });
            yield* store.apply({
              id: EventId.make("later-run"),
              type: "run.created",
              threadId: id,
              occurredAt: now,
              payload: {
                ...original,
                id: RunId.make("later-run"),
                ordinal: auxiliary === "terminal-failure" ? 3 : 2,
                status: runShape === "rolled-back" ? "rolled_back" : "queued",
                ...(runShape === "held-queue" ? { queueHeld: true } : {}),
                startedAt: null,
                completedAt: null,
              },
            });
          }
          if (auxiliary === "runtime-request")
            yield* store.apply({
              id: EventId.make("request"),
              type: "runtime-request.updated",
              threadId: id,
              runId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make("request"),
                nodeId: NodeId.make("root"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "not_resumable", reason: description! },
                createdAt: now,
                resolvedAt: null,
              },
            });
          if (auxiliary === "secret-request")
            yield* store.apply({
              id: EventId.make("secret"),
              type: "turn-item.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("secret"),
                threadId: id,
                runId,
                nodeId: NodeId.make("root"),
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "secret_request",
                label: "Test credential",
                reason: description!,
                secretStatus: "pending",
              },
            });
          if (auxiliary === "session-error")
            yield* store.apply({
              id: EventId.make("session"),
              type: "provider-session.attached",
              threadId: id,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make("session"),
                driver: ProviderDriverKind.make("claude"),
                providerInstanceId: provider,
                status: "error",
                cwd: "/workspace",
                model: base.modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: description!,
              },
            });
          for (let i = 0; i < providerRows; i++)
            yield* store.apply({
              id: EventId.make(`provider:${i}`),
              type: "provider-thread.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                id: ProviderThreadId.make(`provider:${i}`),
                driver: ProviderDriverKind.make("claude"),
                providerInstanceId: provider,
                providerSessionId: null,
                appThreadId: id,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks:
                  source === "roster" && i === providerRows - 1
                    ? [
                        {
                          taskId: "native-task",
                          kind: "subagent",
                          ...(description === undefined || auxiliary !== undefined
                            ? {}
                            : { description }),
                        },
                      ]
                    : [],
                createdAt: now,
                updatedAt: now,
              },
            });
          if (source === "item") {
            for (let i = 0; i < itemRows; i++)
              yield* store.apply({
                id: EventId.make(`item:${i}`),
                type: "turn-item.updated",
                threadId: id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`item:${i}`),
                  threadId: id,
                  runId,
                  nodeId: NodeId.make("root"),
                  providerThreadId: ProviderThreadId.make("provider:0"),
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: i,
                  status: "running",
                  title: description ?? "Native work",
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "subagent",
                  subagentId: NodeId.make(`native:${i}`),
                  origin: "provider_native",
                  driver: ProviderDriverKind.make("claude"),
                  providerInstanceId: provider,
                  childThreadId: null,
                  prompt: "test",
                  result: null,
                },
              });
          }
          if (!activeProvider)
            yield* sql`
            UPDATE orchestration_v2_projection_threads
            SET active_provider_thread_id = NULL,
              payload_json = json_set(payload_json, '$.activeProviderThreadId', NULL)
            WHERE thread_id = ${id}
          `;
          const exact = yield* store.getThreadShell(id);
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const fallback = yield* Deferred.make<void>();
          const holder = yield* sql
            .withTransaction(
              sql`SELECT 1`.pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
            )
            .pipe(SqliteClient.readOnly, Effect.forkChild);
          yield* Deferred.await(held);
          const viewHolders = yield* Effect.forEach([0, 1], () =>
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>();
              const fiber = yield* sql
                .withTransaction(
                  sql`SELECT 1`.pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                  ),
                )
                .pipe(SqliteClient.readOnly, SqliteClient.foregroundReads, Effect.forkChild);
              yield* Deferred.await(entered);
              return fiber;
            }),
          );
          yield* Effect.gen(function* () {
            const caller = yield* ThreadAccess.loadCaller().pipe(
              Effect.provide(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getCallerRow: (threadId) =>
                    store.getCallerRow(threadId).pipe(SqliteClient.readOnly, Effect.orDie),
                  getThreadShell: (threadId) =>
                    Deferred.succeed(fallback, undefined).pipe(
                      Effect.andThen(
                        store.getThreadShell(threadId).pipe(SqliteClient.readOnly, Effect.orDie),
                      ),
                    ),
                }),
              ),
              Effect.provideService(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("test"),
                requestNamespace: "caller-fallback",
                thread: {
                  threadId: id,
                  providerSessionId: "session",
                  providerInstanceId: provider,
                },
                client: undefined,
                capabilities: new Set(["orchestration"] as const),
                issuedAt: 1,
              }),
              Effect.result,
              Effect.forkChild,
            );
            const first = yield* Effect.raceFirst(
              Fiber.join(caller),
              Deferred.await(fallback).pipe(Effect.as("fallback" as const)),
            );
            if (expectedFallback) {
              assert.equal(first, "fallback");
              yield* TestClock.adjust("10 seconds");
              const result = yield* Fiber.join(caller);
              assert.equal(result._tag, "Failure");
              if (result._tag === "Failure") {
                assert.equal(result.failure.code, "caller_unresolved");
                assert.include(result.failure.message, "Nothing was saved; retry the same call.");
              }
            } else {
              assert.notEqual(first, "fallback");
              const result = yield* Fiber.join(caller);
              assert.equal(result._tag, "Success");
              if (result._tag === "Success") {
                assert.equal(result.success.caller?.activeRunId, exact?.activeRunId);
                assert.deepEqual(
                  result.success.caller?.pendingBackgroundTasks,
                  exact?.pendingBackgroundTasks,
                );
                if (isLiveCallerShell(exact, provider))
                  yield* ThreadAccess.assertLiveCaller(result.success);
                else
                  assert.equal(
                    (yield* ThreadAccess.assertLiveCaller(result.success).pipe(Effect.flip)).code,
                    "parent_not_active",
                  );
              }
              assert.isFalse(yield* Deferred.isDone(fallback));
            }
            assert.isFalse(yield* Deferred.isDone(release));
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          yield* Fiber.join(holder);
          yield* Effect.forEach(viewHolders, Fiber.join);
        }).pipe(Effect.provide(ProjectionStore.layer));
      }).pipe(Effect.provide(sqlLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
