import { assert, it } from "@effect/vitest";
import {
  type KanbanThreadLink,
  type OrchestrationV2ProviderTurn,
  KanbanBoardId,
  KanbanCardId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "./Analytics.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import { makeRunUsageObserver, makeRunUsageState } from "./RunUsage.ts";

const decodeRetryEvent = Schema.decodeUnknownSync(AnalyticsEvent, { onExcessProperty: "error" });
const threadId = ThreadId.make("thread:one");
const providerThreadId = ProviderThreadId.make("provider:one");
const providerTurnId = ProviderTurnId.make("turn:one");
const attemptId = RunAttemptId.make("attempt:one");
const driver = ProviderDriverKind.make("codex");
const input = (startedAt: DateTime.Utc) => ({
  run: {
    id: RunId.make("run:one"),
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    startedAt,
  },
  attempt: { id: attemptId },
  appThread: {
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
  },
  providerThread: { id: providerThreadId },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "max" }],
  },
});
const terminal = (status: "completed" | "interrupted" | "cancelled") => ({
  type: "turn.terminal" as const,
  driver,
  providerThreadId,
  providerTurnId,
  runOrdinal: 1,
  status,
  failure: null,
  threadDisposition: "reusable" as const,
});
const link: KanbanThreadLink = {
  threadId,
  boardId: KanbanBoardId.make("board:one"),
  cardId: KanbanCardId.make("card:one"),
  discussionId: null,
  role: "work",
  purpose: null,
  model: null,
  startedAt: "2026-11-13T00:00:00.000Z",
  endedAt: null,
  paused: null,
};
const turn = (startedAt: DateTime.Utc): OrchestrationV2ProviderTurn => ({
  id: providerTurnId,
  providerThreadId,
  nodeId: NodeId.make("node:one"),
  runAttemptId: attemptId,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt,
  completedAt: startedAt,
  finish: null,
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    hasSubagents: false,
  },
});

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "records one metadata-only usage event for %s runs",
  (status) =>
    Effect.gen(function* () {
      const events: AnalyticsEvent[] = [];
      const now = yield* DateTime.now;
      const observer = yield* makeRunUsageObserver({
        ...input(now),
        run: { ...input(now).run, cancelReason: "server_shutdown" },
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
            Layer.mock(KanbanStore.KanbanStore)({
              threadLink: () => Effect.succeed(link),
              card: () => Effect.succeed(null),
            }),
          ),
        ),
      );
      yield* observer.observe({ type: "provider_turn.updated", driver, providerTurn: turn(now) });
      // Repeated snapshots and native child usage must not inflate the root's usage.
      yield* observer.observe({ type: "provider_turn.updated", driver, providerTurn: turn(now) });
      yield* observer.observe({
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn(now), id: ProviderTurnId.make("turn:child"), runAttemptId: null },
      });
      yield* TestClock.adjust("1 second");
      const end =
        status === "failed"
          ? {
              ...terminal("completed"),
              status: "failed" as const,
              failureItemOrdinal: 1,
              failure: makeProviderFailure({ class: "unknown", message: "private failure" }),
            }
          : terminal(status);
      yield* observer.finish(end.status);
      yield* observer.finish(end.status);
      assert.equal(events.length, 1);
      const row = events[0]!;
      assert.isTrue("runId" in row);
      if (!("runId" in row)) return;
      assert.equal(row.inputTokens, 100);
      assert.equal(row.outputTokens, 20);
      assert.equal(row.cachedInputTokens, 50);
      assert.equal(row.reasoningTokens, null);
      assert.equal(row.wallMs, 1000);
      assert.equal(row.turnCount, 1);
      assert.equal(row.endReason, status);
      assert.equal(
        row.cancelReason,
        status === "cancelled" || status === "interrupted" ? "server_shutdown" : undefined,
      );
      assert.equal(
        Object.hasOwn(row, "cancelReason"),
        status === "cancelled" || status === "interrupted",
      );
      assert.equal(row.role, "work");
      assert.equal(row.cardId, "card:one");
      assert.equal(row.effort, "max");
      assert.isFalse(JSON.stringify(row).includes("private"));
    }),
);

