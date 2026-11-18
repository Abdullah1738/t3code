import { expectJsonRoundTrip } from "./McpJson.testkit.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionEndedError } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SecretRedeemer } from "../ardud/auth/heldSecrets.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../orchestration-v2/CommandPolicy.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect.each(["caller row", "caller records", "idle target", "dispatch"] as const)(
  "bounds thread sends waiting on %s before saving",
  (blocked) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const projection = (id: ThreadId) => idleThreadProjection(liveThreadShell(id));
      let sends = 0;
      const layer = layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (id) =>
                blocked === "caller row" ? wait : Effect.succeed(liveThreadShell(id)),
              getThreadRecords: (id) =>
                blocked === "caller records" ? wait : Effect.succeed(projection(id)),
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
              getProjectThreadRecords: ({ threadId }) =>
                blocked === "idle target" ? wait : Effect.succeed(projection(threadId)),
              sendToThread: () =>
                Effect.sync(() => {
                  sends += 1;
                }).pipe(Effect.andThen(wait)),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
            NodeCrypto.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const send = yield* service
          .sendToThread(makeScope(), {
            threadId: childThreadId,
            message: "Follow up on an idle child",
            clientRequestId: "bounded-send",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(blocked === "caller row" ? "10 seconds" : "15 seconds");
        const result = yield* Fiber.join(send);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: blocked === "caller row" ? "caller_unresolved" : "send_timeout" },
        });
        if (result._tag === "Failure")
          expect(result.failure.message).toContain(
            blocked === "caller row" ? "Nothing was saved" : "not save",
          );
        if (result._tag === "Failure" && blocked === "idle target") {
          expect(result.failure.message).toContain(
            `target thread read for thread ${childThreadId}`,
          );
          expect(result.failure.message).toContain("bounded-send");
        }
        if (result._tag === "Failure" && blocked === "dispatch")
          expect(result.failure.message).toContain(`message dispatch for thread ${childThreadId}`);
        expect(sends).toBe(blocked === "dispatch" ? 1 : 0);
      }).pipe(Effect.provide(layer));
    }),
);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");

