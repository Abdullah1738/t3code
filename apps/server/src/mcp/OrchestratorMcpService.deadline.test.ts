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
import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect.each([
  { stage: "caller", stop: "deadline" },
  { stage: "records", stop: "deadline" },
  { stage: "caller", stop: "interruption" },
  { stage: "records", stop: "interruption" },
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
        const snapshot = sql.withTransaction(sql`SELECT * FROM entries`).pipe(
          SqliteClient.readOnly,
          Effect.mapError(
            (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: parent, cause }),
          ),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        );
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              stage === "caller"
                ? snapshot.pipe(Effect.as(liveThreadShell(parent)))
                : Effect.succeed(liveThreadShell(parent)),
            getThreadRecords: () => snapshot.pipe(Effect.andThen(Effect.never)),
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
              NodeId.make("node:review516"),
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
            assert.deepEqual(result, { taskId: NodeId.make("node:review516"), partial: true });
          }
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
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
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
