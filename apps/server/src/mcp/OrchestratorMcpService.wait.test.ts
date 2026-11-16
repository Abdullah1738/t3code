import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpCall } from "../ardud/analytics/McpCall.ts";
import { initializeHistoryArchive } from "../ardud/persistence/HistoryArchive.ts";
import { ensureShellLookupIndexes } from "../ardud/persistence/shellIndexes.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const targetId = ThreadId.make("thread:wait-target");
const callerId = ThreadId.make("thread:wait-caller");
const base = liveThreadShell(targetId);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env:wait"),
  requestNamespace: "wait",
  thread: {
    threadId: callerId,
    providerInstanceId: base.providerInstanceId,
    providerSessionId: "session",
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const run = (ordinal: number, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId: targetId,
  ordinal,
  providerInstanceId: base.providerInstanceId,
  modelSelection: base.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`input:${ordinal}`),
  rootNodeId: NodeId.make(`root:${ordinal}`),
  activeAttemptId: null,
  status,
  requestedAt: base.createdAt,
  startedAt: base.createdAt,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

it.effect.each([
  { name: "latest", selected: undefined, caller: "other", blocked: "background" },
  { name: "given", selected: RunId.make("run:1"), caller: "other", blocked: "background" },
  { name: "self", selected: undefined, caller: "self", blocked: "background" },
  { name: "client", selected: undefined, caller: "client", blocked: "background" },
  { name: "old-path negative control", selected: undefined, caller: "other", blocked: "old-path" },
  {
    name: "foreground lookup deadline",
    selected: undefined,
    caller: "other",
    blocked: "foreground",
  },
] as const)("thread wait: $name with a reader held", ({ selected, caller, blocked }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "thread-wait-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* runMigrations();
      yield* initializeHistoryArchive();
      yield* ensureShellLookupIndexes();
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* store.apply({
          id: EventId.make("created"),
          type: "thread.created",
          threadId: targetId,
          occurredAt: base.createdAt,
          payload: idleThreadProjection(base).thread,
        });
        // Older unfinished runs must not make the latest-run foreground query unbounded.
        for (let ordinal = 1; ordinal <= 12; ordinal++)
          yield* store.apply({
            id: EventId.make(`created:${ordinal}`),
            type: "run.created",
            threadId: targetId,
            occurredAt: base.createdAt,
            payload: run(ordinal, "running"),
          });
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lookupEntered = yield* Deferred.make<void>();
        const waitingEntered = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(
            SqliteClient.readOnly,
            blocked === "foreground" ? SqliteClient.foregroundReads : SqliteClient.backgroundReads,
            Effect.forkChild,
          );
        yield* Deferred.await(held);
        const state: McpCall["Service"] = {
          callerResolved: false,
          callerResolveMs: 0,
          callerReaderLane: "background",
          readerLane: "background",
          phase: "handler",
          saved: "unknown",
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          ServerSettings.layerTest(),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
            getThreadRecords: (id, fields, filter, options) =>
              Effect.gen(function* () {
                assert.equal(fields.join(","), "runs");
                assert.deepEqual(
                  filter,
                  selected === undefined ? { latestRunOnly: true } : { runIds: [selected] },
                );
                assert.deepEqual(options, { projectionOnly: true });
                assert.equal(yield* SqliteClient.ReaderLane, "foreground");
                yield* Deferred.succeed(lookupEntered, undefined);
                const records = yield* store.getThreadRecords(id, fields, filter).pipe(
                  SqliteClient.readOnly,
                  blocked === "old-path" ? SqliteClient.backgroundReads : (effect) => effect,
                  Effect.mapError(
                    (cause) =>
                      new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                  ),
                );
                return records;
              }),
            waitForThread: () =>
              Deferred.succeed(waitingEntered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const started = yield* Clock.monotonicTimeNanos;
          const pending = yield* service
            .waitForThread(
              {
                ...scope,
                thread:
                  caller === "client"
                    ? undefined
                    : { ...scope.thread!, threadId: caller === "self" ? targetId : callerId },
              },
              {
                threadId: targetId,
                timeoutMs: 1000,
                ...(selected === undefined ? {} : { runId: selected }),
              },
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(lookupEntered);
          const failsLookup = blocked === "old-path" || blocked === "foreground";
          if (!failsLookup) yield* Deferred.await(waitingEntered);
          yield* TestClock.adjust(1000);
          assert.isDefined(pending.pollUnsafe(), "reply must finish while the reader remains held");
          const result = yield* Fiber.join(pending);
          assert.equal(Number((yield* Clock.monotonicTimeNanos) - started) / 1e6, 1000);
          if (result._tag === "Success") {
            assert.isFalse(failsLookup);
            assert.deepEqual(result.success, {
              threadId: targetId,
              runId: selected ?? RunId.make("run:12"),
              status: "running",
              timedOut: true,
              startPending: true,
              startProgress: null,
            });
            assert.equal(state.waitStage, "waiting");
            assert.equal(state.readerLane, "background");
          } else {
            assert.isTrue(failsLookup);
            assert.equal(result.failure.code, "lookup_timeout");
            assert.include(result.failure.message, "1 s");
            assert.include(result.failure.message, "Nothing changed. Retry t3_thread_wait");
            assert.notInclude(result.failure.message, "reconnecting");
            assert.equal(state.waitStage, "lookup.target");
            assert.equal(state.readerLane, "foreground");
          }
          assert.isNumber(state.waitLookupMs);
          assert.equal(state.callerReaderLane, caller === "client" ? "background" : "identity");
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))),
          Effect.provideService(McpCall, state),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(holder);
      }).pipe(Effect.provide(ProjectionStore.layer));
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(dir, "state.sqlite"),
          readerWorker: true,
          foregroundReaderSlots: 1,
          backgroundReaderSlots: 1,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "slow lookup",
  "missing thread",
  "deleted thread",
  "missing run",
  "lookup admission",
  "wait admission",
  "idle",
  "terminal",
] as const)("thread wait handles %s without changing other read paths", (scenario) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const waiting = yield* Deferred.make<number>();
    const row = idleThreadProjection(base);
    const state: McpCall["Service"] = {
      callerResolved: false,
      callerResolveMs: 0,
      readerLane: "background",
      phase: "handler",
      saved: "unknown",
    };
    const laneError = new Orchestrator.OrchestratorProjectionError({
      threadId: targetId,
      cause: new Error("Reader lane admission queue full"),
    });
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest(),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
        getThreadRecords: () =>
          Effect.gen(function* () {
            if (scenario === "slow lookup") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            if (scenario === "missing thread")
              return yield* new Orchestrator.OrchestratorProjectionError({
                threadId: targetId,
                cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({
                  threadId: targetId,
                }),
              });
            if (scenario === "lookup admission") return yield* laneError;
            return {
              ...row,
              thread: {
                ...row.thread,
                deletedAt: scenario === "deleted thread" ? base.createdAt : null,
              },
              runs:
                scenario === "idle" || scenario === "missing run"
                  ? []
                  : [run(12, scenario === "terminal" ? "completed" : "running")],
            };
          }),
        waitForThread: ({ timeoutMs }) =>
          Effect.gen(function* () {
            if (scenario === "wait admission")
              return yield* new ThreadManagement.ThreadManagementProjectionLoadError({
                projectId: base.projectId,
                threadId: targetId,
                cause: laneError,
              });
            if (scenario === "idle") return { threadId: targetId, run: null, timedOut: false };
            if (scenario === "terminal")
              return { threadId: targetId, run: run(12, "completed"), timedOut: false };
            yield* Deferred.succeed(waiting, timeoutMs);
            return yield* Effect.never;
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const pending = yield* service
        .waitForThread(scope, {
          threadId: targetId,
          timeoutMs: 1000,
          ...(scenario === "missing run" ? { runId: RunId.make("run:missing") } : {}),
        })
        .pipe(Effect.result, Effect.forkChild);
      if (scenario === "slow lookup") {
        yield* Deferred.await(entered);
        yield* TestClock.adjust(600);
        yield* Deferred.succeed(release, undefined);
        const timeoutMs = yield* Deferred.await(waiting);
        const remaining = 1000 - 600;
        // The event wait leaves part of the remaining budget for the final native-ACK read.
        assert.equal(timeoutMs, Math.max(1, remaining - Math.min(250, remaining / 4)));
        yield* TestClock.adjust(remaining);
        assert.isDefined(pending.pollUnsafe());
      }
      const result = yield* Fiber.join(pending);
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.code,
          scenario === "missing run"
            ? "run_not_found"
            : scenario === "lookup admission"
              ? "lookup_timeout"
              : "thread_not_found",
        );
        if (scenario === "lookup admission") {
          assert.include(result.failure.message, "foreground reader");
          assert.equal(state.waitStage, "lookup.target");
        }
      } else {
        assert.include(["slow lookup", "wait admission", "idle", "terminal"], scenario);
        assert.equal(
          result.success.status,
          scenario === "idle" ? "idle" : scenario === "terminal" ? "completed" : "running",
        );
        assert.equal(
          result.success.timedOut,
          scenario === "slow lookup" || scenario === "wait admission",
        );
        if (scenario === "slow lookup") assert.equal(state.waitLookupMs, 600);
      }
    }).pipe(
      Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))),
      Effect.provideService(McpCall, state),
    );
  }),
);
