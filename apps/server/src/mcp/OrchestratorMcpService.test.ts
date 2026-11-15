import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Clock from "effect/Clock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  type ModelSelection,
  type OrchestratorMcpFailure,
  NodeId,
  OrchestratorMcpTarget,
  OrchestratorMcpDelegateTaskResult,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  SecretRef,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { stalledSummary } from "../orchestration-v2/delegatedTaskProgress.ts";
import {
  codexFailureCategory,
  CodexProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { mapCodexModelCapabilities } from "../provider/CodexProvider.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { McpCall } from "../ardud/analytics/McpCall.ts";

const decodeTarget = Schema.decodeUnknownEffect(OrchestratorMcpTarget);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const encodeDelegateTaskResult = Schema.encodeSync(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskResult),
);
const decodeLegacyDelegateTaskResult = Schema.decodeUnknownSync(
  OrchestratorMcpDelegateTaskResult.mapFields(
    ({ selectionRouting: _routing, ...fields }) => fields,
  ),
);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const captureSpans = () => {
  const ended: Array<{
    name: string;
    spanId: string;
    parentSpanId: string | undefined;
    attributes: Record<string, unknown>;
  }> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        ended.push({
          name: span.name,
          spanId: span.spanId,
          parentSpanId: Option.getOrUndefined(span.parent)?.spanId,
          attributes: Object.fromEntries(span.attributes),
        });
      };
      return span;
    },
  });
  return { ended, tracer };
};

