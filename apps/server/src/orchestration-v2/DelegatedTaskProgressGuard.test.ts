import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  AnalyticsEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Guard from "./DelegatedTaskProgressGuard.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { normalizeIdleTimeout, stalledSummary } from "./delegatedTaskProgress.ts";

const threadId = ThreadId.make("child");
const runId = RunId.make("run");
const decodeAnalytics = Schema.decodeEffect(AnalyticsEvent, { onExcessProperty: "error" });
const makeHarness = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const stops: Array<Threads.ThreadManagementInterruptInput> = [];
  const recoveries: Array<Threads.ThreadManagementSendInput> = [];
  const analytics: Array<AnalyticsEvent> = [];
  let failPromptRead = false;
  let interruptRace: Effect.Effect<void> | undefined;
  let selectedTimeout: number | undefined;
  const retryChecks: number[] = [];
  let stopForRetry = false;
  let retryLookup:
    | NonNullable<Threads.ThreadManagementServiceShape["getDelegatedRetryCheck"]>
    | undefined;
  let run = {
    id: runId,
    threadId,
    providerInstanceId: ProviderInstanceId.make("test-provider"),
    delegatedTaskId: NodeId.make("task"),
    status: "running",
    activeAttemptId: null,
    providerThreadId: ProviderThreadId.make("provider-thread"),
    ordinal: 1,
    startedAt: DateTime.makeUnsafe(-3_600_000),
  } as OrchestrationV2Run;
  let projection = {
    thread: { projectId: "project" },
    runs: [run],
    turnItems: [],
    runtimeRequests: [],
    messages: [],
    providerThreads: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const guard = yield* Guard.DelegatedTaskProgressGuard.pipe(
    Effect.provide(
      Guard.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (_threadId, sections) =>
                Effect.suspend(() => {
                  if (failPromptRead && sections.length === 1 && sections[0] === "messages") {
                    failPromptRead = false;
                    return Effect.die(new Error("temporary prompt read failure"));
                  }
                  return Effect.succeed({
                    ...projection,
                    subagents: [
                      {
                        id: NodeId.make("task"),
                        origin: "app_owned",
                        childThreadId: threadId,
                        idleTimeoutMs: 60_000,
                      },
                    ],
                  } as unknown as OrchestrationV2ThreadProjection);
                }),
              streamDomainEvents: Stream.empty,
              getShellSnapshot: () =>
                Effect.succeed({
                  threads: [
                    {
                      id: threadId,
                      activeRunId: run.id,
                      lineage: {
                        relationshipToParent: "subagent",
                        parentThreadId: ThreadId.make("parent"),
                      },
                    },
                  ],
                } as never),
            }),
            Layer.mock(Threads.ThreadManagementService)({
              sendToThread: (input) =>
                Effect.sync(() => {
                  recoveries.push(input);
                  run = { ...run, delegatedTaskStallRecovery: input.delegatedTaskStallRecovery };
                  projection = { ...projection, runs: [run] };
                  return { run } as never;
                }),
              getDelegatedRetryCheck: (input) =>
                retryLookup?.(input) ??
                Effect.succeed(
                  Effect.gen(function* () {
                    retryChecks.push(DateTime.toEpochMillis(yield* DateTime.now));
                    return stopForRetry;
                  }),
                ),
              interruptThread: (input) =>
                Effect.gen(function* () {
                  if (interruptRace !== undefined) {
                    const race = interruptRace;
                    interruptRace = undefined;
                    yield* race;
                    return {
                      type: "interrupt_requested",
                      run,
                      dispatch: { storedEvents: [] },
                    } as never;
                  }
                  return yield* Effect.sync(() => {
                    stops.push(input);
                    return {
                      type: "interrupt_requested",
                      run,
                      dispatch: {
                        commandId: CommandId.make("stop"),
                        storedEvents: [
                          {
                            event: {
                              type: "run.updated",
                              payload: { ...run, delegatedTaskStall: input.delegatedTaskStall },
                            },
                          },
                        ],
                      },
                    } as never;
                  });
                }),
            }),
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                decodeAnalytics(event).pipe(
                  Effect.orDie,
                  Effect.tap((decoded) =>
                    Effect.sync(() => {
                      analytics.push(decoded);
                    }),
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
      ),
    ),
  );
  const send = (
    data: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "runId" | "occurredAt">,
  ) =>
    Effect.gen(function* () {
      const event = {
        ...data,
        id: EventId.make("event"),
        threadId,
        runId: run.id,
        occurredAt: yield* DateTime.now,
      } as OrchestrationV2DomainEvent;
      yield* guard.handle(event);
    });
  const start = (idleTimeoutMs?: number) =>
    Effect.gen(function* () {
      selectedTimeout = idleTimeoutMs;
      yield* guard.handle({
        id: EventId.make("task"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: NodeId.make("task"),
          origin: "app_owned",
          childThreadId: threadId,
          idleTimeoutMs,
        },
      } as OrchestrationV2DomainEvent);
      yield* send({ type: "run.updated", payload: run });
    });
  const item = (
    type:
      | "reasoning"
      | "command_execution"
      | "dynamic_tool"
      | "file_change"
      | "file_search"
      | "web_search"
      | "compaction"
      | "subagent",
    status: "running" | "completed" = "running",
  ) =>
    send({
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(type),
        runId: run.id,
        type,
        origin: "provider_native",
        status,
      } as OrchestrationV2TurnItem,
    });
  const followup = () =>
    Effect.gen(function* () {
      yield* send({ type: "run.updated", payload: { ...run, status: "interrupted" } });
      run = { ...run, id: RunId.make("followup"), ordinal: 2 };
      projection = { ...projection, runs: [run] };
      yield* send({ type: "run.updated", payload: run });
      yield* guard.handle({
        id: EventId.make("followup-task"),
        type: "subagent.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          id: run.delegatedTaskId,
          origin: "app_owned",
          childThreadId: threadId,
          idleTimeoutMs: selectedTimeout,
          status: "running",
        },
      } as OrchestrationV2DomainEvent);
    });
  return {
    guard,
    stops,
    recoveries,
    analytics,
    failNextPromptRead: () => {
      failPromptRead = true;
    },
    projectItems: (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
      projection = { ...projection, turnItems: items };
    },
    enableProvider: (driver: "codex" | "claudeAgent" = "codex") => {
      const instanceId = ProviderInstanceId.make(driver);
      const providerThreadId = ProviderThreadId.make("provider-child");
      run = {
        ...run,
        providerInstanceId: instanceId,
        providerThreadId,
        userMessageId: MessageId.make("original"),
        modelSelection: {
          instanceId,
          model: driver === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5",
          options: [{ id: driver === "codex" ? "reasoningEffort" : "effort", value: "max" }],
        },
      };
      projection = {
        ...projection,
        runs: [run],
        providerThreads: [{ id: providerThreadId, driver }],
        messages: [
          {
            id: run.userMessageId,
            runId,
            role: "user",
            text: "Review this patch",
            attachments: [],
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
    },
    retryChecks,
    markNetworkRecovery: () => {
      run = {
        ...run,
        transientRecovery: {
          since: DateTime.formatIso(now),
          firstError: {
            class: "transport_error",
            code: "claude_network_error",
            category: "transient",
            retryable: true,
            message: "Connection dropped (ECONNRESET)",
          },
        },
      };
      projection = { ...projection, runs: [run] };
    },
    useRetryLookup: (
      lookup: NonNullable<Threads.ThreadManagementServiceShape["getDelegatedRetryCheck"]>,
    ) => {
      retryLookup = lookup;
    },
    resumeAttempt: (status: OrchestrationV2Run["status"] = "running") =>
      Effect.gen(function* () {
        run = { ...run, status, activeAttemptId: RunAttemptId.make("resumed") };
        projection = { ...projection, runs: [run] };
        yield* send({ type: "run.updated", payload: run });
      }),
    stopForRetry: () => {
      stopForRetry = true;
    },
    start,
    item,
    send,
    followup,
    now,
    projectRequestAt: (at: DateTime.Utc, kind: string) => {
      projection = {
        ...projection,
        runtimeRequests: [
          { id: "request", kind, createdAt: now, resolvedAt: at, status: "resolved" },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
    },
    projectTextAt: (at: DateTime.Utc) => {
      projection = {
        ...projection,
        messages: [{ runId: run.id, role: "assistant", text: "Observed text", updatedAt: at }],
      } as unknown as OrchestrationV2ThreadProjection;
    },
    raceInterrupt: (effect: Effect.Effect<void>) => {
      interruptRace = effect;
    },
  };
});

describe("DelegatedTaskProgressGuard", () => {
  it.effect("a failed original-prompt read does not disable later recovery", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.enableProvider();
      yield* h.start(60_000);
      yield* TestClock.adjust("1 minute");
      h.failNextPromptRead();
      yield* h.guard.check();
      assert.lengthOf(h.recoveries, 0);
      assert.lengthOf(h.stops, 0);
      yield* h.guard.check();
      assert.lengthOf(h.recoveries, 1);
      assert.equal(h.recoveries[0]!.text, "Review this patch");
      assert.lengthOf(h.analytics, 1);
    }),
  );

  it.effect("parallel tools are attributed in completion order", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      const items = [1, 2].map((ordinal): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(`parallel-${ordinal}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        type: "dynamic_tool",
        ordinal,
        status: "running",
        title: null,
        startedAt: h.now,
        completedAt: null,
        toolName: `tool-${ordinal}`,
        input: null,
        updatedAt: h.now,
      }));
      for (const item of items) yield* h.send({ type: "turn-item.updated", payload: item });
      for (const index of [1, 0]) {
        yield* TestClock.adjust("1 second");
        items[index] = {
          ...items[index]!,
          status: "completed",
          completedAt: yield* DateTime.now,
          updatedAt: yield* DateTime.now,
        };
        yield* h.send({ type: "turn-item.updated", payload: items[index]! });
      }
      h.projectItems(items);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.equal(h.stops[0]!.delegatedTaskStall?.lastProgressTool, "tool-1");
      assert.equal(h.analytics[0]!.props?.lastProgressTool, "tool-1");
      assert.equal(h.analytics[0]!.props?.silentSeconds, 60);
    }),
  );

  it.effect.each(["post_tool", "first_event", "mid_turn"] as const)(
    "%s recovers at most once and records each stall decision",
    (phase) =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.enableProvider();
        yield* h.start(60_000);
        if (phase === "post_tool") yield* h.item("dynamic_tool", "completed");
        if (phase === "mid_turn") yield* h.item("reasoning");
        yield* TestClock.adjust("1 minute");
        yield* h.guard.check();
        if (phase !== "mid_turn") {
          assert.lengthOf(h.stops, 0);
          assert.lengthOf(h.recoveries, 1);
          assert.equal(h.recoveries[0]!.mode, "restart");
          assert.equal(h.recoveries[0]!.modelSelection?.model, "gpt-6.1-sol");
          assert.equal(
            h.recoveries[0]!.text,
            phase === "post_tool"
              ? "Your last model request got no reply. Write your final report now from what you have."
              : "Review this patch",
          );
          assert.equal(h.recoveries[0]!.delegatedTaskStallRecovery?.phase, phase);
          yield* h.guard.check();
          assert.lengthOf(h.analytics, 1);
          yield* TestClock.adjust("1 minute");
          yield* h.guard.check();
          assert.lengthOf(h.recoveries, 1);
        }
        assert.lengthOf(h.stops, 1);
        assert.deepEqual(
          h.analytics.map((event) => event.props?.action),
          phase === "mid_turn"
            ? ["failed"]
            : [phase === "post_tool" ? "resumed" : "restarted", "failed"],
        );
        assert.equal(h.analytics[0]!.props?.phase, phase);
        assert.equal(h.analytics[0]!.props?.silentSeconds, 60);
        assert.equal(h.analytics[0]!.props?.effort, "max");
      }),
  );

  it.each(["post_tool", "first_event"] as const)(
    "%s summary names the missing final report",
    (phase) => {
      const text = stalledSummary(
        {
          idleTimeoutMs: 900_000,
          lastProgressAt: DateTime.makeUnsafe("2026-11-16T07:34:02Z"),
          lastProgressKind: phase === "post_tool" ? "dynamic_tool_finished" : "run_started",
          lastProgressTool: "t3-code.list_thread_pull_requests",
          phase,
        },
        "Checking files",
      );
      assert.include(text, "stalled: no model output for 15 min after ");
      assert.include(
        text,
        phase === "post_tool" ? "tool t3-code.list_thread_pull_requests" : "run start",
      );
      assert.include(text, "at 2026-11-16T07:34:02.000Z; no final report");
      assert.include(text, "Checking files");
    },
  );

  it.effect.each(
    [
      { value: undefined, expected: 900_000 },
      { value: 0, expected: 900_000 },
      { value: -1, expected: 60_000 },
      { value: 1, expected: 60_000 },
      { value: 60_000, expected: 60_000 },
      { value: 120_000, expected: 120_000 },
      { value: 7_200_000, expected: 7_200_000 },
      { value: 9_000_000, expected: 7_200_000 },
    ].flatMap((bound) =>
      ["settings-before-run", "run-before-settings"].map((order) => ({ ...bound, order })),
    ),
  )("honours $value with $order", ({ order, value, expected }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      if (order === "run-before-settings") {
        yield* h.send({
          type: "run.updated",
          payload: {
            id: runId,
            ordinal: 1,
            delegatedTaskId: NodeId.make("task"),
            status: "running",
            activeAttemptId: null,
          },
        } as never);
      }
      yield* h.start(value);
      yield* TestClock.adjust(expected - 1);
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust(1);
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );

  it.effect.each([
    "user_input",
    "command",
    "file-read",
    "file-change",
    "mcp-elicitation",
    "permission",
    "auth_refresh",
  ])("a resolved %s request fences out a stale deadline", (kind) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("59 seconds");
      h.projectRequestAt(yield* DateTime.now, kind);
      yield* TestClock.adjust("1 second");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("59 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect.each(["completed", "failed"] as const)("a %s run releases tracking", (status) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "run.updated",
        payload: { id: runId, ordinal: 1, delegatedTaskId: NodeId.make("task"), status },
      } as never);
      assert.isNull(h.guard.status(threadId).lastProgressAt);
    }),
  );
  it.effect("interrupted tracking expires while immediate steering retains the clock", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "run.updated",
        payload: {
          id: runId,
          ordinal: 1,
          delegatedTaskId: NodeId.make("task"),
          status: "interrupted",
        },
      } as never);
      assert.isNotNull(h.guard.status(threadId).lastProgressAt);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.isNull(h.guard.status(threadId).lastProgressAt);
    }),
  );

  it.effect("a queued follow-up cannot replace the active run's clock", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "run.created",
        payload: {
          id: RunId.make("queued"),
          ordinal: 2,
          delegatedTaskId: NodeId.make("next-task"),
          status: "queued",
        },
      } as never);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
      assert.equal(h.stops[0]!.runId, runId);
    }),
  );
  it.effect("an old terminal event cannot replace a running follow-up", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("30 seconds");
      yield* h.followup();
      yield* h.send({
        type: "run.updated",
        payload: {
          id: runId,
          ordinal: 1,
          delegatedTaskId: NodeId.make("task"),
          status: "completed",
        },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
      assert.equal(h.stops[0]!.runId, "followup");
    }),
  );
  it.effect("an async app-owned descendant does not hide the parent's idle period", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make("async-child"),
          type: "subagent",
          origin: "app_owned",
          status: "running",
        },
      } as never);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("projection progress missed by the observer advances the clock once", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("30 seconds");
      h.projectTextAt(yield* DateTime.now);
      yield* TestClock.adjust("30 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("30 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("progress racing a declined interrupt is retained for the next deadline", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("1 minute");
      h.raceInterrupt(
        h.send({
          type: "message.updated",
          payload: { id: MessageId.make("racing-text"), role: "assistant", text: "Still working" },
        } as never),
      );
      yield* h.guard.check();
      assert.equal(h.guard.status(threadId).lastProgressKind, "assistant_text");
      yield* TestClock.adjust("59 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("1 second");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("restart restores a running child's override with a fresh clock", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.guard.start();
      yield* TestClock.adjust("59 seconds");
      assert.equal(h.guard.status(threadId).lastProgressAt, DateTime.formatIso(h.now));
      assert.equal(h.guard.status(threadId).lastProgressKind, "server_restarted");
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("1 second");
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("time queued before the first provider start does not consume the idle budget", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.send({
        type: "run.updated",
        payload: { id: runId, delegatedTaskId: NodeId.make("task"), status: "starting" },
      } as never);
      yield* TestClock.adjust("1 hour");
      yield* h.start();
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("15 minutes");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("top-level runs are outside the guard", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.send({ type: "run.updated", payload: { id: runId, status: "running" } } as never);
      yield* TestClock.adjust("2 hours");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      assert.isNull(h.guard.status(threadId).lastProgressAt);
    }),
  );
  it.effect(
    "thinking and provider retries do not reset the clock; status distinguishes thinking from startup",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.start();
        yield* TestClock.adjust("10 minutes");
        yield* h.item("reasoning");
        yield* h.send({
          type: "turn-item.updated",
          payload: {
            id: TurnItemId.make("retry"),
            type: "error",
            status: "running",
            retry: { attempt: 1 },
          } as OrchestrationV2TurnItem,
        });
        assert.equal(h.guard.status(threadId).lastProgressAt, DateTime.formatIso(h.now));
        assert.isNotNull(h.guard.status(threadId).thinkingSince);
        yield* TestClock.adjust("5 minutes");
        yield* h.guard.check();
        assert.lengthOf(h.stops, 1);
        assert.equal(h.stops[0]!.delegatedTaskStall!.lastProgressKind, "run_started");
      }),
  );
  it.effect.each([
    "command_execution",
    "dynamic_tool",
    "file_change",
    "file_search",
    "web_search",
    "compaction",
    "subagent",
  ] as const)("does not interrupt %s in flight; finishing gives a fresh bound", (type) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.item(type);
      yield* TestClock.adjust("40 minutes");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* h.item(type, "completed");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect.each(["user_input", "command"] as const)("does not interrupt a pending %s", (kind) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "runtime-request.updated",
        payload: { id: "request", runId, kind, status: "pending" },
      } as never);
      yield* TestClock.adjust("40 minutes");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* h.send({
        type: "runtime-request.updated",
        payload: { id: "request", runId, kind, status: "resolved" },
      } as never);
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("text and tools reset the clock", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("50 seconds");
      yield* h.send({
        type: "message.updated",
        payload: { id: MessageId.make("text"), role: "assistant", text: "Working" },
      } as never);
      yield* TestClock.adjust("50 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* h.item("dynamic_tool", "completed");
      yield* TestClock.adjust("50 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("10 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it.effect("parent abort and follow-up do not reset silent thinking", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* TestClock.adjust("50 seconds");
      yield* h.followup();
      yield* TestClock.adjust("10 seconds");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
      assert.equal(h.stops[0]!.runId, "followup");
    }),
  );
  it.effect("a completed child's follow-up gets its own bound", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start(60_000);
      yield* h.send({
        type: "run.updated",
        payload: { id: runId, delegatedTaskId: NodeId.make("task"), status: "completed" },
      } as never);
      yield* TestClock.adjust("1 hour");
      yield* h.followup();
      yield* h.guard.check();
      assert.lengthOf(h.stops, 0);
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.stops, 1);
    }),
  );
  it("clamps overrides and includes partial text in a stalled result", () => {
    for (const [input, expected] of [
      [undefined, 900_000],
      [0, 900_000],
      [-1, 60_000],
      [1, 60_000],
      [120_000, 120_000],
      [8_000_000, 7_200_000],
    ] as const)
      assert.equal(normalizeIdleTimeout(input), expected);
    assert.include(
      stalledSummary(
        {
          idleTimeoutMs: 60_000,
          lastProgressAt: DateTime.makeUnsafe(0),
          lastProgressKind: "assistant_text",
        },
        "Partial text",
      ),
      "Partial assistant result:\nPartial text",
    );
  });
});

it.effect(
  "checks no-response before the longer progress deadline and does not replace its failure",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start();
      yield* TestClock.adjust("5 minutes");
      h.stopForRetry();
      yield* h.guard.check();
      assert.lengthOf(h.retryChecks, 1);
      assert.lengthOf(h.stops, 0);
    }),
);

it.effect("a five-minute cutoff stays fenced through the fifteen-minute scan", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.enableProvider("claudeAgent");
    let interrupts = 0;
    let checks = 0;
    h.useRetryLookup(() =>
      Effect.succeed(
        Effect.sync(() => {
          if (++checks !== 1) return false;
          interrupts++;
          return true;
        }),
      ),
    );
    yield* h.start();
    yield* TestClock.adjust("5 minutes");
    yield* h.guard.check();
    yield* TestClock.adjust("10 minutes");
    yield* h.guard.check();
    assert.equal(interrupts, 1);
    assert.lengthOf(h.stops, 0);
    assert.lengthOf(h.recoveries, 0);
    yield* h.resumeAttempt();
    yield* h.guard.check();
    assert.equal(checks, 2);
    assert.equal(interrupts, 1);
    assert.lengthOf(h.stops, 0);
    assert.lengthOf(h.recoveries, 0);
  }),
);

it.effect.each(["first_event", "post_tool"] as const)(
  "the silent restart does not recover Claude in %s",
  (phase) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.enableProvider("claudeAgent");
      yield* h.start(60_000);
      if (phase === "post_tool") yield* h.item("dynamic_tool", "completed");
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.recoveries, 0);
      assert.lengthOf(h.stops, 1);
    }),
);

it.effect("an old health result cannot fence the resumed attempt", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let checks = 0;
    h.useRetryLookup(() =>
      Effect.succeed(
        Effect.gen(function* () {
          if (++checks !== 1) return false;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(released);
          return true;
        }),
      ),
    );
    yield* h.start();
    const checking = yield* h.guard.check().pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* h.resumeAttempt();
    yield* Deferred.succeed(released, undefined);
    yield* Fiber.join(checking);
    yield* h.guard.check();
    assert.equal(checks, 2);
    assert.lengthOf(h.stops, 0);
  }),
);

it.effect("waiting to start a resumed attempt does not consume its progress budget", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.start();
    yield* h.resumeAttempt("starting");
    yield* TestClock.adjust("16 minutes");
    yield* h.guard.check();
    assert.lengthOf(h.stops, 0);
    yield* h.resumeAttempt();
    yield* h.guard.check();
    assert.lengthOf(h.stops, 0);
    yield* TestClock.adjust("15 minutes");
    yield* h.guard.check();
    assert.lengthOf(h.stops, 1);
  }),
);

it.effect.each(["first_event", "post_tool"] as const)(
  "a previous network recovery consumes the silent restart in %s",
  (phase) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.enableProvider();
      h.markNetworkRecovery();
      yield* h.start(60_000);
      if (phase === "post_tool") yield* h.item("dynamic_tool", "completed");
      yield* TestClock.adjust("1 minute");
      yield* h.guard.check();
      assert.lengthOf(h.recoveries, 0);
      assert.lengthOf(h.stops, 1);
      assert.equal(h.analytics[0]?.props?.reasonClass, "recovery_exhausted");
    }),
);

it.effect.each(["attempt", "session", "run", "blocker"] as const)(
  "does not cache a retry lookup invalidated by a changed %s",
  (change) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const checks: number[] = [];
      let lookups = 0;
      h.useRetryLookup(() =>
        Effect.gen(function* () {
          const lookup = ++lookups;
          if (lookup === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return Effect.sync(() => {
            checks.push(lookup);
            return false;
          });
        }),
      );
      yield* h.start();
      const checking = yield* h.guard.check().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (change === "attempt") yield* h.resumeAttempt();
      else if (change === "session")
        yield* h.send({
          type: "provider-thread.updated",
          payload: {
            id: ProviderThreadId.make("provider-thread"),
            providerSessionId: ProviderSessionId.make("new-session"),
          },
        } as never);
      else if (change === "run") yield* h.followup();
      else yield* h.item("command_execution");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(checking);
      assert.deepEqual(checks, []);
      if (change === "blocker") yield* h.item("command_execution", "completed");
      yield* h.guard.check();
      yield* h.guard.check();
      assert.equal(lookups, 2);
      assert.deepEqual(checks, [2, 2]);
    }),
);

it.effect("slow settlements do not serialize sibling cutoffs or repeat an in-flight check", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const checked = new Set<string>();
    h.useRetryLookup((input) =>
      Effect.succeed(
        Effect.gen(function* () {
          assert.isFalse(checked.has(input.threadId));
          checked.add(input.threadId);
          if (checked.size === 31) yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(released);
          return true;
        }),
      ),
    );
    yield* h.start();
    for (let i = 1; i < 31; i++)
      yield* h.guard.handle({
        id: EventId.make(`run-${i}`),
        type: "run.updated",
        threadId: ThreadId.make(`child-${i}`),
        occurredAt: yield* DateTime.now,
        payload: {
          id: RunId.make(`run-${i}`),
          delegatedTaskId: NodeId.make(`task-${i}`),
          status: "running",
          activeAttemptId: null,
          ordinal: 1,
        },
      } as OrchestrationV2DomainEvent);
    yield* TestClock.adjust("5 minutes");
    const first = yield* h.guard.check().pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* h.guard.check();
    assert.equal(checked.size, 31);
    assert.lengthOf(h.stops, 0);
    yield* Deferred.succeed(released, undefined);
    yield* Fiber.join(first);
  }),
);

it.effect("keeps ticking while an older child's settlement is pending", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const laterChecked = yield* Deferred.make<void>();
    let pendingCalls = 0;
    h.useRetryLookup((input) =>
      Effect.succeed(
        Effect.gen(function* () {
          if (input.threadId === threadId) {
            pendingCalls++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(released);
          } else yield* Deferred.succeed(laterChecked, undefined);
          return true;
        }),
      ),
    );
    yield* h.start();
    yield* h.guard.start();
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(entered);
    yield* h.guard.handle({
      id: EventId.make("later-run"),
      type: "run.updated",
      threadId: ThreadId.make("later-child"),
      occurredAt: yield* DateTime.now,
      payload: {
        id: RunId.make("later-run"),
        delegatedTaskId: NodeId.make("later-task"),
        status: "running",
        activeAttemptId: null,
        ordinal: 1,
      },
    } as OrchestrationV2DomainEvent);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(laterChecked);
    assert.equal(pendingCalls, 1);
    yield* Deferred.succeed(released, undefined);
  }),
);
