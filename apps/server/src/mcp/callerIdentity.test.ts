import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";
import * as ThreadAccess from "./threadAccess.ts";
import { readCallerIdentity } from "./callerIdentity.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const callerId = ThreadId.make("caller:foreground");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:foreground"),
  requestNamespace: "caller-foreground",
  thread: {
    threadId: callerId,
    providerSessionId: "session:foreground",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect(
  "target shells and target records stay on the background lane after caller resolution",
  () =>
    Effect.gen(function* () {
      const result = yield* ThreadAccess.readThread(callerId, ["runs"]);
      assert.equal(result.caller?.id, callerId);
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "foreground");
              return liveThreadShell(id);
            }),
          getThreadShell: (id) =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "background");
              return liveThreadShell(id);
            }),
          getProjectThreadRecords: ({ threadId }) =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "background");
              return idleThreadProjection(liveThreadShell(threadId));
            }),
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    ),
);

it.effect.each(["board", "send", "status"] as const)(
  "%s resolves an active caller with the real background reader pinned",
  (operation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "caller-lanes-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        yield* sql`INSERT INTO entries VALUES (1)`;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const resolved = yield* Deferred.make<void>();
        const recordEntered = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT * FROM entries`;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(held);
        const lanes: string[] = [];
        const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: () =>
            Effect.gen(function* () {
              lanes.push(yield* SqliteClient.ReaderLane);
              yield* sql
                .withTransaction(sql`SELECT * FROM entries`)
                .pipe(SqliteClient.readOnly, Effect.orDie);
              yield* Deferred.succeed(resolved, undefined);
              return liveThreadShell(callerId);
            }),
          getThreadShell: () => Effect.die("active caller must not load its full shell"),
          getThreadRecords: () =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "background");
              yield* Deferred.succeed(recordEntered, undefined);
              yield* sql
                .withTransaction(sql`SELECT * FROM entries`)
                .pipe(SqliteClient.readOnly, Effect.orDie);
              return yield* Effect.never;
            }),
          getProjectThreadRecords: () =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "background");
              yield* Deferred.succeed(recordEntered, undefined);
              yield* sql
                .withTransaction(sql`SELECT * FROM entries`)
                .pipe(SqliteClient.readOnly, Effect.orDie);
              return yield* Effect.never;
            }),
        });
        const deps = Layer.mergeAll(
          NodeServices.layer,
          threads,
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
        yield* Effect.gen(function* () {
          if (operation === "board") {
            const caller = yield* ThreadAccess.loadCaller();
            yield* ThreadAccess.assertLiveCaller(caller);
            assert.equal(caller.caller?.id, callerId);
          } else {
            const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
            const pending = yield* (
              operation === "status"
                ? mcp.taskStatus(scope, NodeId.make("task:foreground"))
                : mcp.sendToThread(scope, { message: "test", threadId: callerId })
            ).pipe(Effect.forkChild);
            yield* Deferred.await(resolved);
            yield* Deferred.await(recordEntered);
            assert.isFalse(yield* Deferred.isDone(release));
            if (operation === "status") {
              yield* TestClock.adjust("10 seconds");
              assert.deepEqual(yield* Fiber.join(pending), {
                taskId: NodeId.make("task:foreground"),
                partial: true,
                callerResolved: true,
                stoppedAt: "parent_records",
                retryHint:
                  "Robob was busy and this read stopped at parent_records. The task itself is unaffected. Retry task_status in a few seconds.",
              });
            } else yield* Fiber.interrupt(pending);
          }
          assert.deepEqual(lanes, ["foreground"]);
          assert.isFalse(yield* Deferred.isDone(release));
        }).pipe(
          Effect.provide(OrchestratorMcp.layer.pipe(Layer.provideMerge(deps))),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(holder);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
            backgroundReaderSlots: 1,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["ended", "archived", "fork", "other-provider"] as const)(
  "%s caller uses the exact background shell fallback",
  (state) =>
    Effect.gen(function* () {
      const base = liveThreadShell(callerId);
      const shell = {
        ...base,
        activeRunId: state === "ended" ? null : base.activeRunId,
        archivedAt: state === "archived" ? base.createdAt : null,
        forkedFrom:
          state === "fork"
            ? { type: "run" as const, threadId: callerId, runId: base.activeRunId! }
            : null,
        providerInstanceId: ProviderInstanceId.make(
          state === "other-provider" ? "claude" : "codex",
        ),
        pendingBackgroundTasks: [
          {
            taskId: "native-task",
            kind: "subagent" as const,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        ],
      };
      let fallbackReads = 0;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const identity = yield* readCallerIdentity(
        {
          ...threads,
          getCallerRow: () =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "foreground");
              return shell;
            }),
          getThreadShell: () =>
            Effect.gen(function* () {
              assert.equal(yield* SqliteClient.ReaderLane, "background");
              fallbackReads++;
              return shell;
            }),
        },
        callerId,
        ProviderInstanceId.make("codex"),
      );
      assert.strictEqual(identity, shell);
      assert.equal(fallbackReads, 1);
      assert.equal(
        OrchestratorMcp.isLiveCallerShell(identity, ProviderInstanceId.make("codex")),
        OrchestratorMcp.isLiveCallerShell(shell, ProviderInstanceId.make("codex")),
      );
    }).pipe(Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({}))),
);
