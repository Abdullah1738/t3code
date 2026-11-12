/**
 * Words are not a verdict or a pick: an approval, or an ask he must pick on,
 * never closes on words alone, whichever way they arrive.
 */
import { assert, it } from "@effect/vitest";
import {
  KANBAN_ASK_WORDS_REFUSED,
  ThreadId,
  kanbanAskTakesWords,
  kanbanAskWaitsOn,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
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
import type * as Asks from "./asks.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
const untouched = (card: KanbanCard, id = "q1") => {
  const ask = askOf(card, id);
  return [ask.closedAt, ask.answer];
};

/** The asks words can't close, and what the asker is told his words were not. */
const NEEDS_MORE: ReadonlyArray<readonly [string, Asks.AskFieldsInput, string, string]> = [
  [
    "an approval",
    { action: { summary: "Deploy build 42", command: "make deploy" } },
    "It is not an approval or a rejection.",
    "approved or rejected",
  ],
  ["a required pick", { options: ["Staging", "Production"] }, "It is not a pick.", "picked"],
];

for (const [name, fields, notThat, takes] of NEEDS_MORE) {
  it.effect(
    `words typed on the pick block of ${name} are a reply: it stays open and blocking`,
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFake;
        yield* Effect.gen(function* () {
          const { kanban, card, threadId, worker } = yield* workingCard("Deploy");
          const asked = yield* kanban.askOwner(
            card.id,
            { question: "Go ahead?", blocking: true, ...fields },
            worker,
            "cardThread",
          );
          assert.isFalse(kanbanAskTakesWords(askOf(asked)));
          const discussion = yield* kanban.cardDiscussion(card.id);
          const heardBefore = (yield* fake.heard(threadId)).length;
          const words = "Which environment?";
          const shown = yield* kanban.answer(
            discussion.id,
            askOf(asked).seq!,
            "q1",
            [],
            owner,
            words,
          );

          // Nothing is recorded on the pick block, and nothing closed or was released.
          assert.deepStrictEqual(shown.answers, []);
          const after = (yield* kanban.card(card.id)).card;
          assert.deepStrictEqual(untouched(after), [null, undefined]);
          assert.strictEqual(after.stage, "needs_owner");
          assert.isNull(after.wakeNote ?? null);
          assert.strictEqual(kanbanAskWaitsOn(askOf(after)), "agent");
          // His words are a message on the ask.
          const reply = yield* kanban.message(
            discussion.id,
            (yield* kanban.cardDiscussion(card.id)).lastSeq,
          );
          assert.deepStrictEqual(
            [reply.author._tag, reply.askId, reply.blocks],
            ["owner", "q1", [{ _tag: "md", text: words }]],
          );
          // The worker is parked on its ask: the evaluator is told, and told what the words were not.
          assert.lengthOf(yield* fake.heard(threadId), heardBefore);
          const told = (yield* fake.evaluators).flatMap((entry) => entry.messages).join("\n");
          assert.include(told, `His message:\n${words}`);
          assert.include(told, "without answering it");
          assert.include(told, `Don't treat his message as the answer. ${notThat}`);
          assert.notInclude(told, "ANSWERED");

          // A pick on the same block still decides it.
          const first = fields.options === undefined ? "approve" : "o1";
          yield* kanban.answer(discussion.id, askOf(asked).seq!, "q1", [first], owner);
          const decided = askOf((yield* kanban.card(card.id)).card);
          assert.strictEqual(
            decided.answer?.verdict,
            fields.options === undefined ? "approved" : "picked",
          );
        }).pipe(Effect.provide(testLayer(fake.layer)));
      }),
  );

  it.effect(
    `${name} refuses words alone on the answer route, in a batch and from an evaluator`,
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFake;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { kanban, card, worker } = yield* workingCard("Deploy");
            const http = yield* makeHttp;
            yield* kanban.askOwner(
              card.id,
              { question: "Go ahead?", blocking: true, ...fields },
              worker,
              "cardThread",
            );
            const refusal = `q1 on card #1 ${KANBAN_ASK_WORDS_REFUSED}: it takes ${takes}. To say something about it without deciding, reply on the ask instead: it stays open.`;
            const words = { verdict: "answered", text: "Which environment?", revision: 0 };

            const direct = yield* kanban.answerAsk(card.id, "q1", words, owner).pipe(Effect.flip);
            assert.deepStrictEqual([direct.code, direct.detail], ["invalid", refusal]);

            const single = yield* http.post("/cards/toy:1/asks/q1/answer", words);
            assert.strictEqual(single.status, 400);
            assert.strictEqual(single.body.error.code, "invalid");
            assert.include(single.body.error.message, refusal);

            const batch = yield* http.post("/asks/answer", {
              verdict: "answered",
              text: "Which environment?",
              items: [{ card: "toy:1", askId: "q1", revision: 0 }],
            });
            assert.deepStrictEqual(
              batch.body.results.map((result: Record<string, any>) => [
                result.ok,
                result.error?.code,
              ]),
              [[false, "invalid"]],
            );

            // Handed over, the evaluator can't close it in words either.
            yield* kanban.handAsk(card.id, "q1", "hand", owner);
            const [started] = yield* fake.evaluators;
            const handed = yield* kanban
              .answerAsk(card.id, "q1", words, { _tag: "evaluator", threadId: started!.threadId })
              .pipe(Effect.flip);
            assert.deepStrictEqual([handed.code, handed.detail], ["invalid", refusal]);

            const after = (yield* kanban.card(card.id)).card;
            assert.deepStrictEqual(untouched(after), [null, undefined]);
            assert.strictEqual(after.stage, "needs_owner");
          }),
        ).pipe(Effect.provide(testLayer(fake.layer)));
      }),
  );
}