const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "interrupted" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it.effect.each(
  (["send", "wait", "wait timeout"] as const).flatMap((operation) =>
    (["absent", "reason only", "with detail", "detail only"] as const).map((form) => ({
      operation,
      form,
    })),
  ),
)("$operation returns JSON cancellation fields ($form)", ({ operation, form }) =>
  Effect.gen(function* () {
    const shell = liveThreadShell(parentThreadId);
    const run = {
      ...makeRun({ id: cancelledRunId, ordinal: 1, status: "cancelled" }),
      ...(form === "reason only" || form === "with detail"
        ? { cancelReason: "task_cancel" as const }
        : {}),
      ...(form === "with detail" || form === "detail only"
        ? { cancelDetail: "Caller cancelled." }
        : {}),
    };
    const projection = {
      ...idleThreadProjection(shell),
      runs: [run],
    } as unknown as OrchestrationV2ThreadProjection;
    const waiting = yield* Deferred.make<void>();
    const layer = layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: () => Effect.succeed(shell),
            getThreadShell: () => Effect.succeed(shell),
            getThreadRecords: () => Effect.succeed(projection),
            getProjectThreadRecords: () => Effect.succeed(projection),
            sendToThread: () =>
              Effect.succeed({
                run: projection.runs[0]!,
                delivery: "started",
                dispatch: { sequence: 1, storedEvents: [] },
                projection,
                message: {
                  id: MessageId.make("message-json-cancellation"),
                  threadId: parentThreadId,
                  runId: run.id,
                  nodeId: null,
                  role: "user",
                  text: "Follow up",
                  phase: "unknown",
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "mcp",
                  createdAt: now,
                  updatedAt: now,
                },
                turnItem: null,
              }),
            waitForThread: () =>
              operation === "wait timeout"
                ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({
                    threadId: parentThreadId,
                    run: projection.runs[0]!,
                    timedOut: false,
                  }),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          NodeCrypto.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const response = yield* operation === "send"
        ? service.sendToThread(makeScope(), { threadId: parentThreadId, message: "Follow up" })
        : Effect.gen(function* () {
            const fiber = yield* service
              .waitForThread(makeScope(), { threadId: parentThreadId, timeoutMs: 1_000 })
              .pipe(Effect.forkChild);
            if (operation === "wait timeout") {
              yield* Deferred.await(waiting);
              yield* TestClock.adjust("1 second");
            }
            return yield* Fiber.join(fiber);
          });
      expectJsonRoundTrip(response);
      expect(response.cancelReason).toBe(run.cancelReason);
      expect(response.cancelDetail).toBe(run.cancelDetail);
      if (operation === "wait timeout") expect(response).toMatchObject({ timedOut: true });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["committed", "without detail", "missing", "unreadable"] as const)(
  "interrupt response reads committed provenance for its exact run (%s)",
  (form) =>
    Effect.gen(function* () {
      let dispatched = false;
      const shell = liveThreadShell(parentThreadId);
      const stale = {
        ...makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
        cancelReason: "provider_interrupted",
        cancelDetail: "Stale detail.",
      };
      const before = {
        ...idleThreadProjection(shell),
        runs: [stale],
      } as unknown as OrchestrationV2ThreadProjection;
      const after = {
        ...before,
        runs: [
          {
            ...makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
            cancelReason: "thread_reset",
            cancelDetail: "Unrelated detail.",
          },
          ...(form === "missing"
            ? []
            : [
                {
                  ...stale,
                  status: "interrupted",
                  cancelReason: "user_stop",
                  cancelDetail: form === "without detail" ? undefined : "Caller stopped.",
                },
              ]),
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const layer = layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: () => Effect.succeed(shell),
              getThreadRecords: () =>
                dispatched && form === "unreadable"
                  ? Effect.fail(
                      new OrchestratorProjectionError({
                        threadId: parentThreadId,
                        cause: "read failed",
                      }),
                    )
                  : Effect.succeed(dispatched ? after : before),
              interruptThread: () =>
                Effect.sync(() => {
                  dispatched = true;
                  return {
                    type: "interrupt_requested",
                    run: before.runs[0]!,
                    dispatch: { sequence: 1, storedEvents: [] },
                  } as const;
                }),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
            NodeCrypto.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const response = yield* service.interruptThread(makeScope(), { threadId: parentThreadId });
        expectJsonRoundTrip(response);
        expect(response.runId).toBe(activeRunId);
        expect(response.status).toBe("interrupt_requested");
        expect(response.cancelReason).toBe(
          form === "missing" || form === "unreadable" ? undefined : "user_stop",
        );
        expect(response.cancelDetail).toBe(form === "committed" ? "Caller stopped." : undefined);
      }).pipe(Effect.provide(layer));
    }),
);

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      {
        ...makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
        cancelReason: "server_shutdown",
        cancelDetail: "Server shut down.",
      },
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getCallerRow: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expectJsonRoundTrip(result);
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.recentRuns[0]?.cancelReason).toBe("server_shutdown");
    expect(result.recentRuns[0]?.cancelDetail).toBe("Server shut down.");
    expect(result.recentRuns[0]?.statusSummary).toBe(
      "cancelled (server_shutdown: Server shut down.)",
    );
    expect(JSON.stringify(result)).toContain("cancelled (server_shutdown: Server shut down.)");
    expect(result.thread.activeRunId).toBe(activeRunId);
    // Native harnesses don't know their own thread id: omitting it reads the caller's thread.
    const own = yield* service.readThread(makeScope(), {});
    expect(own.thread.threadId).toBe(parentThreadId);
    const anonymous = yield* service
      .readThread({ ...makeScope(), thread: undefined }, {})
      .pipe(Effect.flip);
    expect(anonymous.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread prefers waiting activity status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent waiting",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "waiting" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getCallerRow: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("waiting");
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it.each([
  "working",
  "retrying",
  "retrying-timeout",
  "retrying-refused",
  "resuming",
  "cancelled",
  "interrupted",
  "fallback",
  "fallback-resumed",
  "continuation-cancelled",
  "continuation-interrupted",
  "continuation-interrupted-mirrored",
  "continuation-interrupted-mirrored-transfer",
  "continuation-interrupted-mirrored-provider-interrupted-transfer",
  "continuation-interrupted-mirrored-provider-cancelled-transfer",
  "continuation-interrupted-mirrored-unknown-transfer",
  "continuation-interrupted-mirrored-detail-only-transfer",
  "continuation-interrupted-mirrored-specific-transfer",
  "continuation-interrupted-mirrored-provider-interrupted-no-detail-transfer",
  "continuation-interrupted-mirrored-legacy",
  "continuation-interrupted-missing",
  "continuation-interrupted-no-detail",
  "continuation-completed",
  "continuation-running",
  "restart-interrupted",
  "restart-interrupted-disposed",
  "restart-cancelled",
  "restart-cancelled-marker",
])("taskStatus exposes live child state: %s", async (state) => {
  const retryCause =
    state === "retrying-timeout"
      ? "Request timed out — retry 2/10 (request_retry), next in 1 s"
      : state === "retrying-refused"
        ? "Connection refused (ECONNREFUSED) — retry 2/10 (connection_retry), next in 1 s"
        : "Claude API no HTTP response: unknown.";
  const restart = state.startsWith("restart-interrupted");
  const unmirroredRestart = state.startsWith("restart-cancelled");
  const continuation = state === "fallback-resumed" || state.startsWith("continuation-");
  const mirrored = state.includes("-mirrored");
  const legacy = state.endsWith("-legacy");
  const transferred = state.endsWith("-transfer");
  const mirroredCause = state.includes("-provider-interrupted")
    ? "provider_interrupted"
    : state.includes("-provider-cancelled")
      ? "provider_cancelled"
      : state.includes("-unknown")
        ? "unknown"
        : state.includes("-specific")
          ? "user_stop"
          : legacy || transferred
            ? undefined
            : "task_cancel";
  const noDetail = state.includes("-no-detail");
  const continuationStatus = state.includes("interrupted")
    ? "interrupted"
    : state === "continuation-cancelled"
      ? "cancelled"
      : state === "continuation-running"
        ? "running"
        : "completed";
  const continuationCause =
    continuation &&
    (continuationStatus === "interrupted" || continuationStatus === "cancelled") &&
    !state.endsWith("-missing");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    turnItems: state.startsWith("retrying")
      ? [
          {
            type: "error",
            status: "running",
            runId: childRunId,
            ordinal: 1,
            failure: { message: retryCause },
            retry: { attempt: 2, maxAttempts: 10, retryDelayMs: 500 },
            startedAt: now,
            updatedAt: now,
          },
        ]
      : [],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: transferred
      ? [
          {
            id: "transfer:continued-result",
            type: "subagent_result",
            sourceThreadId: childThreadId,
            targetThreadId: parentThreadId,
            sourcePoint: { runId: RunId.make("run-mcp-resumed") },
            targetPoint: { runId: activeRunId },
          },
        ]
      : [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        completionDelivery: { state: "acknowledged" },
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        ...(mirrored
          ? {
              status: "interrupted",
              result: "Task was cancelled.",
              cancelReason: mirroredCause,
              cancelDetail:
                state.includes("-detail-only") ||
                (mirroredCause !== undefined && mirroredCause !== "task_cancel")
                  ? "Stale mirrored detail."
                  : legacy || transferred
                    ? undefined
                    : "Task cancelled.",
            }
          : {}),
        ...(restart
          ? {
              status: "interrupted",
              result: "Interrupted by restart. Resume the same child thread.",
              cancelReason: "server_shutdown",
              completionDelivery: {
                state: state.endsWith("-disposed") ? "disposed" : "acknowledged",
              },
            }
          : {}),
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      ...(continuation
        ? [
            {
              ...makeRun({
                id: childRunId,
                ordinal: 1,
                status: "cancelled",
                instanceId: customCodexInstanceId,
              }),
              delegatedTaskId: taskId,
              cancelReason: "server_shutdown",
              cancelDetail: "Original run shut down.",
              modelSelection: { instanceId: customCodexInstanceId, model: "claude-haiku-5-5" },
            },
          ]
        : []),
      {
        ...makeRun({
          id: continuation ? RunId.make("run-mcp-resumed") : childRunId,
          ordinal: continuation ? 2 : 1,
          status: continuation
            ? continuationStatus
            : unmirroredRestart
              ? "cancelled"
              : restart
                ? "interrupted"
                : ["fallback", "fallback-resumed"].includes(state)
                  ? "completed"
                  : state === "cancelled" || state === "interrupted"
                    ? state
                    : "running",
          instanceId: customCodexInstanceId,
        }),
        ...(unmirroredRestart ? { cancelReason: "server_restart" } : {}),
        ...(continuation
          ? { delegatedTaskId: taskId, restartContinuationOfRunId: childRunId }
          : {}),
        ...(continuationCause
          ? {
              cancelReason: "task_cancel",
              cancelDetail: noDetail ? undefined : "Task cancelled.",
            }
          : {}),
        ...(["fallback", "fallback-resumed"].includes(state)
          ? {
              modelSelection: { instanceId: customCodexInstanceId, model: "claude-sonnet-5-5" },
              launchRecovery: {
                kind: "model_access",
                retriesOnModel: 0,
                attempt: 2,
                delayMs: 20_000,
                since: DateTime.formatIso(now),
              },
            }
          : {}),
        ...(["resuming", "cancelled", "interrupted"].includes(state)
          ? {
              transientRecovery: {
                firstError: { message: "502 connection reset" },
                since: DateTime.formatIso(now),
              },
            }
          : {}),
      },
    ],
    turnItems:
      state === "restart-cancelled-marker"
        ? [
            {
              type: "run_interrupt_request",
              runId: childRunId,
              cancelReason: "task_cancel",
              message: "Parent cancelled this interrupted work.",
              status: "completed",
              ordinal: 1,
              updatedAt: now,
            },
          ]
        : state.startsWith("retrying")
          ? [
              {
                type: "error",
                status: "running",
                runId: childRunId,
                ordinal: 1,
                failure: { message: retryCause },
                retry: { attempt: 2, maxAttempts: 10, retryDelayMs: 500 },
                startedAt: now,
                updatedAt: now,
              },
            ]
          : [],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const lateStop =
    transferred &&
    (state.includes("-provider-") || state.includes("-unknown") || state.includes("-detail-only"));
  let controlsProjection: OrchestrationV2ThreadProjection = lateStop
    ? {
        ...childProjection,
        runs: childProjection.runs.map((run) =>
          run.id === RunId.make("run-mcp-resumed")
            ? {
                ...run,
                cancelReason: mirroredCause ?? "provider_interrupted",
                cancelDetail: "Provider finished first.",
              }
            : run,
        ),
      }
    : childProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          delegatedTaskResultPending: () => Effect.succeed(false),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(controlsProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    if (lateStop) {
      const before = yield* service.taskStatus(makeScope(), taskId);
      expect(before.cancelReason).toBe(mirroredCause ?? "provider_interrupted");
      // The typed late Stop repairs the run; the finalized result transfer prevents remirroring.
      controlsProjection = childProjection;
    }
    const result = yield* service.taskStatus(makeScope(), taskId);
    expectJsonRoundTrip(result);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe(
      continuation
        ? continuationStatus
        : unmirroredRestart
          ? "cancelled"
          : restart
            ? "interrupted"
            : ["fallback", "fallback-resumed"].includes(state)
              ? "completed"
              : state === "cancelled" || state === "interrupted"
                ? state
                : "running",
    );
    if (continuation) {
      expect(result.cancelReason).toBe(
        state.includes("-specific")
          ? "user_stop"
          : continuationCause && !legacy
            ? "task_cancel"
            : undefined,
      );
      expect(result.cancelDetail).toBe(
        state.includes("-specific")
          ? "Stale mirrored detail."
          : continuationCause && !legacy && !noDetail
            ? "Task cancelled."
            : undefined,
      );
    }
    expect(result.taskId).toBe(taskId);
    const resumable = (restart && !state.endsWith("-disposed")) || state === "restart-cancelled";
    expect(result.resumable).toBe(resumable ? true : undefined);
    expect(result.resumeThreadId).toBe(resumable ? childThreadId : undefined);
    expect(result.childThreadId).toBe(childThreadId);
    expect(result.finishedOn).toBe(
      ["fallback", "fallback-resumed"].includes(state) ? "claude-sonnet-5-5" : undefined,
    );
    if (
      continuation ||
      restart ||
      unmirroredRestart ||
      ["working", "cancelled", "interrupted", "fallback", "fallback-resumed"].includes(state)
    )
      expect(result.retry).toBeNull();
    else {
      expect(result.retry?.state).toBe(state.startsWith("retrying") ? "retrying" : state);
      expect(result.retry?.lastError).toContain(state.startsWith("retrying") ? retryCause : "502");
      expect(result.retry?.since).toBe("2026-08-04T12:00:00.000Z");
    }
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread and sendToThread reach threads in other projects", async () => {
  let parentShell: OrchestrationV2ThreadShell | null = null;
  let parentRuns: ReadonlyArray<unknown> = [
    makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
  ];
  const foreignProjectId = ProjectId.make("project-mcp-orchestrator-foreign");
  const foreignThreadId = ThreadId.make("thread-mcp-orchestrator-foreign");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    get runs() {
      return parentRuns;
    },
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const redeemers: Array<ThreadId | null> = [];
  const foreignProjection = (threadId: ThreadId) =>
    ({
      thread: {
        ...baseThread({
          threadId,
          title: "Foreign",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        projectId: foreignProjectId,
      },
      runs: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: threadId,
          sourceItemId: "item-1",
          item: {
            id: "item-1",
            type: "assistant_message",
            messageId: "assistant-1",
            status: "completed",
            title: null,
            text: "Foreign thread said hello",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === foreignThreadId) return Effect.succeed(foreignProjection(threadId));
            return Effect.die(`unexpected thread ${threadId}`);
          },
          hasReceipt: () => Effect.succeed(false),
          getCommandReceipt: () => Effect.succeed(Option.none()),
          getDelegationCommandState: () => Effect.succeed({ status: "never_saved" }),
          getCallerRow: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId
                ? ({
                    ...liveThreadShell(threadId),
                    ...foreignProjection(threadId).thread,
                  } as OrchestrationV2ThreadShell)
                : threadId === parentThreadId
                  ? (parentShell ?? {
                      ...liveThreadShell(parentThreadId, {
                        activeRunId: parentRuns.length > 0 ? RunId.make("run-parent-live") : null,
                      }),
                      ...parentProjection.thread,
                    })
                  : null,
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId
                ? ({
                    ...liveThreadShell(threadId),
                    ...foreignProjection(threadId).thread,
                  } as OrchestrationV2ThreadShell)
                : threadId === parentThreadId
                  ? (parentShell ?? {
                      ...liveThreadShell(parentThreadId, {
                        activeRunId: parentRuns.length > 0 ? RunId.make("run-parent-live") : null,
                      }),
                      ...parentProjection.thread,
                    })
                  : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.succeed({
              items: foreignProjection(threadId).visibleTurnItems,
              totalItems: 1,
              hasMore: false,
            }),
          getProjectThreadRecords: (input) =>
            input.threadId === foreignThreadId && input.projectId === foreignProjectId
              ? Effect.succeed(foreignProjection(input.threadId))
              : Effect.fail(
                  new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                ),
          sendToThread: () =>
            Effect.succeed({
              run: { id: "run-foreign", status: "queued" },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work" } as never)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          // ardud: records which thread a save would redeem a secretRef as.
          upsert: () =>
            SecretRedeemer.pipe(
              Effect.tap((redeemer) => Effect.sync(() => redeemers.push(redeemer))),
              Effect.andThen(Effect.die("saved far enough for this test")),
            ),
          list: () =>
            Effect.succeed({
              tasks: [
                {
                  id: "task-foreign",
                  projectId: foreignProjectId,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                } as never,
              ],
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const foreign = yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(foreign.thread.threadId).toBe(foreignThreadId);
    expect(foreign.thread.projectId).toBe(foreignProjectId);
    expect(foreign.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);

    const sent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "hi",
    });
    expect(sent.threadId).toBe(foreignThreadId);

    // ardud: a secretRef from a board ask is redeemed as the calling thread, taken
    // from the session, so a ref given to another thread is refused.
    yield* service
      .scheduleTask(makeScope(), {
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.exit);
    expect(redeemers).toEqual([parentThreadId]);

    parentRuns = [];
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    const stale = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "hi again" })
      .pipe(Effect.flip);
    expect(stale.code).toBe("parent_not_active");
    const staleInterrupt = yield* service
      .interruptThread(makeScope(), { threadId: foreignThreadId })
      .pipe(Effect.flip);
    expect(staleInterrupt.code).toBe("parent_not_active");

    const staleSchedule = yield* service
      .scheduleTask(makeScope(), {
        projectId: foreignProjectId,
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.flip);
    expect(staleSchedule.code).toBe("parent_not_active");
    const staleUpdate = yield* service
      .updateScheduledTask(makeScope(), {
        scheduledTaskId: ScheduledTaskId.make("task-foreign"),
        enabled: false,
      })
      .pipe(Effect.flip);
    expect(staleUpdate.code).toBe("parent_not_active");
    const staleDelete = yield* service
      .deleteScheduledTask(makeScope(), { scheduledTaskId: ScheduledTaskId.make("task-foreign") })
      .pipe(Effect.flip);
    expect(staleDelete.code).toBe("parent_not_active");

    // A background item keeps only its owning instance live, even after a switch.
    const backgroundTasks = [
      {
        taskId: "background-subagent",
        kind: "subagent" as const,
        providerInstanceId: parentInstanceId,
      },
    ];
    parentShell = {
      ...liveThreadShell(parentThreadId, { activeRunId: null }),
      pendingBackgroundTasks: backgroundTasks,
    };
    const backgroundSent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "background",
    });
    expect(backgroundSent.threadId).toBe(foreignThreadId);
    const delegate = yield* service
      .delegateTask(makeScope(), { task: "requires a run" })
      .pipe(Effect.flip);
    expect(delegate.code).toBe("parent_not_active");
    const create = yield* service
      .createThreads(makeScope(), { threads: [{ prompt: "requires a run" }] })
      .pipe(Effect.flip);
    expect(create.code).toBe("parent_not_active");
    const secret = yield* service
      .requestSecret(makeScope(), { label: "Secret", reason: "requires a run" })
      .pipe(Effect.flip);
    expect(secret.code).toBe("parent_not_active");

    parentShell = { ...parentShell, providerInstanceId: customCodexInstanceId };
    const switchedScope = {
      ...makeScope(),
      thread: { ...makeScope().thread!, providerInstanceId: customCodexInstanceId },
    };
    const switched = yield* service
      .sendToThread(switchedScope, { threadId: foreignThreadId, message: "wrong owner" })
      .pipe(Effect.flip);
    expect(switched.code).toBe("parent_not_active");
    const mismatched = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "stale provider" })
      .pipe(Effect.flip);
    expect(mismatched.code).toBe("parent_not_active");

    // A fresh active run wins over the earlier inactive projection and empty roster.
    parentShell = liveThreadShell(parentThreadId);
    const restarted = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "new run",
    });
    expect(restarted.threadId).toBe(foreignThreadId);

    parentShell = {
      ...parentShell,
      activeRunId: null,
      pendingBackgroundTasks: backgroundTasks,
      archivedAt: now,
    };
    const archived = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "archived" })
      .pipe(Effect.flip);
    expect(archived.code).toBe("parent_not_active");

    parentShell = { ...parentShell, archivedAt: null, pendingBackgroundTasks: [] };
    const stopped = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "after stop" })
      .pipe(Effect.flip);
    expect(stopped.code).toBe("parent_not_active");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it.effect("wake tools that need a run return run_starting until admission", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  let archived = false;
  const scope = {
    ...makeScope(),
    thread: { ...makeScope().thread!, providerInstanceId: instanceId },
  };
  const shell = {
    ...liveThreadShell(parentThreadId, { activeRunId: null }),
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-5-5" },
    get archivedAt() {
      return archived ? now : null;
    },
  };
  const projection = idleThreadProjection(shell);
  const dependencies = Layer.mergeAll(
    McpProviderSessions.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getCallerRow: () => Effect.succeed(shell),
      getThreadShell: () => Effect.succeed(shell),
      getThreadRecords: () => Effect.succeed(projection),
      hasReceipt: () => Effect.succeed(false),
      getCommandReceipt: () => Effect.succeed(Option.none()),
      getDelegationCommandState: () => Effect.succeed({ status: "never_saved" }),
    }),
    ServerSettings.layerTest(),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    NodeCrypto.layer,
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const caller = scope.thread;
      const credential = {
        ...caller,
        runtimeProviderSessionId: ProviderSessionId.make("runtime:wake-activity"),
        environmentId,
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
      };
      yield* sessions.set(credential);
      let state: McpProviderSessions.WakeCallerState = "starting";
      yield* sessions.registerWakeCaller(credential, () => state);
      const calls = [
        service
          .delegateTask(scope, { task: "requires a run", clientRequestId: "wake-delegate" })
          .pipe(Effect.asVoid),
        service
          .createThreads(scope, { threads: [{ prompt: "requires a run" }] })
          .pipe(Effect.asVoid),
        service
          .requestSecret(scope, { label: "Secret", reason: "requires a run" })
          .pipe(Effect.asVoid),
      ];
      for (const phase of ["starting", "live", "inactive"] as const) {
        state = phase;
        for (const call of calls) {
          const error = yield* call.pipe(Effect.flip);
          expect(error.code).toBe(phase === "inactive" ? "parent_not_active" : "run_starting");
          if (phase !== "inactive") expect(error.saved).toBe(false);
        }
      }
      state = "live";
      archived = true;
      for (const call of calls) {
        const error = yield* call.pipe(Effect.flip);
        expect(error.code).toBe("parent_not_active");
      }
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(dependencies)))),
  );
});

