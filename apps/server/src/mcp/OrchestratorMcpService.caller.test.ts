import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestratorMcpFailure,
  type ScheduledTask,
  type OrchestrationV2ThreadProjection,
  RunId,
  TurnItemId,
  ScheduledTaskId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";

const callerId = ThreadId.make("caller:light");
const targetId = ThreadId.make("target:light");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:light"),
  requestNamespace: "light-caller",
  thread: {
    threadId: callerId,
    providerSessionId: "session:light",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const layer = (
  threads: Partial<ThreadManagement.ThreadManagementService["Service"]>,
  schedules: Partial<ScheduledTasks.ScheduledTaskService["Service"]> = {},
) =>
  OrchestratorMcp.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)(threads),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)(schedules),
        ServerSettings.layerTest(),
      ),
    ),
  );

it.effect("capabilities and listings read caller limits and selection without any records", () =>
  Effect.gen(function* () {
    let recordReads = 0;
    const shell = liveThreadShell(callerId, {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const capabilities = yield* mcp.capabilities(scope);
      assert.equal(capabilities.parentThreadId, callerId);
      assert.equal(capabilities.inheritedModel, shell.modelSelection.model);
      assert.equal(capabilities.runtimeMode, "approval-required");
      assert.equal(capabilities.interactionMode, "plan");
      const listed = yield* mcp.listThreads(scope, {});
      assert.equal(listed.currentThreadId, callerId);
      assert.equal(recordReads, 0);
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: () => Effect.succeed(shell),
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: () =>
            Effect.sync(() => {
              recordReads++;
              return idleThreadProjection(shell);
            }),
          listProjectThreads: () => Effect.succeed([]),
        }),
      ),
    );
  }),
);

it.effect.each(["missing", "deleted"] as const)(
  "rejects a %s caller before reading records",
  (state) =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const calls: ReadonlyArray<Effect.Effect<void, OrchestratorMcpFailure>> = [
        mcp.capabilities(scope).pipe(Effect.asVoid),
        mcp.listThreads(scope, {}).pipe(Effect.asVoid),
        mcp.delegateTask(scope, { task: "test", mode: "async" }).pipe(Effect.asVoid),
        mcp.requestSecret(scope, { label: "Test", reason: "Test" }).pipe(Effect.asVoid),
        mcp.createThreads(scope, { threads: [{ title: "Test" }] }).pipe(Effect.asVoid),
        mcp.readThread(scope, { threadId: targetId }).pipe(Effect.asVoid),
        mcp.sendToThread(scope, { threadId: targetId, message: "test" }).pipe(Effect.asVoid),
        mcp.interruptThread(scope, { threadId: targetId }).pipe(Effect.asVoid),
        mcp.waitForThread(scope, { threadId: targetId }).pipe(Effect.asVoid),
      ];
      for (const call of calls) {
        const error = yield* Effect.flip(call);
        assert.equal(error.code, "thread_not_found");
      }
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: () =>
            Effect.succeed(
              state === "missing"
                ? null
                : {
                    ...liveThreadShell(callerId),
                    deletedAt: liveThreadShell(callerId).createdAt,
                  },
            ),
          getThreadShell: () =>
            Effect.succeed(
              state === "missing"
                ? null
                : {
                    ...liveThreadShell(callerId),
                    deletedAt: liveThreadShell(callerId).createdAt,
                  },
            ),
        }),
      ),
    ),
);

it.effect("reading an unrelated target does not load caller records", () =>
  Effect.gen(function* () {
    const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
    const read = yield* mcp.readThread(scope, { threadId: targetId });
    assert.equal(read.thread.threadId, targetId);
  }).pipe(
    Effect.provide(
      layer({
        getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        getThreadRecords: (id) => Effect.die(`Unexpected record read: ${id}`),
        getProjectThreadRecords: ({ threadId }, fields) => {
          assert.deepEqual(Array.from(fields, String), [
            "runs",
            "runtimeRequests",
            "contextTransfers",
          ]);
          return Effect.succeed(idleThreadProjection(liveThreadShell(threadId)));
        },
        getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
      }),
    ),
  ),
);

it.effect.each(["foreign", "native"] as const)(
  "rejects a %s task without reading its child",
  (kind) =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const error = yield* mcp.taskStatus(scope, NodeId.make("task:foreign")).pipe(Effect.flip);
      assert.equal(error.code, "task_not_found");
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: (id, fields) => {
            assert.equal(id, callerId);
            assert.deepEqual(Array.from(fields, String), ["runs", "subagents", "contextTransfers"]);
            const projection = idleThreadProjection(liveThreadShell(id));
            return Effect.succeed({
              ...projection,
              subagents: [
                {
                  id: NodeId.make("task:foreign"),
                  threadId: kind === "foreign" ? targetId : callerId,
                  origin: kind === "native" ? "provider_native" : "app_owned",
                  childThreadId: targetId,
                },
              ],
            } as unknown as typeof projection);
          },
        }),
      ),
    ),
);

it.effect("bounds a stalled caller shell before loading any records", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const call = yield* mcp.capabilities(scope).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(call);
      assert.equal(error.code, "caller_unresolved");
      assert.include(error.message, "caller");
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          getThreadShell: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
  }),
);

