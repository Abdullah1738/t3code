/** Who a handed ask is with: the evaluators of its card's board, and nobody else. */
import { assert, it } from "@effect/vitest";
import { ThreadId, kanbanAskWaitsOn, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  toyBoard,
  workingCard,
} from "./askFlows.testkit.ts";

const NOT_ITS_EVALUATOR = "is with the evaluators of its own board: this thread is not one of them";
const evaluatorOf = (threadId: string): KanbanActor => ({
  _tag: "evaluator",
  threadId: ThreadId.make(threadId),
});

it.effect("a handed ask is answered or returned only by an evaluator of its card's board", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        { question: "Merge PR 9?", blocking: false, action: { summary: "Merge PR 9" } },
        worker,
        "cardThread",
      );
      yield* kanban.handAsk(card.id, "q1", "hand", owner);
      const [mine] = yield* fake.evaluators;

      // Another board, with an evaluator of its own.
      const { board: elsewhere } = yield* toyBoard("elsewhere");
      const theirs = yield* kanban.createCard(
        elsewhere.id,
        { prompt: "Docs", title: "Docs" },
        owner,
      );
      yield* kanban.askOwner(
        theirs.id,
        { question: "Publish?", blocking: false },
        evaluatorOf("evaluator-elsewhere"),
        "evaluator",
      );
      yield* kanban.handAsk(theirs.id, "q1", "hand", owner);
      const other = (yield* fake.evaluators).find((entry) => entry.threadId !== mine!.threadId)!;
      assert.strictEqual((yield* kanban.caller(other.threadId))?.boardId, elsewhere.id);
      assert.strictEqual((yield* kanban.caller(mine!.threadId))?.boardId, card.boardId);

      const strangers: ReadonlyArray<readonly [string, KanbanActor]> = [
        ["another board's evaluator", evaluatorOf(other.threadId)],
        // A thread no board started: an outside thread, or a subagent of the card's worker.
        ["a thread the board never started", evaluatorOf("thread-outside")],
        ["the card's own thread, named as an evaluator", evaluatorOf(threadId)],
        ["the card's own thread", worker],
      ];
      for (const [name, actor] of strangers) {
        const answered = yield* kanban
          .answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, actor)
          .pipe(Effect.flip);
        assert.deepStrictEqual([name, answered.code], [name, "denied"]);
        assert.include(answered.detail, NOT_ITS_EVALUATOR, name);
        const returned = yield* kanban.handAsk(card.id, "q1", "return", actor).pipe(Effect.flip);
        assert.deepStrictEqual([name, returned.code], [name, "denied"]);
        assert.include(returned.detail, NOT_ITS_EVALUATOR, name);
      }
      const still = askOf((yield* kanban.card(card.id)).card);
      assert.deepStrictEqual(
        [still.closedAt, still.answer, kanbanAskWaitsOn(still)],
        [null, undefined, "evaluator"],
      );

      // Its own board's evaluator gives it back, and decides it when it is handed again.
      const own = evaluatorOf(mine!.threadId);
      const returned = yield* kanban.handAsk(card.id, "q1", "return", own);
      assert.strictEqual(kanbanAskWaitsOn(askOf(returned)), "owner");
      yield* kanban.handAsk(card.id, "q1", "hand", owner);
      const decided = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "approved", revision: 0 },
        own,
      );
      assert.deepStrictEqual(
        [askOf(decided.card).answer?.verdict, askOf(decided.card).answer?.decision],
        ["handed", "approved"],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an ask handed every time is with the evaluator that was started for it too", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard("Bump deps");
        const http = yield* makeHttp;
        yield* kanban.askOwner(
          card.id,
          { question: "Merge the bump?", blocking: false, action: { summary: "Merge PR 7" } },
          worker,
          "cardThread",
        );
        const hand = yield* http.post("/cards/toy:1/asks/q1/hand", {
          always: true,
          text: "Decide dependency bumps yourself.",
        });
        assert.strictEqual(hand.status, 200);
        const started = hand.body.evaluator.threadId as string;
        assert.strictEqual((yield* kanban.caller(started))?.role, "evaluator");

        const outside = yield* kanban
          .answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, evaluatorOf("thread-x"))
          .pipe(Effect.flip);
        assert.include(outside.detail, NOT_ITS_EVALUATOR);
        const decided = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "approved", revision: 0 },
          evaluatorOf(started),
        );
        assert.strictEqual(askOf(decided.card).answer?.decision, "approved");
      }).pipe(Effect.provide(testLayer(fake.layer))),
    );
  }),
);
