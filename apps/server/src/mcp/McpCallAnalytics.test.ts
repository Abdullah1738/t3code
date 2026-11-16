import { KanbanService } from "../ardud/kanban/engine/KanbanService.ts";
import { expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- isolated loopback MCP integration.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter } from "effect/http";
import { makeHttpSocketTelemetry } from "../ardud/http/HttpSocketTelemetry.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import {
  AnalyticsEvent,
  CommandId,
  NodeId,
  RunId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
  PreviewAutomationError,
  PreviewAutomationTimeoutError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationUnavailableError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationUnsupportedClientError,
  McpCapabilityUnavailableError,
  PreviewControlRequiredError,
  DeviceToolError,
  DeviceActionUnavailableError,
  DeviceToolUnavailableError,
  DeviceBootError,
  DeviceHostId,
  DeviceId,
  KanbanError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import * as DateTime from "effect/DateTime";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as McpCallLedger from "../ardud/analytics/McpCallLedger.ts";
import * as McpCall from "../ardud/analytics/McpCall.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as McpResponseDelivery from "../ardud/http/McpResponseDelivery.ts";
import * as SavedWrite from "../ardud/kanban/engine/savedWrite.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import {
  PullRequestToolTimeoutError,
  PullRequestWatchTimeoutError,
} from "./toolkits/pullRequests/tools.ts";
import * as Testkit from "./McpToolAccess.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CommandReceiptStoreReadError } from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { callIdentifiers } from "../ardud/analytics/McpCall.ts";
import * as McpDeadline from "./McpDeadline.ts";
import { readCallerIdentity } from "./callerIdentity.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";

it("hashes retry ids deterministically within their caller identity", () => {
  const first = callIdentifiers(
    { clientRequestId: "private id", prompt: "private text" },
    "caller",
  );
  expect(first).toEqual(callIdentifiers({ clientRequestId: "private id" }, "caller"));
  expect(first).not.toEqual(callIdentifiers({ clientRequestId: "private id" }, "other"));
  expect(first).not.toEqual(callIdentifiers({ clientRequestId: "other id" }, "caller"));
  expect(JSON.stringify(first)).not.toMatch(/private|caller|prompt/);
});

const invocation = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("env-ledger"),
  requestNamespace: "namespace-ledger",
  thread: {
    threadId: ThreadId.make("caller-ledger"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-ledger",
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const ProbeFailure = Schema.Union([
  OrchestratorMcpFailure,
  PullRequestWatchTimeoutError,
  PullRequestToolTimeoutError,
  KanbanError,
  PreviewAutomationError,
  McpCapabilityUnavailableError,
  PreviewControlRequiredError,
  DeviceToolError,
  Schema.instanceOf(Cause.TimeoutError),
]);
const probe = (name: string) =>
  Toolkit.make(
    Tool.make(name, {
      parameters: Schema.Struct({
        clientRequestId: Schema.String,
        boardId: Schema.String,
        card: Schema.String,
        timeoutMs: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 270_000 })),
        ),
      }),
      success: Schema.Unknown,
      failure: ProbeFailure,
      failureMode: "return",
      dependencies: [
        McpInvocationContext.McpInvocationContext,
        ThreadManagement.ThreadManagementService,
      ],
    }),
  );
const decodeAnalyticsEvent = Schema.decodeEffect(AnalyticsEvent);
const args = { clientRequestId: "private retry id", boardId: "board-robob", card: "#1301" };
const isAnalyticsEvent = Schema.is(AnalyticsEvent);

const lookupParent = ThreadId.make("caller-ledger");
const lookupChild = ThreadId.make("private-child");
const lookupCommand = CommandId.make(
  "command:mcp:delegate-task:env-ledger:caller-ledger:private%3A%2525%2F%C3%A9",
);
const lookupId = IdAllocator.derive.delegatedTaskNode({ commandId: lookupCommand });
const copiedLookupId = NodeId.make(`node:delegated-task:${encodeURIComponent(lookupId.slice(20))}`);
const lookupCases = [
  { name: "normal hit", hit: true, foundBy: "subagents", saved: true },
  { name: "acknowledgement", hit: true, ack: true, foundBy: "subagents", saved: true },
  { name: "late projection", late: true, foundBy: "subagents", saved: true },
  {
    name: "request key recovery",
    hit: true,
    id: copiedLookupId,
    foundBy: "request_key_recovery",
    saved: true,
    canonical: false,
  },
  { name: "unsaved", reason: "never_saved", saved: false },
  {
    name: "accepted receipt",
    state: "accepted",
    reason: "accepted",
    foundBy: "receipt",
    saved: true,
  },
  {
    name: "rejected receipt",
    state: "rejected",
    reason: "rejected",
    foundBy: "receipt",
    saved: true,
  },
  { name: "pending", state: "pending", reason: "pending" },
  { name: "abandoned", state: "abandoned", reason: "abandoned" },
  { name: "copied miss", id: copiedLookupId, reason: "non_canonical_id", canonical: false },
  {
    name: "not a delegation id",
    id: NodeId.make("private-unknown"),
    reason: "not_a_delegation_id",
    canonical: false,
    shape: "other",
  },
  {
    name: "invalid escape",
    id: NodeId.make("node:delegated-task:%ZZ"),
    reason: "not_a_delegation_id",
    canonical: false,
    shape: "other",
  },
  {
    name: "foreign caller",
    id: IdAllocator.derive.delegatedTaskNode({
      commandId: CommandId.make("command:mcp:delegate-task:env-ledger:private-other:private"),
    }),
    reason: "non_canonical_id",
    canonical: false,
  },
  {
    name: "foreign receipt",
    state: "accepted",
    foreign: true,
    reason: "other_thread",
    canonical: false,
  },
  {
    name: "wrong command receipt",
    state: "accepted",
    wrongCommand: true,
    reason: "not_a_delegation_command",
    canonical: false,
  },
  {
    name: "missing child",
    hit: true,
    noChild: true,
    reason: "missing_child_thread",
    foundBy: "subagents",
    saved: true,
  },
  ...[
    "thread:project:private:uuid",
    `thread:delegated-task:${lookupId.slice(20)}`,
    "019f3baa-87de-7d51-ae17-d80a8d6a6b45",
    "019F3BAA-87DE-7D51-AE17-D80A8D6A6B45",
  ].map(
    (id) =>
      ({
        name: `thread shape ${id.slice(0, 20)}`,
        id,
        shape: "thread_id",
        reason: "not_a_delegation_id",
        canonical: false,
      }) as const,
  ),
  {
    name: "known child thread",
    id: lookupChild,
    hit: true,
    shape: "child_thread_id",
    reason: "not_a_delegation_id",
    canonical: false,
  },
  { name: "empty input", id: "", shape: "empty", invalid: true },
  { name: "blank input", id: "   ", shape: "empty", invalid: true },
  {
    name: "missing child receipt failure",
    hit: true,
    noChild: true,
    receiptError: true,
    foundBy: "subagents",
    saved: true,
    error: "orchestration_error",
  },
  {
    name: "missing child receipt timeout",
    hit: true,
    noChild: true,
    pause: "receipt",
    finish: "timeout",
    foundBy: "subagents",
    saved: true,
    error: "partial_result",
  },
  {
    name: "cancel interrupted on second read",
    hit: true,
    cancel: true,
    pause: "cancel_read",
    finish: "interrupt",
    foundBy: "subagents",
    saved: true,
  },
  {
    name: "cancel fails on second read",
    hit: true,
    cancel: true,
    pause: "cancel_read",
    finish: "error",
    foundBy: "subagents",
    saved: true,
    error: "orchestration_error",
  },
  {
    name: "shutdown after projection hit",
    hit: true,
    pause: "child",
    finish: "shutdown",
    foundBy: "subagents",
    saved: true,
  },
  {
    name: "shutdown after recovery hit",
    hit: true,
    id: copiedLookupId,
    pause: "child",
    finish: "shutdown",
    foundBy: "request_key_recovery",
    canonical: false,
    saved: true,
  },
] as const;