it.effect.each(["self", "other"] as const)("loads the full scoped target only for %s", (target) =>
  Effect.gen(function* () {
    const recordReads: Array<ReadonlyArray<string>> = [];
    const id = target === "self" ? callerId : targetId;
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const result = yield* mcp.waitForThread(scope, { threadId: id });
      assert.equal(result.status, "idle");
      assert.deepEqual(recordReads, [
        ...(target === "self"
          ? [
              [
                "runs",
                "messages",
                "subagents",
                "providerThreads",
                "providerTurns",
                "runtimeRequests",
                "contextTransfers",
                "turnItems",
              ],
            ]
          : []),
        ["runs"],
      ]);
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadRecords: (threadId, fields) => {
            recordReads.push(Array.from(fields, String));
            return Effect.succeed(idleThreadProjection(liveThreadShell(threadId)));
          },
          getProjectThreadRecords: ({ threadId }, fields) => {
            assert.equal(threadId, targetId);
            assert.deepEqual(Array.from(fields, String), []);
            return Effect.succeed(idleThreadProjection(liveThreadShell(threadId)));
          },
          waitForThread: ({ threadId }) => Effect.succeed({ threadId, run: null, timedOut: false }),
        }),
      ),
    );
  }),
);

it.effect.each([0, 3])(
  "reads live caller runs at most once when listing %s scheduled tasks",
  (count) =>
    Effect.gen(function* () {
      const shell = liveThreadShell(callerId);
      let runReads = 0;
      const tasks = Array.from(
        { length: count },
        (_, index) =>
          ({
            id: ScheduledTaskId.make(`schedule:${index}`),
            title: "Test",
            prompt: "Test",
            enabled: true,
            schedule: { type: "webhook" as const, signature: null },
            projectId: shell.projectId,
            threadId: null,
            workspaceStrategy: { type: "root" as const },
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdBy: "agent" as const,
            creationSource: "mcp" as const,
            createdAt: "2026-11-13T00:00:00Z",
            updatedAt: "2026-11-13T00:00:00Z",
            nextRunAt: null,
            lastRunAt: null,
            lastRunStatus: "never" as const,
            lastRunError: null,
            runCount: 0,
            webhook: {
              path: "/hooks/test",
              url: "https://example.test/hooks/test",
              hasSecret: false,
            },
          }) satisfies ScheduledTask,
      );
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const result = yield* mcp.listScheduledTasks(scope, {});
        assert.equal(result.tasks.length, count);
        assert.equal(runReads, count === 0 ? 0 : 1);
        for (const task of result.tasks) assert.equal(task.webhookUrl, tasks[0]?.webhook.url);
      }).pipe(
        Effect.provide(
          layer(
            {
              getCallerRow: () => Effect.succeed(shell),
              getThreadShell: () => Effect.succeed(shell),
              getThreadRecords: (id, fields) => {
                assert.equal(id, callerId);
                assert.deepEqual(Array.from(fields, String), ["runs"]);
                runReads++;
                return Effect.succeed(idleThreadProjection(shell));
              },
            },
            { list: () => Effect.succeed({ tasks }) },
          ),
        ),
      );
    }),
);

it.effect.each([
  { name: "empty page", rows: false, textOffset: 0, matchingRun: true, ownSource: true },
  { name: "continuation offset", rows: true, textOffset: 12, matchingRun: true, ownSource: true },
  { name: "no matching run", rows: true, textOffset: 0, matchingRun: false, ownSource: true },
  { name: "inherited source", rows: true, textOffset: 0, matchingRun: true, ownSource: false },
])("does not load caller acknowledgement records for $name", (testCase) =>
  Effect.gen(function* () {
    const shell = liveThreadShell(targetId);
    const runId = RunId.make("run:visible");
    const projection = {
      ...idleThreadProjection(shell),
      thread: {
        ...idleThreadProjection(shell).thread,
        lineage: {
          rootThreadId: callerId,
          parentThreadId: callerId,
          relationshipToParent: "subagent",
        },
      },
      runs: [{ id: runId, ordinal: 1, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const items = testCase.rows
      ? ([
          {
            position: 0,
            visibility: "normal",
            sourceThreadId: testCase.ownSource ? targetId : callerId,
            sourceItemId: TurnItemId.make("item:visible"),
            item: {
              type: "notification",
              runId: testCase.matchingRun ? runId : RunId.make("run:other"),
              status: "completed",
              title: "Result",
              summary: "Result",
              updatedAt: shell.updatedAt,
            },
          },
        ] as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"])
      : [];
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const read = yield* mcp.readThread(scope, {
        threadId: targetId,
        runLimit: 0,
        itemId: TurnItemId.make("item:visible"),
        textOffset: testCase.textOffset,
      });
      assert.equal(read.items.length, items.length);
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getThreadRecords: (id) => Effect.die(`Unexpected acknowledgement records for ${id}`),
          getTimelinePage: () =>
            Effect.succeed({ items, totalItems: items.length, hasMore: false }),
        }),
      ),
    );
  }),
);
