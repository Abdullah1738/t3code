import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type OrchestrationV2ThreadProjection,
  RunId,
  TurnItemId,
  ScheduledTaskId,
  CommandId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
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
    Layer.provide(McpProviderSessions.layer),
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
          getThreadListCandidates: () => Effect.succeed([]),
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

it.effect.each(["self", "other"] as const)("waiting for %s reads only run records", (target) =>
  Effect.gen(function* () {
    const recordReads: Array<ReadonlyArray<string>> = [];
    const id = target === "self" ? callerId : targetId;
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const result = yield* mcp.waitForThread(scope, { threadId: id });
      assert.equal(result.status, "idle");
      assert.deepEqual(recordReads, [["runs"]]);
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

it.effect(
  "listThreads filters candidates before hydrating only its page, with the existing order and cursor",
  () =>
    Effect.gen(function* () {
      const shells = Array.from({ length: 123 }, (_, i): OrchestrationV2ThreadShell => ({
        ...liveThreadShell(ThreadId.make(`list-${i}`)),
        title: i % 2 === 0 ? `ÉTAPE ${i}` : `Other ${i}`,
        status: i % 3 === 0 ? "completed" : "idle",
        activityRunStatus: i % 5 === 0 ? "waiting" : null,
        settledOverride: i % 7 === 0 ? "settled" : null,
        lineage: {
          parentThreadId: i % 4 === 0 ? callerId : null,
          relationshipToParent: i % 4 === 0 ? "subagent" : null,
          rootThreadId: callerId,
        },
        visibleItemCount: i + 10,
      }));
      const hydrated: string[][] = [];
      const cases = [
        { input: {}, expected: shells },
        { input: { includeSubagents: false }, expected: shells.filter((_, i) => i % 4 !== 0) },
        {
          input: { statuses: ["waiting" as const] },
          expected: shells.filter((_, i) => i % 5 === 0),
        },
        { input: { statuses: [] }, expected: [] },
        { input: { settled: true }, expected: shells.filter((_, i) => i % 7 === 0) },
        { input: { snoozed: true }, expected: [] },
        { input: { titleContains: "étape" }, expected: shells.filter((_, i) => i % 2 === 0) },
        { input: { titleContains: "" }, expected: shells },
        { input: { cursor: 11, limit: 1 }, expected: shells },
        { input: { cursor: 500 }, expected: shells },
      ];
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        for (const { input, expected } of cases) {
          const sorted = expected.toSorted((a, b) => b.id.localeCompare(a.id));
          const offset = input.cursor ?? 0;
          const page = sorted.slice(offset, offset + (input.limit ?? 50));
          const before = hydrated.length;
          const result = yield* mcp.listThreads(scope, input);
          assert.deepEqual(
            result.threads.map((t) => t.threadId),
            page.map((t) => t.id),
          );
          assert.equal(result.total, expected.length);
          assert.equal(
            result.nextCursor,
            offset + page.length < sorted.length ? offset + page.length : null,
          );
          assert.deepEqual(
            hydrated.slice(before),
            page.length === 0 ? [] : [page.map((t) => t.id)],
          );
          for (const item of result.threads) {
            const shell = shells.find((t) => t.id === item.threadId)!;
            assert.equal(item.itemCount, shell.visibleItemCount);
            assert.equal(item.status, shell.activityRunStatus ?? shell.status);
            assert.equal(item.title, shell.title);
            assert.equal(item.model, shell.modelSelection.model);
          }
        }
      }).pipe(
        Effect.provide(
          layer({
            getCallerRow: () => Effect.succeed(liveThreadShell(callerId)),
            getThreadListCandidates: () => Effect.succeed(shells),
            getShellSnapshot: (options) =>
              Effect.sync(() => {
                const ids = [...(options?.threadIds ?? [])];
                hydrated.push(ids);
                return {
                  schemaVersion: 2,
                  snapshotSequence: 0,
                  threads: shells.filter((shell) => ids.includes(shell.id)),
                  archivedThreads: [],
                };
              }),
          }),
        ),
      );
    }),
);

const listTransitionCases: ReadonlyArray<{
  readonly name: string;
  readonly changed: Partial<OrchestrationV2ThreadShell>;
}> = [
  { name: "status", changed: { status: "completed", activityRunStatus: null } },
  { name: "title", changed: { title: "No longer matches" } },
  { name: "settlement", changed: { settledOverride: "settled" } },
  { name: "snooze", changed: { snoozedUntil: null } },
  {
    name: "lineage",
    changed: {
      lineage: {
        parentThreadId: callerId,
        relationshipToParent: "subagent",
        rootThreadId: callerId,
      },
    },
  },
  { name: "recency", changed: { updatedAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z") } },
  { name: "run identity", changed: { latestRunId: RunId.make("later-run") } },
  {
    name: "model",
    changed: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "later-model" },
    },
  },
];
it.effect.each(listTransitionCases)(
  "listThreads keeps candidate metadata across a $name transition",
  ({ changed }) =>
    Effect.gen(function* () {
      const candidates: OrchestrationV2ThreadShell[] = [
        {
          ...liveThreadShell(ThreadId.make("transition-first")),
          title: "Matching first",
          activityRunStatus: "running",
          latestRunId: RunId.make("original-run"),
          snoozedUntil: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
        },
        {
          ...liveThreadShell(ThreadId.make("transition-second")),
          title: "Matching second",
          activityRunStatus: "running",
          updatedAt: DateTime.makeUnsafe("2025-01-01T00:00:00Z"),
          snoozedUntil: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
        },
      ];
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const result = yield* mcp.listThreads(scope, {
          statuses: ["running"],
          titleContains: "Matching",
          settled: false,
          snoozed: true,
          includeSubagents: false,
        });
        assert.deepEqual(
          result.threads.map((thread) => thread.threadId),
          candidates.map((thread) => thread.id),
        );
        assert.equal(result.total, 2);
        assert.isNull(result.nextCursor);
        for (const [i, item] of result.threads.entries()) {
          const original = candidates[i]!;
          assert.equal(item.status, original.activityRunStatus);
          assert.equal(item.title, original.title);
          assert.isFalse(item.settled);
          assert.isTrue(item.snoozed);
          assert.isNull(item.parentThreadId);
          assert.equal(item.updatedAt, DateTime.formatIso(original.updatedAt));
          assert.equal(item.latestRunId, original.latestRunId);
          assert.equal(item.model, original.modelSelection.model);
          assert.equal(item.itemCount, 700 + i);
        }
      }).pipe(
        Effect.provide(
          layer({
            getCallerRow: () => Effect.succeed(liveThreadShell(callerId)),
            getThreadListCandidates: () => Effect.succeed(candidates),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: candidates.map((shell, i) => ({
                  ...shell,
                  ...(i === 0 ? changed : {}),
                  visibleItemCount: 700 + i,
                })),
                archivedThreads: [],
              }),
          }),
        ),
      );
    }),
);

