import { expect, it } from "@effect/vitest";
import {
  AnalyticsEvent,
  CommandId,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as McpCallLedger from "../ardud/analytics/McpCallLedger.ts";
import * as McpCall from "../ardud/analytics/McpCall.ts";
import * as SavedWrite from "../ardud/kanban/engine/savedWrite.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as Testkit from "./McpToolAccess.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { callIdentifiers } from "../ardud/analytics/McpCall.ts";
import * as McpDeadline from "./McpDeadline.ts";
import { readCallerIdentity } from "./callerIdentity.ts";

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
const args = { clientRequestId: "private retry id", boardId: "board-robob", card: "#1301" };

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
    name: `typed-${error._tag}-${"reason" in error ? error.reason : ""}`,
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
        readerLane: "foreground",
        props: { phase: "caller" },
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
        callerResolveMs: stage === "caller" ? 10_000 : 0,
        durationMs: 10_000,
        readerLane: "foreground",
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