it.effect.each(["cursor", "grok", "antigravity"])("keeps unsupported %s usage null", (provider) =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    const now = yield* DateTime.now;
    const initial = input(now);
    const observer = yield* makeRunUsageObserver({
      ...initial,
      run: { ...initial.run, providerInstanceId: ProviderInstanceId.make(provider) },
    }).pipe(
      Effect.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        }),
      ),
    );
    yield* observer.observe({
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn(now), turnTokenUsage: undefined },
    });
    yield* observer.finish("interrupted");
    const row = events[0]!;
    if (!("runId" in row)) return assert.fail("missing usage");
    assert.equal(row.inputTokens, null);
    assert.equal(row.outputTokens, null);
    assert.equal(row.cachedInputTokens, null);
    assert.equal(row.reasoningTokens, null);
    assert.equal(row.usageStatus, "unavailable");
    assert.equal(row.role, "chat");
  }),
);

it.effect("carries observed usage across retry attempts and preserves partial coverage", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    const now = yield* DateTime.now;
    const state = makeRunUsageState();
    const layer = Layer.mock(Analytics.Analytics)({
      record: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });
    const first = yield* makeRunUsageObserver(input(now), state).pipe(Effect.provide(layer));
    yield* first.observe({
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn(now), turnTokenUsage: undefined },
    });
    const nextAttempt = RunAttemptId.make("attempt:two");
    const next = yield* makeRunUsageObserver(
      { ...input(now), attempt: { id: nextAttempt } },
      state,
    ).pipe(Effect.provide(layer));
    yield* next.observe({
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        ...turn(now),
        id: ProviderTurnId.make("turn:two"),
        runAttemptId: nextAttempt,
      },
    });
    yield* next.finish("completed");
    const row = events[0]!;
    if (!("runId" in row)) return assert.fail("missing usage");
    assert.equal(row.inputTokens, 100);
    assert.equal(row.turnCount, 2);
    assert.equal(row.usageStatus, "partial");
  }),
);

it.effect.each(["review", "evaluator", "discussion", "delegated", "fork"] as const)(
  "attributes %s runs from the start snapshot",
  (role) =>
    Effect.gen(function* () {
      const events: AnalyticsEvent[] = [];
      const now = yield* DateTime.now;
      const initial = input(now);
      const boardLink = {
        ...link,
        role: role === "review" ? ("review" as const) : ("evaluator" as const),
        discussionId:
          role === "discussion" ? ("discussion:one" as KanbanThreadLink["discussionId"]) : null,
      };
      const observer = yield* makeRunUsageObserver({
        ...initial,
        appThread: {
          lineage: {
            parentThreadId:
              role === "delegated" || role === "fork" ? ThreadId.make("thread:parent") : null,
            rootThreadId: threadId,
            relationshipToParent:
              role === "delegated" ? "subagent" : role === "fork" ? "fork" : null,
          },
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
            Layer.mock(KanbanStore.KanbanStore)({
              threadLink: (id) =>
                Effect.succeed(
                  (role === "delegated" && id === threadId) || role === "fork" ? null : boardLink,
                ),
              card: () => Effect.succeed({ reviewRound: 3 } as never),
            }),
          ),
        ),
      );
      yield* observer.finish("completed");
      const row = events[0]!;
      if (!("runId" in row)) return assert.fail("missing usage");
      assert.equal(row.role, role === "fork" ? "chat" : role);
      assert.equal(row.reviewRound, role === "review" ? 3 : null);
      assert.equal(row.cardId, role === "fork" ? undefined : "card:one");
    }),
);