it.effect.each(lookupCases)("records task lookup metadata: $name", (testCase) =>
  Effect.gen(function* () {
    const rows = yield* Queue.unbounded<AnalyticsEvent>();
    const blocked = yield* Deferred.make<void>();
    const acknowledged = yield* Deferred.make<void>();
    const parent = Testkit.idleThreadProjection(Testkit.liveThreadShell(lookupParent));
    const child = {
      ...Testkit.idleThreadProjection(Testkit.liveThreadShell(lookupChild)),
      runs:
        "cancel" in testCase
          ? [
              {
                id: RunId.make("private-run"),
                threadId: lookupChild,
                delegatedTaskId: lookupId,
                ordinal: 1,
                status: "running",
                activeAttemptId: null,
                startedAt: DateTime.makeUnsafe(0),
                completedAt: null,
              } as OrchestrationV2Run,
            ]
          : [],
    };
    const task = {
      id: lookupId,
      threadId: lookupParent,
      origin: "app_owned",
      childThreadId: "noChild" in testCase ? null : lookupChild,
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
      result: "cancel" in testCase ? null : "private result",
      status: "cancel" in testCase ? "running" : "completed",
      completionDelivery: { state: "ack" in testCase ? "pending" : "acknowledged" },
    } as OrchestrationV2Subagent;
    let parentReads = 0;
    let acknowledgements = 0;
    let stopped = false;
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getCallerRow: (id) => Effect.succeed(Testkit.liveThreadShell(id)),
      getThreadShell: (id) => Effect.succeed(Testkit.liveThreadShell(id)),
      getThreadProjection: () => Effect.succeed({ ...parent, subagents: [task] }),
      stopDelegatedTasks: () => Effect.void,
      getThreadRecords: (id) => {
        if (
          "pause" in testCase &&
          ((testCase.pause === "child" && id === lookupChild) ||
            (testCase.pause === "cancel_read" && stopped && id === lookupParent))
        )
          return Deferred.succeed(blocked, undefined).pipe(
            Effect.andThen(
              testCase.finish === "error"
                ? Effect.fail(
                    new OrchestratorProjectionError({
                      threadId: id,
                      cause: new Error("private"),
                    }),
                  )
                : Effect.never,
            ),
          );
        return Effect.succeed(
          id === lookupParent
            ? {
                ...parent,
                subagents:
                  "hit" in testCase || ("late" in testCase && parentReads++ > 0) ? [task] : [],
              }
            : child,
        );
      },
      getDelegationCommandState: () => {
        if ("receiptError" in testCase)
          return Effect.fail(new CommandReceiptStoreReadError({ commandId: lookupCommand }));
        if ("pause" in testCase && testCase.pause === "receipt")
          return Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never));
        const status = "state" in testCase ? testCase.state : "never_saved";
        return Effect.succeed(
          status === "accepted" || status === "rejected"
            ? {
                commandId: lookupCommand,
                threadId: "foreign" in testCase ? lookupChild : lookupParent,
                commandType:
                  "wrongCommand" in testCase ? "thread.create" : "delegated_task.request",
                acceptedAt: DateTime.makeUnsafe(0),
                resultSequence: 0,
                status,
                error: null,
              }
            : status === "abandoned"
              ? {
                  status,
                  elapsedSeconds: 10,
                  reason: "timeout",
                  at: DateTime.makeUnsafe(0),
                }
              : { status },
        );
      },
      dispatch: (command) =>
        Effect.sync(() => {
          acknowledgements++;
          if (command.type === "thread.stop") stopped = true;
          return { sequence: 1, storedEvents: [] };
        }).pipe(Effect.tap(() => Deferred.succeed(acknowledged, undefined))),
    });
    const service = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          threads,
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
    const toolkit = Toolkit.make(
      OrchestratorToolkit.tools.task_status,
      OrchestratorToolkit.tools.task_cancel,
    );
    const registration = McpHttpServer.toolkitRegistration(
      toolkit,
      McpToolAccess.toLayer(toolkit, {
        task_status: McpToolAccess.readsAsCaller(({ taskId }) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).taskStatus(
              scope,
              taskId,
            );
          }),
        ),
        task_cancel: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).cancelTask(
              scope,
              input,
            );
          }),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(McpCallLedger.layer),
      Layer.provide(service),
      Layer.provide(threads),
      Layer.provide(invocation),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            row.kind === "mcp.call" ? Queue.offer(rows, row).pipe(Effect.asVoid) : Effect.void,
          flush: Effect.void,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names =
        "cancel" in testCase
          ? ["task_cancel"]
          : "reason" in testCase || "invalid" in testCase
            ? ["task_status", "task_cancel"]
            : ["task_status"];
      for (const name of names) {
        const call = server
          .callTool({ name, arguments: { taskId: "id" in testCase ? testCase.id : lookupId } })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client));
        const response = yield* Effect.gen(function* () {
          if ("invalid" in testCase) {
            const exit = yield* call.pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            return undefined;
          }
          if (!("pause" in testCase)) return yield* call;
          const pending = yield* call.pipe(Effect.forkChild);
          yield* Deferred.await(blocked);
          if (testCase.finish === "timeout") {
            yield* TestClock.adjust("10 seconds");
            return yield* Fiber.join(pending);
          }
          if (testCase.finish === "error") return yield* Fiber.join(pending);
          if (testCase.finish === "shutdown") yield* (yield* McpCallLedger.McpCallLedger).shutdown;
          yield* Fiber.interrupt(pending);
          return undefined;
        });
        const row = yield* Queue.take(rows);
        expect(row).toMatchObject({
          tool: name,
          saved: "saved" in testCase ? testCase.saved : "unknown",
          props: {
            ...("invalid" in testCase
              ? {}
              : {
                  foundBy: "foundBy" in testCase ? testCase.foundBy : "none",
                  idCanonical: "canonical" in testCase ? testCase.canonical : true,
                }),
            idShape: "shape" in testCase ? testCase.shape : "task_id",
            ...("reason" in testCase ? { notFoundReason: testCase.reason } : {}),
          },
        });
        expect(row.errorTag).toBe(
          "reason" in testCase
            ? "task_not_found"
            : "error" in testCase
              ? testCase.error
              : "invalid" in testCase
                ? "invalid_request"
                : undefined,
        );
        if ("pause" in testCase)
          expect(row.outcome).toBe(
            testCase.finish === "shutdown"
              ? "interrupted_by_shutdown"
              : testCase.finish === "timeout"
                ? "timeout"
                : testCase.finish === "error"
                  ? "error"
                  : "interrupted",
          );
        expect(isAnalyticsEvent(row)).toBe(true);
        expect(JSON.stringify(row.props)).not.toMatch(/private|command:|node:|clientRequestId/);
        if (!("reason" in testCase)) expect(row.props).not.toHaveProperty("notFoundReason");
        if ("reason" in testCase) {
          const text = JSON.stringify(response);
          const threadShape =
            "shape" in testCase &&
            (testCase.shape === "thread_id" || testCase.shape === "child_thread_id");
          expect(text.includes("This looks like a thread id (childThreadId).")).toBe(threadShape);
          expect(text).toContain(
            threadShape
              ? "Use t3_thread_read for the child thread."
              : "Expected the taskId returned by delegate_task.",
          );
          expect(text).not.toContain("id" in testCase ? testCase.id : lookupId);
        }
      }
      if ("ack" in testCase) {
        yield* Deferred.await(acknowledged);
        expect(acknowledgements).toBe(1);
      }
    }).pipe(Effect.provide(registration));
  }),
);

