import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Option from "effect/Option";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect.each([
  { stage: "caller", stop: "deadline" },
  { stage: "parent_records", stop: "deadline" },
  { stage: "child_records", stop: "deadline" },
  { stage: "result", stop: "deadline" },
  { stage: "caller", stop: "interruption" },
  { stage: "parent_records", stop: "interruption" },
  { stage: "child_records", stop: "interruption" },
  { stage: "result", stop: "interruption" },
] as const)(
  "releases task_status on $stop while the production reader snapshot gate holds $stage",
  ({ stage, stop }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "review516-" });
      const gate = yield* Semaphore.make(1);
      const entered = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const readerSnapshotLock = {
        ...gate,
        withPermits:
          (n: number) =>
          <A, E, R>(body: Effect.Effect<A, E, R>) =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(gate.withPermits(n)(body))),
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries (value INTEGER)`;
        yield* gate.take(1);
        const parent = ThreadId.make("thread:review516");
        const child = ThreadId.make("thread:review516-child");
        const taskId = NodeId.make("node:review516");
        const parentProjection = {
          thread: { id: parent },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parent,
              origin: "app_owned",
              childThreadId: child,
              status: "running",
              result: null,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const childProjection = {
          thread: { id: child },
          runs: [],
          messages: [],
          contextTransfers: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const logs: unknown[] = [];
        const logger = Logger.make(({ message }) => {
          logs.push(message);
        });
        const snapshot = sql.withTransaction(sql`SELECT * FROM entries`).pipe(
          // This case exercises cleanup for a reader that cannot acknowledge cancellation.
          Effect.uninterruptible,
          SqliteClient.readOnly,
          Effect.mapError(
            (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: parent, cause }),
          ),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        );
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: () =>
              stage === "caller"
                ? snapshot.pipe(Effect.as(liveThreadShell(parent)))
                : Effect.succeed(liveThreadShell(parent)),
            getThreadShell: () =>
              stage === "caller"
                ? snapshot.pipe(Effect.as(liveThreadShell(parent)))
                : Effect.succeed(liveThreadShell(parent)),
            getThreadRecords: (threadId, fields) => {
              const readingStage =
                threadId === parent
                  ? "parent_records"
                  : fields.some((field) => field === "runs")
                    ? "child_records"
                    : "result";
              return stage === readingStage
                ? snapshot.pipe(Effect.andThen(Effect.never))
                : Effect.succeed(threadId === parent ? parentProjection : childProjection);
            },
          }),
          ServerSettings.layerTest(),
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
        const completedAtDeadline = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const reading = yield* service
            .taskStatus(
              {
                environmentId: EnvironmentId.make("environment:review516"),
                requestNamespace: "review516",
                thread: {
                  threadId: parent,
                  providerSessionId: "review516",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration"]),
                issuedAt: 1,
              },
              taskId,
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const cancelling =
            stop === "interruption"
              ? yield* Fiber.interrupt(reading).pipe(Effect.forkChild)
              : undefined;
          yield* TestClock.adjust(stop === "deadline" ? "10 seconds" : 0);
          const completed = reading.pollUnsafe() !== undefined;
          const cleanupPending = !(yield* Deferred.isDone(finalized));
          yield* gate.release(1);
          if (cancelling !== undefined) yield* Fiber.join(cancelling);
          else {
            const result = yield* Fiber.join(reading);
            assert.deepEqual(result, {
              taskId: NodeId.make("node:review516"),
              partial: true,
              stoppedAt: stage,
              retryHint:
                `Robob was busy and this read stopped at ${stage}. The task itself is unaffected. Retry task_status in a few seconds` +
                (["child_records", "result"].includes(stage)
                  ? ", or read childThreadId with t3_thread_read."
                  : "."),
              ...(stage !== "caller" ? { callerResolved: true as const } : {}),
              ...(["child_records", "result"].includes(stage)
                ? { childThreadId: child, childNodeId: taskId }
                : {}),
              ...(stage === "result"
                ? {
                    childRunId: null,
                    currentRunId: null,
                    currentRunStatus: null,
                    latestTerminalRunId: null,
                    latestTerminalStatus: null,
                    hasPendingChildRuns: false,
                    startPending: false as const,
                    startProgress: null,
                    // The child's run status is known before the result read starts.
                    status: "running" as const,
                  }
                : {}),
            });
          }
          assert.deepEqual(
            logs,
            stop === "deadline"
              ? [
                  [
                    "orchestrator-mcp.task-status.partial",
                    { taskId, stoppedAt: stage, elapsedMs: 10000, callerThreadId: parent },
                  ],
                ]
              : [],
          );
          yield* Deferred.await(finalized);
          // A fresh BEGIN on the same reader fails if cancellation stranded its transaction.
          const rows = yield* sql
            .withTransaction(sql`SELECT 42 AS value`)
            .pipe(SqliteClient.readOnly);
          assert.deepEqual(rows, [{ value: 42 }]);
          assert.isTrue(
            cleanupPending,
            "cleanup must remain with the masked read until the gate opens",
          );
          return completed;
        }).pipe(
          Effect.provide([
            OrchestratorMcpService.layer.pipe(
              Layer.provide(McpProviderSessions.layer),
              Layer.provide(dependencies),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ]),
        );
        assert.isTrue(
          completedAtDeadline,
          "read still waits for the masked archive snapshot gate after its deadline",
        );
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            readerSnapshotSql: ["SELECT rootpage FROM main.sqlite_schema LIMIT 1"],
            readerSnapshotLock,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { first: "status", second: "status" },
  { first: "status", second: "cancel" },
  { first: "cancel", second: "status" },
  { first: "cancel", second: "cancel" },
] as const)(
  "concurrent $first/$second do not count a receipt read as a pending create",
  ({ first, second }) =>
    Effect.gen(function* () {
      const parent = ThreadId.make("parent:receipt-read-fence");
      const commandId = CommandId.make(
        `command:mcp:delegate-task:env:${encodeURIComponent(parent)}:retry`,
      );
      const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
      const firstReadHeld = yield* Deferred.make<void>();
      const concurrentRead = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reads: CommandId[] = [];
      const settings = ServerSettings.layerTest();
      const threads = ThreadManagement.layer.pipe(
        Layer.provide(settings),
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getCallerRow: () => Effect.succeed(liveThreadShell(parent)),
            getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(parent))),
          }),
        ),
        Layer.provide(
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
            getByCommandId: (readCommandId) =>
              Effect.gen(function* () {
                if (readCommandId === `delegation-lost:${commandId}`) return Option.none();
                reads.push(readCommandId);
                assert.equal(readCommandId, commandId);
                if (reads.length === 2) {
                  yield* Deferred.succeed(firstReadHeld, undefined);
                  yield* Deferred.await(release);
                }
                if (reads.length === 3) yield* Deferred.succeed(concurrentRead, undefined);
                return Option.none();
              }),
          }),
        ),
      );
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        threads,
        settings,
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
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("env"),
          requestNamespace: "receipt-read-fence",
          thread: {
            threadId: parent,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const read = (operation: "status" | "cancel") =>
          operation === "status"
            ? service.taskStatus(scope, taskId).pipe(Effect.asVoid)
            : service.cancelTask(scope, { taskId }).pipe(Effect.asVoid);
        // TestClock only yields once per adjustment; task_status forks a service-scoped reader.
        // A live watchdog bounds missing milestones without advancing the production deadline.
        const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, milestone: string) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () =>
                Effect.die(new Error(`${milestone}; receipt reads: ${JSON.stringify(reads)}`)),
            }),
            TestClock.withLive,
          );
        const firstRead = yield* read(first).pipe(Effect.flip, Effect.forkChild);
        yield* bounded(Deferred.await(firstReadHeld), `first ${first} must hold the receipt fence`);
        const secondRead = yield* read(second).pipe(Effect.flip, Effect.forkChild);
        yield* bounded(
          Deferred.await(concurrentRead),
          `second ${second} must reach the receipt read`,
        );
        yield* TestClock.adjust(0);
        assert.lengthOf(reads, 3, "a concurrent read must wait for the receipt fence");
        assert.isUndefined(
          secondRead.pollUnsafe(),
          "a concurrent read must wait for the receipt fence",
        );
        yield* Deferred.succeed(release, undefined);
        const errors = yield* bounded(
          Effect.all([Fiber.join(firstRead), Fiber.join(secondRead)], { concurrency: "unbounded" }),
          "both reads must finish after releasing the fence",
        );
        for (const error of errors) {
          assert.equal(error.code, "task_not_found");
          assert.include(error.message, "This delegation was never saved.");
        }
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(McpProviderSessions.layer),
            Layer.provide(dependencies),
          ),
        ),
      );
    }),
);