describe("OrchestratorMcpService", () => {
  it.effect.each([
    { status: "failed", code: "cyberPolicy", category: "content_filter", partial: false },
    { status: "failed", code: "serverOverloaded", category: "transient", partial: false },
    { status: "failed", code: "cyberPolicy", category: "content_filter", partial: true },
    { status: "failed", code: "serverOverloaded", category: "transient", partial: true },
    { status: "failed", code: null, category: "unknown", partial: false },
    { status: "completed", code: "cyberPolicy", category: null, partial: false },
    { status: "running", code: "cyberPolicy", category: null, partial: false },
    { status: "cancelled", code: "cyberPolicy", category: null, partial: false },
    { status: "interrupted", code: "cyberPolicy", category: null, partial: false },
    {
      status: "failed",
      code: "serverOverloaded",
      category: "transient",
      partial: false,
      continuation: true,
    },
    { status: "running", code: "cyberPolicy", category: null, partial: false, continuation: true },
    {
      status: "completed",
      code: "cyberPolicy",
      category: null,
      partial: false,
      continuation: true,
    },
    {
      status: "failed",
      code: "cyberPolicy",
      category: "content_filter",
      partial: false,
      stalled: true,
    },
  ] as const)(
    "reports normalized task failure only for failed tasks ($status, $code, partial=$partial)",
    (testCase) =>
      Effect.gen(function* () {
        const { status, code, category, partial } = testCase;
        const continuation = "continuation" in testCase;
        const stalled = "stalled" in testCase;
        const parentThreadId = ThreadId.make("failure-parent");
        const childThreadId = ThreadId.make("failure-child");
        const taskId = NodeId.make("failure-task");
        const runId = RunId.make("failure-run");
        const rootNodeId = NodeId.make("failure-root");
        const at = DateTime.makeUnsafe("2026-11-13T00:00:00Z");
        const blocked = yield* Deferred.make<void>();
        const never = yield* Deferred.make<never>();
        const providerFailure = makeProviderFailure({
          message: `Provider refused Authorization: Bearer test-private-token ${continuation ? "please retry" : "detail ".repeat(400)}`,
          code,
          category: codexFailureCategory(code, code),
          retryable: code === "serverOverloaded",
        });
        // Records written before categories existed decode with category unknown.
        const { category: _category, ...legacyFailure } = providerFailure;
        const parent = {
          ...idleThreadProjection(liveThreadShell(parentThreadId)),
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              status,
              result: status === "running" ? null : "Task ended.",
              completionDelivery: { state: "acknowledged" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const errorItem = {
          id: "error:root",
          runId,
          nodeId: rootNodeId,
          ordinal: 1,
          type: "error",
          status: "failed",
          updatedAt: at,
          failure: code === null ? legacyFailure : providerFailure,
        };
        const child = {
          ...idleThreadProjection(liveThreadShell(childThreadId)),
          runs: [
            ...(continuation
              ? [
                  {
                    id: RunId.make("failure-original"),
                    delegatedTaskId: taskId,
                    rootNodeId,
                    ordinal: 1,
                    status: "failed",
                    startedAt: at,
                    completedAt: at,
                  },
                ]
              : []),
            {
              id: runId,
              delegatedTaskId: taskId,
              rootNodeId,
              ordinal: continuation ? 2 : 1,
              status,
              startedAt: at,
              completedAt: status === "running" ? null : at,
              ...(stalled
                ? {
                    delegatedTaskStall: {
                      idleTimeoutMs: 60_000,
                      lastProgressAt: at,
                      lastProgressKind: "assistant_text",
                    },
                  }
                : {}),
            },
          ],
          turnItems: [
            ...(continuation
              ? [
                  {
                    ...errorItem,
                    id: "error:original",
                    runId: "failure-original",
                    failure: makeProviderFailure({
                      message: "Original run refused",
                      category: "content_filter",
                    }),
                  },
                ]
              : []),
            errorItem,
            {
              ...errorItem,
              id: "error:nested",
              ordinal: 2,
              nodeId: "nested-node",
              failure: makeProviderFailure({ message: "Nested failure", category: "config" }),
            },
            {
              ...errorItem,
              id: "error:other",
              ordinal: 3,
              runId: "unrelated-run",
              failure: makeProviderFailure({
                message: "Other run failed",
                category: "auth_expired",
              }),
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
            getThreadRecords: (id, fields, filter) => {
              if (id === childThreadId && filter?.messageRoles?.includes("user")) {
                assert.isTrue(fields?.some((field) => field === "turnItems"));
                assert.deepEqual(filter.turnItemTypes, ["error"]);
              }
              if (partial && id === childThreadId && filter?.messageRoles?.includes("assistant")) {
                return Deferred.succeed(blocked, undefined).pipe(
                  Effect.andThen(Deferred.await(never)),
                );
              }
              return Effect.succeed(id === parentThreadId ? parent : child);
            },
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const read = yield* service
            .taskStatus(
              {
                environmentId: EnvironmentId.make("failure-env"),
                requestNamespace: "failure",
                thread: {
                  threadId: parentThreadId,
                  providerSessionId: "failure",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration"]),
                issuedAt: 1,
              },
              taskId,
            )
            .pipe(Effect.forkChild);
          if (partial) {
            yield* Deferred.await(blocked);
            yield* TestClock.adjust("10 seconds");
          }
          const result = yield* Fiber.join(read);
          assert.equal(result.partial, partial);
          assert.equal(result.status, status);
          if (category === null) {
            assert.isUndefined(result.failure);
          } else {
            assert.deepEqual(result.failure, {
              category,
              code: providerFailure.code,
              message: providerFailure.message.slice(0, 2_000),
              retryable: code === "serverOverloaded",
            });
            assert.equal(
              result.failure!.message.length,
              Math.min(2_000, providerFailure.message.length),
            );
            assert.include(result.failure!.message, "[REDACTED]");
            assert.notInclude(result.failure!.message, "test-private-token");
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("a terminal stalled run is reported correctly before parent finalization", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("stall-race-parent");
      const childThreadId = ThreadId.make("stall-race-child");
      const taskId = NodeId.make("stall-race-task");
      const runId = RunId.make("stall-race-run");
      const at = DateTime.makeUnsafe("2026-11-12T01:00:00Z");
      const acknowledgements: Array<string> = [];
      const acknowledged = yield* Deferred.make<void>();
      const parent = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "test",
            result: null,
            status: "running",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const child = {
        thread: { id: childThreadId },
        contextTransfers: [],
        runtimeRequests: [],
        providerThreads: [],
        providerTurns: [],
        subagents: [],
        turnItems: [],
        runs: [
          {
            id: runId,
            ordinal: 1,
            delegatedTaskId: taskId,
            status: "interrupted",
            startedAt: at,
            completedAt: at,
            delegatedTaskStall: {
              idleTimeoutMs: 60_000,
              lastProgressAt: at,
              lastProgressKind: "assistant_text",
            },
          },
        ],
        messages: [
          {
            id: MessageId.make("partial"),
            runId,
            role: "assistant",
            text: "Partial work",
            createdAt: at,
            updatedAt: at,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadRecords: (id) => Effect.succeed(id === parentThreadId ? parent : child),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: (command) =>
            Effect.sync(() => {
              acknowledgements.push(command.type);
            }).pipe(
              Effect.andThen(Deferred.succeed(acknowledged, undefined)),
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.taskStatus(
          {
            environmentId: EnvironmentId.make("stall-race-env"),
            requestNamespace: "stall-race",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "stall-race",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          },
          taskId,
        );
        assert.equal(result.status, "failed");
        assert.equal(result.failureReason, "stalled");
        assert.deepEqual(result.failure, {
          category: "unknown",
          code: null,
          message: stalledSummary(child.runs[0]!.delegatedTaskStall!, null),
          retryable: null,
        });
        assert.equal(result.latestTerminalStatus, "failed");
        assert.match(result.summary!, /^Stalled:/);
        assert.include(result.summary!, "Partial work");
        assert.equal(result.lastProgressAt, DateTime.formatIso(at));
        yield* Deferred.await(acknowledged);
        assert.deepEqual(acknowledgements, ["delegated_task.completion-delivery.acknowledge"]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    { finish: "stop", followup: null, incomplete: false },
    { finish: "length", followup: null, incomplete: true },
    { finish: "length", followup: "stop", incomplete: true },
    { finish: "stop", followup: "length", incomplete: false },
    { finish: "end_turn", followup: null, incomplete: false },
    { finish: "stop_sequence", followup: null, incomplete: false },
    { finish: "max_tokens", followup: null, incomplete: true },
    { finish: "end_turn", followup: "length", incomplete: false },
    { finish: "length", followup: "end_turn", incomplete: true },
    { finish: "stop_sequence", followup: "length", incomplete: false },
    { finish: "length", followup: "stop_sequence", incomplete: true },
  ] as const)(
    "reports incomplete metadata for stored finish=$finish with followup=$followup",
    ({ finish, followup, incomplete }) =>
      Effect.gen(function* () {
        const parentId = ThreadId.make("parent:incomplete");
        const childId = ThreadId.make("child:incomplete");
        const taskId = NodeId.make("task:incomplete");
        const runId = RunId.make("run:incomplete");
        const attemptId = RunAttemptId.make("attempt:incomplete");
        const now = DateTime.makeUnsafe("2026-11-05T17:52:25Z");
        const nativeClaude =
          finish === "end_turn" || finish === "stop_sequence" || finish === "max_tokens";
        const childInstanceId = ProviderInstanceId.make(nativeClaude ? "claudeAgent" : "codex");
        const childModel = nativeClaude ? "claude-haiku-5-5" : "gpt-5.4";
        const storedResult = incomplete
          ? "[Result looks incomplete: original output limit]\nOriginal answer."
          : "Original answer.";
        let parent = {
          ...idleThreadProjection(liveThreadShell(parentId)),
          subagents: [
            {
              id: taskId,
              threadId: parentId,
              origin: "app_owned",
              childThreadId: childId,
              providerInstanceId: childInstanceId,
              model: childModel,
              status: "completed",
              result: followup === null ? null : storedResult,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        let child = {
          ...idleThreadProjection(liveThreadShell(childId)),
          runs: [
            {
              id: runId,
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
              modelSelection: { instanceId: childInstanceId, model: childModel },
              activeAttemptId: attemptId,
              rootNodeId: NodeId.make("root:incomplete"),
            },
          ],
          messages: [
            {
              id: MessageId.make("answer:incomplete"),
              runId,
              role: "assistant",
              phase: "answer",
              text: "All checks passed.",
              createdAt: now,
              updatedAt: now,
            },
          ],
          providerTurns: [
            {
              id: ProviderTurnId.make("turn:incomplete"),
              providerThreadId: ProviderThreadId.make("child:incomplete"),
              runAttemptId: attemptId,
              ordinal: 1,
              finish,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        if (followup !== null) {
          parent = {
            ...parent,
            contextTransfers: [
              {
                id: "transfer:original",
                type: "subagent_result",
                sourceThreadId: childId,
                targetThreadId: parentId,
                sourcePoint: { runId },
              },
            ] as unknown as OrchestrationV2ThreadProjection["contextTransfers"],
          };
          const laterRunId = RunId.make("run:followup");
          const laterAttempt = RunAttemptId.make("attempt:followup");
          child = {
            ...child,
            runs: [
              ...child.runs,
              {
                ...child.runs[0]!,
                id: laterRunId,
                ordinal: 2,
                activeAttemptId: laterAttempt,
                startedAt: DateTime.add(now, { seconds: 1 }),
                completedAt: DateTime.add(now, { seconds: 2 }),
              },
            ],
          };
          child = {
            ...child,
            messages: [
              ...child.messages,
              { ...child.messages[0]!, id: MessageId.make("later"), runId: laterRunId },
            ],
          };
          child = {
            ...child,
            providerTurns: [
              ...child.providerTurns,
              {
                ...child.providerTurns[0]!,
                id: ProviderTurnId.make("turn:followup"),
                runAttemptId: laterAttempt,
                ordinal: 2,
                finish: followup,
              },
            ],
          };
        }
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadRecords: (id, fields) => {
              const requestedFields: ReadonlyArray<string> = fields;
              if (id === childId && requestedFields.includes("runs"))
                assert.isTrue(requestedFields.includes("providerTurns"));
              return Effect.succeed(id === parentId ? parent : child);
            },
            delegatedTaskResultPending: () => Effect.succeed(false),
            dispatch: () => Effect.succeed({} as never),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.taskStatus(
            {
              environmentId: EnvironmentId.make("incomplete"),
              requestNamespace: "incomplete",
              thread: {
                threadId: parentId,
                providerSessionId: "incomplete",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            },
            taskId,
          );
          assert.equal(result.status, "completed");
          assert.equal(result.resultLooksIncomplete, incomplete);
          if (followup !== null) assert.equal(result.summary, storedResult);
          if (incomplete) {
            assert.include(
              result.incompleteReason!,
              finish === "length" ? "output limit (finish=length)" : `finish=${finish}`,
            );
            assert.isTrue(result.summary!.startsWith("[Result looks incomplete:"));
          } else {
            assert.equal(result.summary, followup === null ? "All checks passed." : storedResult);
            assert.isUndefined(result.incompleteReason);
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("returns task status while the acknowledgement command queue is blocked", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const commandQueued = yield* Deferred.make<void>();
      const releaseQueue = yield* Deferred.make<void>();
      const commandFailed = yield* Deferred.make<void>();
      const commandRetried = yield* Deferred.make<void>();
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [],
        turnItems: [],
        providerTurns: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Deferred.succeed(commandQueued, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseQueue)),
                      Effect.andThen(Deferred.succeed(commandFailed, undefined)),
                      Effect.andThen(
                        Effect.fail(new Error("simulated acknowledgement failure") as never),
                      ),
                    )
                  : Deferred.succeed(commandRetried, undefined).pipe(Effect.as({} as never)),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const reading = yield* service
          .taskStatus(scope, taskId)
          .pipe(Effect.timeoutOption("1 second"), Effect.forkChild);
        yield* Deferred.await(commandQueued);
        yield* TestClock.adjust("1 second");
        const observed = yield* Fiber.join(reading);
        assert.isFalse(yield* Deferred.isDone(releaseQueue));
        yield* Deferred.succeed(releaseQueue, undefined);
        assert.isTrue(
          Option.isSome(observed),
          "status must return while the command queue is held",
        );
        if (Option.isNone(observed)) return;
        assert.equal(observed.value.status, "completed");
        assert.equal(observed.value.partial, false);
        assert.notProperty(observed.value, "stoppedAt");
        assert.notProperty(observed.value, "retryHint");
        assert.isNull(observed.value.currentRunId);
        assert.isNull(observed.value.currentRunStatus);
        yield* Deferred.await(commandFailed);
        const result = yield* service.taskStatus(scope, taskId);
        yield* Deferred.await(commandRetried);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    { blockedStage: "caller", stalled: false },
    { blockedStage: "parent", stalled: false },
    { blockedStage: "controls", stalled: false },
    { blockedStage: "result", stalled: false },
    { blockedStage: "restart", stalled: false },
    { blockedStage: "result", stalled: true },
    { blockedStage: "restart", stalled: true },
  ] as const)(
    "returns only available fields at the task_status deadline during $blockedStage read (stalled=$stalled)",
    ({ blockedStage, stalled }) =>
      Effect.gen(function* () {
        const { ended, tracer } = captureSpans();
        const parentThreadId = ThreadId.make("thread:deadline-parent");
        const childThreadId = ThreadId.make("thread:deadline-child");
        const taskId = NodeId.make("node:deadline-task");
        const blocked = yield* Deferred.make<void>();
        const never = yield* Deferred.make<never>();
        let reads = 0;
        const wait = Deferred.succeed(blocked, undefined).pipe(
          Effect.andThen(Deferred.await(never)),
        );
        const at = yield* DateTime.now;
        const parent = {
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              status: "running",
              result: null,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const child = {
          thread: { id: childThreadId },
          runs: [
            {
              id: RunId.make("run:deadline"),
              delegatedTaskId: taskId,
              ordinal: 1,
              status: stalled ? "interrupted" : "cancelled",
              ...(stalled
                ? {
                    delegatedTaskStall: {
                      idleTimeoutMs: 60_000,
                      lastProgressAt: at,
                      lastProgressKind: "assistant_text",
                    },
                  }
                : {}),
            },
          ],
          messages: [],
          contextTransfers: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) =>
              blockedStage === "caller" ? wait : Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) =>
              blockedStage === "caller" ? wait : Effect.succeed(liveThreadShell(threadId)),
            getThreadRecords: (threadId, _fields, _filter, options) => {
              assert.equal(options?.projectionOnly, true);
              const stage = ++reads === 1 ? "parent" : reads === 2 ? "controls" : "result";
              return stage === blockedStage
                ? wait
                : Effect.succeed(threadId === parentThreadId ? parent : child);
            },
            delegatedTaskResultPending: () =>
              blockedStage === "restart" ? wait : Effect.succeed(false),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const scope: McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:deadline"),
            requestNamespace: "deadline",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "deadline",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const read = yield* service.taskStatus(scope, taskId).pipe(Effect.forkChild);
          yield* Deferred.await(blocked);
          yield* TestClock.adjust("10 seconds");
          const result = yield* Fiber.join(read);
          const attributes = ended.find(
            (span) => span.name === "OrchestratorMcpService.taskStatus",
          )!.attributes;
          const traceStage =
            blockedStage === "parent"
              ? "parent_records"
              : blockedStage === "controls"
                ? "child_records"
                : blockedStage === "restart"
                  ? "pending_result"
                  : blockedStage;
          assert.equal(attributes["t3.task.result"], "partial");
          assert.equal(attributes["t3.task.stage"], traceStage);
          assert.equal(attributes[`t3.task.stage_ms.${traceStage}`], 10_000);
          assert.equal(result.partial, true);
          assert.equal(result.taskId, taskId);
          if (result.partial !== true) return;
          const stoppedAt =
            blockedStage === "caller"
              ? "caller"
              : blockedStage === "parent"
                ? "parent_records"
                : blockedStage === "controls"
                  ? "child_records"
                  : "result";
          assert.equal(result.stoppedAt, stoppedAt);
          assert.include(result.retryHint, `read stopped at ${stoppedAt}`);
          assert.include(result.retryHint, "The task itself is unaffected");
          assert.include(result.retryHint, "Retry task_status in a few seconds");
          assert.equal(
            result.retryHint.includes("t3_thread_read"),
            !["caller", "parent"].includes(blockedStage),
          );
          assert.equal(
            result.childThreadId,
            ["caller", "parent"].includes(blockedStage) ? undefined : childThreadId,
          );
          assert.equal(
            result.latestTerminalStatus,
            ["result", "restart"].includes(blockedStage)
              ? stalled
                ? "failed"
                : "cancelled"
              : undefined,
          );
          assert.equal(
            result.status,
            blockedStage === "result" ? (stalled ? "failed" : "cancelled") : undefined,
          );
          if (blockedStage === "result" && stalled) {
            assert.deepEqual(result.failure, {
              category: "unknown",
              code: null,
              message: stalledSummary(child.runs[0]!.delegatedTaskStall!, null),
              retryable: null,
            });
          } else {
            assert.isUndefined(result.failure);
          }
          assert.isUndefined(result.summary);
        }).pipe(
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
          Effect.withTracer(tracer),
        );
      }),
  );

  it.effect.each(["active_continuation", "recut_nested", "recut_native"] as const)(
    "preserves delegated work through restart for %s",
    (scenario) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
        const childThreadId = ThreadId.make("thread:mcp-restart-child");
        const taskId = NodeId.make("node:mcp-restart-task");
        const dispatched = yield* Ref.make(0);
        const now = yield* DateTime.now;
        let awaitsRestart = true;
        let readFails = true;
        const parentProjection = {
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: "running",
              result: null,
              completionDelivery: { state: "pending" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        let childProjection = {
          thread: { id: childThreadId },
          runs: [
            {
              id: RunId.make("run:mcp-restart-child"),
              ordinal: 1,
              status: "cancelled",
              delegatedTaskId: taskId,
            },
            { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
            { id: RunId.make("run:mcp-restart-queued"), ordinal: 3, status: "queued" },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        if (scenario !== "active_continuation") {
          childProjection = {
            ...childProjection,
            runs: [
              { ...childProjection.runs[0]!, status: "completed", startedAt: now },
              {
                ...childProjection.runs[0]!,
                id: RunId.make("run:mcp-recut"),
                ordinal: 2,
                status: "cancelled",
                startedAt: null,
                restartContinuationOfRunId: childProjection.runs[0]!.id,
              },
            ],
            subagents: scenario === "recut_nested" ? [{ status: "running" } as never] : [],
            providerThreads:
              scenario === "recut_native" ? [{ pendingBackgroundTasks: [{}] } as never] : [],
          };
        }
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
            delegatedTaskResultPending: () =>
              readFails
                ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
                : Effect.succeed(awaitsRestart),
            dispatch: () =>
              Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-restart"),
          requestNamespace: "provider-session:mcp-restart",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-restart",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          if (scenario === "active_continuation") {
            const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
            assert.equal(failed.code, "orchestration_error");
            assert.equal(yield* Ref.get(dispatched), 0);
          }
          readFails = false;
          const held = yield* service.taskStatus(scope, taskId);
          assert.equal(held.status, "running");
          assert.equal(
            held.workState,
            scenario === "active_continuation" ? "working" : "waiting_for_children",
          );
          assert.equal(held.childRunId, RunId.make("run:mcp-restart-child"));
          assert.equal(
            held.currentRunId,
            scenario === "active_continuation" ? RunId.make("run:mcp-restart-later") : null,
          );
          assert.equal(
            held.currentRunStatus,
            scenario === "active_continuation" ? "running" : null,
          );
          assert.equal(
            held.latestTerminalStatus,
            scenario === "active_continuation" ? "cancelled" : "completed",
          );
          assert.equal(held.hasPendingChildRuns, scenario === "active_continuation");
          assert.isNull(held.summary);
          assert.equal(yield* Ref.get(dispatched), 0);
          awaitsRestart = false;
          const settled = yield* service.taskStatus(scope, taskId);
          if (scenario === "active_continuation") {
            assert.equal(settled.status, "cancelled");
          } else {
            assert.equal(settled.status, "running");
            assert.equal(settled.workState, "waiting_for_children");
            childProjection = { ...childProjection, subagents: [], providerThreads: [] };
            const finished = yield* service.taskStatus(scope, taskId);
            assert.equal(finished.status, "cancelled");
            assert.equal(finished.workState, "result_available");
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect.each(
    (["cancelled", "interrupted", "failed"] as const).flatMap((status) =>
      (["linked", "legacy", "missing_spawn_target"] as const).map((link) => ({ status, link })),
    ),
  )("reads an unsettled old task as $status with $link run lookup", ({ status, link }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:old-task-parent");
      const childThreadId = ThreadId.make("thread:old-task-child");
      const taskId = NodeId.make("node:old-task");
      const now = yield* DateTime.now;
      const parent = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-6.1-sol",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const child = {
        thread: { id: childThreadId },
        runs: [
          {
            id: RunId.make("run:old-task"),
            ordinal: 1,
            status,
            startedAt: now,
            completedAt: now,
            ...(link === "linked" ? { delegatedTaskId: taskId } : {}),
          },
        ],
        contextTransfers:
          link === "missing_spawn_target"
            ? [
                {
                  type: "subagent_spawn",
                  sourceThreadId: parentThreadId,
                  targetThreadId: childThreadId,
                  targetRunId: null,
                },
              ]
            : [],
        messages: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: (id) => Effect.succeed(id === parentThreadId ? parent : child),
          delegatedTaskResultPending: () => Effect.succeed(false),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.taskStatus(
          {
            environmentId: EnvironmentId.make("environment:old-task"),
            requestNamespace: "old-task",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "old-task",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          },
          taskId,
        );
        assert.equal(result.status, status);
        assert.equal(result.workState, "result_available");
        assert.isNull(result.currentRunId);
        assert.equal(result.latestTerminalStatus, status);
        assert.isFalse(result.hasPendingChildRuns);
        assert.equal(result.childRunId, link === "missing_spawn_target" ? null : child.runs[0]!.id);
        assert.isNotNull(result.summary);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([false, true])(
    "settles a run-less restart task with continuation pending=%s",
    (continuationPending) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
        const childThreadId = ThreadId.make("thread:mcp-restart-child");
        const taskId = NodeId.make("node:mcp-restart-task");
        let awaitsRestart = continuationPending;
        const parentProjection = {
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: "running",
              result: null,
              completionDelivery: { state: "pending" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const childProjection = {
          thread: { id: childThreadId },
          runs: [
            {
              id: RunId.make("run:mcp-restart-child"),
              ordinal: 1,
              status: "cancelled",
              delegatedTaskId: taskId,
            },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
            delegatedTaskResultPending: () => Effect.succeed(awaitsRestart),
            dispatch: (command) => {
              if (command.type === "thread.stop") awaitsRestart = false;
              return Effect.succeed({} as never);
            },
            stopDelegatedTasks: () => Effect.void,
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-restart"),
          requestNamespace: "provider-session:mcp-restart",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-restart",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const held = yield* service.taskStatus(scope, taskId);
          assert.equal(held.status, continuationPending ? "running" : "cancelled");
          assert.equal(held.workState, continuationPending ? "working" : "result_available");
          assert.isNull(held.currentRunId);
          assert.isFalse(held.hasPendingChildRuns);
          const cancelled = yield* service.cancelTask(scope, {
            taskId,
            clientRequestId: "cancel-restart-held-task",
          });
          assert.equal(cancelled.status, "cancelled");
          const settled = yield* service.taskStatus(scope, taskId);
          assert.equal(settled.status, "cancelled");
          assert.equal(settled.workState, "result_available");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("does not dispose delivery when a task has no recorded child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        turnItems: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        turnItems: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        turnItems: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        turnItems: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
            turnItems: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
            turnItems: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getCallerRow: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect.each(["node:delegated-task:unknown", "unknown"])(
    "taskStatus traces an unknown id %s",
    (id) =>
      Effect.gen(function* () {
        const { ended, tracer } = captureSpans();
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) =>
              Effect.succeed({ ...liveThreadShell(threadId), ...parentProjection([]).thread }),
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service.taskStatus(scope, NodeId.make(id)).pipe(Effect.flip);
          assert.equal(error.code, "task_not_found");
        }).pipe(
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
          Effect.withTracer(tracer),
        );
        const attributes = ended.find(
          (span) => span.name === "OrchestratorMcpService.taskStatus",
        )!.attributes;
        assert.equal(attributes["t3.mcp.caller_thread_id"], parentThreadId);
        assert.equal(attributes["t3.task.task_id"], id);
        assert.equal(attributes["t3.task.result"], "not_found");
        assert.equal(attributes["t3.task.stage"], "parent_records");
        assert.equal(attributes["t3.task.stage_ms.caller"], 0);
        assert.equal(attributes["t3.task.stage_ms.parent_records"], 0);
        const statusSpan = ended.find((span) => span.name === "OrchestratorMcpService.taskStatus")!;
        const readSpan = ended.find((span) => span.name === "OrchestratorMcpService.readTask")!;
        assert.equal(readSpan.parentSpanId, statusSpan.spanId);
      }),
  );

  const encodedTaskId = (threadId = parentThreadId, key = "review:%25/é") =>
    NodeId.make(
      `node:delegated-task:${encodeURIComponent(
        `command:mcp:delegate-task:${encodeURIComponent(scope.environmentId)}:${encodeURIComponent(threadId)}:${encodeURIComponent(key)}`,
      )}`,
    );

  const taskIdForms = [
    { name: "exact", change: (id: string) => id },
    { name: "projection appears after missing receipt", change: (id: string) => id, late: true },
    {
      name: "re-encoded",
      change: (id: string) => `node:delegated-task:${encodeURIComponent(id.slice(20))}`,
    },
    {
      name: "one-level decoded",
      change: (id: string) => `node:delegated-task:${decodeURIComponent(id.slice(20))}`,
    },
    {
      name: "caller separator loses an encoding level",
      change: (id: string) => id.replace("thread%253A", "thread%3A"),
      ambiguous: true,
    },
    {
      name: "caller separator gains an encoding level",
      change: (id: string) => id.replace("thread%253A", "thread%25253A"),
    },
    {
      name: "lowercase escape",
      change: (id: string) => id.replace("%3A", "%3a"),
    },
  ];

  it.effect.each(taskIdForms)("handles the caller's copied task id for $name", (testCase) =>
    Effect.gen(function* () {
      const { change } = testCase;
      let parentReads = 0;
      const realId = encodedTaskId();
      const task = {
        id: realId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: codexInstanceId,
        model: "gpt-5.4",
        result: "Review complete.",
        status: "completed",
        completionDelivery: { state: "pending" },
      } as const;
      const distractions = [
        { ...task, origin: "provider_native" },
        { ...task, threadId: ThreadId.make("thread:other") },
      ];
      const dispatched: Array<{ type: string; taskId?: NodeId }> = [];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: (id) =>
            Effect.succeed(
              id === parentThreadId
                ? parentProjection(
                    "late" in testCase && parentReads++ === 0 ? [] : [...distractions, task],
                  )
                : childProjection,
            ),
          getDelegationCommandState: () => Effect.succeed({ status: "never_saved" }),
          getThreadProjection: () => Effect.succeed(parentProjection([task])),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
            }) as never,
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const inputId = NodeId.make(change(realId));
        if ("ambiguous" in testCase) {
          for (const operation of [
            service.taskStatus(scope, inputId).pipe(Effect.asVoid),
            service.cancelTask(scope, { taskId: inputId }).pipe(Effect.asVoid),
          ]) {
            const error = yield* operation.pipe(Effect.flip);
            assert.equal(error.code, "task_not_found");
            assert.include(error.message, "Check the id; copy it exactly from delegate_task.");
            assert.notInclude(error.message, "never saved");
          }
          yield* Effect.yieldNow;
          assert.deepEqual(dispatched, []);
          return;
        }
        const status = yield* service.taskStatus(scope, inputId);
        assert.equal(status.taskId, realId);
        assert.isFalse(status.partial);
        const cancelled = yield* service.cancelTask(scope, { taskId: inputId });
        assert.equal(cancelled.taskId, realId);
        assert.equal(cancelled.status, "completed");
        yield* Effect.yieldNow;
        assert.isTrue(
          dispatched.some(
            (command) => command.type === "delegated_task.completion-delivery.dispose",
          ),
        );
        for (const command of dispatched)
          if (command.taskId !== undefined) assert.equal(command.taskId, realId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    { name: "modern key colon", key: "review:1", suffix: "1", modern: true },
    { name: "modern key repeated colons", key: "review::1", suffix: "1", modern: true },
    { name: "modern key multiple fields", key: "review:round:1", suffix: "1", modern: true },
    { name: "legacy key colon", key: "review:1", suffix: "1", modern: false },
    { name: "legacy key repeated colons", key: "review::1", suffix: "1", modern: false },
    { name: "legacy key multiple fields", key: "review:round:1", suffix: "1", modern: false },
    {
      name: "legacy operation namespace colon",
      key: "review:1",
      suffix: "1",
      modern: false,
      namespace: "delegate-task",
    },
    {
      name: "legacy operation namespace repeated colons",
      key: "review::1",
      suffix: ":1",
      modern: false,
      namespace: "delegate-task",
      firstOnly: true,
    },
    {
      name: "legacy operation namespace multiple fields",
      key: "review:round:1",
      suffix: "round:1",
      modern: false,
      namespace: "delegate-task",
      firstOnly: true,
    },
  ])("rejects ambiguous $name without selecting its suffix task", (testCase) =>
    Effect.gen(function* () {
      const { key, suffix, modern } = testCase;
      const namespace = "namespace" in testCase ? testCase.namespace : "credential";
      const idFor = (requestKey: string) =>
        modern
          ? encodedTaskId(parentThreadId, requestKey)
          : NodeId.make(
              `node:delegated-task:${encodeURIComponent(`command:mcp:${namespace}:delegate-task:${encodeURIComponent(requestKey)}`)}`,
            );
      const realId = idFor(key);
      const suffixId = idFor(suffix);
      const encodedKey = encodeURIComponent(key);
      const alteredKey = "firstOnly" in testCase ? encodedKey.replace("%3A", ":") : key;
      const inputId = NodeId.make(
        realId.replace(encodeURIComponent(encodedKey), encodeURIComponent(alteredKey)),
      );
      const task = (id: NodeId, child: ThreadId) => ({
        id,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId: child,
        providerInstanceId: codexInstanceId,
        model: "gpt-5.4",
        result: "Review complete.",
        status: "completed",
        completionDelivery: { state: "pending" },
      });
      const parent = parentProjection([
        task(suffixId, ThreadId.make("thread:suffix-child")),
        task(realId, childThreadId),
      ]);
      const dispatched: string[] = [];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: (id) =>
            Effect.succeed(id === parentThreadId ? parent : childProjection),
          getThreadProjection: () => Effect.succeed(parent),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
            }) as never,
          stopDelegatedTasks: () =>
            Effect.sync(() => {
              dispatched.push("stopDelegatedTasks");
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const outcomes = yield* Effect.all([
          Effect.exit(service.cancelTask(scope, { taskId: inputId }).pipe(Effect.asVoid)),
          Effect.exit(service.taskStatus(scope, inputId).pipe(Effect.asVoid)),
        ]);
        yield* Effect.yieldNow;
        assert.deepEqual(dispatched, []);
        for (const outcome of outcomes) {
          assert.isTrue(Exit.isFailure(outcome));
          if (Exit.isFailure(outcome)) {
            const error = Cause.squash(outcome.cause) as OrchestratorMcpFailure;
            assert.equal(error.code, "task_not_found");
            assert.include(error.message, "Check the id; copy it exactly from delegate_task.");
            assert.notInclude(error.message, "never saved");
          }
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    {
      name: "real unsaved",
      id: encodedTaskId(),
      state: "never_saved",
      expected: "This delegation was never saved",
    },
    {
      name: "saved receipt",
      id: encodedTaskId(),
      state: "accepted",
      expected: "This delegation was saved",
    },
    { name: "pending", id: encodedTaskId(), state: "pending", expected: "still being created" },
    { name: "rejected", id: encodedTaskId(), state: "rejected", expected: "was rejected" },
    ...taskIdForms
      .filter((row) => !("late" in row) && row.name !== "exact")
      .map(({ name, change }) => ({
        name,
        id: NodeId.make(change(encodedTaskId())),
        state: "never_saved",
        expected: "Check the id; copy it exactly from delegate_task.",
      })),
    {
      name: "foreign caller",
      id: encodedTaskId(ThreadId.make("thread:other")),
      state: "never_saved",
      expected: "Check the id; copy it exactly from delegate_task.",
    },
    {
      name: "unknown",
      id: NodeId.make("unknown"),
      state: "never_saved",
      expected: "Check the id; copy it exactly from delegate_task.",
    },
    {
      name: "invalid escape",
      id: NodeId.make("node:delegated-task:%ZZ"),
      state: "never_saved",
      expected: "Check the id; copy it exactly from delegate_task.",
    },
    {
      name: "legacy without owner evidence",
      id: NodeId.make(
        `node:delegated-task:${encodeURIComponent("command:mcp:credential:delegate-task:review")}`,
      ),
      state: "never_saved",
      expected: "Check the id; copy it exactly from delegate_task.",
    },
  ] as const)("missing task diagnosis: $name", ({ id, state, expected }) =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          getDelegationCommandState: () =>
            Effect.succeed(
              state === "accepted" || state === "rejected"
                ? ({
                    status: state,
                    threadId: parentThreadId,
                    commandType: "delegated_task.request",
                    error: null,
                  } as never)
                : ({ status: state } as never),
            ),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service.taskStatus(scope, id).pipe(Effect.flip);
        assert.equal(error.code, "task_not_found");
        assert.include(error.message, expected);
        if (expected.startsWith("Check")) {
          assert.notInclude(error.message, "never saved");
          assert.notInclude(error.message, "Retry delegate_task");
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("status and same-key delegation finish while the background reader is held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-task-lanes-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            sql`SELECT * FROM entries`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(held);
        const writerHeld = yield* Deferred.make<void>();
        const writer = yield* sql
          .withTransaction(
            sql`SELECT * FROM entries`.pipe(
              Effect.andThen(Deferred.succeed(writerHeld, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerHeld);
        const taskId = NodeId.make("task:reader-lanes");
        const childRunId = RunId.make("run:reader-lanes");
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          model: "gpt-5.4",
          result: "Review complete.",
          status: "completed",
          completionDelivery: { state: "acknowledged" },
        } as const;
        const parent = parentProjection([task]);
        const child = {
          ...childProjection,
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status: "completed",
              delegatedTaskId: taskId,
              rootNodeId: taskId,
              modelSelection: parent.thread.modelSelection,
              startedAt: DateTime.makeUnsafe("2026-11-13T00:00:00Z"),
              completedAt: DateTime.makeUnsafe("2026-11-13T00:01:00Z"),
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const lanes: string[] = [];
        const pointRead = <A>(value: A, readOnly = true, expectedLane = "foreground") =>
          Effect.gen(function* () {
            const lane = yield* NodeSqliteClient.ReaderLane;
            lanes.push(lane);
            assert.equal(lane, expectedLane);
            yield* sql
              .withTransaction(sql`SELECT * FROM entries`)
              .pipe(readOnly ? NodeSqliteClient.readOnly : (effect) => effect, Effect.orDie);
            return value;
          });
        const commands: CommandId[] = [];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              pointRead({ ...liveThreadShell(id), ...parent.thread }, true, "identity"),
            getThreadRecords: (id, _fields, _filter, options) => {
              assert.isTrue(options?.projectionOnly, "task reads must skip transcript hydration");
              return pointRead(id === parentThreadId ? parent : child);
            },
            hasReceipt: () => pointRead(commands.length > 0, false),
            delegatedTaskResultPending: () => pointRead(false),
            dispatch: (command) => {
              commands.push(command.commandId);
              return Effect.succeed({
                sequence: 1,
                storedEvents: [
                  { event: { type: "subagent.updated", payload: task } },
                  {
                    event: { type: "run.created", threadId: childThreadId, payload: child.runs[0] },
                  },
                ],
              } as never);
            },
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const started = yield* Clock.monotonicTimeNanos;
          const status = yield* service.taskStatus(scope, taskId);
          assert.isFalse(status.partial);
          if (status.partial) return assert.fail("task status must answer in full");
          assert.equal(status.status, "completed");
          assert.equal(status.summary, "Review complete.");
          const request = { task: "Review.", mode: "async", clientRequestId: "same-key" } as const;
          const first = yield* service.delegateTask(scope, request);
          const retry = yield* service.delegateTask(scope, request);
          assert.equal(first.taskId, taskId);
          assert.equal(retry.taskId, first.taskId);
          assert.equal(retry.childThreadId, first.childThreadId);
          assert.equal(retry.summary, "Review complete.");
          assert.deepEqual(commands, [commands[0], commands[0]]);
          assert.isTrue(lanes.length > 6);
          assert.deepEqual([...new Set(lanes)].sort(), ["foreground", "identity"]);
          assert.isBelow(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000, 10_000);
          assert.isUndefined(holder.pollUnsafe(), "the background slot stays held throughout");
          assert.isUndefined(writer.pollUnsafe(), "receipt probes must not require the writer");
        }).pipe(
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(holder);
        yield* Fiber.join(writer);
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            identityReaderProcess: true,
            foregroundReaderSlots: 1,
            backgroundReaderSlots: 1,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { shape: "never created", delegated: true },
    { shape: "never created", delegated: false },
    { shape: "other parent", delegated: true },
    { shape: "other origin", delegated: true },
    { shape: "no child yet", delegated: true },
  ])("missing task guidance for $shape (delegated=$delegated)", ({ shape, delegated }) =>
    Effect.gen(function* () {
      const missingId = NodeId.make(delegated ? "node:delegated-task:missing" : "opaque-missing");
      const subagents =
        shape === "never created"
          ? []
          : [
              {
                id: missingId,
                threadId:
                  shape === "other parent" ? ThreadId.make("another-parent") : parentThreadId,
                origin: shape === "other origin" ? "provider_native" : "app_owned",
                childThreadId: shape === "no child yet" ? null : childThreadId,
              },
            ];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: () => Effect.succeed(parentProjection(subagents)),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const read of [
          service.taskStatus(scope, missingId).pipe(Effect.asVoid),
          service.cancelTask(scope, { taskId: missingId }).pipe(Effect.asVoid),
        ]) {
          const error = yield* read.pipe(Effect.flip);
          assert.equal(error.code, "task_not_found");
          assert.include(error.message, "Check the id; copy it exactly from delegate_task.");
          assert.notInclude(error.message, "does not belong");
          assert.notInclude(error.message, "about 30 seconds after the timeout");
          assert.notInclude(error.message, "same clientRequestId");
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each(["none", "rejected", "read_error"] as const)(
    "a %s receipt does not report a rejected delegation as saved",
    (receipt) =>
      Effect.gen(function* () {
        const state: McpCall["Service"] = {
          callerResolved: false,
          callerResolveMs: 0,
          readerLane: "background",
          phase: "handler",
          saved: "unknown",
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadRecords: () => Effect.succeed(parentProjection([])),
            hasReceipt: () => Effect.succeed(receipt === "rejected"),
            getCommandReceipt: (commandId) =>
              receipt === "read_error"
                ? Effect.fail(new CommandReceiptStore.CommandReceiptStoreReadError({ commandId }))
                : Effect.succeed(
                    receipt === "none"
                      ? Option.none()
                      : Option.some({
                          commandId,
                          threadId: parentThreadId,
                          commandType: "delegated_task.request",
                          acceptedAt: DateTime.makeUnsafe("2026-11-13T00:00:00.000Z"),
                          resultSequence: 1,
                          status: "rejected" as const,
                          error: "Rejected",
                        }),
                  ),
            dispatch: (command) =>
              Effect.fail(
                receipt === "rejected"
                  ? new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                      commandId: command.commandId,
                      commandType: command.type,
                      detail: "Rejected before task creation.",
                    })
                  : new Orchestrator.OrchestratorCommandRejectedError({
                      commandId: command.commandId,
                      commandType: command.type,
                    }),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service
            .delegateTask(scope, {
              task: "Check the diff",
              mode: "async",
              clientRequestId: "rejected-retry",
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "orchestration_error");
          assert.isFalse(state.saved);
          assert.isDefined(state.delegation);
          assert.equal(
            yield* state.delegation!.readCommitted,
            receipt === "read_error" ? "unknown" : receipt === "rejected",
          );
        }).pipe(
          Effect.provideService(McpCall, state),
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
        );
      }),
  );

  it.effect.each(
    (["caller", "parent_records", "catalog", "receipt", "selection", "dispatch"] as const).flatMap(
      (stage) => [false, true].map((interrupted) => ({ stage, interrupted })),
    ),
  )(
    "delegateTask traces stalled $stage (interrupted: $interrupted) without dispatching after preflight",
    ({ stage, interrupted }) =>
      Effect.gen(function* () {
        const { ended, tracer } = captureSpans();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let dispatches = 0;
        const stall = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.uninterruptible,
        );
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              (stage === "caller" ? stall : Effect.void).pipe(
                Effect.as({ ...liveThreadShell(id), ...parentProjection([]).thread }),
              ),
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadRecords: () =>
              stage === "parent_records"
                ? stall.pipe(Effect.as(parentProjection([])))
                : Effect.succeed(parentProjection([])),
            hasReceipt: () =>
              stage === "receipt" ? stall.pipe(Effect.as(false)) : Effect.succeed(false),
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
              }).pipe(Effect.andThen(stall), Effect.as({ sequence: 1, storedEvents: [] } as never)),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: (stage === "catalog" ? stall : Effect.void).pipe(
              Effect.as([
                providerSnapshot({
                  instanceId: codexInstanceId,
                  driver: ProviderDriverKind.make("codex"),
                  model: "gpt-5.4",
                }),
              ]),
            ),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () =>
              (stage === "selection" ? stall : Effect.void).pipe(Effect.as([codexInstanceId])),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .delegateTask(scope, {
              task: "Check the diff",
              mode: "async",
              clientRequestId: "cancelled-first-run",
            })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(entered);
          if (interrupted) yield* Fiber.interrupt(call);
          else yield* TestClock.adjust("30 seconds");
          const completed = call.pollUnsafe();
          yield* Deferred.succeed(release, undefined);
          assert.isDefined(completed);
          const attributes = ended.find(
            (span) => span.name === "OrchestratorMcpService.delegateTask",
          )!.attributes;
          assert.equal(attributes["t3.mcp.caller_thread_id"], parentThreadId);
          assert.equal(attributes["t3.delegate.client_request_id"], "cancelled-first-run");
          assert.equal(attributes["t3.delegate.stage"], stage);
          assert.equal(
            attributes["t3.delegate.outcome"],
            interrupted
              ? "interrupted"
              : stage === "caller"
                ? "caller_unresolved"
                : "timeout_dispatch",
          );
          assert.equal(attributes["t3.delegate.mode"], "async");
          assert.isNumber(attributes[`t3.delegate.stage_ms.${stage}`]);
          if (stage === "dispatch") {
            assert.match(String(attributes["t3.delegate.task_id"]), /^node:delegated-task:/);
            assert.isString(attributes["t3.delegate.command_id"]);
            assert.equal(attributes["t3.delegate.provider_instance_id"], codexInstanceId);
            assert.equal(attributes["t3.delegate.model"], "gpt-5.4");
          }
          assert.notInclude(JSON.stringify(attributes), "Check the diff");
          if (interrupted) return;
          const error = yield* Fiber.join(call);
          assert.equal(error.code, stage === "caller" ? "caller_unresolved" : "delegation_timeout");
          assert.include(error.message, parentThreadId);
          if (stage !== "caller") assert.include(error.message, stage);
          if (stage === "parent_records")
            assert.include(error.message, "Nothing was saved; retry the same call.");
          if (stage === "dispatch") assert.include(error.message, "cancelled-first-run");
          assert.equal(dispatches, stage === "dispatch" ? 1 : 0);
        }).pipe(
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
          Effect.withTracer(tracer),
        );
      }),
  );

  it.effect.each(["result", "wait", "wake_policy"] as const)(
    "delegateTask recovers an accepted task when %s I/O stalls",
    (stage) =>
      Effect.gen(function* () {
        const { ended, tracer } = captureSpans();
        const state: McpCall["Service"] = {
          callerResolved: false,
          callerResolveMs: 0,
          readerLane: "background",
          phase: "handler",
          saved: "unknown",
        };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const stall = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.uninterruptible,
          Effect.ensuring(Deferred.succeed(finished, undefined)),
        );
        let accepted = false;
        let slow = true;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          model: "gpt-5.4",
          status: "running",
          result: null,
        };
        const commandIds: string[] = [];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadRecords: (id) => {
              const projection =
                id === parentThreadId ? parentProjection(accepted ? [task] : []) : childProjection;
              return accepted && slow && stage === "result"
                ? stall.pipe(Effect.as(projection))
                : Effect.succeed(projection);
            },
            hasReceipt: () => Effect.succeed(accepted),
            getThreadEventSequence: () =>
              stage === "wait" || stage === "wake_policy"
                ? stall.pipe(Effect.as(0))
                : Effect.succeed(0),
            dispatch: (command) => {
              if (command.type === "delegated_task.request") {
                accepted = true;
                commandIds.push(command.commandId);
                return Effect.succeed({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: command.commandId,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never);
              }
              return stage === "wake_policy" && slow
                ? stall.pipe(Effect.as({ sequence: 1, storedEvents: [] } as never))
                : Effect.succeed({ sequence: 1, storedEvents: [] } as never);
            },
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const input = {
            task: "Check diff",
            mode: stage === "result" ? ("async" as const) : ("wait" as const),
            timeoutMs: 1000,
            clientRequestId: "recover-accepted",
          };
          const pending = yield* service
            .delegateTask(scope, input)
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("20 seconds");
          const completed = pending.pollUnsafe();
          slow = false;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(finished);
          assert.isDefined(completed);
          const outcome = yield* Fiber.join(pending);
          assert.isTrue(state.saved);
          assert.isTrue(Exit.isSuccess(outcome));
          if (Exit.isSuccess(outcome)) {
            assert.equal(outcome.value.taskId, taskId);
            assert.equal(outcome.value.waitTimedOut, stage !== "result");
          }
          // Replay uses the same command, even after an accepted call lost its response.
          const retry = yield* service.delegateTask(scope, { ...input, mode: "async" });
          assert.equal(retry.taskId, taskId);
          assert.equal(commandIds.length, 2);
          assert.equal(commandIds[0], commandIds[1]);
          const spans = ended.filter((span) => span.name === "OrchestratorMcpService.delegateTask");
          assert.lengthOf(spans, 2);
          assert.equal(
            spans[0]!.attributes["t3.delegate.outcome"],
            stage === "result" ? "accepted" : "timeout_wait",
          );
          const attributes = spans[1]!.attributes;
          assert.equal(attributes["t3.mcp.caller_thread_id"], parentThreadId);
          assert.equal(attributes["t3.delegate.client_request_id"], input.clientRequestId);
          assert.equal(attributes["t3.delegate.task_id"], retry.taskId);
          assert.equal(attributes["t3.delegate.retry_of_accepted"], true);
          assert.equal(attributes["t3.delegate.outcome"], "accepted");
          assert.equal(attributes["t3.delegate.stage_ms.catalog"], 0);
          assert.equal(attributes["t3.delegate.stage_ms.request_key"], 0);
          assert.notInclude(JSON.stringify(attributes), input.task);
        }).pipe(
          Effect.provideService(McpCall, state),
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))),
          Effect.withTracer(tracer),
        );
      }),
  );

  it.effect.each([
    { timeoutMs: 1_000, budgetMs: 1_000 },
    { timeoutMs: 299_999, budgetMs: 270_000 },
    { timeoutMs: 300_000, budgetMs: 270_000 },
    { timeoutMs: 600_000, budgetMs: 270_000 },
    { timeoutMs: 3_600_000, budgetMs: 270_000 },
    { timeoutMs: undefined, budgetMs: 270_000 },
  ])("bounds delegation from call start (requested $timeoutMs)", ({ timeoutMs, budgetMs }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const enteredPreparation = yield* Deferred.make<void>();
        const releasePreparation = yield* Deferred.make<void>();
        const watching = yield* Deferred.make<void>();
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          model: "gpt-5.4",
          status: "running",
          result: null,
        };
        const parent = parentProjection([task]);
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? { ...parent, thread: { ...parent.thread, worktreePath: null } }
                  : childProjection,
              ),
            getThreadEventSequence: () => Deferred.succeed(watching, undefined).pipe(Effect.as(1)),
            streamStoredEventsFrom: () => Stream.never,
            dispatch: (command) =>
              Effect.succeed(
                command.type === "delegated_task.request"
                  ? ({
                      sequence: 1,
                      storedEvents: [
                        { event: { type: "subagent.updated", payload: task } },
                        {
                          event: {
                            type: "run.created",
                            threadId: childThreadId,
                            payload: {
                              id: RunId.make("run:wait-budget-child"),
                              workspacePreparation: { type: "worktree", baseRef: "HEAD" },
                            },
                          },
                        },
                      ],
                    } as never)
                  : ({} as never),
              ),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            prepareRun: () =>
              Deferred.succeed(enteredPreparation, undefined).pipe(
                Effect.andThen(Deferred.await(releasePreparation)),
              ),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit: () => Effect.succeed({ commitSha: "abc123" } as never),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .delegateTask(scope, {
              task: "Review.",
              isolation: "worktree",
              mode: "wait",
              timeoutMs,
              clientRequestId: "wait-budget",
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(enteredPreparation);
          yield* TestClock.adjust(600);
          yield* Deferred.succeed(releasePreparation, undefined);
          yield* Deferred.await(watching);
          yield* TestClock.adjust(budgetMs - 600);
          assert.isDefined(call.pollUnsafe(), "the call must finish within its total wait budget");
          const result = yield* Fiber.join(call);
          assert.equal(result.taskId, taskId);
          assert.isTrue(result.waitTimedOut);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
  );

  it.effect.each([
    "preparation",
    "shutdown",
    "run creation",
    "read",
    "acknowledgement",
    "wake policy",
  ] as const)("returns the accepted task while %s is held past the cap", (held) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const preparationDone = yield* Deferred.make<void>();
        const followUpEntered = yield* Deferred.make<void>();
        const followUpDone = yield* Deferred.make<void>();
        const runId = RunId.make("run:held-child");
        const terminalRun = {
          id: runId,
          ordinal: 1,
          status: "completed",
          startedAt: DateTime.makeUnsafe("2026-11-05T10:00:00Z"),
          completedAt: DateTime.makeUnsafe("2026-11-05T10:01:00Z"),
        };
        let accepted = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: codexInstanceId,
          model: "gpt-5.4",
          status: held === "acknowledgement" ? "completed" : "running",
          result: held === "acknowledgement" ? "Review done." : null,
        };
        const parent = parentProjection([task]);
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) => {
              const result =
                threadId === parentThreadId
                  ? parent
                  : held === "acknowledgement"
                    ? ({
                        ...childProjection,
                        runs: [terminalRun],
                      } as unknown as OrchestrationV2ThreadProjection)
                    : childProjection;
              if (accepted && held === "run creation" && threadId === childThreadId) {
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(childProjection),
                );
              }
              if (accepted && held === "read") {
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Deferred.succeed(followUpDone, undefined)),
                  Effect.as(result),
                );
              }
              return Effect.succeed(result);
            },
            getThreadEventSequence: () => Deferred.succeed(entered, undefined).pipe(Effect.as(1)),
            streamStoredEventsFrom: () => Stream.never,
            dispatch: (command) => {
              if (command.type !== "delegated_task.request") {
                if (
                  held === "acknowledgement" &&
                  command.type === "delegated_task.completion-delivery.acknowledge"
                ) {
                  return Deferred.succeed(followUpEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Deferred.succeed(followUpDone, undefined)),
                    Effect.as({} as never),
                  );
                }
                if (held === "wake policy" && command.type === "delegated_task.wake-policy") {
                  return Deferred.succeed(followUpEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Deferred.succeed(followUpDone, undefined)),
                    Effect.as({} as never),
                  );
                }
                return Effect.succeed({} as never);
              }
              accepted = true;
              return Effect.succeed({
                sequence: 1,
                storedEvents: [
                  { event: { type: "subagent.updated", payload: task } },
                  ...(held === "run creation"
                    ? []
                    : [
                        {
                          event: {
                            type: "run.created",
                            threadId: childThreadId,
                            payload: {
                              id: runId,
                              status: "preparing",
                              startedAt: null,
                              workspacePreparation: { type: "worktree", baseRef: "HEAD" },
                            },
                          },
                        },
                      ]),
                ],
              } as never);
            },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            prepareRun: () =>
              (held === "preparation" || held === "shutdown"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void
              ).pipe(Effect.andThen(Deferred.succeed(preparationDone, undefined))),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          ServerSettings.layerTest(),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const lifetime = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)),
          lifetime,
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .delegateTask(scope, {
              task: "Review.",
              mode: "wait",
              timeoutMs: 300_000,
              clientRequestId: `held-${held}`,
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          if (held === "shutdown") {
            yield* Scope.close(lifetime, Exit.void);
            const outcome = yield* Fiber.await(call);
            assert.isTrue(Exit.isFailure(outcome));
            if (Exit.isFailure(outcome)) {
              const error = Cause.squash(outcome.cause) as OrchestratorMcpFailure;
              assert.equal(error.code, "orchestration_error");
              assert.include(error.message, "same clientRequestId");
            }
            return;
          }
          if (held === "acknowledgement") yield* Deferred.await(followUpEntered);
          yield* TestClock.adjust(270_000);
          assert.isDefined(
            call.pollUnsafe(),
            "accepted identity must not depend on slow follow-up work",
          );
          const result = yield* Fiber.join(call);
          assert.equal(result.taskId, taskId);
          assert.equal(result.childThreadId, childThreadId);
          assert.isTrue(result.waitTimedOut);
          assert.equal(result.startPending, held !== "acknowledgement" && held !== "wake policy");
          if (held === "acknowledgement") assert.equal(result.status, "completed");
          if (held === "run creation") assert.isNull(result.childRunId);
          if (held === "wake policy") yield* Deferred.await(followUpEntered);
          yield* Deferred.succeed(release, undefined);
          if (held === "preparation") yield* Deferred.await(preparationDone);
          if (held === "wake policy" || held === "acknowledgement")
            yield* Deferred.await(followUpDone);
        }).pipe(Effect.provideContext(context), Effect.ensuring(Scope.close(lifetime, Exit.void)));
      }),
    ),
  );

  it.effect.each([
    "pending",
    "acknowledged",
    "blocked",
    "idle",
    "late_ack",
    "confirmed_then_blocked",
    "replacement",
  ] as const)("thread wait exposes native start progress within its total budget: %s", (state) =>
    Effect.gen(function* () {
      const parent = parentProjection([]);
      const now = yield* DateTime.now;
      const run = {
        ...parent.runs[0]!,
        threadId: parentThreadId,
        activeAttemptId: RunAttemptId.make("wait-attempt"),
        status: "running" as const,
        startedAt: now,
        requestedAt: now,
      };
      const waitedRun =
        state === "replacement"
          ? { ...run, activeAttemptId: RunAttemptId.make("replacement-wait-attempt") }
          : run;
      const target = {
        ...parent,
        thread: { ...parent.thread, deletedAt: null },
        runs: state === "idle" ? [] : [run],
        providerTurns: [
          "acknowledged",
          "late_ack",
          "confirmed_then_blocked",
          "replacement",
        ].includes(state)
          ? [
              {
                id: ProviderTurnId.make("wait-turn"),
                providerThreadId: ProviderThreadId.make("wait-pt"),
                nodeId: NodeId.make("wait-native-node"),
                runAttemptId: run.activeAttemptId,
                ordinal: 1,
                status: "running" as const,
                nativeTurnRef: null,
                startedAt: now,
                completedAt: null,
                promptAcceptedAt: now,
              },
            ]
          : [],
      };
      const entered = yield* Deferred.make<void>();
      const waitingEntered = yield* Deferred.make<number>();
      let providerReads = 0;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
          getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
          getThreadRecords: (_id, fields, filter) => {
            if (!fields.some((field) => field === "providerTurns")) return Effect.succeed(target);
            providerReads++;
            assert.equal(
              filter?.providerTurnAttemptId,
              providerReads === 1 ? run.activeAttemptId : waitedRun.activeAttemptId,
            );
            if (state === "late_ack" && providerReads === 1)
              return Effect.succeed({ ...target, providerTurns: [] });
            if (
              (state === "confirmed_then_blocked" || state === "replacement") &&
              providerReads === 1
            )
              return Effect.succeed(target);
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(
                state === "blocked" || state === "confirmed_then_blocked" || state === "replacement"
                  ? Effect.never
                  : Effect.succeed(target),
              ),
            );
          },
          waitForThread: ({ timeoutMs }) =>
            (state === "late_ack"
              ? Deferred.succeed(waitingEntered, timeoutMs!).pipe(
                  Effect.andThen(Effect.never.pipe(Effect.timeoutOption(timeoutMs!))),
                )
              : Effect.void
            ).pipe(
              Effect.as({
                threadId: parentThreadId,
                run: state === "idle" ? null : waitedRun,
                timedOut: state !== "idle",
              }),
            ),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const call = yield* service
          .waitForThread(scope, { threadId: parentThreadId, timeoutMs: 1000 })
          .pipe(Effect.forkScoped);
        if (state === "blocked" || state === "confirmed_then_blocked" || state === "replacement") {
          yield* Deferred.await(entered);
          yield* TestClock.adjust(1000);
        }
        if (state === "late_ack") {
          const budget = yield* Deferred.await(waitingEntered);
          assert.isBelow(budget, 1000);
          yield* TestClock.adjust(budget);
        }
        const result = yield* Fiber.join(call);
        const pending = state === "pending" || state === "blocked" || state === "replacement";
        assert.equal(result.startPending, pending);
        assert.equal(
          result.startProgress?.step ?? null,
          pending ? "awaiting_native_acceptance" : null,
        );
        if (state === "blocked") assert.isTrue(result.timedOut);
        if (state === "idle") assert.equal(providerReads, 0);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("counts thread lookup against the thread wait budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const enteredLookup = yield* Deferred.make<void>();
        const releaseLookup = yield* Deferred.make<void>();
        const watching = yield* Deferred.make<void>();
        const parent = parentProjection([]);
        const target = { ...parent, thread: { ...parent.thread, deletedAt: null } };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadRecords: () =>
              Deferred.succeed(enteredLookup, undefined).pipe(
                Effect.andThen(Deferred.await(releaseLookup)),
                Effect.as(target),
              ),
            waitForThread: ({ timeoutMs }) =>
              Deferred.succeed(watching, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.timeoutOption(Duration.millis(timeoutMs)),
                Effect.as({ threadId: parentThreadId, run: parent.runs[0]!, timedOut: true }),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .waitForThread(scope, { threadId: parentThreadId, timeoutMs: 1_000 })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(enteredLookup);
          yield* TestClock.adjust(600);
          yield* Deferred.succeed(releaseLookup, undefined);
          yield* Deferred.await(watching);
          yield* TestClock.adjust(400);
          assert.isDefined(call.pollUnsafe(), "the call must finish within its total wait budget");
          const result = yield* Fiber.join(call);
          assert.equal(result.threadId, parentThreadId);
          assert.isTrue(result.timedOut);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
    ),
  );

  it.effect("counts secret request setup against the wait budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const enteredSetup = yield* Deferred.make<void>();
        const releaseSetup = yield* Deferred.make<void>();
        const watching = yield* Deferred.make<void>();
        let recorded = false;
        let closed = false;
        const parent = { ...parentProjection([]), turnItems: [] };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadRecords: () =>
              recorded
                ? Deferred.succeed(watching, undefined).pipe(Effect.as(parent))
                : Effect.succeed(parent),
            dispatch: (command) => {
              if (command.type === "secret_request.record" && command.secretStatus === "pending") {
                return Deferred.succeed(enteredSetup, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSetup)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      recorded = true;
                    }),
                  ),
                  Effect.as({} as never),
                );
              }
              return Effect.sync(() => {
                closed = true;
              }).pipe(Effect.as({} as never));
            },
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .requestSecret(scope, {
              label: "Test secret",
              reason: "A test.",
              timeoutMs: 1_000,
              clientRequestId: "secret-wait-budget",
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(enteredSetup);
          yield* TestClock.adjust(600);
          yield* Deferred.succeed(releaseSetup, undefined);
          yield* Deferred.await(watching);
          yield* TestClock.adjust(400);
          assert.isDefined(call.pollUnsafe(), "the call must finish within its total wait budget");
          assert.deepEqual(yield* Fiber.join(call), { status: "timed_out" });
          assert.isTrue(closed);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
    ),
  );

  it.effect.each([
    "caller",
    "pending dispatch",
    "poll read",
    "cancellation",
    "final read",
    "saved ref",
  ] as const)("bounds the full secret response while %s is held", (held) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const watching = yield* Deferred.make<void>();
        const cleanupEntered = yield* Deferred.make<void>();
        const cleanupDone = yield* Deferred.make<void>();
        let pending = false;
        let closed = false;
        let finalReads = 0;
        const parent = { ...parentProjection([]), turnItems: [] };
        const blocked = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.uninterruptible,
        );
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
            getThreadRecords: (_threadId, parts) => {
              if (held === "caller" && !pending) return blocked.pipe(Effect.as(parent));
              if (parts?.length === 1 && parts[0] === "turnItems") {
                finalReads++;
                if (held === "final read") return blocked.pipe(Effect.as(parent));
              }
              if (!pending) return Effect.succeed(parent);
              const projection =
                held === "saved ref"
                  ? ({
                      ...parent,
                      turnItems: [
                        {
                          id: `turn-item:secret-request:${encodeURIComponent(parentThreadId)}:held-secret`,
                          type: "secret_request",
                          secretStatus: "saved",
                        },
                      ],
                    } as unknown as OrchestrationV2ThreadProjection)
                  : parent;
              return Deferred.succeed(watching, undefined).pipe(
                Effect.andThen(held === "poll read" ? blocked : Effect.void),
                Effect.as(projection),
              );
            },
            dispatch: (command) => {
              if (command.type !== "secret_request.record") return Effect.succeed({} as never);
              if (command.secretStatus === "pending")
                return (held === "pending dispatch" ? blocked : Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      pending = true;
                    }),
                  ),
                  Effect.as({} as never),
                );
              return Deferred.succeed(cleanupEntered, undefined).pipe(
                Effect.andThen(held === "cancellation" ? blocked : Effect.void),
                Effect.andThen(
                  Effect.sync(() => {
                    closed = true;
                  }),
                ),
                Effect.andThen(Deferred.succeed(cleanupDone, undefined)),
                Effect.as({} as never),
              );
            },
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({
            savedRef: () => blocked.pipe(Effect.as(Option.none())),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const call = yield* service
            .requestSecret(scope, {
              label: "Test",
              reason: "A test.",
              timeoutMs: 600_000,
              clientRequestId: "held-secret",
            })
            .pipe(Effect.forkScoped);
          if (
            held === "caller" ||
            held === "pending dispatch" ||
            held === "poll read" ||
            held === "saved ref"
          )
            yield* Deferred.await(entered);
          else yield* Deferred.await(watching);
          yield* TestClock.adjust(270_000);
          const completedAtBudget = call.pollUnsafe();
          if (held === "cancellation") {
            yield* Deferred.await(cleanupEntered);
            assert.isFalse(closed);
          }
          if (held === "pending dispatch")
            assert.isFalse(closed, "cleanup must follow the pending write");
          yield* Deferred.succeed(release, undefined);
          if (completedAtBudget === undefined) yield* Fiber.interrupt(call);
          assert.isDefined(
            completedAtBudget,
            "secret setup, cleanup and reads must not hold the transport past its budget",
          );
          assert.deepEqual(yield* Fiber.join(call), { status: "timed_out" });
          if (held !== "caller") yield* Deferred.await(cleanupDone);
          assert.equal(finalReads, 0, "a timeout must not start another read outside its budget");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
    ),
  );

  it.effect.each(["saved", "declined", "cancelled", "read failure", "disconnect"] as const)(
    "preserves secret request lifecycle on %s",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const watching = yield* Deferred.make<void>();
          const cleaned = yield* Deferred.make<void>();
          let pending = false;
          let cancellations = 0;
          const parent = { ...parentProjection([]), turnItems: [] };
          const secretRef = SecretRef.make("secret-ref:00000000000000000000000000000000");
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
              getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ...parent.thread }),
              getThreadRecords: () => {
                if (!pending) return Effect.succeed(parent);
                if (outcome === "disconnect")
                  return Deferred.succeed(watching, undefined).pipe(Effect.andThen(Effect.never));
                if (outcome === "read failure")
                  return Effect.fail(new Error("Read failed") as never);
                return Effect.succeed({
                  ...parent,
                  turnItems: [
                    {
                      id: `turn-item:secret-request:${encodeURIComponent(parentThreadId)}:lifecycle`,
                      type: "secret_request",
                      secretStatus: outcome,
                    },
                  ],
                } as unknown as OrchestrationV2ThreadProjection);
              },
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type === "secret_request.record") {
                    if (command.secretStatus === "pending") pending = true;
                    else cancellations++;
                  }
                }).pipe(
                  Effect.andThen(
                    command.type === "secret_request.record" && command.secretStatus === "cancelled"
                      ? Deferred.succeed(cleaned, undefined)
                      : Effect.void,
                  ),
                  Effect.as({} as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([]),
            adapterRegistryLayer([]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({
              savedRef: () => Effect.succeed(Option.some(secretRef)),
            }),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const call = yield* service
              .requestSecret(scope, {
                label: "Test",
                reason: "A test.",
                clientRequestId: "lifecycle",
              })
              .pipe(Effect.exit, Effect.forkScoped);
            if (outcome === "disconnect") {
              yield* Deferred.await(watching);
              yield* Fiber.interrupt(call);
              assert.isTrue(Exit.isFailure(yield* Fiber.await(call)));
              yield* Deferred.await(cleaned);
              assert.equal(cancellations, 1);
              return;
            }
            const result = yield* Fiber.join(call);
            if (outcome === "saved" || outcome === "declined" || outcome === "cancelled") {
              assert.deepEqual(
                result,
                Exit.succeed(
                  outcome === "saved" ? { status: "saved", secretRef } : { status: outcome },
                ),
              );
            } else assert.isTrue(Exit.isFailure(result));
            if (outcome === "saved" || outcome === "declined") assert.equal(cancellations, 0);
            else {
              yield* Deferred.await(cleaned);
              assert.equal(cancellations, 1);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }),
      ),
  );

  it.effect.each([
    { mode: "async", legacy: false },
    { mode: "async", legacy: false, parentRestart: true },
    { mode: "wait", legacy: false },
    { mode: "wait", legacy: false, stillRunning: true },
    { mode: "async", legacy: true },
    { mode: "wait", legacy: true },
    { mode: "async", legacy: false, recoveryTimeout: true },
    { mode: "async", legacy: true, recoveryTimeout: true },
    { mode: "async", legacy: false, dispatchTimeout: "before commit", expireCreate: true },
    {
      mode: "async",
      legacy: false,
      dispatchTimeout: "before commit",
      expireCreate: true,
      failCreate: true,
    },
    { mode: "async", legacy: false, dispatchTimeout: "before commit" },
    { mode: "async", legacy: false, dispatchTimeout: "after commit" },
    { mode: "async", legacy: false, dispatchTimeout: "before commit", worktree: true },
    { mode: "async", legacy: false, dispatchTimeout: "after commit", worktree: true },
    {
      mode: "async",
      legacy: false,
      dispatchTimeout: "before commit",
      worktree: true,
      concurrentRetry: true,
    },
    { mode: "wait", legacy: false, dispatchTimeout: "before commit", worktree: true },
    { mode: "async", legacy: false, dispatchTimeout: "before commit", concurrentRetry: true },
    { mode: "async", legacy: true, dispatchTimeout: "before commit" },
    { mode: "wait", legacy: false, dispatchTimeout: "before commit", noRetry: true },
    {
      mode: "wait",
      legacy: false,
      dispatchTimeout: "before commit",
      noRetry: true,
      worktree: true,
    },
    { mode: "wait", legacy: false, dispatchTimeout: "after commit", noRetry: true },
    { mode: "wait", legacy: false, dispatchTimeout: "after commit", noRetry: true, worktree: true },
    { mode: "async", legacy: false, dispatchTimeout: "before commit", noRetry: true },
    {
      mode: "async",
      legacy: false,
      dispatchTimeout: "before commit",
      noRetry: true,
      worktree: true,
    },
    { mode: "async", legacy: false, dispatchTimeout: "after commit", noRetry: true },
    {
      mode: "async",
      legacy: false,
      dispatchTimeout: "after commit",
      noRetry: true,
      worktree: true,
    },
    {
      mode: "wait",
      legacy: false,
      dispatchTimeout: "after commit",
      noRetry: true,
      finishBeforeRelease: true,
    },
    {
      mode: "wait",
      legacy: false,
      dispatchTimeout: "after commit",
      noRetry: true,
      finishBeforeRelease: true,
      worktree: true,
    },
    { mode: "wait", legacy: true, dispatchTimeout: "before commit", noRetry: true },
  ] as const)(
    "replays the same delegation across any namespace rebind ($mode, legacy=$legacy, stillRunning=$stillRunning, recoveryTimeout=$recoveryTimeout, dispatchTimeout=$dispatchTimeout, concurrentRetry=$concurrentRetry, worktree=$worktree, noRetry=$noRetry, finishBeforeRelease=$finishBeforeRelease, expireCreate=$expireCreate, failCreate=$failCreate)",
    (testCase) => {
      const { mode, legacy } = testCase;
      const stillRunning = "stillRunning" in testCase;
      const recoveryTimeout = "recoveryTimeout" in testCase;
      const dispatchTimeout = "dispatchTimeout" in testCase ? testCase.dispatchTimeout : undefined;
      return Effect.scoped(
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("codex");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            {
              instanceId: codexInstanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.die("No provider process is needed to test receipt replay."),
            },
          ]);
          const database = SqlitePersistence.layerMemory;
          const orchestratorLayer = ProviderReplayHarness.layerWithRegistry(
            { name: `mcp-delegate-retry-${mode}` },
            layerRegistry,
            { databaseLayer: database, runEffectWorker: false },
          );
          const settings = ServerSettings.layerTest();
          const firstWatch = yield* Deferred.make<void>();
          const secondWatch = yield* Deferred.make<void>();
          const watchCount = yield* Ref.make(0);
          const recoveryEntered = yield* Deferred.make<void>();
          const recoveryRelease = yield* Deferred.make<void>();
          const recoveryStopped = yield* Deferred.make<void>();
          const dispatchEntered = yield* Deferred.make<void>();
          const dispatchRelease = yield* Deferred.make<void>();
          const dispatchFinished = yield* Deferred.make<void>();
          const wakeUpgraded = yield* Deferred.make<void>();
          const prepared = yield* Deferred.make<void>();
          let blockDispatch = dispatchTimeout !== undefined;
          let blockRecovery = false;
          const heldOrchestrator = Layer.effect(
            Orchestrator.OrchestratorV2,
            Effect.gen(function* () {
              const real = yield* Orchestrator.OrchestratorV2;
              return {
                ...real,
                dispatch: (command) =>
                  Effect.gen(function* () {
                    if (command.type !== "delegated_task.request" || !blockDispatch)
                      return yield* real.dispatch(command);
                    blockDispatch = false;
                    const hold = Deferred.succeed(dispatchEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(dispatchRelease)),
                    );
                    if (dispatchTimeout === "before commit") yield* hold;
                    if ("failCreate" in testCase)
                      return yield* new Orchestrator.OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        cause: "create failed before commit",
                      });
                    const result = yield* real.dispatch(command);
                    if (dispatchTimeout === "after commit") yield* hold;
                    return result;
                  }),
              };
            }),
          ).pipe(Layer.provideMerge(orchestratorLayer));
          const threads = ThreadManagementService.layer.pipe(
            Layer.provide(heldOrchestrator),
            Layer.provideMerge(orchestratorLayer),
            Layer.provide(
              LegacyV1ThreadImporter.layer.pipe(
                Layer.provide(orchestratorLayer),
                Layer.provide(database),
              ),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
            Layer.provideMerge(settings),
          );
          const threadsWithWatchSignal = Layer.effect(
            ThreadManagementService.ThreadManagementService,
            Effect.gen(function* () {
              const real = yield* ThreadManagementService.ThreadManagementService;
              return {
                ...real,
                dispatch: (command) =>
                  Effect.gen(function* () {
                    if (command.type === "delegated_task.wake-policy") {
                      return yield* real
                        .dispatch(command)
                        .pipe(Effect.tap(() => Deferred.succeed(wakeUpgraded, undefined)));
                    }
                    return yield* real
                      .dispatch(command)
                      .pipe(
                        Effect.ensuring(
                          command.type === "delegated_task.request"
                            ? Deferred.succeed(dispatchFinished, undefined)
                            : Effect.void,
                        ),
                      );
                  }),
                getThreadRecords: (threadId, fields, filter, options) =>
                  Effect.gen(function* () {
                    if (blockRecovery && filter?.messageRoles?.includes("user")) {
                      yield* Deferred.succeed(recoveryEntered, undefined);
                      yield* Deferred.await(recoveryRelease).pipe(
                        Effect.ensuring(Deferred.succeed(recoveryStopped, undefined)),
                      );
                    }
                    return yield* real.getThreadRecords(threadId, fields, filter, options);
                  }),
                getThreadEventSequence: (threadId) =>
                  real
                    .getThreadEventSequence(threadId)
                    .pipe(
                      Effect.tap(() =>
                        Ref.updateAndGet(watchCount, (count) => count + 1).pipe(
                          Effect.flatMap((count) =>
                            Deferred.succeed(count === 1 ? firstWatch : secondWatch, undefined),
                          ),
                        ),
                      ),
                    ),
              } satisfies ThreadManagementService.ThreadManagementServiceShape;
            }),
          ).pipe(Layer.provideMerge(threads));
          const layerTest = OrchestratorMcpService.layer.pipe(
            Layer.provideMerge(threadsWithWatchSignal),
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                layerRegistry,
                settings,
                providerRegistryLayer([
                  providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                ]),
                Layer.effect(
                  ThreadLaunchService.ThreadLaunchService,
                  Effect.gen(function* () {
                    const real = yield* Orchestrator.OrchestratorV2;
                    const mock = yield* ThreadLaunchService.ThreadLaunchService;
                    return {
                      ...mock,
                      prepareRun: (input) =>
                        Effect.gen(function* () {
                          const projection = yield* real.getThreadProjection(input.threadId);
                          if (
                            projection.runs.find((run) => run.id === input.runId)?.status ===
                            "preparing"
                          ) {
                            yield* real.dispatch({
                              type: "prepared-run.release",
                              commandId: CommandId.make(`${input.commandId}:release`),
                              threadId: input.threadId,
                              runId: input.runId,
                            });
                          }
                          yield* Deferred.succeed(prepared, undefined);
                        }).pipe(Effect.orDie),
                    } satisfies ThreadLaunchService.ThreadLaunchService["Service"];
                  }),
                ).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      orchestratorLayer,
                      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                    ),
                  ),
                ),
                Layer.mock(GitVcsDriver.GitVcsDriver)({
                  resolveCommit: () => Effect.succeed({ commitSha: "abc123" } as never),
                }),
                Layer.mock(ProjectService.ProjectService)({
                  getById: () =>
                    Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
                }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("parent:message"),
              text: "Delegate a review.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const request = {
              task: "Review.",
              mode,
              timeoutMs: 1_000,
              clientRequestId: `delegate-replay-${mode}`,
              ...("worktree" in testCase ? { isolation: "worktree" as const } : {}),
            } as const;
            if (legacy) {
              const parent = yield* orchestrator.getThreadProjection(parentThreadId);
              const run = parent.runs[0]!;
              yield* orchestrator.dispatch({
                type: "delegated_task.request",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: CommandId.make(
                  `command:mcp:${encodeURIComponent("expired-credential")}:delegate-task:${encodeURIComponent(request.clientRequestId)}`,
                ),
                parentThreadId,
                parentRunId: run.id,
                parentNodeId: run.rootNodeId!,
                task: "Review.",
                modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
                runtimeMode: "full-access",
                interactionMode: "default",
              });
            }
            let timeoutTaskId: string | undefined;
            if (dispatchTimeout !== undefined) {
              const timedCall = yield* service
                .delegateTask(scope, request)
                .pipe(Effect.flip, Effect.forkScoped);
              yield* Deferred.await(dispatchEntered);
              yield* TestClock.adjust("10 seconds");
              const error = yield* Fiber.join(timedCall);
              assert.equal(error.code, "delegation_timeout");
              timeoutTaskId =
                /Task (\S+) may still be created; use task_status to check whether it was saved\./.exec(
                  error.message,
                )?.[1];
              assert.isDefined(timeoutTaskId);
              assert.include(error.message, `clientRequestId: ${request.clientRequestId}.`);
              const recoveringId = NodeId.make(timeoutTaskId!);
              if (!legacy && dispatchTimeout === "before commit") {
                const missing = yield* service.taskStatus(scope, recoveringId).pipe(Effect.flip);
                assert.equal(missing.code, "task_not_found");
                assert.include(missing.message, "was not found for thread");
                assert.notInclude(missing.message, "does not belong");
                assert.include(missing.message, "This delegation is still being created");
                assert.include(missing.message, "retry task_status with this task id");
                assert.include(missing.message, "same clientRequestId");
              } else {
                const accepted = yield* service.taskStatus(scope, recoveringId);
                assert.equal(accepted.taskId, recoveringId);
              }
              const concurrent =
                "concurrentRetry" in testCase
                  ? yield* service.delegateTask(scope, request).pipe(Effect.forkScoped)
                  : undefined;
              if ("expireCreate" in testCase) {
                const threads = yield* ThreadManagementService.ThreadManagementService;
                const commandId = CommandId.make(
                  decodeURIComponent(recoveringId.slice("node:delegated-task:".length)),
                );
                assert.isTrue(Option.isNone(yield* threads.getCommandReceipt(commandId)));
                assert.lengthOf(
                  (yield* orchestrator.getThreadProjection(parentThreadId)).subagents,
                  0,
                );
                if ("failCreate" in testCase) yield* Deferred.succeed(dispatchRelease, undefined);
                else yield* TestClock.adjust("110 seconds");
                yield* Deferred.await(dispatchFinished);
                assert.isTrue(Option.isNone(yield* threads.getCommandReceipt(commandId)));
                assert.lengthOf(
                  (yield* orchestrator.getThreadProjection(parentThreadId)).subagents,
                  0,
                );
                for (const read of [
                  service.taskStatus(scope, recoveringId).pipe(Effect.asVoid),
                  service.cancelTask(scope, { taskId: recoveringId }).pipe(Effect.asVoid),
                ]) {
                  const missing = yield* read.pipe(Effect.flip);
                  assert.include(
                    missing.message,
                    "failCreate" in testCase
                      ? "This delegation was not created: the create stopped after 10 s waiting at dispatch/threadManagement.dispatch (failure: OrchestratorDispatchError:"
                      : "This delegation was not created: the create stopped after 120 s waiting at dispatch/threadManagement.dispatch (interrupt). Nothing ran. Retry delegate_task with the same clientRequestId.",
                  );
                  assert.notInclude(missing.message, "still being created");
                  assert.include(
                    missing.message,
                    "Nothing ran. Retry delegate_task with the same clientRequestId.",
                  );
                }
              }
              if ("finishBeforeRelease" in testCase) {
                const early = yield* service.taskStatus(scope, recoveringId);
                assert.isFalse(early.partial);
                if (early.partial) return assert.fail("expected the committed child");
                const child = yield* orchestrator.getThreadProjection(early.childThreadId);
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("no-retry:finish-before-return"),
                  threadId: early.childThreadId,
                  runId: child.runs[0]!.id,
                });
                yield* orchestrator.recoverDelegatedTasks;
              }
              yield* Deferred.succeed(dispatchRelease, undefined);
              yield* Deferred.await(dispatchFinished);
              if ("worktree" in testCase) yield* Deferred.await(prepared);
              if (concurrent !== undefined)
                assert.equal((yield* Fiber.join(concurrent)).taskId, recoveringId);
              if (!("finishBeforeRelease" in testCase) && !("expireCreate" in testCase)) {
                const recovered = yield* service.taskStatus(scope, recoveringId);
                assert.equal(recovered.taskId, recoveringId);
                if ("worktree" in testCase && !recovered.partial) {
                  const child = yield* orchestrator.getThreadProjection(recovered.childThreadId);
                  assert.notEqual(child.runs[0]!.status, "preparing");
                }
              }
            }
            if ("noRetry" in testCase && timeoutTaskId !== undefined) {
              if (mode === "wait") yield* Deferred.await(wakeUpgraded);
              const lateParent = yield* orchestrator.getThreadProjection(parentThreadId);
              const lateTask = lateParent.subagents.find((task) => task.id === timeoutTaskId)!;
              assert.isTrue(lateParent.runs.some(ThreadManagementService.isActiveRun));
              assert.equal(lateParent.subagents.length, 1);
              assert.equal(lateTask.completionWake, "always");
              if (!("finishBeforeRelease" in testCase)) {
                const child = yield* orchestrator.getThreadProjection(lateTask.childThreadId!);
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("no-retry:finish-child"),
                  threadId: lateTask.childThreadId!,
                  runId: child.runs[0]!.id,
                });
                yield* orchestrator.recoverDelegatedTasks;
              }
              const after = yield* orchestrator.getThreadProjection(parentThreadId);
              const finished = after.subagents.find((task) => task.id === timeoutTaskId)!;
              assert.equal(finished.status, "interrupted");
              assert.equal(finished.completionDelivery?.state, "claimed");
              return;
            }
            const firstCall = yield* service.delegateTask(scope, request).pipe(Effect.forkScoped);
            if (mode === "wait") {
              yield* Deferred.await(firstWatch);
              yield* TestClock.adjust(1_000);
            }
            const first = yield* Fiber.join(firstCall);
            if (timeoutTaskId !== undefined) assert.equal(first.taskId, timeoutTaskId);
            if ("expireCreate" in testCase) {
              const recovered = yield* service.taskStatus(scope, first.taskId);
              assert.equal(recovered.taskId, first.taskId);
              assert.lengthOf(
                (yield* orchestrator.getThreadProjection(parentThreadId)).subagents,
                1,
              );
            }
            assert.equal(first.waitTimedOut, mode === "wait");
            if ("parentRestart" in testCase) {
              const parent = yield* orchestrator.getThreadProjection(parentThreadId);
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("restart-parent:interrupt"),
                threadId: parentThreadId,
                runId: parent.runs[0]!.id,
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("restart-parent:resume"),
                threadId: parentThreadId,
                messageId: MessageId.make("restart-parent:message"),
                text: "Continue after restart.",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
            }
            const renewedScope = {
              ...scope,
              requestNamespace: "provider-session:renewed",
              thread: { ...scope.thread!, providerSessionId: "provider-session:renewed" },
            };
            const retry = yield* service
              .delegateTask(renewedScope, request)
              .pipe(Effect.forkScoped);
            if (mode === "wait") {
              yield* Deferred.await(secondWatch);
              yield* TestClock.adjust(500);
              assert.isUndefined(retry.pollUnsafe(), "retry must wait for the existing child");
              if (stillRunning) {
                yield* TestClock.adjust(500);
                assert.isDefined(retry.pollUnsafe(), "a replay must answer inside its own budget");
              } else
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("interrupt-child"),
                  threadId: first.childThreadId,
                  runId: first.childRunId!,
                });
            }
            const replayed = yield* Fiber.join(retry);
            assert.equal(replayed.taskId, first.taskId);
            assert.equal(replayed.childThreadId, first.childThreadId);
            assert.equal(replayed.childRunId, first.childRunId);
            if (mode === "wait") {
              assert.equal(replayed.status, stillRunning ? "running" : "interrupted");
              assert.equal(replayed.waitTimedOut, stillRunning);
            }
            const parentBeforeSend = yield* orchestrator.getThreadProjection(parentThreadId);
            const childBeforeSend = yield* orchestrator.getThreadProjection(first.childThreadId);
            assert.equal(parentBeforeSend.subagents.length, 1);
            assert.equal(childBeforeSend.runs.length, 1);
            const send = {
              threadId: first.childThreadId,
              message: "Follow up.",
              mode: "queue" as const,
              clientRequestId: "send-across-rebind",
            };
            if (legacy) {
              const threads = yield* ThreadManagementService.ThreadManagementService;
              yield* threads.sendToThread({
                projectId,
                threadId: first.childThreadId,
                senderThreadId: parentThreadId,
                commandId: CommandId.make(
                  "command:mcp:expired-binding:thread-send:send-across-rebind",
                ),
                messageId: MessageId.make(
                  "message:mcp:expired-binding:thread-send:send-across-rebind",
                ),
                text: send.message,
                attachments: [],
                mode: "queue",
                createdBy: "agent",
                creationSource: "mcp",
              });
            }
            if (recoveryTimeout) {
              blockRecovery = true;
              const waiting = yield* service
                .sendToThread(scope, send)
                .pipe(Effect.result, Effect.forkScoped);
              yield* Deferred.await(recoveryEntered);
              yield* TestClock.adjust("15 seconds");
              const timedOut = yield* Fiber.join(waiting);
              assert.equal(timedOut._tag, "Failure");
              if (timedOut._tag === "Failure") {
                assert.equal(timedOut.failure.code, "send_timeout");
                assert.include(timedOut.failure.message, send.clientRequestId);
              }
              yield* Deferred.await(recoveryStopped);
              blockRecovery = false;
              yield* Deferred.succeed(recoveryRelease, undefined);
              const afterTimeout = yield* orchestrator.getThreadProjection(first.childThreadId);
              assert.equal(
                afterTimeout.messages.filter((message) => message.text === send.message).length,
                legacy ? 1 : 0,
              );
              assert.equal(
                afterTimeout.runs.length,
                childBeforeSend.runs.length + (legacy ? 1 : 0),
              );
            }
            const sent = yield* service.sendToThread(recoveryTimeout ? renewedScope : scope, send);
            const afterSend = yield* orchestrator.getThreadProjection(first.childThreadId);
            const resent = yield* service.sendToThread(
              recoveryTimeout ? scope : renewedScope,
              send,
            );
            assert.equal(resent.messageId, sent.messageId);
            if (legacy)
              assert.equal(
                sent.messageId,
                "message:mcp:expired-binding:thread-send:send-across-rebind",
              );
            const child = yield* orchestrator.getThreadProjection(first.childThreadId);
            assert.equal(child.runs.length, afterSend.runs.length);
            assert.equal(
              child.messages.filter((message) => message.id === sent.messageId).length,
              1,
            );
            assert.equal(
              child.messages.filter((message) => message.text === send.message).length,
              1,
            );
          }).pipe(Effect.provide(layerTest));
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("leaves models the user hid out of the capability catalog", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-5.4-mini", "my-model"], modelOrder: [] },
          },
        }),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              ...codex.models,
              { slug: "gpt-5.4-mini", name: "Mini", isCustom: false, capabilities: null },
              { slug: "my-model", name: "Mine", isCustom: true, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((model) => model.id),
          ["gpt-5.4", "my-model"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    {
      name: "installation",
      snapshot: { installed: false, version: null, status: "warning", auth: { status: "unknown" } },
      constraints: ["Provider executable is not installed."],
    },
    {
      name: "health",
      snapshot: { status: "error", message: "Provider health check failed." },
      constraints: ["Provider health check failed."],
    },
    {
      name: "authentication",
      snapshot: { auth: { status: "unauthenticated" } },
      constraints: ["Provider is not authenticated."],
    },
    {
      name: "combined installation and health",
      snapshot: {
        installed: false,
        version: null,
        status: "error",
        message: "Provider executable could not be found.",
        auth: { status: "unknown" },
      },
      constraints: [
        "Provider executable is not installed.",
        "Provider executable could not be found.",
      ],
    },
    {
      name: "disabled with stale probe failures",
      snapshot: {
        enabled: false,
        installed: false,
        version: null,
        status: "error",
        message: "Stale provider health failure.",
        auth: { status: "unauthenticated" },
      },
      constraints: ["Provider instance is disabled."],
    },
  ] as const)("reports $name provider constraints", (testCase) =>
    Effect.gen(function* () {
      const provider: ServerProvider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...testCase.snapshot,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const entry = capabilities.providers.find(
          (candidate) => candidate.providerInstanceId === codexInstanceId,
        );
        assert.isDefined(entry);
        assert.isFalse(entry!.canRunChildTask);
        assert.isFalse(entry!.canRunCrossProviderChildTask);
        assert.deepEqual(entry!.constraints, testCase.constraints);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        let currentChild = {
          ...childProjection,
          runs: [
            {
              id: RunId.make("run:mcp-providers-child"),
              threadId: childThreadId,
              activeAttemptId: RunAttemptId.make("attempt:mcp-providers-child"),
              requestedAt: DateTime.makeUnsafe("2026-11-04T12:00:00Z"),
              delegatedTaskId: taskId,
              ordinal: 1,
              status: "starting",
              startedAt: null,
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : currentChild,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.isTrue(result.startPending);
          assert.isNull(result.startedAt);
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const originalRun = currentChild.runs[0]!;
          currentChild = {
            ...currentChild,
            runs: [
              {
                ...originalRun,
                status: "running",
                startedAt: DateTime.makeUnsafe("2026-11-04T12:00:00Z"),
              },
            ],
          };
          const started = yield* service.taskStatus(scope, taskId);
          assert.equal(started.status, "running");
          assert.isTrue(started.startPending);
          assert.equal(started.startProgress?.step, "awaiting_native_acceptance");
          assert.equal(started.startedAt, "2026-11-04T12:00:00.000Z");
          currentChild = {
            ...currentChild,
            providerTurns: [
              {
                id: ProviderTurnId.make("native-ack"),
                providerThreadId: ProviderThreadId.make("pt"),
                nodeId: NodeId.make("delegated-native-node"),
                runAttemptId: originalRun.activeAttemptId,
                ordinal: 1,
                status: "running",
                nativeTurnRef: null,
                startedAt: DateTime.makeUnsafe("2026-11-04T12:00:00Z"),
                completedAt: null,
                promptAcceptedAt: DateTime.makeUnsafe("2026-11-04T12:00:01Z"),
              },
            ],
          };
          const acknowledged = yield* service.taskStatus(scope, taskId);
          assert.isFalse(acknowledged.startPending);
          assert.isNull(acknowledged.startProgress);
          for (const [status, expected] of [
            ["preparing", true],
            ["starting", true],
            ["queued", false],
            ["running", true],
            ["waiting", false],
          ] as const) {
            currentChild = {
              ...currentChild,
              runs: [{ ...originalRun, status, startedAt: null }],
              providerTurns: [],
            };
            const pending = yield* service.taskStatus(scope, taskId);
            assert.equal(pending.startPending, expected, status);
            assert.isNull(pending.startedAt);
          }
          for (const status of ["starting", "running"] as const) {
            const recovery = {
              ...originalRun,
              id: RunId.make("run:mcp-providers-recovery"),
              activeAttemptId: RunAttemptId.make("attempt:mcp-providers-recovery"),
              ordinal: 2,
              status,
            };
            currentChild = {
              ...currentChild,
              runs: [
                {
                  ...originalRun,
                  status: "interrupted",
                  startedAt: DateTime.makeUnsafe("2026-11-04T12:00:00Z"),
                },
                recovery,
              ],
              providerTurns: [],
            };
            const pending = yield* service.taskStatus(scope, taskId);
            assert.equal(pending.childRunId, originalRun.id);
            assert.equal(pending.startedAt, "2026-11-04T12:00:00.000Z");
            assert.equal(pending.currentRunId, recovery.id);
            assert.equal(pending.currentRunStatus, status);
            assert.isTrue(pending.startPending);
            assert.equal(pending.startProgress?.runId, recovery.id);
            assert.equal(pending.startProgress?.attemptId, recovery.activeAttemptId);
          }
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses delegation to a provider the project turned off", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: codexInstanceId,
              }),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-disabled-1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.live.each([
    { name: "parent instance", parentEnabled: true, model: "gpt-5.4" },
    { name: "alternate instance", parentEnabled: false, model: "gpt-5.5" },
    ...[true, false].flatMap((parentEnabled) =>
      ["same binding", "rebound binding", "unlinked rebound binding"].flatMap((legacy) =>
        [false, true].map((promptAccepted) => ({
          name: `legacy ${legacy} / parent=${parentEnabled} / prompt=${promptAccepted}`,
          parentEnabled,
          model: parentEnabled ? "gpt-5.4" : "gpt-5.5",
          legacy,
          promptAccepted,
        })),
      ),
    ),
  ])(
    "replays accepted creation on the $name without authorizing new disabled work",
    ({ parentEnabled, model, ...testCase }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const altInstanceId = ProviderInstanceId.make("codex-alt");
          const driver = ProviderDriverKind.make("codex");
          const cwd = yield* checkpointWorkspace("mcp-create-retry");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
            [codexInstanceId, altInstanceId].map((instanceId) => ({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.die("These tests exercise committed commands before provider execution."),
            })),
          );
          const layerDatabase = SqlitePersistence.layerMemory;
          const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
            { name: "mcp-create-retry", runtimePolicyOverride: { cwd } },
            layerRegistry,
            { databaseLayer: layerDatabase, runEffectWorker: false },
          );
          const layerSettings = ServerSettings.layerTest({
            providerInstances: {
              [codexInstanceId]: { driver: "codex", enabled: true },
              [altInstanceId]: { driver: "codex", enabled: true },
            },
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [codexInstanceId]: { enabled: parentEnabled } } },
            },
          });
          const layerThreads = ThreadManagementService.layer.pipe(
            Layer.provideMerge(layerOrchestrator),
            Layer.provide(
              LegacyV1ThreadImporter.layer.pipe(
                Layer.provide(layerOrchestrator),
                Layer.provide(layerDatabase),
              ),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
            Layer.provideMerge(layerSettings),
          );
          const layerTest = layerOrchestratorService.pipe(
            Layer.provideMerge(layerThreads),
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                layerRegistry,
                layerSettings,
                providerRegistryLayer([
                  providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                  providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
                ]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("parent:message"),
              text: "Create a thread.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const request = {
              threads: [{ target: { driverKind: driver, model } }],
              clientRequestId: "create-retry",
            };
            const selection = parentEnabled
              ? { instanceId: codexInstanceId, model: "gpt-5.4" }
              : { instanceId: altInstanceId, model: "gpt-5.5" };
            const legacyId = ThreadId.make(
              `thread:mcp:${encodeURIComponent(scope.requestNamespace)}:create-retry:0`,
            );
            let retryScope = scope;
            if ("legacy" in testCase) {
              const commandId = (operation: string) =>
                CommandId.make(
                  `command:mcp:${encodeURIComponent(scope.requestNamespace)}:${operation}:create-retry:0`,
                );
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: commandId("create-thread"),
                threadId: legacyId,
                projectId,
                title: "Legacy created thread",
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "agent",
                creationSource: "mcp",
              });
              if (testCase.promptAccepted)
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: commandId("dispatch-thread"),
                  threadId: legacyId,
                  messageId: MessageId.make(
                    `message:mcp:${encodeURIComponent(scope.requestNamespace)}:create-retry:0`,
                  ),
                  senderThreadId: parentThreadId,
                  text: "Start work.",
                  attachments: [],
                  modelSelection: selection,
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "agent",
                  creationSource: "mcp",
                });
              if (testCase.legacy !== "same binding") {
                if (testCase.legacy === "rebound binding") {
                  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
                  yield* orchestrator.dispatch({
                    type: "thread.created.record",
                    commandId: commandId("record-created-thread"),
                    parentThreadId,
                    parentRunId: parent.runs[0]!.id,
                    parentNodeId: parent.runs[0]!.rootNodeId!,
                    targetThreadId: legacyId,
                    targetRunId: null,
                  });
                }
                retryScope = {
                  ...scope,
                  requestNamespace: "new-catalog-binding",
                  thread: { ...scope.thread!, providerSessionId: "new-catalog-binding" },
                };
              }
            }
            if (
              "legacy" in testCase &&
              testCase.legacy === "unlinked rebound binding" &&
              !testCase.promptAccepted
            ) {
              const error = yield* service.createThreads(retryScope, request).pipe(Effect.flip);
              assert.equal(error.code, "ambiguous_replay");
              assert.include(error.message, "t3_thread_list");
              const threads = yield* ThreadManagementService.ThreadManagementService;
              assert.equal(
                (yield* threads.listProjectThreads({ projectId, includeSubagents: true })).length,
                2,
              );
              const legacy = yield* orchestrator.getThreadProjection(legacyId);
              assert.equal(legacy.messages.length, 0);
              assert.equal(legacy.runs.length, 0);
              const parent = yield* orchestrator.getThreadProjection(parentThreadId);
              assert.equal(
                parent.turnItems.filter((item) => item.type === "thread_created").length,
                0,
              );
              return;
            }
            const first = yield* service.createThreads(retryScope, request);
            if ("legacy" in testCase) assert.equal(first.threads[0]?.threadId, legacyId);

            const child = first.threads[0]!;
            assert.equal(first.threads.length, 1);
            assert.equal(child.providerInstanceId, selection.instanceId);
            assert.equal(child.model, selection.model);
            assert.deepEqual(yield* service.createThreads(retryScope, request), first);

            // The creation receipt exists, but this prompt has not been accepted yet.
            const withPrompt = {
              ...request,
              threads: [{ ...request.threads[0]!, prompt: "Start work." }],
            };
            const started = yield* service.createThreads(retryScope, withPrompt);
            assert.equal(started.threads[0]?.threadId, child.threadId);
            const before = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(before.runs[0]?.modelSelection, selection);
            assert.equal(before.messages.length, 1);
            assert.equal(before.runs.length, 1);
            const parentRecords = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              parentRecords.turnItems.filter(
                (item) => item.type === "thread_created" && item.targetThreadId === child.threadId,
              ).length,
              1,
            );
            const empty = yield* service.createThreads(retryScope, {
              ...request,
              clientRequestId: "empty",
            });

            yield* settings.updateSettings({
              projectSettingsOverrides: {
                [projectId]: {
                  providerInstances: {
                    [codexInstanceId]: { enabled: false },
                    [altInstanceId]: { enabled: false },
                  },
                },
              },
            });
            assert.deepEqual(yield* service.createThreads(retryScope, withPrompt), started);
            const after = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(after.thread.modelSelection, selection);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);

            const freshError = yield* service
              .createThreads(retryScope, {
                ...request,
                clientRequestId: "fresh",
              })
              .pipe(Effect.flip);
            assert.equal(freshError.code, "provider_unavailable");
            const promptError = yield* service
              .createThreads(retryScope, {
                ...withPrompt,
                clientRequestId: "empty",
              })
              .pipe(Effect.flip);
            assert.equal(promptError.code, "invalid_request");
            assert.include(promptError.message, "disabled");
            const untouched = yield* orchestrator.getThreadProjection(empty.threads[0]!.threadId);
            assert.equal(untouched.messages.length, 0);
            assert.equal(untouched.runs.length, 0);
          }).pipe(Effect.provide(layerTest));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          getThreadShell: (id) =>
            Effect.succeed({ ...liveThreadShell(id), ...parentProjection([]).thread }),
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (id) =>
                Effect.succeed({
                  ...liveThreadShell(id),
                  ...parentProjection([], parentModelSelection).thread,
                }),
              getThreadShell: (id) =>
                Effect.succeed({
                  ...liveThreadShell(id),
                  ...parentProjection([], parentModelSelection).thread,
                }),
              hasReceipt: () => Effect.succeed(false),
              findMcpThreadCreations: () => Effect.succeed([]),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.equal(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.equal(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getCallerRow: () => Effect.succeed(shell),
                    getThreadShell: () => Effect.succeed(shell),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getCallerRow: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });
  it.effect(
    "reports the child run's selection after a restart and the thread selection before launch",
    () =>
      Effect.gen(function* () {
        const runSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent-personal"),
          model: "claude-opus-4-6",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        } as const;
        const threadSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        let hasRun = true;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection([task])
                  : ({
                      ...childProjection,
                      thread: { ...childProjection.thread, modelSelection: threadSelection },
                      runs: hasRun
                        ? [
                            {
                              id: RunId.make("run:mcp-restarted-child"),
                              ordinal: 1,
                              status: "running",
                              modelSelection: runSelection,
                            },
                          ]
                        : [],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const selection of [runSelection, threadSelection]) {
            const result = yield* service.taskStatus(scope, taskId);
            assert.equal(result.providerInstanceId, selection.instanceId);
            assert.equal(result.model, selection.model);
            assert.deepEqual(result.options, selection.options);
            hasRun = false;
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect(
    "inherits delegated options, merges overrides, and resets on explicit clearing or a new target",
    () =>
      Effect.gen(function* () {
        const peerId = ProviderInstanceId.make("codex-subscription-2");
        const driver = ProviderDriverKind.make("codex");
        const inherited = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        } as const;
        const override = [{ id: "reasoningEffort", value: "max" }] as const;
        const cases = [
          {
            name: "partial override",
            target: { options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            name: "clear with array",
            target: { options: [] },
            expected: { ...inherited, options: [] },
          },
          {
            name: "clear with object",
            target: { options: {} },
            expected: { ...inherited, options: [] },
          },
          {
            name: "change model",
            target: { model: "other-model" },
            expected: { instanceId: codexInstanceId, model: "other-model" },
          },
          {
            name: "change provider with override",
            target: { providerInstanceId: peerId, options: { reasoningEffort: "max" } },
            expected: { instanceId: peerId, model: inherited.model, options: override },
          },
        ] as const;
        for (const testCase of cases) {
          const commands: Array<unknown> = [];
          const task = {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            providerInstanceId: testCase.expected.instanceId,
            model: testCase.expected.model,
            status: "running",
            result: null,
          };
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (id) =>
                Effect.succeed({
                  ...liveThreadShell(id),
                  ...parentProjection([], inherited).thread,
                }),
              getThreadShell: (id) =>
                Effect.succeed({
                  ...liveThreadShell(id),
                  ...parentProjection([], inherited).thread,
                }),
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                    : childProjection,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return {
                    sequence: 1,
                    storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                  } as never;
                }),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: inherited.model,
                }),
                models: [inherited.model, "other-model"].map((model) => ({
                  slug: model,
                  name: model,
                  isCustom: false,
                  capabilities: null,
                })),
              },
              providerSnapshot({ instanceId: peerId, driver, model: inherited.model }),
            ]),
            adapterRegistryLayer([codexInstanceId, peerId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(capabilities.inheritedOptions, inherited.options);
            yield* service.delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget(testCase.target),
              mode: "async",
              clientRequestId: testCase.name,
            });
            assert.deepEqual(
              (commands[0] as { modelSelection: unknown }).modelSelection,
              testCase.expected,
              testCase.name,
            );
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }
      }),
  );

  it.effect("drops obsolete inherited options while validating explicit delegated options", () =>
    Effect.gen(function* () {
      const claude = ProviderInstanceId.make("claudeAgent");
      const high = { id: "effort", value: "high" } as const;
      const xhigh = { id: "effort", value: "xhigh" } as const;
      const stale = { id: "retiredOption", value: false } as const;
      const cases = [
        { name: "object override", target: { options: { effort: "xhigh" } }, expected: [xhigh] },
        { name: "array override", target: { options: [xhigh] }, expected: [xhigh] },
        { name: "no override", expected: [high] },
        {
          name: "explicit standard marker",
          target: { options: { fastMode: false } },
          expected: [high, { id: "fastMode", value: false }],
        },
        { name: "array clear", target: { options: [] }, expected: [] },
        { name: "object clear", target: { options: {} }, expected: [] },
        {
          name: "explicit true",
          target: { options: [{ id: "retiredOption", value: true }] },
          error: "Unknown option retiredOption",
        },
        {
          name: "explicit false",
          target: { options: { retiredOption: false } },
          error: "Unknown option retiredOption",
        },
        {
          name: "obsolete select",
          inherited: [{ id: "effort", value: "ultra" }, stale],
          reportedOptions: [],
          expected: [],
        },
        {
          name: "obsolete select overridden",
          inherited: [{ id: "effort", value: "ultra" }, stale],
          reportedOptions: [],
          target: { options: { effort: "xhigh" } },
          expected: [xhigh],
        },
        {
          name: "explicit obsolete select",
          target: { options: { effort: "ultra" } },
          error: "must be one of",
        },
        {
          name: "unknown descriptors",
          descriptors: undefined,
          reportedOptions: [high, stale],
          expected: [high, stale],
        },
        { name: "empty descriptors", descriptors: [], reportedOptions: [], expected: [] },
        {
          name: "legacy variant",
          inherited: [{ id: "variant", value: "high" }, stale],
          reportedOptions: [{ id: "variant", value: "high" }],
          expected: [high],
        },
      ] as const;
      for (const testCase of cases) {
        const inherited = {
          instanceId: claude,
          model: "claude-opus-5-5",
          options: "inherited" in testCase ? testCase.inherited : [high, stale],
        };
        const descriptors =
          "descriptors" in testCase
            ? testCase.descriptors
            : [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select" as const,
                  options: ["high", "xhigh"].map((id) => ({ id, label: id })),
                },
              ];
        const commands: Array<{ modelSelection: ModelSelection }> = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: claude,
          model: inherited.model,
          status: "running",
          result: null,
        };
        const provider: ServerProvider = {
          ...providerSnapshot({
            instanceId: claude,
            driver: ProviderDriverKind.make("claudeAgent"),
          }),
          models: [
            {
              slug: inherited.model,
              name: inherited.model,
              isCustom: false,
              capabilities: descriptors === undefined ? null : { optionDescriptors: descriptors },
            },
          ],
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([], inherited).thread }),
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), ...parentProjection([], inherited).thread }),
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                  : {
                      ...childProjection,
                      thread: {
                        ...childProjection.thread,
                        modelSelection: commands[0]?.modelSelection ?? inherited,
                      },
                    },
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command as unknown as { modelSelection: ModelSelection });
                return {
                  storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                } as never;
              }),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([provider]),
          adapterRegistryLayer([claude]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const expectedInheritance =
            "reportedOptions" in testCase ? testCase.reportedOptions : [high];
          assert.deepEqual(capabilities.inheritedOptions, expectedInheritance, testCase.name);
          const target = yield* decodeTarget({
            providerInstanceId: claude,
            model: inherited.model,
            ...("target" in testCase ? testCase.target : {}),
          });
          const result = yield* service
            .delegateTask(scope, {
              task: "Review.",
              target,
              mode: "async",
              clientRequestId: testCase.name,
            })
            .pipe(Effect.result);
          if ("error" in testCase) {
            assert.equal(result._tag, "Failure", testCase.name);
            if (result._tag !== "Failure") return;
            assert.equal(result.failure.code, "invalid_request");
            assert.include(result.failure.message, "rejected options");
            assert.include(result.failure.message, testCase.error);
            assert.equal(commands.length, 0);
          } else {
            assert.equal(result._tag, "Success", testCase.name);
            assert.deepEqual(
              commands[0]?.modelSelection,
              {
                instanceId: claude,
                model: inherited.model,
                ...(testCase.expected.length === 0 && !("target" in testCase)
                  ? {}
                  : { options: testCase.expected }),
              },
              testCase.name,
            );
            if (result._tag === "Success")
              assert.deepEqual(result.success.options, testCase.expected);
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }
    }),
  );

  it.effect("routes and validates the final delegated selection under the migration flag", () =>
    Effect.gen(function* () {
      const opencode = ProviderInstanceId.make("opencode");
      const claude = ProviderInstanceId.make("claudeAgent");
      const select = (id: string) => ({
        id,
        label: id,
        type: "select" as const,
        options: ["high", "max", "xhigh"].map((value) => ({ id: value, label: value })),
      });
      const haiku = "claude-haiku-5-5";
      const legacyHaiku = `opus/cc/${haiku}`;
      const snapshot = (
        instanceId: ProviderInstanceId,
        driver: string,
        model: string,
        optionDescriptors: NonNullable<
          NonNullable<ServerProvider["models"][number]["capabilities"]>["optionDescriptors"]
        >,
        extraModels: ServerProvider["models"] = [],
      ): ServerProvider => ({
        ...providerSnapshot({ instanceId, driver: ProviderDriverKind.make(driver), model }),
        models: [
          { slug: model, name: model, isCustom: false, capabilities: { optionDescriptors } },
          ...extraModels,
        ],
      });
      const legacyProvider = snapshot(
        opencode,
        "opencode",
        "opus/claude-opus-5-5#high",
        [select("variant"), { id: "fastMode", label: "fastMode", type: "boolean" }],
        [
          {
            slug: legacyHaiku,
            name: legacyHaiku,
            isCustom: false,
            capabilities: { optionDescriptors: [select("variant")] },
          },
        ],
      );
      const codexDescriptors = mapCodexModelCapabilities({
        id: "gpt-6.1-sol",
        model: "gpt-6.1-sol",
        displayName: "Sol",
        description: "",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "high",
        additionalSpeedTiers: [],
        supportedReasoningEfforts: ["high", "max", "xhigh"].map((reasoningEffort) => ({
          reasoningEffort,
          description: "",
        })),
        serviceTiers: [{ id: "priority", name: "Fast", description: "" }],
      }).optionDescriptors!;
      const providers = [
        snapshot(
          claude,
          "claudeAgent",
          "claude-opus-5-5",
          [select("effort"), { id: "fastMode", label: "fastMode", type: "boolean" }],
          [
            {
              slug: haiku,
              name: haiku,
              isCustom: false,
              capabilities: { optionDescriptors: [select("effort")] },
            },
          ],
        ),
        snapshot(codexInstanceId, "codex", "gpt-6.1-sol", codexDescriptors, [
          {
            slug: "gpt-6-astra",
            name: "Astra",
            isCustom: false,
            capabilities: {
              optionDescriptors: codexDescriptors,
            },
          },
        ]),
        snapshot(ProviderInstanceId.make("codex-cu"), "codex", "gpt-6.1-terra", codexDescriptors),
      ];
      const maxVariant = [{ id: "variant", value: "max" }] as const;
      const maxEffort = [{ id: "effort", value: "max" }] as const;
      const nativeParent = { instanceId: claude, model: "claude-opus-5-5" };
      const fast = { id: "fastMode", value: true } as const;
      const cases = [
        ...(
          [
            ["opus/cx/gpt-6.1-sol", "gpt-6.1-sol", "codex"],
            ["opus/cx/gpt-6.1-terra", "gpt-6.1-terra", "codex-cu"],
            ["opus/gpt-6-astra", "gpt-6-astra", "codex"],
            ["layso/gpt-6-astra", "gpt-6-astra", "codex"],
          ] as const
        ).flatMap(([source, model, instanceId]) =>
          (["variant", "reasoningEffort"] as const).flatMap((effortId) =>
            (["array", "record"] as const).map((shape) => ({
              name: `preserves serviceTier on ${source} remap with ${effortId} ${shape}`,
              mode: "apply" as const,
              parent: nativeParent,
              target: {
                providerInstanceId: opencode,
                model: source,
                options:
                  shape === "record"
                    ? { [effortId]: "xhigh", serviceTier: "default" }
                    : [
                        { id: effortId, value: "xhigh" },
                        { id: "serviceTier", value: "default" },
                      ],
              },
              expected: {
                instanceId: ProviderInstanceId.make(instanceId),
                model,
                options: [
                  { id: "reasoningEffort", value: "xhigh" },
                  { id: "serviceTier", value: "default" },
                ],
              },
            })),
          ),
        ),
        {
          name: "reports an explicit legacy Haiku request",
          mode: "apply",
          parent: nativeParent,
          target: { providerInstanceId: opencode, model: legacyHaiku, options: maxVariant },
          routingRequested: {
            providerInstanceId: opencode,
            model: legacyHaiku,
            options: maxVariant,
          },
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "flag off leaves an explicit legacy request unchanged",
          mode: "off",
          parent: nativeParent,
          target: { providerInstanceId: opencode, model: legacyHaiku, options: maxVariant },
          routingRequested: null,
          expected: { instanceId: opencode, model: legacyHaiku, options: maxVariant },
        },
        {
          name: "native target has no remap notice",
          mode: "apply",
          parent: nativeParent,
          target: { providerInstanceId: claude, model: haiku, options: maxEffort },
          routingRequested: null,
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "reports an inherited legacy Haiku selection",
          mode: "apply",
          parent: { instanceId: opencode, model: legacyHaiku, options: maxVariant },
          routingRequested: {
            providerInstanceId: opencode,
            model: legacyHaiku,
            options: maxVariant,
          },
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "reports a model-only legacy Haiku request from a native parent",
          mode: "apply",
          parent: nativeParent,
          target: { model: legacyHaiku, options: maxVariant },
          routingRequested: {
            providerInstanceId: opencode,
            model: legacyHaiku,
            options: maxVariant,
          },
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "reports a driver-only inherited legacy Haiku request",
          mode: "apply",
          parent: { instanceId: opencode, model: legacyHaiku, options: maxVariant },
          target: { driverKind: "opencode" },
          routingRequested: {
            providerInstanceId: opencode,
            model: legacyHaiku,
            options: maxVariant,
          },
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "reports an explicit legacy GPT request",
          mode: "apply",
          parent: nativeParent,
          target: {
            providerInstanceId: opencode,
            model: "opus/cx/gpt-6.1-sol",
            options: maxVariant,
          },
          routingRequested: {
            providerInstanceId: opencode,
            model: "opus/cx/gpt-6.1-sol",
            options: maxVariant,
          },
          expected: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        },
        {
          name: "reports an explicit non-cc Opus request",
          mode: "apply",
          parent: nativeParent,
          target: {
            providerInstanceId: opencode,
            model: "opus/claude-opus-5-5",
            options: maxVariant,
          },
          routingRequested: {
            providerInstanceId: opencode,
            model: "opus/claude-opus-5-5",
            options: maxVariant,
          },
          expected: { ...nativeParent, options: maxEffort },
        },
        {
          name: "explicit native target stays unreported when the parent is legacy",
          mode: "apply",
          parent: { instanceId: opencode, model: legacyHaiku, options: maxVariant },
          target: { providerInstanceId: claude, model: haiku },
          routingRequested: null,
          expected: { instanceId: claude, model: haiku, options: maxEffort },
        },
        {
          name: "inherits a saved standard marker without a fast catalog option",
          mode: "apply",
          hideFastDescriptor: true,
          parent: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "fastMode", value: false }],
          },
          expected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "fastMode", value: false }],
          },
        },
        {
          name: "missing flag keeps legacy",
          mode: undefined,
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          expected: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
        },
        {
          name: "dryrun keeps legacy",
          mode: "dryrun",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          expected: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
        },
        {
          name: "off keeps legacy",
          mode: "off",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          expected: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
        },
        {
          name: "apply routes suffix without source catalog lookup",
          mode: "apply",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high", options: [fast] },
          expected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }, fast],
          },
        },
        {
          name: "mapped source suffix and option agree",
          mode: "apply",
          parent: {
            instanceId: opencode,
            model: "opus/claude-opus-5-5#high",
            options: [{ id: "variant", value: "high" }, fast],
          },
          expected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }, fast],
          },
        },
        {
          name: "explicit empty options clear an inherited suffix",
          mode: "apply",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high", options: [fast] },
          target: { options: [] },
          expected: { instanceId: claude, model: "claude-opus-5-5", options: [] },
        },
        {
          name: "an explicit matching suffix and effort agree",
          mode: "apply",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          target: { model: "opus/cx/gpt-6.1-sol#max", options: { reasoningEffort: "max" } },
          expected: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        },
        {
          name: "a requested suffix conflicts with a different effort",
          mode: "apply",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          target: { model: "opus/cx/gpt-6.1-sol#max", options: { reasoningEffort: "high" } },
          error: "conflicting efforts",
        },
        {
          name: "apply maps a requested legacy model before lookup",
          mode: "apply",
          parent: { instanceId: opencode, model: "opus/claude-opus-5-5#high" },
          target: { model: "opus/cx/gpt-6.1-sol#max" },
          expected: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        },
        {
          name: "native override replaces inherited variant and retains secondary setting",
          mode: "apply",
          parent: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "variant", value: "high" }, fast],
          },
          target: { options: { effort: "max" } },
          expected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "max" }, fast],
          },
        },
        {
          name: "codex explicit effort replaces inherited variant and retains tier",
          mode: "apply",
          parent: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [
              { id: "variant", value: "high" },
              { id: "serviceTier", value: "default" },
            ],
          },
          target: { options: { reasoningEffort: "max" } },
          expected: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [
              { id: "reasoningEffort", value: "max" },
              { id: "serviceTier", value: "default" },
            ],
          },
        },
        {
          name: "native clear",
          mode: "apply",
          parent: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "variant", value: "high" }, fast],
          },
          target: { options: [] },
          expected: { instanceId: claude, model: "claude-opus-5-5", options: [] },
        },
        {
          name: "explicit effort replaces conflicting inherited efforts",
          mode: "apply",
          parent: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "variant", value: "high" }, { id: "effort", value: "max" }, fast],
          },
          target: { options: { effort: "max" } },
          expected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "max" }, fast],
          },
        },
        {
          name: "codex variant canonicalizes",
          mode: "apply",
          parent: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "variant", value: "high" }],
          },
          expected: {
            instanceId: codexInstanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
        {
          name: "invalid inherited option is rejected",
          mode: "apply",
          parent: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "fastMode", value: "yes" }],
          },
          error: "expects a boolean",
        },
        {
          name: "conflicting requested efforts are rejected",
          mode: "apply",
          parent: { instanceId: claude, model: "claude-opus-5-5" },
          target: { options: { effort: "max", variant: "high" } },
          error: "conflicting efforts",
        },
        {
          name: "duplicate requested options are rejected",
          mode: "apply",
          parent: { instanceId: claude, model: "claude-opus-5-5" },
          target: {
            options: [
              { id: "effort", value: "max" },
              { id: "effort", value: "max" },
            ],
          },
          error: "specified more than once",
        },
        {
          name: "conflicting stored suffix fails closed",
          mode: "apply",
          parent: {
            instanceId: opencode,
            model: "opus/claude-opus-5-5#high",
            options: [{ id: "variant", value: "max" }],
          },
          error: "conflicts with its effort",
        },
      ] as const;
      for (const testCase of cases) {
        const commands: Array<{
          modelSelection: ModelSelection;
          selectionRouting?: NonNullable<OrchestratorMcpDelegateTaskResult["selectionRouting"]>;
        }> = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: testCase.parent.instanceId,
          model: testCase.parent.model,
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getCallerRow: (id) =>
              Effect.succeed({
                ...liveThreadShell(id),
                ...parentProjection([], testCase.parent).thread,
              }),
            getThreadShell: (id) =>
              Effect.succeed({
                ...liveThreadShell(id),
                ...parentProjection([], testCase.parent).thread,
              }),
            getThreadRecords: ((threadId: ThreadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(
                      commands.length > 0
                        ? [
                            {
                              ...task,
                              ...(commands[0]?.selectionRouting === undefined
                                ? {}
                                : { selectionRouting: commands[0].selectionRouting }),
                            },
                          ]
                        : [],
                      testCase.parent,
                    )
                  : {
                      ...childProjection,
                      thread: {
                        ...childProjection.thread,
                        modelSelection: commands[0]?.modelSelection,
                      },
                    },
              )) as never,
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command as unknown as (typeof commands)[number]);
                return {
                  storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                } as never;
              }),
          }),
          ServerSettings.layerTest(
            testCase.mode === undefined
              ? {}
              : { ardudHarnessMigration: { selections: testCase.mode } },
          ),
          providerRegistryLayer(
            testCase.mode === "apply"
              ? "hideFastDescriptor" in testCase
                ? providers.map((provider) => ({
                    ...provider,
                    models: provider.models.map((model) => ({
                      ...model,
                      capabilities: {
                        ...model.capabilities,
                        optionDescriptors: model.capabilities?.optionDescriptors?.filter(
                          (option) => option.id !== "fastMode",
                        ),
                      },
                    })),
                  }))
                : providers
              : [legacyProvider, ...providers],
          ),
          adapterRegistryLayer([
            opencode,
            claude,
            codexInstanceId,
            ProviderInstanceId.make("codex-cu"),
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const target = "target" in testCase ? yield* decodeTarget(testCase.target) : undefined;
          const call = service.delegateTask(scope, {
            task: "Review.",
            target,
            mode: "async",
            clientRequestId: testCase.name,
          });
          if ("error" in testCase) {
            const error = yield* call.pipe(Effect.flip);
            assert.equal(error.code, "invalid_request", testCase.name);
            assert.include(error.message, testCase.error, testCase.name);
            assert.equal(commands.length, 0, testCase.name);
          } else {
            const result = yield* call;
            assert.deepEqual(commands[0]?.modelSelection, testCase.expected, testCase.name);
            assert.equal(result.providerInstanceId, testCase.expected.instanceId, testCase.name);
            assert.equal(result.model, testCase.expected.model, testCase.name);
            assert.deepEqual(
              result.options,
              commands[0]?.modelSelection.options ?? [],
              testCase.name,
            );
            if ("routingRequested" in testCase) {
              if (testCase.routingRequested === null) {
                assert.isUndefined(result.selectionRouting, testCase.name);
              } else {
                assert.deepEqual(
                  result.selectionRouting?.requested,
                  testCase.routingRequested,
                  testCase.name,
                );
                assert.equal(result.selectionRouting?.reason, "harness-migration");
                assert.include(
                  result.selectionRouting!.message,
                  `${testCase.routingRequested.providerInstanceId}/${testCase.routingRequested.model}`,
                );
                assert.include(
                  result.selectionRouting!.message,
                  `${result.providerInstanceId}/${result.model} (${result.providerInstanceId === "codex" ? "reasoningEffort" : "effort"} max)`,
                );
                assert.include(result.selectionRouting!.message, "same route as");
                assert.include(result.selectionRouting!.message, "not a separate fallback");
              }
              const status = yield* service.taskStatus(scope, result.taskId);
              assert.deepEqual(status.selectionRouting, result.selectionRouting, testCase.name);
              assert.deepEqual(
                decodeLegacyDelegateTaskResult(result),
                (() => {
                  const { selectionRouting: _routing, ...legacy } =
                    decodeDelegateTaskResult(result);
                  return legacy;
                })(),
              );
              if (result.selectionRouting !== undefined && result.selectionRouting !== null) {
                assert.include(encodeDelegateTaskResult(result), result.selectionRouting.message);
              }
              const oldReply = { ...result };
              delete oldReply.selectionRouting;
              assert.isUndefined(decodeDelegateTaskResult(oldReply).selectionRouting);
              assert.deepEqual(
                decodeDelegateTaskResult(result).selectionRouting,
                result.selectionRouting,
              );
            }
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }

      const missingDestination = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (id) =>
            Effect.succeed({
              ...liveThreadShell(id),
              ...parentProjection([], { instanceId: opencode, model: "opus/claude-opus-5-5#high" })
                .thread,
            }),
          getThreadShell: (id) =>
            Effect.succeed({
              ...liveThreadShell(id),
              ...parentProjection([], { instanceId: opencode, model: "opus/claude-opus-5-5#high" })
                .thread,
            }),
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed(
              parentProjection([], {
                instanceId: opencode,
                model: "opus/claude-opus-5-5#high",
              }),
            ),
        }),
        ServerSettings.layerTest({ ardudHarnessMigration: { selections: "apply" } }),
        providerRegistryLayer([legacyProvider]),
        adapterRegistryLayer([opencode]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Review.",
            mode: "async",
            clientRequestId: "mapped-provider-missing",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(missingDestination))));
    }),
  );

  describe("scheduled tasks that start a fresh thread per run", () => {
    const projectId = ProjectId.make("project:fresh-runs");
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:fresh-runs"),
      requestNamespace: "client:fresh-runs",
      thread: undefined,
      client: { sessionId: "fresh-runs", label: "Claude Code", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    const worktree = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;
    const savedTask = (workspaceStrategy: ScheduledTask["workspaceStrategy"]): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:fresh-runs"),
      title: "Weekly review",
      prompt: "Review the week.",
      enabled: true,
      schedule: { type: "interval", everyMs: 604_800_000 },
      projectId,
      threadId: null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    });
    const savedStrategies = (
      workspaceRoot: "/work/plain" | "/work/repo" | "/work/unreadable",
      call: (
        mcp: OrchestratorMcpService.OrchestratorMcpService["Service"],
      ) => Effect.Effect<unknown, OrchestratorMcpFailure>,
      existing?: ScheduledTask,
    ) =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap(call),
          Effect.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: (id) =>
                      Effect.succeedSome({
                        id,
                        title: "Weekly reviews",
                        workspaceRoot,
                        defaultModelSelection: modelSelection,
                        scripts: [],
                        createdAt: "2026-10-12T00:00:00.000Z",
                        updatedAt: "2026-10-12T00:00:00.000Z",
                        deletedAt: null,
                      }),
                  }),
                  Layer.mock(GitVcsDriver.GitVcsDriver)({
                    execute: ({ cwd }) =>
                      cwd === "/work/unreadable"
                        ? Effect.fail(
                            new GitCommandError({
                              operation: "OrchestratorMcpService.scheduledTaskWorkspaceStrategy",
                              command: "git",
                              cwd,
                              detail: "Permission denied.",
                            }),
                          )
                        : cwd === "/work/plain"
                          ? Effect.fail(
                              new GitCommandError({
                                operation: "OrchestratorMcpService.scheduledTaskWorkspaceStrategy",
                                command: "git",
                                cwd,
                                reason: "not_a_repository",
                                detail: "Not a Git repository.",
                              }),
                            )
                          : Effect.succeed({
                              exitCode: ChildProcessSpawner.ExitCode(0),
                              stdout: ".git\n",
                              stderr: "",
                              stdoutTruncated: false,
                              stderrTruncated: false,
                            }),
                  }),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: existing === undefined ? [] : [existing] }),
                    upsert: (input) =>
                      Ref.update(saved, (strategies) => [
                        ...strategies,
                        input.workspaceStrategy,
                      ]).pipe(Effect.as({ task: savedTask(input.workspaceStrategy) })),
                  }),
                ),
              ),
            ),
          ),
        );
        return yield* Ref.get(saved);
      });
    const scheduleWeekly = (mcp: OrchestratorMcpService.OrchestratorMcpService["Service"]) =>
      mcp.scheduleTask(client, {
        projectId,
        prompt: "Review the week.",
        schedule: { type: "interval", everyMs: 604_800_000 },
      });

    it.effect("uses the project folder only when the Git check confirms a non-repository", () =>
      Effect.gen(function* () {
        assert.deepEqual(yield* savedStrategies("/work/plain", scheduleWeekly), [{ type: "root" }]);
        assert.deepEqual(yield* savedStrategies("/work/repo", scheduleWeekly), [worktree]);
        assert.deepEqual(yield* savedStrategies("/work/unreadable", scheduleWeekly), [worktree]);
      }),
    );

    it.effect("preserves the saved strategy until explicit unbinding repairs a non-Git task", () =>
      Effect.gen(function* () {
        const existing = savedTask(worktree);
        const saved = yield* savedStrategies(
          "/work/plain",
          (mcp) =>
            Effect.gen(function* () {
              yield* mcp.updateScheduledTask(client, {
                scheduledTaskId: existing.id,
                prompt: "Review this week instead.",
              });
              yield* mcp.updateScheduledTask(client, {
                scheduledTaskId: existing.id,
                bindToCurrentThread: false,
              });
            }),
          existing,
        );
        assert.deepEqual(saved, [worktree, { type: "root" }]);
      }),
    );
  });

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* OrchestratorMcpService.resolveRuntimeMode(
          "full-access",
          "auto-accept-edits",
          muse,
        ).pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("full-access", "inherit", muse),
          "full-access",
        );
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("auto", undefined, muse),
          "approval-required",
        );
      }),
    );
  });
});
