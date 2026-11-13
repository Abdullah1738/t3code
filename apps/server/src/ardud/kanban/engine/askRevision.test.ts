/** An answer says which revision of the ask it is for, unless the ask takes words alone. */
import { assert, it } from "@effect/vitest";
import { ThreadId, kanbanAskIsFreeText, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { askOf, makeFake, makeHttp, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };

it.effect("an answer with no revision is refused with the current one, on every answer path", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
        const approval = {
          question: "Deploy?",
          blocking: false,
          action: { summary: "Deploy build 41" },
        };
        yield* kanban.askOwner(first.id, approval, evaluator, "evaluator");
        yield* kanban.askOwner(second.id, approval, evaluator, "evaluator");
        yield* kanban.askOwner(
          second.id,
          { question: "Build 42 is live.", blocking: false, kind: "notice" },
          evaluator,
          "evaluator",
        );

        // The service, as a tool or the secrets RPC calls it.
        const direct = yield* kanban
          .answerAsk(first.id, "q1", { verdict: "approved" }, owner)
          .pipe(Effect.flip);
        assert.strictEqual(direct.code, "invalid");
        assert.include(direct.detail, "q1 on card #1 needs the revision you are answering");
        assert.include(direct.detail, "It is at revision 0");
        // The revision is a field too, so a client need not read it out of the words.
        assert.strictEqual(direct.revision, 0);

        const firstSeq = askOf((yield* kanban.card(first.id)).card).seq!;
        // The ask moves on; the refusal names the revision it is at now.
        yield* kanban.editAsk(
          first.id,
          "q1",
          { action: { summary: "Deploy build 42" }, revisionNote: "Newer build" },
          evaluator,
          "evaluator",
        );
        const single = yield* http.post("/cards/toy:1/asks/q1/answer", { verdict: "approved" });
        assert.strictEqual(single.status, 400);
        assert.strictEqual(single.body.error.code, "invalid");
        assert.include(single.body.error.message, "It is at revision 1");
        assert.strictEqual(single.body.error.revision, 1);
        // An older revision is a conflict, and says where the ask is now the same way.
        const stale = yield* http.post("/cards/toy:1/asks/q1/answer", {
          verdict: "approved",
          revision: 0,
        });
        assert.strictEqual(stale.status, 409);
        assert.deepInclude(stale.body.error, { code: "conflict", revision: 1 });
        const stalePick = yield* kanban
          .answer(
            (yield* kanban.cardDiscussion(first.id)).id,
            firstSeq,
            "q1",
            ["approve"],
            owner,
          )
          .pipe(Effect.flip);
        assert.deepInclude(stalePick, { code: "conflict", revision: 1 });
        // Rejecting needs it as much as approving does.
        const rejected = yield* http.post("/cards/toy:1/asks/q1/answer", { verdict: "rejected" });
        assert.strictEqual(rejected.status, 400);
        assert.include(rejected.body.error.message, "It is at revision 1");

        // A batch: each item carries its own; one without is refused, the rest go through.
        const batch = yield* http.post("/asks/answer", {
          verdict: "approved",
          items: [
            { card: "toy:1", askId: "q1", revision: 1 },
            { card: "toy:2", askId: "q1" },
          ],
        });
        assert.strictEqual(batch.status, 200);
        assert.deepStrictEqual(
          batch.body.results.map((result: Record<string, any>) => [
            result.card,
            result.ok,
            result.error?.code,
          ]),
          [
            ["toy:1", true, undefined],
            ["toy:2", false, "invalid"],
          ],
        );
        assert.include(batch.body.results[1].error.message, "It is at revision 0");
        assert.strictEqual(batch.body.results[1].error.revision, 0);
        assert.isNull(askOf((yield* kanban.card(second.id)).card).closedAt);

        // A notice is not a plain question either.
        const seen = yield* http.post("/cards/toy:2/asks/q2/answer", { verdict: "acknowledged" });
        assert.strictEqual(seen.status, 400);
        assert.include(seen.body.error.message, "It is at revision 0");
        const withIt = yield* http.post("/cards/toy:2/asks/q2/answer", {
          verdict: "acknowledged",
          revision: 0,
        });
        assert.strictEqual(withIt.status, 200);
        const approved = yield* http.post("/cards/toy:2/asks/q1/answer", {
          verdict: "approved",
          revision: 0,
        });
        assert.strictEqual(approved.status, 200);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a plain question is still answered without a revision, alone or in a batch", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        for (const question of ["Which tier?", "Which name?", "Which colour?"]) {
          const asked = yield* kanban.askOwner(
            card.id,
            { question, blocking: false },
            evaluator,
            "evaluator",
          );
          assert.isTrue(kanbanAskIsFreeText(asked.asks.at(-1)!));
        }
        const direct = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Tier 2." },
          owner,
        );
        assert.strictEqual(askOf(direct.card).answer?.text, "Tier 2.");
        const single = yield* http.post("/cards/toy:1/asks/q2/answer", {
          verdict: "answered",
          text: "Orion",
        });
        assert.strictEqual(single.status, 200);
        const batch = yield* http.post("/asks/answer", {
          verdict: "answered",
          text: "Blue",
          items: [{ card: "toy:1", askId: "q3" }],
        });
        assert.deepStrictEqual(
          batch.body.results.map((result: Record<string, any>) => result.ok),
          [true],
        );
        // One that says a revision is still held to it.
        const again = yield* kanban.askOwner(
          card.id,
          { question: "Which font?", blocking: false },
          evaluator,
          "evaluator",
        );
        assert.strictEqual(again.asks.length, 4);
        const stale = yield* http.post("/cards/toy:1/asks/q4/answer", {
          verdict: "answered",
          text: "Inter",
          revision: 2,
        });
        assert.strictEqual(stale.status, 409);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
