/**
 * Cutover: the asks the previous build left behind, in the exact shape it
 * stored them (an ask with only id, text, blocking, by, at, seq, closedAt, and
 * a message with no askId), read and answered by this build with no migration.
 */
import { assert, it } from "@effect/vitest";
import {
  KANBAN_ASK_ANSWER_FIELD,
  ThreadId,
  kanbanAskKind,
  kanbanAskResponse,
  kanbanAskWaitsOn,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KanbanStore from "../store/KanbanStore.ts";
import { ownerMessageText } from "./briefs.ts";
import { askOf, makeFake, makeHttp, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const OLD_KEYS = ["id", "text", "blocking", "by", "at", "seq", "closedAt"];
const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };

/**
 * Rewrites what this build stored into what the previous one stored: each ask
 * keeps only its seven keys, and no message says which ask it belongs to.
 */
const asThePreviousBuildStoredIt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', json_extract(ask.value, '$.id'),
        'text', json_extract(ask.value, '$.text'),
        'blocking', json(CASE WHEN json_extract(ask.value, '$.blocking') THEN 'true' ELSE 'false' END),
        'by', json(json_extract(ask.value, '$.by')),
        'at', json_extract(ask.value, '$.at'),
        'seq', json_extract(ask.value, '$.seq'),
        'closedAt', json_extract(ask.value, '$.closedAt')
      ))
      FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
    ), '[]')))
  `;
  yield* sql`UPDATE ardud_kanban_messages SET json = json_remove(json, '$.askId')`;
});

const rawCard = (id: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ json: string }>`SELECT json FROM ardud_kanban_cards WHERE id = ${id}`;
    return rows[0]!.json;
  });

/**
 * A board as the previous build left it: #1 waits in Needs Owner on a blocking
 * ask its worker raised and also has an async one from an evaluator; #2 is
 * completed with an ask still open.
 */
const oldBoard = Effect.gen(function* () {
  const { kanban, board } = yield* toyBoard();
  const sql = yield* SqlClient.SqlClient;
  const first = yield* kanban.createCard(board.id, { prompt: "Fees", title: "Fees" }, owner);
  yield* kanban.dispatchNow;
  const threadId = (yield* kanban.card(first.id)).card.activeThreadId!;
  const worker: KanbanActor = { _tag: "thread", threadId };
  yield* kanban.askOwner(
    first.id,
    { question: "Which fee tier?", blocking: true },
    worker,
    "cardThread",
  );
  yield* kanban.askOwner(
    first.id,
    { question: "Rename the plan?", blocking: false },
    evaluator,
    "evaluator",
  );
  const done = yield* kanban.createCard(board.id, { prompt: "Docs", title: "Docs" }, owner);
  yield* kanban.askOwner(
    done.id,
    { question: "Publish the docs?", blocking: false },
    evaluator,
    "evaluator",
  );
  yield* sql`
    UPDATE ardud_kanban_cards
    SET stage = 'completed', json = json_set(json, '$.stage', 'completed')
    WHERE id = ${done.id}
  `;
  yield* asThePreviousBuildStoredIt;
  return { kanban, board, first, done, threadId, worker };
});

it.effect("old cards and messages decode and save back unchanged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { first, done } = yield* oldBoard;
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      for (const id of [first.id, done.id]) {
        const before = yield* rawCard(id);
        // The fixture is the old shape: every ask has exactly the seven keys.
        for (const ask of JSON.parse(before).asks) {
          assert.deepStrictEqual(Object.keys(ask), OLD_KEYS);
        }
        const card = (yield* store.card(id))!;
        yield* store.putCard(card);
        assert.strictEqual(yield* rawCard(id), before);
      }
      const messages = yield* sql<{ json: string }>`SELECT json FROM ardud_kanban_messages`;
      assert.isAbove(messages.length, 2);
      assert.isTrue(messages.every((row) => !row.json.includes("askId")));
      const stored = (yield* store.card(first.id))!;
      assert.deepStrictEqual(
        [stored.stage, stored.asks.map((ask) => [ask.id, ask.blocking, ask.by._tag])],
        [
          "needs_owner",
          [
            ["q1", true, "thread"],
            ["q2", false, "evaluator"],
          ],
        ],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("each old ask is in the feed as a plain question for the owner, with its message", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban } = yield* oldBoard;
      const feed = yield* kanban.askFeed({});
      assert.deepStrictEqual(
        feed.open.map((item) => [
          item.cardRef,
          item.stage,
          item.ask.id,
          item.kind,
          item.revision,
          item.waitsOn,
          item.expired,
          item.messages.map((message) => [message.seq === item.ask.seq, message.askId]),
        ]),
        [
          ["toy:1", "needs_owner", "q1", "question", 0, "owner", false, [[true, undefined]]],
          ["toy:1", "needs_owner", "q2", "question", 0, "owner", false, [[true, undefined]]],
          // A completed card's open ask is still his to answer.
          ["toy:2", "completed", "q1", "question", 0, "owner", false, [[true, undefined]]],
        ],
      );
      for (const item of feed.open) {
        assert.deepStrictEqual(Object.keys(item.ask), OLD_KEYS);
        // It takes a free-text reply and nothing else.
        assert.deepStrictEqual(kanbanAskResponse(item.ask), {
          verdict: null,
          choose: null,
          fields: [
            { id: KANBAN_ASK_ANSWER_FIELD, label: "Your answer", type: "longtext", required: true },
          ],
          edit: null,
          task: null,
          ack: false,
        });
        assert.strictEqual(kanbanAskKind(item.ask), "question");
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const ANSWER = "Tier 2, like the others.";

/** How one old blocking ask ends for its worker, for each way the owner can answer it. */
const outcome = (way: "reply" | "route" | "batch") =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, first, threadId } = yield* oldBoard;
        // Drop the async ask first, so the old reply (which answers every open ask) compares like for like.
        yield* kanban.changeAsk(first.id, "q2", "drop", evaluator, "evaluator");
        const heardBefore = (yield* fake.heard(threadId)).length;
        if (way === "reply") {
          const discussion = yield* kanban.cardDiscussion(first.id);
          yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: ANSWER }]);
        } else {
          const http = yield* makeHttp;
          const response =
            way === "route"
              ? yield* http.post("/cards/toy:1/asks/q1/answer", {
                  verdict: "answered",
                  text: ANSWER,
                })
              : yield* http.post("/asks/answer", {
                  verdict: "answered",
                  text: ANSWER,
                  items: [
                    { card: "toy:1", askId: "q1", revision: 0 },
                    { card: "toy:2", askId: "q1" },
                  ],
                });
          assert.strictEqual(response.status, 200);
          if (way === "batch") assert.strictEqual(response.body.answered, 2);
        }
        const card = (yield* kanban.card(first.id)).card;
        yield* kanban.dispatchNow;
        const after = (yield* kanban.card(first.id)).card;
        return {
          state: [
            card.stage,
            askOf(card).closedAt !== null,
            askOf(card).answer?.verdict,
            askOf(card).answer?.by._tag,
            after.activeThreadId === threadId,
          ],
          wakeNote: card.wakeNote,
          discussionId: card.discussionId!,
          heard: (yield* fake.heard(threadId)).slice(heardBefore).join("\n"),
        };
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  });

it.effect("an old ask is answered three ways with the same result for its asker", () =>
  Effect.gen(function* () {
    const reply = yield* outcome("reply");
    const route = yield* outcome("route");
    const batch = yield* outcome("batch");
    // Closed as answered by the owner, the card back in the queue, its worker running again.
    const expected = ["todo", true, "answered", "owner", true];
    assert.deepStrictEqual(reply.state, expected);
    assert.deepStrictEqual(route.state, expected);
    assert.deepStrictEqual(batch.state, expected);

    // The old reply wakes the worker with the text the previous build gave it (briefs.ts is unchanged).
    assert.strictEqual(reply.wakeNote, ownerMessageText("#1 Fees", reply.discussionId, ANSWER));
    assert.include(reply.wakeNote ?? "", `Owner message in "#1 Fees"`);
    // The answer route and a batch say which ask it answers, then the same words.
    const framed = `The owner ANSWERED q1 on card #1: "Which fee tier?".\n\nHis answer:\n${ANSWER}`;
    assert.strictEqual(route.wakeNote, framed);
    assert.strictEqual(batch.wakeNote, framed);
    for (const way of [reply, route, batch]) assert.include(way.heard, ANSWER);
  }),
);

