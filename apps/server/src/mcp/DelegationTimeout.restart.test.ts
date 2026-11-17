import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect.each([
  "lost",
  "saved",
  "archived",
  "missing",
  "crash_during_cleanup",
  "newer_timeout",
] as const)("recovers a persisted async timeout after service restart: %s", (scenario) =>
  Effect.gen(function* () {
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const parent = ThreadId.make("parent:restart-timeout");
    const commandId = CommandId.make(
      "command:mcp:delegate-task:env:parent%3Arestart-timeout:restart-request",
    );
    const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
    const entered = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const notifications: string[] = [];
    const events: AnalyticsEvent[] = [];
    const shell = liveThreadShell(parent);
    const engine = Layer.mock(Orchestrator.OrchestratorV2)({
      getCallerRow: () => Effect.succeed(shell),
      getThreadShell: () =>
        Effect.succeed(
          scenario === "missing"
            ? null
            : { ...shell, archivedAt: scenario === "archived" ? DateTime.makeUnsafe(0) : null },
        ),
      getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "delegated_task.request") {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(held);
          }
          if (command.type === "message.dispatch") {
            if (
              yield* receipts.insertIfAbsent({
                commandId: command.commandId,
                threadId: parent,
                commandType: command.type,
                acceptedAt: yield* DateTime.now,
                resultSequence: 1,
                status: "accepted",
                error: null,
              })
            )
              notifications.push(command.text);
          }
          return { sequence: 1, storedEvents: [] };
        }).pipe(
          Effect.catchTags({
            CommandReceiptStoreReadError: Effect.die,
            CommandReceiptStoreWriteError: Effect.die,
          }),
        ),
    });
    const service = Threads.layer.pipe(
      Layer.provide(engine),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(Sessions.ProviderSessionManagerV2)({})),
    );
    const record: Receipts.DelegationTimeout = {
      attemptId: "restart-attempt",
      commandId,
      parentThreadId: parent,
      clientRequestId: "restart-request",
      taskId,
      createdAt: "2026-11-16T14:27:00Z",
      analyticsJson: JSON.stringify({
        ts: "1970-01-01T00:00:00.000Z",
        kind: "mcp.detached",
        surface: "server",
        route: "mcp",
        outcome: "failed",
        tool: "delegate_task",
        bootId: "previous-boot",
        build: "test",
        startedAt: "1970-01-01T00:00:00.000Z",
      }),
    };
    // Closing this scope interrupts the in-flight create; only the shared durable store survives.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const threads = yield* Threads.ThreadManagementService;
        yield* threads
          .dispatch({
            type: "delegated_task.request",
            commandId,
            parentThreadId: parent,
            parentRunId: RunId.make("run:restart-parent"),
            parentNodeId: NodeId.make("node:restart-parent"),
            task: "Review",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* threads.recordDelegationTimeout(record);
      }).pipe(Effect.provide(service)),
    );
    if (scenario === "saved")
      yield* receipts.upsert({
        commandId,
        threadId: parent,
        commandType: "delegated_task.request",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
    let failCleanup = scenario === "crash_during_cleanup";
    const crashStore = Layer.succeed(Receipts.CommandReceiptStoreV2, {
      ...receipts,
      removeDelegationTimeout: (id, attemptId) =>
        failCleanup
          ? Effect.sync(() => {
              failCleanup = false;
            }).pipe(
              Effect.andThen(
                Effect.fail(new Receipts.CommandReceiptStoreWriteError({ commandId: id })),
              ),
            )
          : receipts.removeDelegationTimeout(id, attemptId),
    });
    yield* Effect.gen(function* () {
      const restarted = yield* Threads.ThreadManagementService;
      const startupRecords = yield* receipts.listDelegationTimeouts();
      const newerRecord = {
        ...record,
        commandId: CommandId.make("newer-timeout"),
        clientRequestId: "newer-request",
      };
      if (scenario === "newer_timeout") yield* restarted.recordDelegationTimeout(newerRecord);
      yield* restarted.sweepDelegationTimeouts(startupRecords);
      yield* restarted.sweepDelegationTimeouts(startupRecords);
      assert.deepEqual(
        yield* receipts.listDelegationTimeouts(),
        scenario === "newer_timeout" ? [newerRecord] : [],
      );
      const failed =
        scenario === "lost" || scenario === "crash_during_cleanup" || scenario === "newer_timeout";
      assert.equal(notifications.length, failed ? 1 : 0);
      assert.equal(
        events.filter((event) => event.detachedOutcomeWake === "sent_after_restart").length,
        failed ? 1 : 0,
      );
      if (scenario === "saved")
        assert.equal(events.at(-1)?.detachedOutcomeWake, "suppressed_retry_saved");
      if (failed) {
        assert.include(notifications[0]!, "lost in server restart");
        assert.include(notifications[0]!, "restart-request");
        assert.include(notifications[0]!, taskId);
        assert.include(
          notifications[0]!,
          "Nothing ran. Retry delegate_task with the same clientRequestId.",
        );
        assert.deepEqual(yield* restarted.getDelegationCommandState(commandId), {
          status: "never_saved",
          reason: "lost in server restart",
        });
        const missing = yield* Effect.gen(function* () {
          const mcp = yield* Mcp.OrchestratorMcpService;
          return yield* mcp
            .taskStatus(
              {
                environmentId: EnvironmentId.make("env"),
                requestNamespace: "restart-test",
                thread: {
                  threadId: parent,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  providerSessionId: "restart-test",
                },
                client: undefined,
                capabilities: new Set(["orchestration"]),
                issuedAt: 1,
              },
              taskId,
            )
            .pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            Mcp.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Threads.ThreadManagementService, restarted),
                  NodeServices.layer,
                  ServerSettings.layerTest(),
                  Layer.mock(McpProviderSessions.McpProviderSessions)({}),
                  Layer.mock(Launch.ThreadLaunchService)({}),
                  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(Adapters.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(Projects.ProjectService)({}),
                  Layer.mock(Secrets.SecretRequests)({}),
                  Layer.mock(Schedules.ScheduledTaskService)({}),
                ),
              ),
            ),
          ),
        );
        assert.equal(missing.code, "task_not_found");
        assert.include(missing.message, "never saved: lost in server restart");
        // A saved retry supersedes the durable diagnostic too.
        yield* receipts.upsert({
          commandId,
          threadId: parent,
          commandType: "delegated_task.request",
          acceptedAt: yield* DateTime.now,
          resultSequence: 1,
          status: "accepted",
          error: null,
        });
        assert.equal((yield* restarted.getDelegationCommandState(commandId)).status, "accepted");
      }
      if (scenario === "saved")
        assert.isTrue(Option.isSome(yield* receipts.getByCommandId(commandId)));
    }).pipe(
      Effect.provideService(Analytics.Analytics, {
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        flush: Effect.void,
        ingest: () => Effect.void,
        read: () => Effect.die("unused"),
      }),
      Effect.provide(Layer.fresh(service).pipe(Layer.provide(crashStore))),
    );
  }).pipe(Effect.provide(Receipts.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
);
