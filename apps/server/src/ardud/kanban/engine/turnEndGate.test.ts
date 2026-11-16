import { assert, it } from "@effect/vitest";
import type { KanbanCard } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as KanbanStore from "../store/KanbanStore.ts";
import { makeFake, owner, testLayer, workingCard } from "./askFlows.testkit.ts";

const finish = Effect.fn("test.finishTurn")(function* (
  blocked: boolean,
  review: boolean,
  editTarget: boolean,
) {
  const fake = yield* makeFake;
  const entered = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  let waiting: KanbanCard["id"] | undefined;
  const slowStore = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) => ({
      ...real,
      card: (id: KanbanCard["id"]) =>
        Effect.gen(function* () {
          const snapshot = yield* real.card(id);
          if (id === waiting) {
            waiting = undefined;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
          }
          return snapshot;
        }),
    })),
  ).pipe(Layer.provide(KanbanStore.layer));
  return yield* Effect.gen(function* () {
    const { kanban, board, card, worker, threadId } = yield* workingCard();
    let target = threadId;
    if (review) {
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.turnEnded(threadId);
      yield* kanban.dispatchNow;
      target = (yield* kanban.card(card.id)).card.activeThreadId!;
      assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
    }
    const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
    const editedId = editTarget ? card.id : other.id;
    if (blocked) waiting = card.id;
    if (!blocked) yield* kanban.editCard(editedId, { description: "Concurrent edit" }, owner);
    const ending = yield* Effect.forkChild(kanban.turnEnded(target));
    if (blocked) {
      yield* Deferred.await(entered);
      // Completion before releasing the latch proves card_update did not queue
      // behind turnEnded. The test runner deadline catches the old deadlock.
      const saved = yield* kanban.editCard(editedId, { description: "Concurrent edit" }, owner);
      assert.equal(saved.description, "Concurrent edit");
      assert.isUndefined(ending.pollUnsafe());
      yield* Deferred.succeed(resume, undefined);
    }
    yield* Fiber.join(ending);
    assert.equal((yield* kanban.card(editedId)).card.description, "Concurrent edit");
    const result = yield* kanban.card(card.id);
    const link = yield* (yield* KanbanStore.KanbanStore).threadLink(target);
    return {
      stage: result.card.stage,
      role: result.card.activeRole,
      assigned: result.card.activeThreadId !== null,
      nudged: result.card.nudgedAt !== null,
      stalled: result.card.stalled,
      asks: result.card.asks.length,
      events: result.events.map(({ kind, fromStage, toStage }) => ({ kind, fromStage, toStage })),
      ended: link?.endedAt !== null,
      messages: (yield* fake.heard(target)).length,
    };
  }).pipe(Effect.provide(testLayer(fake.layer, slowStore)));
});

it.effect.each([
  { review: false, editTarget: false },
  { review: false, editTarget: true },
  { review: true, editTarget: false },
  { review: true, editTarget: true },
])(
  "turnEnded releases its card read for card_update and preserves its result ($review, $editTarget)",
  ({ review, editTarget }) =>
    Effect.gen(function* () {
      const baseline = yield* finish(false, review, editTarget);
      const concurrent = yield* finish(true, review, editTarget);
      assert.deepEqual(concurrent, baseline);
    }),
);