it.effect.each(["provider", "oauth"] as const)(
  "%s auth and dispatch are separate from handler duration, including caller_unresolved",
  (credential) =>
    Effect.gen(function* () {
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          if (span.name === "tools/call") spans.push(span);
          return span;
        },
      });
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.provide(invocation),
      );
      const entered = yield* Deferred.make<void>();
      let unresolved = false;
      const toolkit = probe("timing_probe");
      const handlers = McpToolAccess.toLayer(toolkit, {
        timing_probe: McpToolAccess.actsAsCaller(() =>
          TestClock.adjust("40 millis").pipe(Effect.as({ ok: true })),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (threadId) =>
              unresolved
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(Testkit.liveThreadShell(threadId)),
          }),
        ),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              event.kind === "mcp.call"
                ? Queue.offer(rows, event).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
      );
      const authenticate = yield* McpHttpServer.makeMcpAuthMiddleware.pipe(
        Effect.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () =>
              TestClock.adjust("7 millis").pipe(
                Effect.as(
                  credential === "provider" ? { ...scope, thread: scope.thread! } : undefined,
                ),
              ),
          }),
        ),
        Effect.provideService(McpHttpServer.McpClientAuthenticator, {
          authenticate: () => TestClock.adjust("13 millis").pipe(Effect.as(scope)),
        }),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        for (const failing of [false, true]) {
          unresolved = failing;
          const httpEffect = Effect.gen(function* () {
            yield* TestClock.adjust("30 millis");
            yield* server
              .callTool({ name: "timing_probe", arguments: args })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, client),
                Effect.withSpan("tools/call"),
                Effect.orDie,
              );
            return HttpServerResponse.empty();
          });
          const pending = yield* authenticate(httpEffect).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/mcp", {
                  headers: { authorization: "Bearer timing-token" },
                }),
              ),
            ),
            Effect.forkChild,
          );
          if (unresolved) {
            yield* Deferred.await(entered);
            yield* TestClock.adjust("10 seconds");
          }
          yield* Fiber.join(pending);
          const authMs = credential === "provider" ? 7 : 20;
          const durationMs = unresolved ? 10_000 : 40;
          const row = yield* Queue.take(rows);
          expect(row).toMatchObject({
            authMs,
            dispatchMs: 30,
            preHandlerMs: authMs + 30,
            durationMs,
            totalMs: authMs + 30 + durationMs,
            outcome: unresolved ? "timeout" : "ok",
            ...(unresolved ? { errorTag: "caller_unresolved", callerResolved: false } : {}),
          });
          expect(isAnalyticsEvent(row)).toBe(true);
          expect(row.preHandlerMs).toBeGreaterThanOrEqual(row.authMs!);
          expect(Object.fromEntries(spans.at(-1)!.attributes)).toMatchObject({
            "mcp.auth_ms": authMs,
            "mcp.dispatch_ms": 30,
            "mcp.pre_handler_ms": authMs + 30,
            "mcp.total_ms": authMs + 30 + durationMs,
          });
        }
      }).pipe(Effect.provide(registration), Effect.withTracer(tracer));
    }),
);

it.effect(
  "keeps the saved outcome findable when the real MCP HTTP caller disconnects during commit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const recorded = yield* Deferred.make<AnalyticsEvent>();
        const closed = Promise.withResolvers<void>();
        const caller = yield* McpInvocationContext.McpInvocationContext.pipe(
          Effect.provide(invocation),
        );
        const raw = makeHttpSocketTelemetry(() => {}).instrument(NodeHttp.createServer());
        raw.on("request", (request, response) => {
          if (request.headers["mcp-session-id"]) response.once("close", () => closed.resolve());
        });
        const toolkit = probe("subtask_done");
        const handlers = McpToolAccess.toLayer(toolkit, {
          subtask_done: McpToolAccess.reads(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* McpCall.setSaved(true);
              return { saved: true };
            }).pipe(Effect.uninterruptible),
          ),
        });
        const serverLayer = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
          Layer.provideMerge(McpHttpServer.layerMcpTransport),
          Layer.provide(Testkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: () =>
                Effect.succeed(caller as McpInvocationContext.McpThreadInvocationScope),
            }),
          ),
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (row) =>
                row.kind === "mcp.call"
                  ? Deferred.succeed(recorded, row).pipe(Effect.asVoid)
                  : Effect.void,
              flush: Effect.void,
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provide(NodeHttpServer.layer(() => raw, { port: 0, host: "127.0.0.1" })),
          Layer.build,
        );
        const address = raw.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback listener");
        const send = (body: unknown, sessionId?: string) => {
          const request = NodeHttp.request({
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/mcp",
            agent: false,
            headers: {
              authorization: "Bearer test",
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              ...(sessionId === undefined
                ? {}
                : { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }),
            },
          });
          request.on("error", () => {});
          request.end(JSON.stringify(body));
          return request;
        };
        const sessionId = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const request = send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: client.initializePayload,
              });
              request.once("error", reject);
              request.once("response", (response) => {
                response.resume();
                response.once("end", () => resolve(String(response.headers["mcp-session-id"])));
              });
            }),
        );
        const request = send(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "subtask_done", arguments: args },
          },
          sessionId,
        );
        yield* Deferred.await(entered);
        request.destroy();
        yield* Effect.promise(() => closed.promise);
        yield* Deferred.succeed(release, undefined);
        const row = yield* Deferred.await(recorded);
        expect(row).toMatchObject({
          tool: "subtask_done",
          callerThreadId: "caller-ledger",
          saved: true,
          responseDelivery: "closed",
          responseCloseReason: "peer_end",
        });
      }),
    ),
);

it.effect("freezes the timed-out read stage before response delivery and late cleanup", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe("t3_thread_read");
    const registration = McpHttpServer.toolkitRegistration(
      toolkit,
      McpToolAccess.toLayer(toolkit, {
        t3_thread_read: McpToolAccess.reads(() =>
          ThreadReadMetrics.read(
            "timeline",
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.uninterruptible,
            ),
          ).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            row.kind === "mcp.call"
              ? Deferred.succeed(recorded, row).pipe(Effect.asVoid)
              : Effect.void,
          flush: Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const pending = yield* server.callTool({ name: "t3_thread_read", arguments: args }).pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpResponseDelivery.McpResponseDelivery, {
          settled: Deferred.await(settled),
          closeReason: "unknown",
          snapshot: () => ({ responseDelivery: "finished", responseElapsedMs: 46_000 }),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(McpDeadline.READ_TIMEOUT);
      const result = yield* Fiber.join(pending);
      expect(result.isError).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(cleaned);
      expect(yield* Deferred.isDone(recorded)).toBe(false);
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(settled, undefined);
      const row = yield* Deferred.await(recorded);
      expect(row).toMatchObject({
        outcome: "timeout",
        errorTag: "ThreadReadTimeoutError",
        durationMs: 45_000,
        responseElapsedMs: 46_000,
        threadReadStages: [{ stage: "timeline", durationMs: 45_000, completed: false }],
      });
    }).pipe(Effect.provide(registration));
  }),
);

