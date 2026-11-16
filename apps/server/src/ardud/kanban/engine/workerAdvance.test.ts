import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  type AnalyticsEvent,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Analytics from "../../analytics/Analytics.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { makeFake, testLayer, toyBoard } from "./askFlows.testkit.ts";
import { KanbanThreadError, KanbanThreads, type KanbanThreadView } from "./threads.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("planner") };

const fixture = Effect.gen(function* () {
  const fake = yield* makeFake;
  const notified = yield* Deferred.make<void>();
  const events: AnalyticsEvent[] = [];
  const control = {
    state: "running" as KanbanThreadView["state"],
    backgroundWork: 0,
    queued: false,
  };
  let beforeFind: Effect.Effect<void> | undefined;
  let beforeHandoff: Effect.Effect<void, KanbanThreadError> | undefined;
  const layer = Layer.effect(
    KanbanThreads,
    Effect.map(KanbanThreads, (real) => {
      const view = (id: ThreadId) =>
        real
          .view(id)
          .pipe(
            Effect.map((view) =>
              view === null || view.title.startsWith("Evaluator") ? view : { ...view, ...control },
            ),
          );
      const observe = (text: string) =>
        text.includes("waiting on your subtasks:")
          ? Deferred.succeed(notified, undefined).pipe(Effect.asVoid)
          : Effect.void;
      return {
        ...real,
        view,
        find: (id) =>
          Effect.gen(function* () {
            const hook = beforeFind;
            beforeFind = undefined;
            if (hook) yield* hook;
            return yield* view(id);
          }),
        queuedRuns: (id) =>
          Effect.gen(function* () {
            if (!control.queued) return [];
            const model = (yield* real.model(id))!;
            return [
              {
                id: RunId.make("queued"),
                threadId: id,
                ordinal: 2,
                providerInstanceId: model.instanceId,
                modelSelection: model,
                providerThreadId: null,
                userMessageId: MessageId.make("queued"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "queued" as const,
                requestedAt: DateTime.makeUnsafe("2026-11-16T15:00:00.000Z"),
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            ];
          }),
        launch: (input) => real.launch(input).pipe(Effect.tap(() => observe(input.text))),
        send: (input) =>
          Effect.gen(function* () {
            if (input.text.includes("waiting on your subtasks:")) {
              const hook = beforeHandoff;
              beforeHandoff = undefined;
              if (hook) yield* hook;
            }
            return yield* real.send(input).pipe(Effect.tap(() => observe(input.text)));
          }),
      };
    }),
  ).pipe(Layer.provide(fake.layer));
  const provided = testLayer(layer).pipe(
    Layer.provide(
      Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    ),
  );
  const start = (next: "review" | "evaluator" | "script" = "review", laterWork = false) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Handoff",
          prompt: "Handoff",
          subtasks: [
            { text: "First work", owner: "work", step: 1 },
            { text: "Next", owner: next, step: 2 },
            ...(laterWork ? [{ text: "Later work", owner: "work" as const, step: 3 }] : []),
          ],
        },
        evaluator,
      );
      yield* kanban.dispatchNow;
      const current = (yield* kanban.card(card.id)).card;
      const threadId = current.activeThreadId!;
      assert.isNotNull(threadId);
      const worker: KanbanActor = { _tag: "thread", threadId };
      return { kanban, board, card: current, threadId, worker };
    });
  return {
    fake,
    notified,
    events,
    control,
    provided,
    start,
    beforeFind: (effect: Effect.Effect<void>) => {
      beforeFind = effect;
    },
    beforeHandoff: (effect: Effect.Effect<void, KanbanThreadError>) => {
      beforeHandoff = effect;
    },
  };
});

const advanced = (events: AnalyticsEvent[]) =>
  events.filter((event) => event.kind === "kanban.card.autoAdvanced");
const assertReleased = (card: KanbanCard, threadId: ThreadId) => {
  assert.isNull(card.activeThreadId);
  assert.isNull(card.activeRole);
  assert.isNull(card.activePool);
  assert.equal(card.workThreadId, threadId);
};

