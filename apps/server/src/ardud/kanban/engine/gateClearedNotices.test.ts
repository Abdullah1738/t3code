import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanService from "./KanbanService.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";
import { closeClearedGateNotices } from "./asks.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
const clearCard = Effect.gen(function* () {
  const { kanban, board } = yield* toyBoard();
  const card = yield* kanban.createCard(
    board.id,
    {
      title: "Report results",
      prompt: "Work",
      subtasks: [
        { text: "Tell first reporter once installed", owner: "evaluator" },
        { text: "Tell second reporter once installed", owner: "evaluator" },
      ],
    },
    owner,
  );
  const cleared = yield* kanban.editCard(
    card.id,
    {
      subtasks: [
        { id: "s1", clearGate: "Only reports results" },
        { id: "s2", clearGate: "Only reports results" },
      ],
    },
    evaluator,
  );
  return { kanban, board, card: cleared };
});

it.effect.each(["done", "skipped"] as const)(
  "closes a gate-cleared notice on subtask %s, retaining other asks and notices",
  (state) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* clearCard;
        assert.equal(card.asks[0]?.subtaskId, "s1");
        assert.isNull(card.asks[0]!.closedAt);
        const store = yield* KanbanStore.KanbanStore;
        const untouched = [
          { ...card.asks[0]!, id: "q3", batchKey: "other" },
          { ...card.asks[0]!, id: "q4", kind: "decision", blocking: true },
        ];
        yield* store.putCard({ ...card, asks: [...card.asks, ...untouched] });
        yield* TestClock.adjust("1 second");
        const marked = yield* kanban.markSubtask(
          card.id,
          "s1",
          state,
          "Reported",
          evaluator,
          "evaluator",
        );
        assert.equal(marked.asks[0]?.answer?.verdict, "auto_closed");
        assert.equal(marked.asks[0]?.answer?.by._tag, "system");
        assert.equal(marked.asks[0]?.closedAt, marked.updatedAt);
        assert.isNull(marked.asks[1]!.closedAt);
        assert.deepStrictEqual(marked.asks.slice(2), untouched);
        assert.deepStrictEqual((yield* kanban.card(card.id)).card.asks, marked.asks);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("manual acknowledgement remains final and verification closes remaining notices", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card } = yield* clearCard;
      yield* kanban.answerAsk(card.id, "q1", { verdict: "acknowledged", revision: 0 }, owner);
      const ack = (yield* kanban.card(card.id)).card.asks[0]!;
      assert.equal(ack.answer?.verdict, "acknowledged");
      yield* TestClock.adjust("1 second");
      const verified = yield* kanban.moveCard(card.id, "verified", "owner", owner);
      assert.deepStrictEqual(verified.asks[0], ack);
      assert.equal(verified.asks[1]?.answer?.verdict, "auto_closed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "plan edits close legacy skipped notices, and settling closes legacy verified notices",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* clearCard;
        const store = yield* KanbanStore.KanbanStore;
        yield* store.putCard({
          ...card,
          subtasks: card.subtasks.map((task) =>
            task.id === "s1" ? { ...task, state: "skipped" } : task,
          ),
        });
        const edited = yield* kanban.editCard(card.id, { subtasks: [{ id: "s2" }] }, evaluator);
        assert.equal(edited.asks[0]?.answer?.verdict, "auto_closed");
        assert.isNull(edited.asks[1]!.closedAt);
        yield* store.putCard({ ...edited, stage: "verified" });
        const settled = yield* kanban.settleCard(card.id);
        assert.equal(settled.asks[1]?.answer?.verdict, "auto_closed");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "startup backfills old gate-cleared notices once, leaving open steps and timing intact",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* clearCard;
        const store = yield* KanbanStore.KanbanStore;
        const legacy = card.asks.map(({ subtaskId: _subtask, ...ask }) => ask);
        const seeded: KanbanCard = {
          ...card,
          asks: legacy,
          subtasks: card.subtasks.map((task) =>
            task.id === "s1" ? { ...task, state: "done" } : task,
          ),
        };
        yield* store.putCard(seeded);
        const restart = Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* KanbanService.KanbanService;
            yield* restarted.ready;
          }).pipe(Effect.provide(Layer.fresh(KanbanService.layer))),
        );
        yield* restart;
        const once = (yield* kanban.card(card.id)).card;
        assert.equal(once.asks[0]?.answer?.verdict, "auto_closed");
        assert.isNull(once.asks[1]!.closedAt);
        assert.deepStrictEqual(
          once.asks.map((ask) => ask.timing),
          legacy.map((ask) => ask.timing),
        );
        yield* TestClock.adjust("1 second");
        yield* restart;
        assert.deepStrictEqual((yield* kanban.card(card.id)).card, once);
        for (const state of ["skipped", "verified", "settled"] as const) {
          const old: KanbanCard =
            state === "skipped"
              ? {
                  ...seeded,
                  subtasks: seeded.subtasks.map((task) => ({ ...task, state: "skipped" })),
                }
              : {
                  ...seeded,
                  stage: state === "verified" ? "verified" : "completed",
                  settledAt: state === "settled" ? card.updatedAt : null,
                };
          const closed = closeClearedGateNotices(old, card.updatedAt);
          assert.isTrue(closed.asks.every((ask) => ask.answer?.verdict === "auto_closed"));
          assert.strictEqual(closeClearedGateNotices(closed, card.updatedAt), closed);
        }
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
