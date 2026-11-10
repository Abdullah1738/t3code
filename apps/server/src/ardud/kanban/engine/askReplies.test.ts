/**
 * What the owner's words and picks in a card's discussion do to its asks: a
 * pick is checked like any answer, and words alone close only the asks that
 * take words alone.
 */
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  kanbanAskIsFreeText,
  kanbanAskRevision,
  kanbanAskWaitsOn,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerMessageText } from "./briefs.ts";
import { askOf, makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";
import type * as Asks from "./asks.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
const NOT_AN_ANSWER = "It is not an approval, a pick or a decision on that ask";

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

it.effect("a reply in words closes a plain question as before, with the same wake text", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* runningCard("Fees");
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Which fee tier?", blocking: true },
        worker,
        "cardThread",
      );
      assert.isTrue(kanbanAskIsFreeText(askOf(asked)));
      const discussion = yield* kanban.cardDiscussion(card.id);
      const text = "Tier 2.";
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text }]);
      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(open(after), []);
      assert.deepStrictEqual(
        [askOf(after).answer?.verdict, askOf(after).answer?.by._tag, after.stage],
        ["answered", "owner", "todo"],
      );
      assert.strictEqual(after.wakeNote, ownerMessageText("#1 Fees", discussion.id, text));
      yield* kanban.dispatchNow;
      const heard = (yield* fake.heard(threadId)).join("\n");
      assert.include(heard, text);
      assert.notInclude(heard, NOT_AN_ANSWER);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

/** One ask of each kind that has an answer of its own, by what it is answered with. */
const TYPED: ReadonlyArray<readonly [string, Asks.AskFieldsInput]> = [
  ["a verdict", { action: { summary: "Deploy build 42", command: "make deploy" } }],
  ["a pick", { options: ["Rebase", "Merge"] }],
  ["fields", { respond: { fields: [{ id: "budget", label: "Budget", type: "number" }] } }],
  ["a draft to approve", { draft: { text: "Thanks, merged." } }],
  ["a task", { kind: "task", respond: { task: { steps: ["Install build 42"] } } }],
  [
    "a secret",
    { respond: { fields: [{ id: "token", label: "Token", type: "secret", required: true }] } },
  ],
];

it.effect(
  "a reply in words closes no ask that has an answer of its own, and its asker is told",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* runningCard("Deploy");
        for (const [name, fields] of TYPED) {
          yield* kanban.askOwner(
            card.id,
            { question: `Go ahead (${name})?`, blocking: false, ...fields },
            worker,
            "cardThread",
          );
        }
        const before = (yield* kanban.card(card.id)).card;
        assert.deepStrictEqual(
          before.asks.map((ask) => [kanbanAskIsFreeText(ask), kanbanAskWaitsOn(ask)]),
          TYPED.map(() => [false, "owner" as const]),
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const text = "Yes, go ahead with all of it.";
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text }]);

        const after = (yield* kanban.card(card.id)).card;
        // Nothing closed and no verdict recorded: each one waits on its asker now.
        assert.deepStrictEqual(
          after.asks.map((ask) => [ask.closedAt, ask.answer, kanbanAskWaitsOn(ask)]),
          TYPED.map(() => [null, undefined, "agent"]),
        );
        const heard = (yield* fake.heard(threadId)).at(-1)!;
        assert.include(heard, text);
        for (const ask of after.asks) {
          assert.include(
            heard,
            `without using the answer on ${ask.id} on card #1 ("${ask.title ?? ask.text}"). ${NOT_AN_ANSWER}: nobody may act as if it were.`,
          );
        }
        // Said once, to the thread that asked them.
        assert.lengthOf(
          (yield* fake.heard(threadId)).filter((entry) => entry.includes(NOT_AN_ANSWER)),
          1,
        );
        // The asker's reply on the ask gives him the turn back, as after any reply on it.
        yield* kanban.replyOnAsk(
          card.id,
          "q1",
          worker,
          [{ _tag: "md", text: "Approve it?" }],
          "cardThread",
        );
        assert.strictEqual(kanbanAskWaitsOn(askOf((yield* kanban.card(card.id)).card)), "owner");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "a blocking approval is not released by words, and its parked asker's evaluator hears why",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* runningCard("Deploy");
        yield* kanban.askOwner(
          card.id,
          { question: "Deploy tonight?", blocking: true, action: { summary: "Deploy build 42" } },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const heardBefore = (yield* fake.heard(threadId)).length;
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Sure." }]);
        const after = (yield* kanban.card(card.id)).card;
        assert.strictEqual(after.stage, "needs_owner");
        assert.deepStrictEqual(
          [askOf(after).closedAt, askOf(after).answer, kanbanAskWaitsOn(askOf(after))],
          [null, undefined, "agent"],
        );
        assert.isNull(after.wakeNote ?? null);
        // The worker is parked on its ask, so the discussion's evaluator gets it.
        assert.lengthOf(yield* fake.heard(threadId), heardBefore);
        const evaluators = yield* fake.evaluators;
        assert.lengthOf(evaluators, 1);
        const told = evaluators[0]!.messages.join("\n");
        assert.include(told, "Sure.");
        assert.include(told, NOT_AN_ANSWER);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an expired ask is never closed by a reply", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* runningCard("Plan");
      const asked = yield* kanban.askOwner(
        card.id,
        {
          question: "Which plan?",
          blocking: false,
          basis: "prices on 30 Dec",
          expiresAt: "1969-12-31T00:00:00.000Z",
        },
        worker,
        "cardThread",
      );
      // It takes words alone: only its expiry keeps the reply from closing it.
      assert.isTrue(kanbanAskIsFreeText(askOf(asked)));
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "The yearly one." }]);
      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(
        [askOf(after).closedAt, askOf(after).answer, askOf(after).clarifyAskedAt],
        [null, undefined, undefined],
      );
      const heard = (yield* fake.heard(threadId)).at(-1)!;
      assert.include(heard, "The yearly one.");
      assert.include(heard, "has expired, so this reply did not answer it");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