it.effect.each([false, true])(
  "turn end advances to review even with later work ($0)",
  (laterWork) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* f.start("review", laterWork);
        yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        assert.equal((yield* kanban.card(card.id)).card.stage, "working");
        yield* TestClock.adjust("5 seconds");
        f.control.state = "idle";
        yield* kanban.turnEnded(threadId);
        const result = yield* kanban.card(card.id);
        assert.equal(result.card.stage, "needs_review");
        assertReleased(result.card, threadId);
        assert.equal(result.card.reviewStep, 0);
        assert.equal(advanced(f.events).length, 1);
        assert.equal(advanced(f.events)[0]!.props?.reasonClass, "review_step");
        assert.equal(advanced(f.events)[0]!.props?.msInPrevStage, 5_000);
        assert.equal(
          result.events.filter((event) => event.body?.startsWith("Auto-advanced:")).length,
          1,
        );
        yield* kanban.turnEnded(threadId);
        assert.equal(advanced(f.events).length, 1);
        const handedOff = yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        assert.equal(handedOff.stage, "needs_review");
        assert.equal(
          (yield* kanban.card(card.id)).events.filter(
            (event) => event.kind === "moved" && event.fromStage === "working",
          ).length,
          1,
        );
        yield* kanban.dispatchNow;
        assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
      }).pipe(Effect.provide(f.provided));
    }),
);

it.effect("turn end releases an evaluator step, clears a stale note and wakes once", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* f.start("evaluator", true);
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putCard({ ...(yield* kanban.card(card.id)).card, wakeNote: "Old wake" });
      f.control.state = "idle";
      yield* kanban.turnEnded(threadId);
      yield* Deferred.await(f.notified);
      yield* kanban.turnEnded(threadId);
      yield* kanban.dispatchNow;
      const result = (yield* kanban.card(card.id)).card;
      assert.equal(result.stage, "todo");
      assertReleased(result, threadId);
      assert.isNull(result.wakeNote);
      assert.equal(advanced(f.events).length, 1);
      assert.equal(advanced(f.events)[0]!.props?.reasonClass, "evaluator_step");
      const evaluators = yield* f.fake.evaluators;
      assert.equal(
        evaluators
          .flatMap((e) => e.messages)
          .filter((text) => text.includes("waiting on your subtasks:")).length,
        1,
      );
      assert.equal((yield* f.fake.heard(threadId)).length, 1);
    }).pipe(Effect.provide(f.provided));
  }),
);

it.effect.each(["review", "evaluator", "script"] as const)(
  "an idle worker advances when its last subtask is marked by an evaluator (%s)",
  (next) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId } = yield* f.start(next);
        f.control.state = "idle";
        const result = yield* kanban.markSubtask(
          card.id,
          "s1",
          "done",
          null,
          evaluator,
          "evaluator",
        );
        assert.equal(result.stage, next === "review" ? "needs_review" : "todo");
        assertReleased(result, threadId);
        if (next === "evaluator") yield* Deferred.await(f.notified);
        assert.equal(advanced(f.events).length, 1);
      }).pipe(Effect.provide(f.provided));
    }),
);

it.effect.each(["running", "background", "queued", "findings", "worker moved"])(
  "does not auto-advance: %s",
  (hold) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* f.start();
        yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        if (hold !== "running") f.control.state = "idle";
        if (hold === "background") f.control.backgroundWork = 1;
        if (hold === "queued") f.control.queued = true;
        if (hold === "findings") {
          const store = yield* KanbanStore.KanbanStore;
          yield* store.putCard({
            ...(yield* kanban.card(card.id)).card,
            reviewFindingsPending: true,
          });
        }
        if (hold === "worker moved")
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.turnEnded(threadId);
        const result = (yield* kanban.card(card.id)).card;
        assert.equal(result.stage, hold === "worker moved" ? "needs_review" : "working");
        assert.equal(advanced(f.events).length, 0);
      }).pipe(Effect.provide(f.provided));
    }),
);

it.effect("a worker move wins while the auto-advance reads idle state", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* f.start();
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      f.control.state = "idle";
      f.beforeFind(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      );
      const ending = yield* Effect.forkChild(kanban.turnEnded(threadId));
      yield* Deferred.await(entered);
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(ending);
      const result = yield* kanban.card(card.id);
      assert.equal(result.card.stage, "needs_review");
      assert.equal(
        result.events.filter((event) => event.kind === "moved" && event.fromStage === "working")
          .length,
        1,
      );
      assert.equal(advanced(f.events).length, 0);
    }).pipe(Effect.provide(f.provided));
  }),
);

it.effect("the idle backstop advances immediately without the nudge grace", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* f.start("evaluator");
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      f.control.state = "idle";
      yield* kanban.tick;
      yield* Deferred.await(f.notified);
      const result = (yield* kanban.card(card.id)).card;
      assert.equal(result.stage, "todo");
      assertReleased(result, threadId);
      assert.isNull(result.nudgedAt);
      assert.equal(advanced(f.events).length, 1);
    }).pipe(Effect.provide(f.provided));
  }),
);