it.effect.each(["finished", "closed"] as const)(
  "records a saved result separately from a %s HTTP response without blocking its handler",
  (responseDelivery) =>
    Effect.gen(function* () {
      const recorded = yield* Deferred.make<AnalyticsEvent>();
      const settled = yield* Deferred.make<void>();
      const toolkit = probe("subtask_done");
      const handlers = McpToolAccess.toLayer(toolkit, {
        subtask_done: McpToolAccess.reads(() =>
          McpCall.setSaved(true).pipe(Effect.as({ saved: true })),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpCallLedger.layer),
        Layer.provide(Testkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              event.kind === "mcp.call"
                ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
                : Effect.void,
            flush: Effect.void,
          }),
        ),
        Layer.provideMerge(invocation),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server.callTool({ name: "subtask_done", arguments: args }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpResponseDelivery.McpResponseDelivery, {
            settled: Deferred.await(settled),
            closeReason: "peer_end",
            snapshot: () => ({
              responseDelivery,
              responseElapsedMs: 10_000,
              ...(responseDelivery === "closed"
                ? { responseCloseReason: "peer_end" as const }
                : {}),
            }),
          }),
        );
        expect(result.isError).not.toBe(true);
        expect(yield* Deferred.isDone(recorded)).toBe(false);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(settled, undefined);
        const row = yield* Deferred.await(recorded);
        expect(row).toMatchObject({
          tool: "subtask_done",
          callerThreadId: "caller-ledger",
          outcome: "ok",
          saved: true,
          responseDelivery,
          responseElapsedMs: 10_000,
        });
        expect(row.durationMs).toBeLessThan(10_000);
        expect(row.responseCloseReason).toBe(
          responseDelivery === "closed" ? "peer_end" : undefined,
        );
        expect(yield* decodeAnalyticsEvent(row)).toEqual(row);
      }).pipe(Effect.provide(registration));
    }),
);

it.effect.each([
  { name: "shutdown before receipt", committed: false, shutdown: true, expected: "unknown" },
  { name: "shutdown after receipt", committed: true, shutdown: true, expected: true },
  { name: "shutdown blocked receipt", committed: "blocked", shutdown: true, expected: "unknown" },
  { name: "interruption before receipt", committed: false, shutdown: false, expected: false },
  { name: "interruption after receipt", committed: true, shutdown: false, expected: true },
] as const)(
  "$name records a delegate call once and awaits the disk flush",
  ({ committed, shutdown, expected }) =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const entered = yield* Deferred.make<void>();
      const flushed = yield* Deferred.make<void>();
      const checkingReceipt = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const toolkit = probe("delegate_task");
      const handlers = McpToolAccess.toLayer(toolkit, {
        delegate_task: McpToolAccess.reads(() =>
          Effect.gen(function* () {
            yield* McpCall.trackDelegation(
              "task-committed",
              committed === "blocked"
                ? Deferred.succeed(checkingReceipt, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(committed),
            );
            yield* McpCall.resolvedContext({
              boardId: "board-robob",
              id: "card-1301",
              number: 1301,
            });
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpCallLedger.layer),
        Layer.provide(Testkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                if (event.kind === "mcp.call") rows.push(event);
              }),
            flush: Deferred.succeed(flushed, undefined).pipe(Effect.asVoid),
          }),
        ),
        Layer.provideMerge(invocation),
      );
      const context = yield* Layer.buildWithScope(registration, scope);
      const server = Context.get(context, McpServer.McpServer);
      const call = yield* server
        .callTool({ name: "delegate_task", arguments: args })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provide(invocation),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      if (shutdown) {
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        if (committed === "blocked") {
          yield* Deferred.await(checkingReceipt);
          yield* TestClock.adjust("250 millis");
        }
        yield* Fiber.join(closing);
      } else {
        yield* Fiber.interrupt(call);
        yield* Scope.close(scope, Exit.void);
      }
      yield* Deferred.await(flushed);
      yield* Fiber.interrupt(call);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "mcp.call",
        tool: "delegate_task",
        outcome: shutdown ? "interrupted_by_shutdown" : "interrupted",
        callerThreadId: "caller-ledger",
        committed: expected,
        ...callIdentifiers(args, "caller-ledger"),
        cardId: "card-1301",
        props: {
          code: "unknown",
          cause: shutdown ? "shutdown" : "unknown",
          boardId: "board-robob",
          cardNumber: 1301,
          saved: "unknown",
        },
      });
      expect(rows[0]!.bootId).toBeTruthy();
      expect(rows[0]!.startedAt).toBe(rows[0]!.ts);
      expect(rows[0]!.taskId).toBe(committed === true ? "task-committed" : undefined);
      expect(yield* decodeEvent(rows[0])).toEqual(rows[0]);
    }),
);
const failure = (code: OrchestratorMcpFailure["code"], message = "private error text") =>
  Effect.fail(new OrchestratorMcpFailure({ code, message }));
const boardBusy = new KanbanError({
  code: "conflict",
  detail: "Board busy: not written (held 2m by private-operation). Safe to retry once.",
  saved: false,
});