it.each(["missing-session", "capability", "replay"] as const)(
  "sendToThread reports the real rejection reason (%s)",
  async (kind) => {
    const reason =
      "Claude cannot restart an active run. Use t3_thread_interrupt, then send the message.";
    const targetThreadId = ThreadId.make("thread-mcp-orchestrator-dead-session");
    const targetProjection = {
      thread: baseThread({
        threadId: targetThreadId,
        title: "Stalled",
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      }),
      runs: [],
      visibleTurnItems: [],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const layer = layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getCallerRow: (threadId) =>
              Effect.succeed(
                threadId === targetThreadId
                  ? (targetProjection.thread as unknown as OrchestrationV2ThreadShell)
                  : liveThreadShell(parentThreadId),
              ),
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === targetThreadId
                  ? (targetProjection.thread as unknown as OrchestrationV2ThreadShell)
                  : liveThreadShell(parentThreadId),
              ),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === targetThreadId
                  ? targetProjection
                  : ({
                      ...targetProjection,
                      thread: baseThread({
                        threadId: parentThreadId,
                        title: "Parent",
                        instanceId: parentInstanceId,
                        model: "gpt-5.4",
                      }),
                      runs: [
                        makeRun({
                          id: RunId.make("run-parent-live"),
                          ordinal: 1,
                          status: "running",
                        }),
                      ],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
            getProjectThreadRecords: () => Effect.succeed(targetProjection),
            sendToThread: (input) =>
              Effect.fail(
                kind === "replay"
                  ? new OrchestratorCommandPreviouslyRejectedError({
                      commandId: input.commandId,
                      commandType: "message.dispatch",
                      detail: reason,
                    })
                  : new OrchestratorDispatchError({
                      commandId: input.commandId,
                      commandType: "message.dispatch",
                      cause:
                        kind === "missing-session"
                          ? new ProviderSessionEndedError({
                              providerSessionId: ProviderSessionId.make("provider-session-dead"),
                            })
                          : new CommandPolicyCapabilityUnsupportedError({
                              commandId: input.commandId,
                              threadId: targetThreadId,
                              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                              capability: "interrupt_restart_steering",
                              detail: "provider has no interrupt support",
                            }),
                    }),
              ),
          } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
          } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
          NodeCrypto.layer,
        ),
      ),
    );

    await Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const failure = yield* service
        .sendToThread(makeScope(), {
          threadId: targetThreadId,
          message: "restart",
          mode: "restart",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("orchestration_error");
      if (kind === "replay") {
        expect(failure.message).toContain(`previously rejected: ${reason}`);
      } else {
        expect(failure.message).toBe(
          `Unable to send to thread ${targetThreadId}: ${
            kind === "capability"
              ? reason
              : new ProviderSessionEndedError({
                  providerSessionId: ProviderSessionId.make("provider-session-dead"),
                }).message
          }`,
        );
      }
      expect(failure.message).not.toContain("Failed to dispatch orchestration command");
    }).pipe(Effect.provide(layer), Effect.runPromise);
  },
);

it("readThread exposes the stored sender thread only for thread-sent messages", async () => {
  const shell = liveThreadShell(parentThreadId);
  const messages = [
    { id: "message-from-child", text: "Child reporting in", senderThreadId: childThreadId },
    { id: "message-from-user", text: "Thanks" },
  ];
  const projection = {
    ...idleThreadProjection(shell),
    messages,
    visibleTurnItems: messages.map((message, position) => ({
      position,
      visibility: "local",
      sourceThreadId: parentThreadId,
      sourceItemId: `item-${message.id}`,
      item: {
        id: `item-${message.id}`,
        type: "user_message",
        messageId: message.id,
        runId: activeRunId,
        status: "completed",
        title: null,
        text: message.text,
        updatedAt: now,
      },
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: () => Effect.succeed(shell),
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getTimelinePage: () =>
            Effect.succeed({ items: projection.visibleTurnItems, totalItems: 2, hasMore: false }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.items).toMatchObject([
      { messageId: "message-from-child", senderThreadId: childThreadId },
      { messageId: "message-from-user" },
    ]);
    expect(result.items[1]).not.toHaveProperty("senderThreadId");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