it.effect.each(["turn end", "tick", "idle mark"] as const)(
  "a deferred dependency wait survives %s with no worker work left",
  (entry) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* f.start("evaluator");
        const dependency = yield* kanban.createCard(board.id, { prompt: "Dependency" }, evaluator);
        const waiting = yield* kanban.waitCard(
          card.id,
          { on: "card", card: dependency.id, note: "Wait for dependency" },
          worker,
        );
        assert.equal(waiting.activeThreadId, threadId);
        const savedWait = (yield* kanban.card(card.id)).card.wait;
        if (entry !== "idle mark")
          yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        f.control.state = "idle";
        if (entry === "idle mark")
          yield* kanban.markSubtask(card.id, "s1", "done", null, evaluator, "evaluator");
        else if (entry === "tick") yield* kanban.tick;
        else yield* kanban.turnEnded(threadId);
        yield* kanban.tick;
        const result = (yield* kanban.card(card.id)).card;
        assert.deepEqual(result.wait, savedWait);
        assert.equal(advanced(f.events).length, 0);
        assert.equal(
          (yield* f.fake.evaluators)
            .flatMap((e) => e.messages)
            .filter((text) => text.includes("waiting on your subtasks:")).length,
          0,
        );
      }).pipe(Effect.provide(f.provided));
    }),
);

it.effect.each(["turn end", "tick", "idle mark"] as const)(
  "the evaluator handoff from %s persists before sending and retries a rejection",
  (entry) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const attempted = yield* Deferred.make<void>();
      const reject = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* f.start("evaluator");
        const talk = yield* kanban.cardDiscussion(card.id);
        const evaluatorId = yield* kanban.startEvaluator(board.id, {
          kind: "request",
          text: "Track this card",
        });
        const store = yield* KanbanStore.KanbanStore;
        yield* store.putDiscussion({ ...talk, evaluatorThreadId: evaluatorId });
        f.beforeHandoff(
          Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(Deferred.await(reject)),
            Effect.andThen(
              Effect.fail(
                new KanbanThreadError({ operation: "send", detail: "rejected", rejected: true }),
              ),
            ),
          ),
        );
        if (entry !== "idle mark")
          yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        f.control.state = "idle";
        const handoff = yield* Effect.forkChild(
          entry === "idle mark"
            ? kanban
                .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
                .pipe(Effect.asVoid)
            : entry === "tick"
              ? kanban.tick
              : kanban.turnEnded(threadId),
        );
        yield* Deferred.await(attempted);
        const result = (yield* kanban.card(card.id)).card;
        assert.equal(result.stage, "todo");
        assertReleased(result, threadId);
        const sql = yield* BoardsDatabase.client;
        const pending = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ardud_kanban_owner_routes
          WHERE done_at IS NULL AND json_extract(json, '$.effect.kind') = 'evaluatorTurn'
            AND json_extract(json, '$.effect.after.id') = ${card.id}
        `;
        assert.equal(pending[0]!.count, 1);
        yield* Deferred.succeed(reject, undefined);
        yield* Fiber.join(handoff);
        yield* Deferred.await(f.notified);
        yield* kanban.turnEnded(threadId);
        assert.equal(
          (yield* f.fake.heard(evaluatorId)).filter((text) =>
            text.includes("waiting on your subtasks:"),
          ).length,
          1,
        );
        assert.equal(advanced(f.events).length, 1);
      }).pipe(Effect.provide(f.provided));
    }),
);

it.effect("an unsaved evaluator obligation rolls back the handoff and its event", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* f.start("evaluator");
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      const sql = yield* BoardsDatabase.client;
      yield* sql`CREATE TRIGGER reject_handoff BEFORE INSERT ON ardud_kanban_owner_routes
        WHEN json_extract(NEW.json, '$.effect.kind') = 'evaluatorTurn'
        BEGIN SELECT RAISE(ABORT, 'handoff write failed'); END`;
      f.control.state = "idle";
      yield* kanban.turnEnded(threadId).pipe(Effect.exit);
      const held = yield* kanban.card(card.id);
      assert.equal(held.card.stage, "working");
      assert.equal(held.card.activeThreadId, threadId);
      assert.equal(advanced(f.events).length, 0);
      assert.equal(
        held.events.filter((event) => event.body?.startsWith("Auto-advanced:")).length,
        0,
      );
      yield* sql`DROP TRIGGER reject_handoff`;
      yield* kanban.turnEnded(threadId);
      yield* Deferred.await(f.notified);
      assert.equal((yield* kanban.card(card.id)).card.stage, "todo");
      assert.equal(advanced(f.events).length, 1);
    }).pipe(Effect.provide(f.provided));
  }),
);
