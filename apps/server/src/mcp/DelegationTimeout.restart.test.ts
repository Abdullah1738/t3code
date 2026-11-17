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
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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
  "transient_startup_read",
  "transient_read",
  "transient_receipt",
  "transient_parent",
  "transient_projection",
  "transient_diagnostic",
  "transient_dispatch",
  "transient_dispatch_committed",
  "transient_cleanup",
  "transient_retry_saved",
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
    const failedAttempt = yield* Deferred.make<void>();
    const failurePoint =
      scenario === "crash_during_cleanup"
        ? "cleanup"
        : scenario === "transient_retry_saved"
          ? "read"
          : scenario.replace("transient_", "");
    let failureInjected = false;
    let recovering = false;
    const failOnce = <A, E, R, E2>(point: string, effect: Effect.Effect<A, E, R>, error: E2) =>
      Effect.suspend<A, E | E2, R>(() => {
        if (!recovering || failurePoint !== point || failureInjected) return effect;
        failureInjected = true;
        return Deferred.succeed(failedAttempt, undefined).pipe(Effect.andThen(Effect.fail(error)));
      });
    const dispatchError = () =>
      new Orchestrator.OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "temporary dispatch failure",
      });
    const engine = Layer.mock(Orchestrator.OrchestratorV2)({
      getCallerRow: () => Effect.succeed(shell),
      getThreadShell: () =>
        failOnce(
          "parent",
          Effect.succeed(
            scenario === "missing"
              ? null
              : { ...shell, archivedAt: scenario === "archived" ? DateTime.makeUnsafe(0) : null },
          ),
          dispatchError(),
        ),
      getThreadRecords: () =>
        failOnce("projection", Effect.succeed(idleThreadProjection(shell)), dispatchError()),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "delegated_task.request") {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(held);
          }
          if (command.type === "message.dispatch") {
            yield* failOnce("dispatch", Effect.void, dispatchError());
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
            yield* failOnce("dispatch_committed", Effect.void, dispatchError());
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
    recovering = true;
    const crashStore = Layer.succeed(Receipts.CommandReceiptStoreV2, {
      ...receipts,
      listDelegationTimeouts: () =>
        failOnce(
          "startup_read",
          receipts.listDelegationTimeouts(),
          new Receipts.CommandReceiptStoreReadError({ commandId }),
        ),
      getDelegationTimeout: (id, attemptId) =>
        failOnce(
          "read",
          receipts.getDelegationTimeout(id, attemptId),
          new Receipts.CommandReceiptStoreReadError({ commandId: id }),
        ),
      getByCommandId: (id) =>
        failOnce(
          "receipt",
          receipts.getByCommandId(id),
          new Receipts.CommandReceiptStoreReadError({ commandId: id }),
        ),
      upsert: (receipt) =>
        failOnce(
          "diagnostic",
          receipts.upsert(receipt),
          new Receipts.CommandReceiptStoreWriteError({ commandId: receipt.commandId }),
        ),
      removeDelegationTimeout: (id, attemptId) =>
        failOnce(
          "cleanup",
          receipts.removeDelegationTimeout(id, attemptId),
          new Receipts.CommandReceiptStoreWriteError({ commandId: id }),
        ),
    });
    yield* Effect.gen(function* () {
      const restarted = yield* Threads.ThreadManagementService;
      const snapshot = yield* restarted.snapshotDelegationTimeouts().pipe(Effect.forkScoped);
      if (scenario === "transient_startup_read") {
        yield* Deferred.await(failedAttempt);
        assert.isUndefined(
          snapshot.pollUnsafe(),
          "a failed startup read must retain snapshot ownership",
        );
        yield* TestClock.adjust("1 second");
      }
      const startupRecords = yield* Fiber.join(snapshot);
      const newerRecord = {
        ...record,
        commandId: CommandId.make("newer-timeout"),
        clientRequestId: "newer-request",
      };
      if (scenario === "newer_timeout") yield* restarted.recordDelegationTimeout(newerRecord);
      const sweep = yield* restarted
        .sweepDelegationTimeouts(startupRecords)
        .pipe(Effect.forkScoped);
      if (
        (scenario.startsWith("transient_") && scenario !== "transient_startup_read") ||
        scenario === "crash_during_cleanup"
      ) {
        yield* Deferred.await(failedAttempt);
        assert.isUndefined(sweep.pollUnsafe(), "one transient failure must not abandon recovery");
        if (scenario === "transient_retry_saved")
          yield* receipts.upsert({
            commandId,
            threadId: parent,
            commandType: "delegated_task.request",
            acceptedAt: yield* DateTime.now,
            resultSequence: 1,
            status: "accepted",
            error: null,
          });
        yield* TestClock.adjust("1 second");
      }
      yield* Fiber.join(sweep);
      const failed =
        scenario !== "saved" &&
        scenario !== "archived" &&
        scenario !== "missing" &&
        scenario !== "transient_retry_saved";
      assert.equal(
        notifications.length,
        failed ? 1 : 0,
        "recovery must finish without a second sweep or restart",
      );
      yield* restarted.sweepDelegationTimeouts(startupRecords);
      assert.deepEqual(
        yield* receipts.listDelegationTimeouts(),
        scenario === "newer_timeout" ? [newerRecord] : [],
      );
      assert.equal(notifications.length, failed ? 1 : 0);
      assert.equal(
        events.filter((event) => event.detachedOutcomeWake === "sent_after_restart").length,
        failed ? 1 : 0,
      );
      if (scenario === "saved" || scenario === "transient_retry_saved")
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
