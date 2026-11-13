/** Picks are checked against the current ask revision and its required fields. */
import { assert, it } from "@effect/vitest";
import { ThreadId, kanbanAskRevision, type KanbanActor, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { askOf, makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };

/** A card whose worker is running, so it can raise asks of its own. */
const runningCard = (title: string) =>
  Effect.gen(function* () {
    const { kanban, board } = yield* toyBoard();
    const card = yield* kanban.createCard(board.id, { prompt: title, title }, owner);
    yield* kanban.dispatchNow;
    const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
    const worker: KanbanActor = { _tag: "thread", threadId };
    return { kanban, board, card, threadId, worker };
  });

const open = (card: KanbanCard) =>
  card.asks.filter((ask) => ask.closedAt === null).map((ask) => ask.id);

it.effect("a pick on an ask's earlier message is refused as stale and closes nothing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* runningCard("Deploy");
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Deploy tonight?", blocking: true, action: { summary: "Deploy build 41" } },
        worker,
        "cardThread",
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Also drop the old table?", blocking: false, action: { summary: "Drop it" } },
        evaluator,
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      const first = askOf(asked).seq!;
      // The ask changes under him: build 42 now, a new message, revision 1.
      const edited = yield* kanban.editAsk(
        card.id,
        "q1",
        { action: { summary: "Deploy build 42" }, revisionNote: "Newer build" },
        evaluator,
        "evaluator",
      );
      assert.strictEqual(kanbanAskRevision(askOf(edited)), 1);
      assert.notStrictEqual(askOf(edited).seq, first);

      // He clicks Approve on the message he still has on screen: build 41's.
      const stale = yield* kanban
        .answer(discussion.id, first, "q1", ["approve"], owner)
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "conflict");
      assert.include(stale.detail, "it is at revision 1 now");
      assert.include(stale.detail, "Nothing was answered");
      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(open(after), ["q1", "q2"]);
      assert.isUndefined(askOf(after).answer);
      assert.strictEqual(after.stage, "needs_owner");
      // Nor is the pick recorded on the old message.
      assert.deepStrictEqual((yield* kanban.message(discussion.id, first)).answers, []);

      // The same pick on the current message is his approval of build 42, and of that ask alone.
      yield* kanban.answer(discussion.id, askOf(edited).seq!, "q1", ["approve"], owner);
      const approved = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(open(approved), ["q2"]);
      assert.strictEqual(askOf(approved).answer?.verdict, "approved");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a pick on an ask's current message is checked like any answer to it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* runningCard("Merge");
      yield* kanban.askOwner(
        card.id,
        {
          question: "Merge PR 9?",
          blocking: true,
          action: { summary: "Merge PR 9" },
          // The test clock starts at the epoch, so this is already past.
          expiresAt: "1969-12-31T00:00:00.000Z",
        },
        worker,
        "cardThread",
      );
      yield* kanban.askOwner(
        card.id,
        {
          question: "Schedule the deploy?",
          blocking: false,
          action: { summary: "Deploy build 42" },
          respond: { fields: [{ id: "when", label: "When", type: "datetime", required: true }] },
        },
        evaluator,
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      const asks = (yield* kanban.card(card.id)).card;

      const expired = yield* kanban
        .answer(discussion.id, askOf(asks, "q1").seq!, "q1", ["approve"], owner)
        .pipe(Effect.flip);
      assert.strictEqual(expired.code, "conflict");
      assert.include(expired.detail, "expired at 1969-12-31T00:00:00.000Z");

      // An approval that needs a value he has not given is not an approval.
      const unfilled = yield* kanban
        .answer(discussion.id, askOf(asks, "q2").seq!, "q2", ["approve"], owner)
        .pipe(Effect.flip);
      assert.strictEqual(unfilled.code, "invalid");
      assert.include(unfilled.detail, 'field "when" (When) is required');

      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(open(after), ["q1", "q2"]);
      assert.deepStrictEqual(
        after.asks.map((ask) => ask.answer),
        [undefined, undefined],
      );
      assert.strictEqual(after.stage, "needs_owner");

      // Rejecting needs no value, so that pick goes through, with the verdict it stands for.
      yield* kanban.answer(discussion.id, askOf(asks, "q2").seq!, "q2", ["reject"], owner);
      assert.strictEqual(
        askOf((yield* kanban.card(card.id)).card, "q2").answer?.verdict,
        "rejected",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
