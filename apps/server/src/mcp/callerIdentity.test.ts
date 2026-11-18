import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
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
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { readCallerIdentity } from "./callerIdentity.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const callerId = ThreadId.make("caller:foreground");

it.effect.each([
  ["readerAdmission", "Reader lane admission queue full"],
  ["readerBusy", "Reader lane busy: not admitted within 5500 ms"],
  ["readerSnapshot", "Reader lane snapshot limit exceeded"],
  ["execute", "Database reader retired: request interrupted"],
  ["execute", "no such table: private_table"],
] as const)("a %s failure names the identity wait without exposing SQL", ([operation, message]) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const cause = new OrchestratorProjectionError({
      threadId: callerId,
      cause: new SqlError({
        reason: classifySqliteError(new Error(message), { operation, message }),
      }),
    });
    const error = yield* readCallerIdentity(
      {
        ...threads,
        getCallerRow: () => Effect.fail(cause),
        getThreadShell: () => Effect.die("lane failure must not load a background shell"),
      },
      callerId,
      ProviderInstanceId.make("codex"),
    ).pipe(Effect.flip);
    if (message.startsWith("no such table")) {
      assert.strictEqual(error, cause);
      return;
    }
    assert.equal(error._tag, "OrchestratorMcpFailure");
    assert.include(error.message, 'waiting on "statev2 identity caller row"');
    assert.include(error.message, "identity reader");
    assert.include(error.message, "Nothing was saved; retry the same call.");
    assert.notInclude(error.message, message);
  }).pipe(Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({}))),
);

