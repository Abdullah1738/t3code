import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Guard from "./DelegatedTaskProgressGuard.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Threads from "./ThreadManagementService.ts";
import { normalizeIdleTimeout, stalledSummary } from "./delegatedTaskProgress.ts";

const threadId = ThreadId.make("child");
const runId = RunId.make("run");
const makeHarness = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const stops: Array<Threads.ThreadManagementInterruptInput> = [];
  let interruptRace: Effect.Effect<void> | undefined;
  let selectedTimeout: number | undefined;
  let run = {
    id: runId,
    threadId,
    delegatedTaskId: NodeId.make("task"),
    status: "running",
    activeAttemptId: null,
    ordinal: 1,
    startedAt: DateTime.makeUnsafe(-3_600_000),
  } as OrchestrationV2Run;
  let projection = {
    thread: { projectId: "project" },
    runs: [run],
    turnItems: [],
    runtimeRequests: [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const guard = yield* Guard.DelegatedTaskProgressGuard.pipe(
    Effect.provide(
      Guard.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  subagents: [
                    {
                      id: NodeId.make("task"),
                      origin: "app_owned",
                      childThreadId: threadId,
                      idleTimeoutMs: 60_000,
                    },
                  ],
                } as unknown as OrchestrationV2ThreadProjection),
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