/** Rewrites q1 into what the previous build stored: seven keys, and a message with no askId. */
const asThePreviousBuildStoredIt = (cardId: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks[0]', json_object(
        'id', json_extract(json, '$.asks[0].id'),
        'text', json_extract(json, '$.asks[0].text'),
        'blocking', json('true'),
        'by', json(json_extract(json, '$.asks[0].by')),
        'at', json_extract(json, '$.asks[0].at'),
        'seq', json_extract(json, '$.asks[0].seq'),
        'closedAt', json_extract(json, '$.asks[0].closedAt')
      ))
      WHERE id = ${cardId}
    `;
    yield* sql`UPDATE ardud_kanban_messages SET json = json_remove(json, '$.askId')`;
  });

it.effect("on a card with an old ask and an approval open, a reply closes the old one only", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* runningCard("Fees");
      yield* kanban.askOwner(
        card.id,
        { question: "Which fee tier?", blocking: true },
        worker,
        "cardThread",
      );
      yield* asThePreviousBuildStoredIt(card.id);
      assert.deepStrictEqual(Object.keys(askOf((yield* kanban.card(card.id)).card)), [
        "id",
        "text",
        "blocking",
        "by",
        "at",
        "seq",
        "closedAt",
      ]);
      yield* kanban.askOwner(
        card.id,
        {
          question: "Refund order 77?",
          blocking: false,
          title: "Refund",
          action: { summary: "Refund order 77", command: "refund 77" },
        },
        evaluator,
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      const text = "Yes, tier 2.";
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text }]);

      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(open(after), ["q2"]);
      assert.deepStrictEqual(
        [askOf(after).answer?.verdict, askOf(after).answer?.by._tag],
        ["answered", "owner"],
      );
      // The approval: still open, no verdict, and waiting on the evaluator that asked it.
      const approval = askOf(after, "q2");
      assert.deepStrictEqual(
        [approval.closedAt, approval.answer, kanbanAskWaitsOn(approval)],
        [null, undefined, "agent"],
      );
      // The worker goes back to work on its answer: today's wake text, then that
      // his "yes" was not the refund's approval.
      assert.strictEqual(after.stage, "todo");
      const today = ownerMessageText("#1 Fees", discussion.id, text);
      assert.isTrue(after.wakeNote?.startsWith(`${today}\n\n`));
      assert.include(
        after.wakeNote ?? "",
        `without using the answer on q2 on card #1 ("Refund"). ${NOT_AN_ANSWER}`,
      );
      yield* kanban.dispatchNow;
      assert.include((yield* fake.heard(threadId)).join("\n"), today);
      // The approval's asker is not this card's thread: the discussion's evaluator hears it.
      const told = (yield* fake.evaluators).flatMap((entry) => entry.messages).join("\n");
      assert.include(told, text);
      assert.include(told, NOT_AN_ANSWER);

      // Approving it is still his to do, through the ask.
      yield* kanban.answerAsk(card.id, "q2", { verdict: "approved", revision: 0 }, owner);
      assert.strictEqual(
        askOf((yield* kanban.card(card.id)).card, "q2").answer?.verdict,
        "approved",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
