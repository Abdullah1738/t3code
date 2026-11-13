import { assert, it } from "@effect/vitest";
import {
  type AnalyticsEvent,
  KanbanBoardId,
  KanbanCardId,
  NodeId,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as KanbanStore from "../ardud/kanban/store/KanbanStore.ts";
import { makeFirstTokenObserver } from "./RunExecutionService.ts";

it.effect(
  "records evaluator and worker latency once at the first root text or reasoning event",
  () =>
    Effect.gen(function* () {
      for (const role of ["work", "evaluator"] as const) {
        const events: AnalyticsEvent[] = [];
        const recorded = yield* Deferred.make<AnalyticsEvent>();
        const run = {
          id: RunId.make(`run:${role}`),
          threadId: ThreadId.make(`thread:${role}`),
          startedAt: yield* DateTime.now,
        };
        const nodeId = NodeId.make(`node:${role}`);
        const makeEvent = (
          text: string,
          threadId = run.threadId,
        ): ProviderAdapter.ProviderAdapterV2Event => ({
          type: "turn_item.updated",
          driver: ProviderDriverKind.make("codex"),
          turnItem: {
            id: TurnItemId.make(`item:${role}`),
            threadId,
            runId: run.id,
            nodeId,
            ordinal: 1,
            type: "reasoning",
            text,
            streaming: true,
            startedAt: run.startedAt,
            completedAt: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            status: "running",
            parentItemId: null,
            title: null,
            updatedAt: run.startedAt,
          },
        });
        const observe = yield* makeFirstTokenObserver(
          run,
          RunAttemptId.make(`attempt:${role}`),
        ).pipe(
          Effect.provide(
            Layer.merge(
              Layer.mock(Analytics.Analytics)({
                record: (event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }).pipe(Effect.andThen(Deferred.succeed(recorded, event)), Effect.asVoid),
              }),
              Layer.mock(KanbanStore.KanbanStore)({
                threadLink: () =>
                  Effect.succeed({
                    threadId: run.threadId,
                    boardId: KanbanBoardId.make("board:one"),
                    cardId: KanbanCardId.make("card:one"),
                    discussionId: null,
                    role,
                    purpose: null,
                    model: null,
                    startedAt: DateTime.formatIso(run.startedAt),
                    endedAt: null,
                    paused: null,
                  }),
              }),
            ),
          ),
        );
        yield* observe(makeEvent(""));
        yield* observe(makeEvent("private child output", ThreadId.make("thread:child")));
        yield* TestClock.adjust("250 millis");
        yield* observe(makeEvent("private reasoning"));
        yield* observe(makeEvent("private reasoning continued"));
        yield* Deferred.await(recorded);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.durationMs, 250);
        assert.equal(events[0]?.props?.phase, role === "work" ? "worker" : "evaluator");
        assert.equal(events[0]?.boardId, "board:one");
        assert.equal(events[0]?.cardId, "card:one");
        assert.equal(events[0]?.props?.key, `attempt:${role}`);
        assert.isFalse(JSON.stringify(events).includes("private"));
      }
    }),
);

it.effect("works without optional analytics or a board store", () =>
  Effect.gen(function* () {
    const observe = yield* makeFirstTokenObserver(
      { id: RunId.make("run:none"), threadId: ThreadId.make("thread:none"), startedAt: null },
      RunAttemptId.make("attempt:none"),
    );
    yield* observe({
      type: "command_output.delta",
      driver: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread:none"),
      itemId: TurnItemId.make("item:none"),
      chunk: "private output",
    });
  }),
);

it.effect.each(["blocked", "failure", "defect", "no-link"] as const)(
  "keeps first-token observation independent of %s board attribution",
  (mode) =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const recorded = yield* Deferred.make<AnalyticsEvent>();
      const now = yield* DateTime.now;
      const run = {
        id: RunId.make("run:unblocked"),
        threadId: ThreadId.make("thread:unblocked"),
        startedAt: now,
      };
      const lookup =
        mode === "blocked"
          ? Effect.never
          : mode === "failure"
            ? Effect.fail(
                new KanbanStore.KanbanStoreError({ operation: "threadLink", cause: "private" }),
              )
            : mode === "defect"
              ? Effect.die("private defect")
              : Effect.succeed(null);
      const observe = yield* makeFirstTokenObserver(
        run,
        RunAttemptId.make("attempt:unblocked"),
      ).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(Analytics.Analytics)({
              record: (event) => Deferred.succeed(recorded, event).pipe(Effect.asVoid),
            }),
            Layer.mock(KanbanStore.KanbanStore)({
              threadLink: () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(lookup)),
            }),
          ),
        ),
      );
      yield* observe({
        type: "turn_item.updated",
        driver: ProviderDriverKind.make("codex"),
        turnItem: {
          id: TurnItemId.make("item:unblocked"),
          threadId: run.threadId,
          runId: run.id,
          nodeId: NodeId.make("node:unblocked"),
          ordinal: 1,
          type: "reasoning",
          text: "private text",
          streaming: true,
          startedAt: now,
          completedAt: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          status: "running",
          parentItemId: null,
          title: null,
          updatedAt: now,
        },
      });
      // Reaching this milestone proves the provider consumer did not await the lookup.
      yield* Deferred.await(requested);
      if (mode === "blocked") yield* TestClock.adjust("2 seconds");
      const event = yield* Deferred.await(recorded);
      assert.equal(event.durationMs, 0);
      assert.equal(event.threadId, run.threadId);
      assert.isUndefined(event.boardId);
      assert.isFalse(JSON.stringify(event).includes("private"));
    }),
);