const outcomes = [
  ["interruption", Effect.interrupt, { outcome: "interrupted" }],
  ["ok", Effect.succeed({ privateResult: "secret body" }), { outcome: "ok", saved: "unknown" }],
  [
    "successful-error-like-message",
    Effect.succeed({ message: "Board busy: not written" }),
    { outcome: "ok", saved: "unknown" },
  ],
  [
    "error",
    failure("orchestration_error"),
    { outcome: "error", errorTag: "orchestration_error", errorPhase: "handler" },
  ],
  [
    "timeout",
    failure("caller_unresolved"),
    { outcome: "timeout", errorPhase: "caller", saved: false },
  ],
  ["refused", failure("capability_denied"), { outcome: "refused", saved: false }],
  [
    "busy",
    failure("invalid_request", "Board busy: not written (held 2m). Safe to retry once."),
    { outcome: "refused", errorTag: "board_busy", saved: false },
  ],
  ...(
    [
      ["encoded", failure("invalid_request", boardBusy.message)],
      ["typed", Effect.fail(boardBusy)],
      ["defect", Effect.die(boardBusy)],
      ["legacy", failure("invalid_request", "Not saved (board busy). Safe to retry once.")],
    ] as const
  ).map(
    ([name, handle]) =>
      [
        `board-busy-${name}`,
        handle,
        { outcome: "refused", errorTag: "board_busy", saved: false },
      ] as const,
  ),
  [
    "partial",
    Effect.succeed({ partial: true, taskId: "task" }),
    { outcome: "timeout", errorTag: "partial_result", errorPhase: "result" },
  ],
  ["defect", Effect.die("private defect text"), { outcome: "error", errorTag: "Defect" }],
  [
    "wait",
    Effect.succeed({ waitTimedOut: true, taskId: "task" }),
    { outcome: "timeout", errorTag: "wait_timeout", errorPhase: "result" },
  ],
] as const;
const decodeEvent = Schema.decodeUnknownEffect(AnalyticsEvent);
it.effect("keeps the same retry hash across a caller credential namespace refresh", () =>
  Effect.gen(function* () {
    const rows: AnalyticsEvent[] = [];
    const recorded = yield* Deferred.make<void>();
    const toolkit = probe("ledger_probe");
    const handlers = McpToolAccess.toLayer(toolkit, {
      ledger_probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.gen(function* () {
              if (event.kind !== "mcp.call") return;
              rows.push(event);
              if (rows.length === 2) yield* Deferred.succeed(recorded, undefined);
            }),
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      for (const requestNamespace of ["first-credential", "refreshed-credential"]) {
        yield* server.callTool({ name: "ledger_probe", arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scope,
            requestNamespace,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      }
      yield* Deferred.await(recorded);
      expect(rows[0]!.clientRequestId).toBe(rows[1]!.clientRequestId);
      expect(rows[0]!.clientRequestId).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(registration));
  }),
);
const invalidTimeouts = [
  { name: "negative", value: -1 },
  { name: "zero", value: 0 },
  { name: "fraction", value: 1.5 },
  { name: "too-large", value: 270_001 },
  { name: "string", value: "1000" },
  { name: "null", value: null },
];
const phases = [
  { stage: "caller", phase: "caller" },
  { stage: "dispatch", phase: "dispatch" },
  { stage: "result", phase: "result" },
  { stage: "records", phase: "result" },
  ...["catalog", "request_key", "receipt", "settings", "selection", "workspace", "unknown"].map(
    (stage) => ({ stage, phase: "handler" }),
  ),
];
const browserRequest = {
  operation: "waitFor" as const,
  environmentId: EnvironmentId.make("env-ledger"),
  threadId: ThreadId.make("caller-ledger"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "private-session",
  clientId: "private-client",
  connectionId: "private-connection",
  requestId: "private-request",
  timeoutMs: 1000,
};
const remoteDiagnostic = {
  remoteTag: "private-tag",
  remoteMessageLength: 17,
  cause: new Error("private error"),
};
const boot = {
  hostId: DeviceHostId.make("host"),
  deviceId: DeviceId.make("device"),
  cause: new Error("private error"),
};
const typedFailures = [
  ...(
    [
      "link_pull_request",
      "unlink_pull_request",
      "list_thread_pull_requests",
      "write_pull_request_guides",
      "read_pull_request_guide",
    ] as const
  ).map((tool) => ({
    error: new PullRequestToolTimeoutError({ tool, saved: "unknown" }),
    outcome: "timeout",
  })),
  { error: new PullRequestWatchTimeoutError({ saved: "unknown" }), outcome: "timeout" },
  { error: new PreviewAutomationTimeoutError(browserRequest), outcome: "timeout" },
  {
    error: new PreviewAutomationRecordingDeadlineExpiredError({
      threadId: browserRequest.threadId,
    }),
    outcome: "timeout",
  },
  { error: new Cause.TimeoutError("private error"), outcome: "timeout" },
  {
    error: new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: browserRequest.environmentId,
    }),
    outcome: "refused",
  },
  {
    error: new McpCapabilityUnavailableError({
      capability: "worktree",
      environmentId: browserRequest.environmentId,
    }),
    outcome: "refused",
  },
  { error: new PreviewControlRequiredError({ tabId: "tab" }), outcome: "refused" },
  {
    error: new PreviewAutomationUnsupportedClientError({ ...browserRequest, ...remoteDiagnostic }),
    outcome: "refused",
  },
  {
    error: new DeviceActionUnavailableError({
      operation: "install",
      platform: "ios",
      reason: "unsupported",
    }),
    outcome: "refused",
  },
  { error: new DeviceToolUnavailableError({ reason: "private error" }), outcome: "refused" },
  ...(["timeout", "disk_space", "launch_failed"] as const).map((reason) => ({
    error: new DeviceBootError({ ...boot, reason }),
    outcome: reason === "timeout" ? "timeout" : "error",
  })),
  ...(
    [
      "agentMismatch",
      "humanControl",
      "tabRequired",
      "closed",
      "interrupted",
      "dialogPending",
      "tabLimit",
    ] as const
  ).map((reason) => ({
    error: new PreviewAutomationControlInterruptedError({
      ...browserRequest,
      ...remoteDiagnostic,
      reason,
    }),
    outcome: "refused",
  })),
];
const outcomeCases = [
  ...outcomes.map(([name, handle, expected]) => ({ name, handle, expected, input: args })),
  ...invalidTimeouts.map(({ name, value }) => ({
    name: `invalid-timeout-${name}`,
    handle: Effect.succeed({ ok: true }),
    expected: { outcome: "error", errorPhase: "handler" },
    input: { ...args, timeoutMs: value },
  })),
  ...[
    "timeoutMs must be valid",
    "The text says timed out",
    "timeout in a parameter value",
    "User said Board busy: not written",
    "Board busy: may have applied",
    "Missions board conflict: Board changed during this operation",
  ].map((message) => ({
    name: `diagnostic-${message}`,
    handle: failure("invalid_request", message),
    expected: { outcome: "error", errorTag: "invalid_request" },
    input: args,
  })),
  ...phases.map(({ stage, phase }) => ({
    name: `phase-${stage}`,
    handle: McpDeadline.withDeadline(failure("model_unavailable"), {
      code: "delegation_timeout",
      stage,
      threadId: ThreadId.make("caller-ledger"),
    }),
    expected: { outcome: "error", errorPhase: phase },
    input: args,
  })),
  ...typedFailures.map(({ error, outcome }) => ({
    name: `typed-${error._tag}-${"reason" in error ? error.reason : "tool" in error ? error.tool : ""}`,
    handle: Effect.fail(error),
    expected: { outcome, errorTag: outcome === "error" ? "Failure" : error._tag },
    input: args,
  })),
  {
    name: "thread-wait-timeout",
    handle: Effect.succeed({ timedOut: true }),
    expected: { outcome: "timeout", errorTag: "wait_timeout", errorPhase: "result" },
    input: args,
  },
  {
    name: "secret-request-timeout",
    handle: Effect.succeed({ status: "timed_out" }),
    expected: { outcome: "timeout", errorTag: "request_timeout", errorPhase: "result" },
    input: args,
  },
  ...["partial", "waitTimedOut", "timedOut"].map((key) => ({
    name: `not-expired-${key}`,
    handle: Effect.succeed({ [key]: false }),
    expected: { outcome: "ok" },
    input: args,
  })),
  ...["declined", "cancelled", "saved"].map((status) => ({
    name: `secret-request-${status}`,
    handle: Effect.succeed({ status }),
    expected: { outcome: "ok" },
    input: args,
  })),
];
it.effect.each(outcomeCases)(
  "records one MCP ledger row for $name without payloads",
  ({ name, handle, expected, input }) =>
    Effect.gen(function* () {
      const recorded = yield* Deferred.make<AnalyticsEvent>();
      const compatibility = yield* Deferred.make<AnalyticsEvent>();
      const toolkit = probe("ledger_probe");
      const handlers = McpToolAccess.toLayer(toolkit, {
        ledger_probe: McpToolAccess.reads(
          (): Effect.Effect<unknown, typeof ProbeFailure.Type> => handle,
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Testkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              event.kind === "mcp.call"
                ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
                : event.kind === "server.mcp" || event.kind === "server.mcp.error"
                  ? Deferred.succeed(compatibility, event).pipe(Effect.asVoid)
                  : Effect.void,
          }),
        ),
        Layer.provideMerge(invocation),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server
          .callTool({ name: "ledger_probe", arguments: input })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.exit);
        const row = yield* Deferred.await(recorded);
        expect(row).toMatchObject({
          kind: "mcp.call",
          tool: "ledger_probe",
          callerThreadId: "caller-ledger",
          boardId: "board-robob",
          cardId: "#1301",
          ...expected,
        });
        const generic = yield* Deferred.await(compatibility);
        expect(generic.props?.code).toBe(row.props?.code);
        if (name.startsWith("invalid-timeout-"))
          expect(generic.props?.code).toBe("invalid_request");
        if (name.startsWith("board-busy-")) expect(generic.props?.code).toBe("board_busy");
        expect(generic.props?.saved).toBe(row.saved);
        if ("errorTag" in expected && expected.errorTag === "orchestration_error")
          expect(generic.props?.code).toBe("orchestration_error");
        expect(JSON.stringify(generic)).not.toMatch(
          /private|secret body|namespace-ledger|session-ledger/,
        );
        expect(row.durationMs).toBeGreaterThanOrEqual(0);
        expect(row.clientRequestId).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(row)).not.toMatch(
          /private|secret body|namespace-ledger|session-ledger/,
        );
        expect(yield* decodeEvent(row)).toEqual(row);
      }).pipe(Effect.provide(registration));
    }),
);