it.effect.each(["board", "send", "status", "delegate"] as const)(
  "%s fails safely with an unavailable identity caller reader and foreground held",
  (operation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "caller-unavailable-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        const callerServices = yield* Layer.build(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            identityReaderProcess: true,
            readerInitializationSql: ["SELECT * FROM missing_init_table"],
          }),
        );
        const callerSql = Context.get(callerServices, SqlClient.SqlClient);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            sql`SELECT * FROM entries`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(SqliteClient.readOnly, SqliteClient.foregroundReads, Effect.forkChild);
        yield* Deferred.await(held);
        const threads = yield* ThreadManagement.ThreadManagementService.pipe(
          Effect.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getCallerRow: (threadId) =>
                callerSql.withTransaction(callerSql`SELECT * FROM entries`).pipe(
                  SqliteClient.readOnly,
                  Effect.as(liveThreadShell(threadId)),
                  Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
                ),
              getThreadShell: () => Effect.die("must not fall back to a shell after lane failure"),
            }),
          ),
        );
        const deps = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ThreadManagement.ThreadManagementService, threads),
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
        const error = yield* Effect.gen(function* () {
          if (operation === "board") return yield* ThreadAccess.loadCaller();
          const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
          if (operation === "status")
            return yield* mcp.taskStatus(scope, NodeId.make("task:unavailable"));
          if (operation === "delegate")
            return yield* mcp.delegateTask(scope, { task: "test", clientRequestId: "same-key" });
          return yield* mcp.sendToThread(scope, { threadId: callerId, message: "test" });
        }).pipe(
          Effect.provide(
            OrchestratorMcp.layer.pipe(
              Layer.provide(McpProviderSessions.layer),
              Layer.provideMerge(deps),
            ),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.flip,
        );
        assert.equal(error._tag, "OrchestratorMcpFailure");
        assert.include(error.message, 'waiting on "statev2 identity caller row"');
        assert.include(error.message, "identity reader");
        assert.include(error.message, "Nothing was saved; retry the same call.");
        if (error._tag === "OrchestratorMcpFailure") assert.equal(error.code, "caller_unresolved");
        if (operation === "delegate")
          assert.include(error.message, "Retry only with the same clientRequestId: same-key.");
        assert.isUndefined(holder.pollUnsafe());
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
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
              assert.equal(yield* SqliteClient.ReaderLane, "identity");
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

it.effect.each(
  (["board", "send", "status"] as const).flatMap((operation) =>
    (["root", "delegated-codex", "delegated-claude"] as const).map((kind) => ({ operation, kind })),
  ),
)(
  "$operation resolves an active $kind caller with every view reader pinned",
  ({ operation, kind }) =>
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
        const providerInstanceId = ProviderInstanceId.make(
          kind === "delegated-claude" ? "claudeAgent" : "codex",
        );
        const callerScope = { ...scope, thread: { ...scope.thread!, providerInstanceId } };
        const shell = {
          ...liveThreadShell(callerId),
          providerInstanceId,
          forkedFrom:
            kind === "root" ? null : { type: "node" as const, nodeId: NodeId.make("task:caller") },
        };
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
        const viewHolders = yield* Effect.forEach([0, 1], () =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const fiber = yield* sql
              .withTransaction(
                sql`SELECT * FROM entries`.pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              )
              .pipe(SqliteClient.readOnly, SqliteClient.foregroundReads, Effect.forkChild);
            yield* Deferred.await(entered);
            return fiber;
          }),
        );
        const lanes: string[] = [];
        const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: () =>
            Effect.gen(function* () {
              lanes.push(yield* SqliteClient.ReaderLane);
              yield* sql
                .withTransaction(sql`SELECT * FROM entries`)
                .pipe(SqliteClient.readOnly, Effect.orDie);
              yield* Deferred.succeed(resolved, undefined);
              return shell;
            }),
          getThreadShell: () => Effect.die("active caller must not load its full shell"),
          getThreadRecords: () =>
            Effect.gen(function* () {
              assert.equal(
                yield* SqliteClient.ReaderLane,
                operation === "board" ? "background" : "foreground",
              );
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
                ? mcp.taskStatus(callerScope, NodeId.make("task:foreground"))
                : mcp.sendToThread(callerScope, { message: "test", threadId: callerId })
            ).pipe(Effect.forkChild);
            yield* Deferred.await(resolved);
            yield* Effect.raceFirst(Fiber.join(pending), Deferred.await(recordEntered));
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
          assert.deepEqual(lanes, ["identity"]);
          assert.isFalse(yield* Deferred.isDone(release));
        }).pipe(
          Effect.provide(
            OrchestratorMcp.layer.pipe(
              Layer.provide(McpProviderSessions.layer),
              Layer.provideMerge(deps),
            ),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(holder);
        yield* Effect.forEach(viewHolders, Fiber.join);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            identityReaderProcess: true,
            foregroundReaderSlots: 2,
            backgroundReaderSlots: 1,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["ended", "fork"] as const)(
  "%s caller uses the exact background shell fallback",
  (state) =>
    Effect.gen(function* () {
      const base = liveThreadShell(callerId);
      const shell = {
        ...base,
        activeRunId: state === "ended" ? null : base.activeRunId,
        forkedFrom:
          state === "fork"
            ? { type: "run" as const, threadId: callerId, runId: base.activeRunId! }
            : null,
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
              assert.equal(yield* SqliteClient.ReaderLane, "identity");
              return { ...shell, pendingBackgroundTasks: undefined };
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

it.effect.each(["ended", "archived", "other-provider", "background-subagent"] as const)(
  "delegated %s caller retains the full liveness check",
  (state) =>
    Effect.gen(function* () {
      const base = liveThreadShell(callerId);
      const shell = {
        ...base,
        forkedFrom: { type: "node" as const, nodeId: NodeId.make("task:caller") },
        activeRunId: state === "archived" || state === "other-provider" ? base.activeRunId : null,
        archivedAt: state === "archived" ? base.createdAt : null,
        providerInstanceId: ProviderInstanceId.make(
          state === "other-provider" ? "claudeAgent" : "codex",
        ),
        pendingBackgroundTasks:
          state === "background-subagent"
            ? [
                {
                  taskId: "native-task",
                  kind: "subagent" as const,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
              ]
            : [],
      };
      let fallbackReads = 0;
      const caller = yield* ThreadAccess.loadCaller().pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: () => Effect.succeed(shell),
            getThreadShell: () =>
              Effect.gen(function* () {
                assert.equal(yield* SqliteClient.ReaderLane, "background");
                fallbackReads++;
                return shell;
              }),
          }),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      );
      assert.equal(fallbackReads, 0);
      assert.equal(caller.caller?.id, shell.id);
      if (state === "background-subagent") yield* ThreadAccess.assertLiveCaller(caller);
      else
        assert.equal(
          (yield* ThreadAccess.assertLiveCaller(caller).pipe(Effect.flip)).code,
          "parent_not_active",
        );
    }),
);