it.effect("an evaluator edits a worker's old ask in place into a typed one", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, first, worker, threadId } = yield* oldBoard;
      const before = askOf((yield* kanban.card(first.id)).card);
      const edited = yield* kanban.editAsk(
        first.id,
        "q1",
        {
          title: "Fee tier for the new plan",
          context: "Tier 2 matches the other plans; tier 3 costs users 0.1% more.",
          options: [
            { id: "t2", label: "Tier 2", recommended: true },
            { id: "t3", label: "Tier 3", consequence: "Users pay 0.1% more" },
          ],
          revisionNote: "Re-issued with options",
        },
        evaluator,
        "evaluator",
      );
      const ask = askOf(edited);
      // Same ask: its id, its asker and when it was asked stay; it is revision 1 and still blocking.
      assert.deepStrictEqual(
        [ask.id, ask.by, ask.at, ask.blocking, ask.revision, kanbanAskKind(ask), ask.firstSeq],
        ["q1", worker, before.at, true, 1, "decision", before.seq],
      );
      assert.strictEqual(edited.stage, "needs_owner");
      assert.strictEqual(kanbanAskWaitsOn(ask), "owner");
      // Its thread in the feed is the old message, then the new version.
      const item = (yield* kanban.askFeed({})).open.find(
        (entry) => entry.cardNumber === 1 && entry.ask.id === "q1",
      )!;
      assert.deepStrictEqual(
        item.messages.map((message) => [message.seq, message.askId]),
        [
          [before.seq!, undefined],
          [ask.seq!, "q1"],
        ],
      );
      // The worker that raised it still gets the answer.
      const answered = yield* kanban.answerAsk(
        first.id,
        "q1",
        { verdict: "picked", optionIds: ["t3"], revision: 1 },
        owner,
      );
      assert.include(answered.card.wakeNote ?? "", "Picked: Tier 3");
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(first.id)).card.activeThreadId, threadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("who may edit an ask: an evaluator any, a worker those on the card it is running", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board, first, worker } = yield* oldBoard;
      // The worker that raised the blocking ask is parked: the card is not its to change now.
      const parked = yield* Effect.flip(
        kanban.editAsk(first.id, "q1", { title: "Mine" }, worker, "cardThread"),
      );
      assert.deepStrictEqual(
        [parked.code, parked.detail],
        ["denied", "card #1 is not assigned to this thread"],
      );
      // A worker running its card edits its own async ask.
      const card = yield* kanban.createCard(board.id, { prompt: "Logo", title: "Logo" }, owner);
      yield* kanban.dispatchNow;
      const running: KanbanActor = {
        _tag: "thread",
        threadId: (yield* kanban.card(card.id)).card.activeThreadId!,
      };
      yield* kanban.askOwner(
        card.id,
        { question: "Round or square?", blocking: false },
        running,
        "cardThread",
      );
      yield* asThePreviousBuildStoredIt;
      const own = yield* kanban.editAsk(
        card.id,
        "q1",
        { options: ["Round", "Square"], revisionNote: "Options" },
        running,
        "cardThread",
      );
      assert.deepStrictEqual([askOf(own).revision, kanbanAskKind(askOf(own))], [1, "decision"]);
      // And an ask an evaluator raised on that card too: the card is the unit, not the asker.
      yield* kanban.askOwner(
        card.id,
        { question: "Colour?", blocking: false },
        evaluator,
        "evaluator",
      );
      const others = yield* kanban.editAsk(
        card.id,
        "q2",
        { title: "Logo colour" },
        running,
        "cardThread",
      );
      assert.strictEqual(askOf(others, "q2").revision, 1);
      // Not an ask on another card.
      const elsewhere = yield* Effect.flip(
        kanban.editAsk(first.id, "q2", { title: "Not mine" }, running, "cardThread"),
      );
      assert.strictEqual(elsewhere.code, "denied");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("words in the card discussion from an older client do not approve a typed ask", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { prompt: "Deploy", title: "Deploy" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const asked = yield* kanban.askOwner(
        card.id,
        {
          question: "Deploy build 42 tonight?",
          blocking: true,
          title: "Deploy build 42",
          action: { summary: "Deploy build 42", command: "make deploy", undo: "make rollback" },
          respond: { fields: [{ id: "when", label: "When", type: "datetime", required: true }] },
        },
        worker,
        "cardThread",
      );
      // What an older client has to show: the question alone on the card, and the
      // ask's message, which spells the rest out as text with an Approve / Reject pick.
      assert.strictEqual(asked.question, "Deploy build 42 tonight?");
      const discussion = yield* kanban.cardDiscussion(card.id);
      const message = yield* kanban.message(discussion.id, askOf(asked).seq!);
      const [detail, pick] = message.blocks;
      assert.strictEqual(detail?._tag, "md");
      if (detail?._tag !== "md" || pick?._tag !== "choice") throw new Error("unexpected blocks");
      assert.include(detail.text, "**Action:** Deploy build 42");
      assert.include(detail.text, "- When (`when`: datetime, required)");
      assert.deepStrictEqual(
        [pick.id, pick.question, pick.options.map((option) => option.label)],
        ["q1", "Deploy build 42 tonight?", ["Approve", "Reject"]],
      );

      // He replies in words from there: no values, no verdict. That is not an approval of
      // the action: the ask stays open, waits on its asker, and the card stays held.
      const text = "Yes, go at 22:00 Dubai time.";
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text }]);
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "needs_owner");
      assert.deepStrictEqual(
        [askOf(after).closedAt, askOf(after).answer, kanbanAskWaitsOn(askOf(after))],
        [null, undefined, "agent"],
      );
      // The worker is parked on its ask, so the discussion's evaluator hears his words and
      // that they were not the ask's answer.
      const told = (yield* fake.evaluators).flatMap((entry) => entry.messages).join("\n");
      assert.include(told, ownerMessageText("#1 Deploy", discussion.id, text));
      assert.include(told, "It is not an approval, a pick or a decision on that ask");
      assert.notInclude((yield* fake.heard(threadId)).join("\n"), text);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an older client's pick on a typed ask's Approve / Reject block answers it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { prompt: "Post", title: "Post" }, owner);
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Post this comment?", blocking: true, draft: { text: "Thanks, merged." } },
        evaluator,
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(discussion.id, askOf(asked).seq!, "q1", ["approve"], owner);
      const after = (yield* kanban.card(card.id)).card;
      assert.isNotNull(askOf(after).closedAt);
      assert.strictEqual(askOf(after).answer?.by._tag, "owner");
      assert.notStrictEqual(after.stage, "needs_owner");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