it.effect.each(["caller", "records"] as const)(
  "preserves the %s phase when a status read returns partial",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const recorded = yield* Deferred.make<AnalyticsEvent>();
      const toolkit = probe("ledger_probe");
      const handlers = McpToolAccess.toLayer(toolkit, {
        ledger_probe: McpToolAccess.reads(() =>
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const read = readCallerIdentity(
              threads,
              ThreadId.make("caller-ledger"),
              ProviderInstanceId.make("codex"),
            ).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "Caller read failed.",
                  }),
              ),
              Effect.andThen(
                stage === "records"
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            );
            yield* read.pipe(Effect.timeoutOption("10 seconds"));
            return { partial: true };
          }),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) =>
              stage === "caller"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(Testkit.liveThreadShell(id)),
          }),
        ),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              event.kind === "mcp.call"
                ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
        Layer.provideMerge(invocation),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const pending = yield* server
          .callTool({ name: "ledger_probe", arguments: args })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(pending);
        const row = yield* Deferred.await(recorded);
        expect(row).toMatchObject({
          outcome: "timeout",
          errorTag: "partial_result",
          errorPhase: stage === "caller" ? "caller" : "result",
          callerResolved: stage === "records",
        });
      }).pipe(Effect.provide(registration));
    }),
);

it.effect("records resolved caller identity and a saved write whose reply fails", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe("evaluator_start");
    const handlers = McpToolAccess.toLayer(toolkit, {
      evaluator_start: McpToolAccess.actsAsCaller(() =>
        SavedWrite.record({ kind: "evaluator", threadId: ThreadId.make("saved-evaluator") }).pipe(
          Effect.andThen(failure("orchestration_error")),
        ),
      ),
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            event.kind === "mcp.call"
              ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
              : Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "evaluator_start", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.structuredContent).toMatchObject({ saved: true });
      const row = yield* Deferred.await(recorded);
      expect(row).toMatchObject({
        saved: true,
        outcome: "error",
        errorTag: "reply_error",
        errorPhase: "result",
        callerResolved: true,
        readerLane: "identity",
        callerReaderLane: "identity",
        props: { phase: "ack" },
      });
    }).pipe(Effect.provide(registration));
  }),
);

it.effect.each(["caller", "dispatch"] as const)("records the real %s deadline", (stage) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe("ledger_probe");
    const handlers = McpToolAccess.toLayer(toolkit, {
      ledger_probe: McpToolAccess.actsAsCaller(() =>
        stage === "caller"
          ? Effect.succeed({ ok: true })
          : McpDeadline.withDeadline(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              {
                code: "delegation_timeout",
                stage: "dispatch",
                threadId: ThreadId.make("caller-ledger"),
              },
            ),
      ),
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: (threadId) =>
            stage === "caller"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(Testkit.liveThreadShell(threadId)),
        }),
      ),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            event.kind === "mcp.call"
              ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
              : Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const pending = yield* server
        .callTool({ name: "ledger_probe", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(pending)).isError).toBe(true);
      const row = yield* Deferred.await(recorded);
      expect(row).toMatchObject({
        outcome: "timeout",
        errorTag: stage === "caller" ? "caller_unresolved" : "delegation_timeout",
        errorPhase: stage,
        callerResolved: stage !== "caller",
        ...(stage === "caller" ? { callerRole: "none", callerKind: "unknown" } : {}),
        callerResolveMs: stage === "caller" ? 10_000 : 0,
        durationMs: 10_000,
        readerLane: "identity",
        saved: stage === "caller" ? false : "unknown",
      });
    }).pipe(Effect.provide(registration));
  }),
);

it.effect.each(["throw", "defect", "blocked"] as const)(
  "a %s analytics sink cannot fail or block a tool",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const toolkit = probe("ledger_probe");
      const handlers = McpToolAccess.toLayer(toolkit, {
        ledger_probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(invocation),
        Layer.provide(Testkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: () => {
              if (mode === "throw") throw new Error("sink failed");
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(
                  mode === "defect" ? Effect.die("sink failed") : Deferred.await(release),
                ),
              );
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: "ledger_probe", arguments: args })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client));
        expect(result.structuredContent).toEqual({ ok: true });
        if (mode !== "throw") yield* Deferred.await(entered);
        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.provide(registration));
    }),
);

it.effect("shutdown uses one second total even when the durable flush blocks", () =>
  Effect.gen(function* () {
    const flushing = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      McpCallLedger.layer.pipe(
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: () => Effect.void,
            flush: Deferred.succeed(flushing, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      ),
      scope,
    );
    const ledger = Context.get(context, McpCallLedger.McpCallLedger);
    for (let index = 0; index < 3; index++) {
      yield* ledger.begin(() =>
        Effect.succeed({
          ts: "2026-11-13T12:00:00.000Z",
          kind: "mcp.call",
          surface: "server",
          route: "mcp",
          outcome: "interrupted_by_shutdown",
          tool: "delegate_task",
        }),
      );
    }
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.await(flushing);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(closing);
  }),
);

const taskIdKeys = [
  ["plain", "review-1338_v1.2"],
  ["parentheses", "review(1338)"],
  ["bang", "review!1338"],
  ["apostrophe", "review'1338"],
  ["star", "review*1338"],
  ["tilde", "review~1338"],
  ["separators", "review:/#@%+1338"],
  ["whitespace", "review 1338\tunit"],
  ["unicode", "مراجعة-1338"],
  ["maximum-key", "界".repeat(256)],
] as const;
it.effect.each(taskIdKeys.map(([name, key]) => ({ name, key })))(
  "retains a committed delegated task ID with $name retry keys",
  ({ key }) =>
    Effect.gen(function* () {
      const taskId = IdAllocator.derive.delegatedTaskNode({
        commandId: CommandId.make(`command:mcp:delegate-task:caller:${encodeURIComponent(key)}`),
      });
      const row = {
        callerThreadId: IdAllocator.derive.delegatedTaskThread({
          commandId: CommandId.make(`command:mcp:delegate-task:caller:${encodeURIComponent(key)}`),
        }),
        ts: "2026-11-13T12:00:00.000Z",
        kind: "mcp.call",
        surface: "server" as const,
        route: "mcp",
        tool: "delegate_task",
        committed: true,
        taskId,
        outcome: "interrupted_by_shutdown" as const,
      };
      expect(yield* decodeEvent(row)).toEqual(row);
    }),
);