it.effect(
  "words still answer what words can: a question, fields, and a pick he may leave empty",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        const asks: ReadonlyArray<Asks.AskFieldsInput & { readonly question: string }> = [
          { question: "Which tier?" },
          {
            question: "Budget?",
            respond: { fields: [{ id: "note", label: "Note", type: "text" }] },
          },
          {
            question: "Any of these?",
            options: ["Red", "Blue"],
            multi: true,
            respond: { choose: { min: 0 } },
          },
        ];
        for (const ask of asks) {
          yield* kanban.askOwner(card.id, { blocking: false, ...ask }, evaluator, "evaluator");
        }
        const open = (yield* kanban.card(card.id)).card;
        assert.deepStrictEqual(
          open.asks.map((ask) => kanbanAskTakesWords(ask)),
          [true, true, true],
        );
        for (const id of ["q1", "q2", "q3"]) {
          const answered = yield* kanban.answerAsk(
            card.id,
            id,
            { verdict: "answered", text: "In my own words.", revision: 0 },
            owner,
          );
          assert.strictEqual(askOf(answered.card, id).answer?.verdict, "answered");
        }
        // A notice and a task with nothing to fill in take no words either: their own verdicts only.
        yield* kanban.askOwner(
          card.id,
          { question: "Build 42 is live.", blocking: false, kind: "notice" },
          evaluator,
          "evaluator",
        );
        yield* kanban.askOwner(
          card.id,
          {
            question: "Install it.",
            blocking: false,
            kind: "task",
            respond: { task: { steps: ["Install build 42"] } },
          },
          evaluator,
          "evaluator",
        );
        const rest = (yield* kanban.card(card.id)).card;
        assert.deepStrictEqual(
          [kanbanAskTakesWords(askOf(rest, "q4")), kanbanAskTakesWords(askOf(rest, "q5"))],
          [false, false],
        );
        const notice = yield* kanban
          .answerAsk(card.id, "q4", { verdict: "answered", text: "ok", revision: 0 }, owner)
          .pipe(Effect.flip);
        assert.include(notice.detail, 'takes acknowledged (got "answered")');
        const task = yield* kanban
          .answerAsk(card.id, "q5", { verdict: "answered", text: "ok", revision: 0 }, owner)
          .pipe(Effect.flip);
        assert.include(task.detail, `${KANBAN_ASK_WORDS_REFUSED}: it takes done or cant`);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