it.effect("measures wall time from the first attempt across a retry", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    const state = makeRunUsageState();
    const layer = Layer.mock(Analytics.Analytics)({
      record: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });
    const first = input(yield* DateTime.now);
    yield* makeRunUsageObserver(first, state).pipe(Effect.provide(layer));
    yield* TestClock.adjust("60 seconds");
    const next = yield* makeRunUsageObserver(
      { ...first, run: { ...first.run, startedAt: yield* DateTime.now } },
      state,
    ).pipe(Effect.provide(layer));
    yield* TestClock.adjust("10 seconds");
    yield* next.finish("completed");
    const row = events[0]!;
    if (!("runId" in row)) return assert.fail("missing usage");
    assert.equal(row.wallMs, 70_000);
  }),
);

it.effect("keeps terminal usage when cleanup interrupts its reader during attribution", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    const lookupEntered = yield* Deferred.make<void>();
    const releaseLookup = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(releaseLookup, undefined));
    const state = makeRunUsageState();
    const now = yield* DateTime.now;
    const observer = yield* makeRunUsageObserver(input(now), state).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          }),
          Layer.mock(KanbanStore.KanbanStore)({
            threadLink: () =>
              Deferred.succeed(lookupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseLookup)),
                Effect.as(link),
              ),
          }),
        ),
      ),
    );
    yield* Deferred.await(lookupEntered);
    yield* observer.observe({ type: "provider_turn.updated", driver, providerTurn: turn(now) });
    const terminalReader = yield* observer.finish("interrupted").pipe(Effect.forkChild);
    // Give the ready reader its turn; the lookup stays held, without advancing the clock.
    yield* Effect.yieldNow;
    assert.isTrue(state.finished);
    const cleanup = yield* Fiber.interrupt(terminalReader).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseLookup, undefined);
    yield* Fiber.join(cleanup);
    yield* observer.finish("interrupted");
    assert.equal(events.length, 1);
    const row = events[0]!;
    if (!("runId" in row)) return assert.fail("missing usage");
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 20);
    assert.equal(row.cardId, "card:one");
    assert.equal(row.endReason, "interrupted");
  }),
);

it.effect.each(["pi", "cursor", "codex", "claudeAgent"])(
  "records %s retry items only when the native adapter has no recorder",
  (provider) =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const now = yield* DateTime.now;
      const selected = input(now);
      const observer = yield* makeRunUsageObserver({
        ...selected,
        run: { ...selected.run, providerInstanceId: ProviderInstanceId.make(provider) },
      }).pipe(
        Effect.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => rows.push(decodeRetryEvent(event))).pipe(Effect.asVoid),
          }),
        ),
      );
      for (const attempt of [1, 2]) {
        yield* TestClock.adjust("1 second");
        const item = makeProviderRetryTurnItem({
          driver: ProviderDriverKind.make(provider),
          threadId,
          runId: selected.run.id,
          nodeId: NodeId.make("root"),
          providerThreadId,
          providerTurnId,
          itemOrdinal: 1,
          failure: makeProviderFailure({ class: "transport_error", message: "Request timed out." }),
          retry: { attempt, maxAttempts: 10, retryDelayMs: 100 },
          status: "running",
          startedAt: now,
          updatedAt: yield* DateTime.now,
        });
        yield* observer.observe({
          type: "turn_item.updated",
          driver: ProviderDriverKind.make(provider),
          turnItem: item,
        });
        yield* observer.observe({
          type: "turn_item.updated",
          driver: ProviderDriverKind.make(provider),
          turnItem: { ...item, status: "completed" },
        });
      }
      assert.deepEqual(
        rows.map((event) => event.props?.attempt),
        provider === "codex" || provider === "claudeAgent" ? [] : [1, 2],
      );
      if (rows.length > 0) {
        assert.deepEqual(
          rows.map((event) => event.props?.waitSinceResponseMs),
          [1000, 2000],
        );
        assert.equal(rows[0]!.props?.maxRetries, 10);
        assert.equal(rows[0]!.props?.errorMessage, "Request timed out.");
      }
    }),
);
