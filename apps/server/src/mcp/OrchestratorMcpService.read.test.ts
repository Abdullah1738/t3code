import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, MessageId, TurnItemId } from "@t3tools/contracts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpCall } from "../ardud/analytics/McpCall.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect.each(["same caller", "different callers"] as const)("reads three threads with background reader and writer held: %s", (mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "thread-read-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE fixture (id INTEGER)`;
      const backgroundHeld = yield* Deferred.make<void>();
      const writerHeld = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hold = (entered: Deferred.Deferred<void>) => sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT 1`;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }));
      const background = yield* hold(backgroundHeld).pipe(SqliteClient.readOnly, SqliteClient.backgroundReads, Effect.forkChild);
      yield* Deferred.await(backgroundHeld);
      const writer = yield* hold(writerHeld).pipe(Effect.forkChild);
      yield* Deferred.await(writerHeld);
      const target = ThreadId.make("thread:read-target");
      const shell = liveThreadShell(target);
      const message = {
        id: MessageId.make("message:read"), threadId: target, runId: null, nodeId: null,
        role: "user" as const, text: "read while lanes stay held", attachments: [], streaming: false,
        createdBy: "user" as const, creationSource: "web" as const, createdAt: shell.createdAt, updatedAt: shell.updatedAt,
      };
      const item = {
        id: TurnItemId.make("item:read"), threadId: target, runId: null, nodeId: null,
        providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
        ordinal: 0, status: "completed" as const, title: null,
        startedAt: shell.createdAt, completedAt: shell.createdAt, updatedAt: shell.updatedAt,
        type: "user_message" as const, inputIntent: "turn_start" as const,
        createdBy: "user" as const, creationSource: "web" as const,
        messageId: message.id, text: message.text, attachments: [],
      };
      const records = { ...idleThreadProjection(shell), messages: [message] };
      const query = <A>(value: A) => sql.withTransaction(sql`SELECT 1`).pipe(
        SqliteClient.readOnly, Effect.as(value), Effect.orDie,
      );
      const entered = yield* Deferred.make<void>();
      const releaseReads = yield* Deferred.make<void>();
      let timelineCount = 0;
      const states = [0, 1, 2].map((): McpCall["Service"] => ({
        callerResolved: false, callerResolveMs: 0, readerLane: "background", phase: "handler", saved: "unknown",
        threadRead: { readerWaitMs: 0, queryMs: 0, renderMs: 0, threadReadStages: [] },
      }));
      const dependencies = Layer.mergeAll(
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: () => query(shell),
          getProjectThreadRecords: () => query(records),
          getThreadRecords: () => query(records),
          getTimelinePage: () => query({
            items: [{ position: 0, sourceThreadId: target, sourceItemId: item.id, visibility: "local" as const, item }],
            totalItems: 1, hasMore: false,
          }).pipe(
            Effect.tap(() => Effect.gen(function* () {
              timelineCount += 1;
              if (timelineCount === 3) yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(releaseReads);
            })),
          ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const reads = yield* Effect.forEach(states, (state, index) => service.readThread({
          environmentId: EnvironmentId.make("env:read"),
          requestNamespace: mode === "same caller" ? "read" : `read:${index}`,
          thread: { threadId: ThreadId.make(mode === "same caller" ? "thread:caller" : `thread:caller:${index}`), providerInstanceId: shell.providerInstanceId, providerSessionId: "read" },
          client: undefined, capabilities: new Set(["orchestration"]), issuedAt: 1,
        }, { threadId: target, limit: 1, runLimit: 1 }).pipe(Effect.provideService(McpCall, state)),
          { concurrency: "unbounded" }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.equal(timelineCount, 3);
        yield* Deferred.succeed(releaseReads, undefined);
        for (const result of yield* Fiber.join(reads)) {
          assert.lengthOf(result.items, 1);
          assert.equal(result.items[0]?.text, message.text);
        }
        assert.isUndefined(background.pollUnsafe());
        assert.isUndefined(writer.pollUnsafe());
        for (const state of states) assert.deepEqual(state.threadRead?.threadReadStages.map((row) => row.stage),
          ["caller", "shell", "records", "timeline", "messages", "acknowledgement"]);
      }).pipe(
        Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      );
      yield* Fiber.join(background);
      yield* Fiber.join(writer);
    }).pipe(Effect.provide(SqliteClient.layer({
      filename: path.join(dir, "test.sqlite"), readerWorker: true,
      foregroundReaderSlots: 1, backgroundReaderSlots: 1,
    })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