it.effect.each(
  (
    [
      {
        state: "never_saved",
        message:
          "This delegation was never saved. Retry delegate_task with the same clientRequestId.",
      },
      {
        state: "pending",
        message: "This delegation is still being created; retry task_status with this task id",
      },
      {
        state: "accepted",
        message: "This delegation was saved; its task projection is catching up.",
      },
      { state: "rejected", message: "This delegation was rejected: Parent run ended." },
    ] as const
  ).flatMap((testCase) =>
    [
      `command:mcp:delegate-task:${encodeURIComponent(scope.environmentId)}:${encodeURIComponent(callerId)}:retry`,
      `command:mcp:delegate-task:${encodeURIComponent(scope.environmentId)}:${encodeURIComponent(callerId)}:review%2F%E9%9B%AA%3A1%25`,
      "command:mcp:old%3Acredential:delegate-task:review%2F%E9%9B%AA%3A1%25",
      "command:mcp:delegate-task:environment:caller:retry",
    ].map((command) => ({
      ...testCase,
      command,
      message:
        command === "command:mcp:delegate-task:environment:caller:retry" ||
        (command.startsWith("command:mcp:old") &&
          (testCase.state === "never_saved" || testCase.state === "pending"))
          ? "No delegated task has this id. Expected the taskId returned by delegate_task."
          : testCase.message,
    })),
  ),
)(
  "recovers a missing task from its $state command $command for status and cancel",
  ({ state, message, command }) =>
    Effect.gen(function* () {
      const commandId = CommandId.make(command);
      const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
      const service = yield* OrchestratorMcp.OrchestratorMcpService;
      for (const [name, operation] of [
        ["status", service.taskStatus(scope, taskId).pipe(Effect.asVoid)],
        ["cancel", service.cancelTask(scope, { taskId }).pipe(Effect.asVoid)],
      ] as const) {
        const error = yield* operation.pipe(Effect.flip);
        const creating =
          name === "status" &&
          (state === "pending" || state === "accepted") &&
          !message.startsWith("No delegated");
        assert.equal(error.code, creating ? "task_creating" : "task_not_found");
        assert.include(error.message, message);
        if (creating) assert.notInclude(error.message, "No delegated task has this id.");
        else assert.isTrue(error.message.startsWith("No delegated task has this id."));
      }
    }).pipe(
      Effect.provide(
        layer({
          getCallerRow: () => Effect.succeed(liveThreadShell(callerId)),
          getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(callerId))),
          getDelegationCommandState: (commandId) =>
            Effect.succeed(
              state === "accepted" || state === "rejected"
                ? {
                    commandId,
                    threadId: callerId,
                    commandType: "delegated_task.request",
                    acceptedAt: DateTime.makeUnsafe(0),
                    resultSequence: 0,
                    status: state,
                    error: state === "rejected" ? "Parent run ended." : null,
                  }
                : { status: state },
            ),
        }),
      ),
    ),
);

it.effect.each([
  "node:unrelated",
  "node:delegated-task:%ZZ",
  "node:delegated-task:command%3Amcp%3Abad",
  "node:delegated-task:command%3Amcp%3Adelegate-task%3Aa%3Ab%3Ac%3Ad",
])("does not look up a receipt for malformed task id %s", (id) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcp.OrchestratorMcpService;
    const error = yield* service.taskStatus(scope, NodeId.make(id)).pipe(Effect.flip);
    assert.equal(error.code, "task_not_found");
    assert.notInclude(error.message, "never saved");
  }).pipe(
    Effect.provide(
      layer({
        getCallerRow: () => Effect.succeed(liveThreadShell(callerId)),
        getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(callerId))),
      }),
    ),
  ),
);

it.effect("does not expose another parent's rejection reason", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcp.OrchestratorMcpService;
    const commandId = CommandId.make("command:mcp:old-credential:delegate-task:retry");
    const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
    const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
    assert.equal(error.code, "task_not_found");
    assert.notInclude(error.message, "private reason");
  }).pipe(
    Effect.provide(
      layer({
        getCallerRow: () => Effect.succeed(liveThreadShell(callerId)),
        getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(callerId))),
        getDelegationCommandState: (commandId) =>
          Effect.succeed({
            commandId,
            threadId: targetId,
            commandType: "delegated_task.request",
            acceptedAt: DateTime.makeUnsafe(0),
            resultSequence: 0,
            status: "rejected",
            error: "private reason",
          }),
      }),
    ),
  ),
);