it.effect("rejects new tool calls while shutdown waits for the disk drain", () =>
  Effect.gen(function* () {
    const flushing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let handled = 0;
    const toolkit = probe("ledger_probe");
    const handlers = McpToolAccess.toLayer(toolkit, {
      ledger_probe: McpToolAccess.reads(() =>
        Effect.sync(() => {
          handled++;
          return { ok: true };
        }),
      ),
    });
    const layer = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(McpCallLedger.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: () => Effect.void,
          flush: Deferred.succeed(flushing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const ledger = yield* McpCallLedger.McpCallLedger;
      const server = yield* McpServer.McpServer;
      const closing = yield* ledger.shutdown.pipe(Effect.forkChild);
      yield* Deferred.await(flushing);
      const result = yield* server
        .callTool({ name: "ledger_probe", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ reason: "server_shutting_down" });
      expect(handled).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      const after = yield* server
        .callTool({ name: "ledger_probe", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(after.isError).toBe(true);
      expect(handled).toBe(0);
    }).pipe(Effect.provide(layer));
  }),
);

const shutdownCommitRaces = [
  { name: "receipt lookup before dispatch", trackBeforeShutdown: true, finishAfterCommit: false },
  { name: "handler before receipt tracking", trackBeforeShutdown: false, finishAfterCommit: false },
  { name: "handler completes during flush", trackBeforeShutdown: true, finishAfterCommit: true },
];
it.effect.each(shutdownCommitRaces)(
  "does not report false when an admitted $name can still commit during shutdown",
  ({ trackBeforeShutdown, finishAfterCommit }) =>
    Effect.gen(function* () {
      let committed = false;
      const rows: AnalyticsEvent[] = [];
      const entered = yield* Deferred.make<void>();
      const allowCommit = yield* Deferred.make<void>();
      const didCommit = yield* Deferred.make<void>();
      const flushing = yield* Deferred.make<void>();
      const finishFlush = yield* Deferred.make<void>();
      const toolkit = probe("delegate_task");
      const track = McpCall.trackDelegation(
        "created-task",
        Effect.sync(() => committed),
      );
      const handlers = McpToolAccess.toLayer(toolkit, {
        delegate_task: McpToolAccess.reads(() =>
          Effect.gen(function* () {
            if (trackBeforeShutdown) yield* track;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(allowCommit);
            if (!trackBeforeShutdown) yield* track;
            committed = true;
            yield* Deferred.succeed(didCommit, undefined);
            return finishAfterCommit ? { taskId: "created-task" } : yield* Effect.never;
          }),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpCallLedger.layer),
        Layer.provide(Testkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (row) =>
              Effect.sync(() => {
                if (row.kind === "mcp.call") rows.push(row);
              }),
            flush: Deferred.succeed(flushing, undefined).pipe(
              Effect.andThen(Deferred.await(finishFlush)),
            ),
          }),
        ),
        Layer.provideMerge(invocation),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const ledger = yield* McpCallLedger.McpCallLedger;
        const call = yield* server
          .callTool({ name: "delegate_task", arguments: args })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
        yield* Deferred.await(entered);
        const stopping = yield* ledger.shutdown.pipe(Effect.forkChild);
        yield* Deferred.await(flushing);
        yield* Deferred.succeed(allowCommit, undefined);
        yield* Deferred.await(didCommit);
        if (finishAfterCommit) yield* Fiber.join(call);
        yield* Deferred.succeed(finishFlush, undefined);
        yield* Fiber.join(stopping);
        yield* Fiber.interrupt(call);
        expect(committed).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: "interrupted_by_shutdown",
          committed: "unknown",
          ...callIdentifiers(args, "caller-ledger"),
        });
        expect(rows[0]!.taskId).toBeUndefined();
      }).pipe(Effect.provide(registration));
    }),
);

it.effect("card_next records interrupted calls with caller and duration", () =>
  Effect.gen(function* () {
    const rows: AnalyticsEvent[] = [];
    const entered = yield* Deferred.make<void>();
    const toolkit = probe("card_next");
    const handlers = McpToolAccess.toLayer(toolkit, {
      card_next: McpToolAccess.reads(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.sync(() => {
              if (event.kind === "mcp.call") rows.push(event);
            }),
          flush: Effect.void,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const request = yield* server
        .callTool({ name: "card_next", arguments: args })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provide(invocation),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.interrupt(request);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "mcp.call",
        tool: "card_next",
        callerThreadId: "caller-ledger",
        outcome: "interrupted",
      });
      expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(3000);
    }).pipe(Effect.provide(registration));
  }),
);

it.effect.each([
  { waitStage: "lookup.target", callerLane: "identity" },
  { waitStage: "waiting", callerLane: "identity" },
  { waitStage: "lookup.target", callerLane: "background" },
  { waitStage: "waiting", callerLane: "background" },
] as const)(
  "thread wait $waitStage preserves $callerLane caller lane after handler lane changes",
  ({ waitStage, callerLane }) =>
    Effect.gen(function* () {
      const recorded = yield* Deferred.make<AnalyticsEvent>();
      let shellReads = 0;
      const toolkit = probe("t3_thread_wait");
      const handlers = McpToolAccess.toLayer(toolkit, {
        t3_thread_wait: McpToolAccess.actsAsCaller(() =>
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(McpCall.McpCall);
            if (context._tag === "None") return yield* Effect.die("Missing MCP analytics context");
            const state = context.value;
            state.waitStage = waitStage;
            state.waitLookupMs = 600;
            state.readerLane = waitStage === "waiting" ? "background" : "foreground";
            if (waitStage === "lookup.target") return yield* failure("lookup_timeout");
            return { status: "running", timedOut: true };
          }),
        ),
      });
      const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.succeed(
                Testkit.liveThreadShell(
                  id,
                  callerLane === "background" ? { activeRunId: null } : {},
                ),
              ),
            getThreadShell: (id) =>
              Effect.sync(() => {
                shellReads++;
                return Testkit.liveThreadShell(id);
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              event.kind === "mcp.call"
                ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
        Layer.provideMerge(invocation),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server
          .callTool({ name: "t3_thread_wait", arguments: args })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client));
        const row = yield* Deferred.await(recorded);
        expect(shellReads).toBe(callerLane === "background" ? 1 : 0);
        expect(yield* decodeAnalyticsEvent(row)).toMatchObject({
          tool: "t3_thread_wait",
          outcome: "timeout",
          waitStage,
          waitLookupMs: 600,
          callerReaderLane: callerLane,
          readerLane: callerLane,
          errorTag: waitStage === "waiting" ? "wait_timeout" : "lookup_timeout",
        });
      }).pipe(Effect.provide(registration));
    }),
);

const provenanceCases = [
  {
    name: "card thread",
    origin: "card",
    own: true,
    role: "work",
    kind: "board_thread",
    number: 4336,
  },
  {
    name: "legacy run origin",
    origin: "legacy",
    own: false,
    role: "work",
    kind: "delegated_child",
    number: 4336,
  },
  ...(["work", "review", "evaluator", "discussion"] as const).map((role) => ({
    name: `explicit subagent of ${role}`,
    origin: "subagent" as const,
    own: false,
    role,
    kind: "delegated_child" as const,
    number: 4336,
  })),
  {
    name: "ordinary fork",
    origin: "fork",
    own: false,
    role: "none",
    kind: "plain_thread",
    number: null,
  },
  {
    name: "explicit root",
    origin: "root",
    own: false,
    role: "none",
    kind: "plain_thread",
    number: null,
  },
  {
    name: "ordinary fork with own card",
    origin: "fork",
    own: true,
    role: "work",
    kind: "board_thread",
    number: 4339,
  },
] as const;

