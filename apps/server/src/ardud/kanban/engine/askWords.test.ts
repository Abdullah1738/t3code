import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { askOf, makeFake, makeHttp, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
it.effect.each([
  "answer",
  "single-http",
  "batch-http",
  "reply-http",
  "pick",
  "discussion",
] as const)("owner words are retained and close the ask through %s", (route) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(board.id, { title: "Words", prompt: "Work" }, owner);
        const asked = yield* kanban.askOwner(
          card.id,
          { question: "Which?", blocking: true, options: ["Staging", "Production"] },
          evaluator,
          "evaluator",
        );
        const words = "Which environment?";
        const answer = { verdict: "answered", text: words, revision: 0 };
        const talk = yield* kanban.cardDiscussion(card.id);
        if (route === "answer") yield* kanban.answerAsk(card.id, "q1", answer, owner);
        else if (route === "pick")
          yield* kanban.answer(talk.id, askOf(asked).seq!, "q1", [], owner, words);
        else if (route === "discussion")
          yield* kanban.post(talk.id, owner, [{ _tag: "md", text: words }]);
        else {
          const http = yield* makeHttp;
          const result =
            route === "single-http"
              ? yield* http.post("/cards/toy:1/asks/q1/answer", answer)
              : route === "reply-http"
                ? yield* http.post("/cards/toy:1/asks/q1/reply", { text: words })
                : yield* http.post("/asks/answer", {
                    ...answer,
                    items: [{ card: "toy:1", askId: "q1", revision: 0 }],
                  });
          assert.strictEqual(result.status, 200);
        }
        const closed = askOf((yield* kanban.card(card.id)).card);
        assert.isNotNull(closed.closedAt);
        assert.strictEqual(closed.answer?.verdict, "text");
        assert.strictEqual(closed.answer?.text, words);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
it.effect("unscoped words cannot silently decide two independent option asks", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Two asks", prompt: "Work" }, owner);
      for (const question of ["Deploy A?", "Deploy B?"])
        yield* kanban.askOwner(
          card.id,
          { question, blocking: false, options: ["Yes", "No"] },
          evaluator,
          "evaluator",
        );
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "yes" }]);
      assert.isTrue((yield* kanban.card(card.id)).card.asks.every((ask) => ask.closedAt === null));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
