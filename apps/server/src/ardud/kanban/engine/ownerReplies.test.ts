import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor, type KanbanOwnerAsk } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { classifyReply } from "./ownerReplies.ts";
import { ownerReplyFixtures } from "./ownerReplyFixtures.ts";
import { askOf, makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

it.effect.each(ownerReplyFixtures)("#$card: $text", (fixture) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        { title: "Owner reply", prompt: "Work" },
        owner,
      );
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
      yield* kanban.askOwner(
        card.id,
        {
          question: fixture.ask.text,
          blocking: true,
          ...("options" in fixture.ask ? { options: [...fixture.ask.options] } : {}),
          ...("respond" in fixture.ask ? { respond: fixture.ask.respond } : {}),
        },
        evaluator,
        "evaluator",
      );
      yield* kanban.replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: fixture.text }], "owner");
      const after = (yield* kanban.card(card.id)).card;
      assert.isNotNull(askOf(after).closedAt);
      assert.strictEqual(askOf(after).answer?.verdict, fixture.expected);
      assert.strictEqual(askOf(after).answer?.text, fixture.text);
      assert.include((yield* fake.evaluators).flatMap((e) => e.messages).join("\n"), fixture.text);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
it.effect("ambiguous words post candidate buttons; the chosen button closes only that ask", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Confirm", prompt: "Work" }, owner);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
      yield* kanban.askOwner(
        card.id,
        { question: "When?", blocking: true, options: ["Deploy now", "Deploy later", "Cancel"] },
        evaluator,
        "evaluator",
      );
      yield* kanban.replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "Deploy" }], "owner");
      const after = (yield* kanban.card(card.id)).card;
      assert.isNull(askOf(after).closedAt);
      assert.strictEqual(after.stage, "needs_owner");
      const talk = yield* kanban.cardDiscussion(card.id);
      const confirm = yield* kanban.message(talk.id, askOf(after).confirmation!.seq);
      const block = confirm.blocks.find((b) => b._tag === "choice");
      assert.isDefined(block);
      if (block?._tag !== "choice") return;
      assert.deepStrictEqual(
        block.options.map((o) => o.label),
        ["Deploy now", "Deploy later"],
      );
      yield* kanban.answer(talk.id, confirm.seq, "q1", ["o2"], owner);
      assert.deepStrictEqual(askOf((yield* kanban.card(card.id)).card).answer?.optionIds, ["o2"]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const ask: KanbanOwnerAsk = {
  id: "q1",
  text: "Go?",
  at: "2026-11-13T00:00:00.000Z",
  by: owner,
  blocking: true,
  seq: 1,
  closedAt: null,
  respond: { verdict: { approve: "Apply", reject: "Don't apply" } },
};
it.each([
  ...["yes", "approve", "go", "ok", "do it", "APPLY", "1", "o1"].map((text) => [text, "approved"]),
  ...["no", "drop", "Drop", "drop it", "skip", "leave it", "don't", "2", "o2"].map((text) => [
    text,
    "rejected",
  ]),
] as const)("maps %s to %s", (words, verdict) => {
  const result = classifyReply(ask, words!);
  assert.isTrue("answer" in result);
  if ("answer" in result) assert.strictEqual(result.answer.verdict, verdict);
});

it.each([
  "Don't approve",
  "Do not apply",
  "I don't approve",
  "No, don't apply",
  "I mentioned Apply as an example",
])("keeps qualified words as text: %s", (text) => {
  const result = classifyReply(ask, text);
  assert.isTrue("answer" in result);
  if ("answer" in result) assert.strictEqual(result.answer.verdict, "text");
});

it.effect("stale words cannot approve a revised ask, and an approval keeps its note", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Revision", prompt: "Work" }, owner);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy 41?", blocking: true, action: { summary: "Deploy 41" } },
        evaluator,
        "evaluator",
      );
      yield* kanban.editAsk(
        card.id,
        "q1",
        { question: "Deploy 42?", revisionNote: "New build" },
        evaluator,
        "evaluator",
      );
      const stale = yield* kanban
        .replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "yes" }], "owner", 0)
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "conflict");
      assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);
      yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "yes", note: "staging only", revision: 1 },
        owner,
      );
      const answer = askOf((yield* kanban.card(card.id)).card).answer;
      assert.strictEqual(answer?.verdict, "approved");
      assert.strictEqual(answer?.note, "staging only");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("confirmation retries keep the original evidence and reuse the same buttons", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Evidence", prompt: "Work" }, owner);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
      const asked = yield* kanban.askOwner(
        card.id,
        {
          question: "When?",
          blocking: true,
          options: ["Deploy now", "Deploy later"],
          respond: { fields: [{ id: "region", label: "Region", type: "text", required: true }] },
          blocks: [{ _tag: "md", text: "Build evidence" }],
        },
        evaluator,
        "evaluator",
      );
      const input = {
        verdict: "answered",
        text: "Deploy",
        note: "staging only",
        values: { region: "staging" },
        revision: 0,
      };
      yield* kanban.answerAsk(card.id, "q1", input, owner);
      const first = askOf((yield* kanban.card(card.id)).card);
      yield* kanban.answerAsk(card.id, "q1", input, owner);
      const second = askOf((yield* kanban.card(card.id)).card);
      assert.strictEqual(second.seq, askOf(asked).seq);
      assert.strictEqual(second.confirmation?.seq, first.confirmation?.seq);
      const detail = yield* kanban.askDetail(card.id, "q1");
      assert.isTrue(
        detail.ask.blocks?.some((block) => block._tag === "md" && block.text === "Build evidence"),
      );
      const feed = yield* kanban.askFeed({});
      assert.isTrue(
        feed.open[0]?.messages.some((message) => message.seq === first.confirmation?.seq),
      );
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(talk.id, second.confirmation!.seq, "q1", ["o1"], owner);
      const answer = askOf((yield* kanban.card(card.id)).card).answer;
      assert.strictEqual(answer?.note, "staging only");
      assert.strictEqual(answer?.values?.region, "staging");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("form-only answers still require their fields", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Form", prompt: "Work" }, owner);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
      yield* kanban.askOwner(
        card.id,
        {
          question: "URL?",
          blocking: true,
          respond: { fields: [{ id: "url", label: "URL", type: "text", required: true }] },
        },
        evaluator,
        "evaluator",
      );
      const refused = yield* kanban
        .answerAsk(card.id, "q1", { verdict: "answered", text: "here", revision: 0 }, owner)
        .pipe(Effect.flip);
      assert.include(refused.detail, "is required");
      assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