it.effect.each([
  ...provenanceCases.map((scenario) => ({ ...scenario, tool: "delegate_task" as const })),
  { ...provenanceCases[0], name: "card thread with read timings", tool: "t3_thread_read" as const },
])("attributes $tool: $name", (scenario) =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe(scenario.tool);
    const handlers = McpToolAccess.toLayer(toolkit, {
      [scenario.tool]: McpToolAccess.actsAsCaller(() =>
        scenario.tool === "t3_thread_read"
          ? ThreadReadMetrics.read("shell", TestClock.adjust(7).pipe(Effect.as({ ok: true })))
          : McpCall.failedPhase("dispatch").pipe(Effect.andThen(failure("delegation_timeout"))),
      ),
    });
    const callerId = ThreadId.make("caller-ledger");
    const parentId = ThreadId.make("card-parent");
    const shell = Testkit.liveThreadShell(callerId);
    const { lineage, ...legacyCaller } = shell;
    const explicitLineage =
      scenario.origin === "fork" || scenario.origin === "subagent"
        ? ({
            parentThreadId: parentId,
            rootThreadId: parentId,
            relationshipToParent: scenario.origin,
          } as const)
        : lineage;
    const forkedFrom =
      scenario.origin === "card"
        ? null
        : { type: "run" as const, threadId: parentId, runId: shell.activeRunId! };
    const callerRow = {
      ...(scenario.origin === "legacy" ? legacyCaller : { ...shell, lineage: explicitLineage }),
      forkedFrom,
    };
    const cachedCard = (number: number) => ({
      boardId: "board-crpko",
      cardId: `card-${number}`,
      cardNumber: number,
      cardStage: "working",
      callerRole: scenario.role === "none" ? ("work" as const) : scenario.role,
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: () => Effect.succeed(callerRow),
          getThreadShell: () => Effect.succeed({ ...shell, lineage: explicitLineage, forkedFrom }),
        }),
      ),
      Layer.provide(
        Layer.mock(KanbanService)({
          attachmentPath: () => null,
          callerAnalytics: (id) =>
            id === parentId
              ? cachedCard(4336)
              : id === callerId && scenario.own
                ? cachedCard(scenario.number!)
                : { callerRole: "none" as const, callerKind: "plain_thread" as const },
        }),
      ),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            row.kind === "mcp.call"
              ? Deferred.succeed(recorded, row).pipe(Effect.asVoid)
              : Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* server
        .callTool({ name: scenario.tool, arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      const row = yield* Deferred.await(recorded);
      expect(row).toMatchObject({
        callerRole: scenario.role,
        callerKind: scenario.kind,
        ...(scenario.tool === "t3_thread_read"
          ? {
              outcome: "ok",
              callerReaderLane: "identity",
              readerLane: "identity",
              readerWaitMs: 0,
              queryMs: 0,
              renderMs: 0,
              inFlightAtStart: { session: 1, overall: 1 },
              threadReadStages: [
                { stage: "shell", durationMs: 7, completed: true, readerWaitMs: 0, queryMs: 0 },
              ],
            }
          : { errorTag: "delegation_timeout" }),
      });
      expect(row.callerCardNumber).toBe(scenario.number ?? undefined);
      expect(row.cardNumber).toBe(scenario.number ?? undefined);
      expect(row.callerCardStage).toBe(scenario.number === null ? undefined : "working");
      if (scenario.number !== null)
        expect(row).toMatchObject({
          boardId: "board-crpko",
          cardId: `card-${scenario.number}`,
          cardStage: "working",
        });
    }).pipe(Effect.provide(registration));
  }),
);

it.effect("retains a fixed denial reason after the toolkit encodes the failure", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe("reason_probe");
    const handlers = McpToolAccess.toLayer(toolkit, {
      reason_probe: McpToolAccess.reads(() =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            reason: "subtask_not_in_current_step",
            message: "private refusal body",
          }),
        ),
      ),
    });
    const registration = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            row.kind === "mcp.call"
              ? Deferred.succeed(recorded, row).pipe(Effect.asVoid)
              : Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
      Layer.provide(Testkit.liveThreadsLayer),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* server
        .callTool({ name: "reason_probe", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      const row = yield* Deferred.await(recorded);
      expect(row).toMatchObject({
        errorTag: "capability_denied",
        denyReason: "subtask_not_in_current_step",
        outcome: "refused",
      });
      expect(JSON.stringify(row)).not.toContain("private refusal body");
    }).pipe(Effect.provide(registration));
  }),
);

it.effect("the canonical target replaces caller attribution and survives dependency reads", () =>
  Effect.gen(function* () {
    const state: McpCall.McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      phase: "handler",
      readerLane: "foreground",
      saved: "unknown",
      cardId: "caller-card",
      cardNumber: 4336,
      callerCardNumber: 4336,
      callerCardStage: "working",
    };
    yield* McpCall.resolvedContext({
      boardId: "board-crpko",
      id: "target-card",
      number: 4339,
      stage: "in_review",
    }).pipe(Effect.provideService(McpCall.McpCall, state));
    yield* McpCall.resolvedContext({
      boardId: "board-crpko",
      id: "dependency-card",
      number: 4343,
      stage: "todo",
    }).pipe(Effect.provideService(McpCall.McpCall, state));
    expect(state).toMatchObject({
      cardId: "target-card",
      cardNumber: 4339,
      cardStage: "in_review",
      callerCardNumber: 4336,
      callerCardStage: "working",
    });
  }),
);

it("does not take refusal metadata from a successful result body", () => {
  const state: McpCall.McpCall["Service"] = {
    callerResolved: true,
    callerResolveMs: 0,
    readerLane: "foreground",
    phase: "handler",
    saved: "unknown",
  };
  const result = McpCall.callOutcome(
    Exit.succeed(
      new McpSchema.CallToolResult({
        content: [],
        structuredContent: { code: "invalid_request", reason: "invalid_args" },
      }),
    ),
    state,
  );
  expect(result.outcome).toBe("ok");
  expect(state.denyReason).toBeUndefined();
});

it.each([
  ["work", "board_thread"],
  ["review", "delegated_child"],
] as const)("caller_unresolved preserves known %s caller context", (callerRole, callerKind) => {
  const state: McpCall.McpCall["Service"] = {
    callerResolved: false,
    callerResolveMs: 10000,
    readerLane: "foreground",
    phase: "caller",
    saved: "unknown",
    callerRole,
    callerKind,
    callerCardNumber: 4336,
    callerCardStage: "working",
  };
  const result = McpCall.callOutcome(
    Exit.fail(
      new OrchestratorMcpFailure({ code: "caller_unresolved", message: "Caller lookup timed out" }),
    ),
    state,
  );
  expect(result).toMatchObject({ outcome: "timeout", errorTag: "caller_unresolved" });
  expect(state).toMatchObject({
    callerRole,
    callerKind,
    callerCardNumber: 4336,
    callerCardStage: "working",
  });
});

it.effect("records a late detached create with the original HTTP call's correlation metadata", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const callRow = yield* Deferred.make<AnalyticsEvent>();
    const detachedRow = yield* Deferred.make<AnalyticsEvent>();
    const toolkit = probe("delegate_task");
    const registration = McpHttpServer.toolkitRegistration(
      toolkit,
      McpToolAccess.toLayer(toolkit, {
        delegate_task: McpToolAccess.reads(() =>
          McpDeadline.withDeadline(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ taskId: "created-task" }),
            ),
            {
              code: "delegation_timeout",
              threadId: ThreadId.make("caller-ledger"),
              stage: "dispatch",
              onTimeout: "detach",
              requestKey: args.clientRequestId,
            },
          ),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Testkit.liveThreadsLayer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            row.kind === "mcp.call"
              ? Deferred.succeed(callRow, row).pipe(Effect.asVoid)
              : row.kind === "mcp.detached"
                ? Deferred.succeed(detachedRow, row).pipe(Effect.asVoid)
                : Effect.void,
        }),
      ),
      Layer.provideMerge(invocation),
    );
    yield* Effect.gen(function* () {
      const pending = yield* (yield* McpServer.McpServer)
        .callTool({ name: "delegate_task", arguments: args })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(pending)).isError).toBe(true);
      const call = yield* Deferred.await(callRow);
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.succeed(release, undefined);
      const detached = yield* Deferred.await(detachedRow);
      expect(detached).toMatchObject({
        kind: "mcp.detached",
        outcome: "committed",
        lateMs: 3000,
        tool: call.tool,
        startedAt: call.startedAt,
        bootId: call.bootId,
        build: call.build,
        clientRequestId: call.clientRequestId,
        callerThreadId: call.callerThreadId,
      });
      expect(JSON.stringify(detached)).not.toContain(args.clientRequestId);
      yield* decodeAnalyticsEvent(detached);
    }).pipe(Effect.provide(registration));
  }),
);
