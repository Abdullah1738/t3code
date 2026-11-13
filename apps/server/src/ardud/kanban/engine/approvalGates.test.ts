import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { inferGate, isNegativeOption } from "./subtasks.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
it.effect.each([owner, evaluator])(
  "$_tag drop cannot complete, skip, remove or verify a deploy gate",
  (dropper) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Gate",
            prompt: "Work",
            subtasks: [{ text: "Restart LaunchAgent", owner: "evaluator", gate: "deploy" }],
          },
          owner,
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Restart?", blocking: true, action: { summary: "Restart LaunchAgent" } },
          evaluator,
          "evaluator",
        );
        yield* kanban.changeAsk(
          card.id,
          "q1",
          "drop",
          dropper,
          dropper._tag === "owner" ? "owner" : "evaluator",
        );
        for (const state of ["done", "skipped"] as const) {
          const refused = yield* kanban
            .markSubtask(card.id, "s1", state, "Dropped", evaluator, "evaluator")
            .pipe(Effect.flip);
          assert.include(refused.detail, "needs Abdullah's approval");
        }
        const verify = yield* kanban
          .moveCard(card.id, "verified", "evaluator", evaluator)
          .pipe(Effect.flip);
        assert.include(verify.detail, "approval");
        const removal = yield* kanban
          .editCard(card.id, { subtasks: [] }, evaluator)
          .pipe(Effect.flip);
        assert.include(removal.detail, "approval");
        yield* kanban.editCard(
          card.id,
          { subtasks: [{ id: "s1", text: "Read back", owner: "evaluator" }] },
          evaluator,
        );
        const renamed = yield* kanban
          .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
          .pipe(Effect.flip);
        assert.include(renamed.detail, "approval");
        const heard = (yield* fake.evaluators).flatMap((e) => e.messages).join("\n");
        if (dropper._tag === "owner")
          assert.include(heard, "Abdullah dropped q1. That is not approval for s1");
        yield* TestClock.adjust("1 second");
        yield* kanban.askOwner(
          card.id,
          { question: "Restart?", blocking: true, action: { summary: "Restart LaunchAgent" } },
          evaluator,
          "evaluator",
        );
        yield* kanban.replyOnAsk(card.id, "q2", owner, [{ _tag: "md", text: "go" }], "owner");
        const done = yield* kanban.markSubtask(
          card.id,
          "s1",
          "done",
          "Approved",
          evaluator,
          "evaluator",
        );
        assert.strictEqual(done.subtasks[0]?.state, "done");
        yield* kanban.moveCard(card.id, "verified", "evaluator", evaluator);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
it.each([
  ["deploy", "deploy"],
  ["install", "deploy"],
  ["restart", "deploy"],
  ["LaunchAgent", "deploy"],
  ["release", "deploy"],
  ["pay", "money"],
  ["purchase", "money"],
  ["charge", "money"],
  ["refund", "money"],
  ["secret", "secret"],
  ["token", "secret"],
  ["key", "secret"],
  ["Read back", undefined],
] as const)("infers %s", (text, gate) => assert.strictEqual(inferGate(text), gate));

it.effect("old approvals, text, drops and negative picks cannot approve a new gated subtask", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Timing", prompt: "Work" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Go?", blocking: false, action: { summary: "Deploy" } },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner);
      yield* TestClock.adjust("1 second");
      yield* kanban.editCard(
        card.id,
        {
          subtasks: [
            { text: "Deploy", owner: "evaluator" },
            { text: "Read back", owner: "evaluator" },
          ],
        },
        evaluator,
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy?", blocking: false, options: ["Yes", "No"] },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(
        card.id,
        "q2",
        { verdict: "picked", optionIds: ["o2"], revision: 0 },
        owner,
      );
      const denied = yield* kanban
        .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(denied.detail, "approval");
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy?", blocking: false, options: ["Yes", "No"] },
        evaluator,
        "evaluator",
      );
      yield* kanban.replyOnAsk(
        card.id,
        "q3",
        owner,
        [{ _tag: "md", text: "Is this still relevant?" }],
        "owner",
      );
      const textDenied = yield* kanban
        .markSubtask(card.id, "s1", "skipped", "text", evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(textDenied.detail, "approval");
      // A separate non-gated subtask is unaffected.
      yield* kanban.markSubtask(card.id, "s2", "done", "Read", evaluator, "evaluator");
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy?", blocking: false, options: ["Yes", "No"] },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(
        card.id,
        "q4",
        { verdict: "picked", optionIds: ["o1"], revision: 0 },
        owner,
      );
      yield* kanban.markSubtask(card.id, "s1", "skipped", "Owner approved", evaluator, "evaluator");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.each([
  "No",
  "Not yet",
  "Don't deploy",
  "Don’t deploy",
  "Do not deploy",
  "Reject",
  "Drop",
  "Skip",
  "Leave it",
  "Hold",
  "Cancel",
  "Wait",
  "Stop",
  "Later",
])("does not authorize a gate with %s", (label) => assert.isTrue(isNegativeOption(label)));

it.effect("an ask presented before a subtask edit cannot approve the replacement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Version",
          prompt: "Work",
          subtasks: [{ text: "Deploy build 41", owner: "evaluator" }],
        },
        owner,
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy build 41?", blocking: false, action: { summary: "Deploy 41" } },
        evaluator,
        "evaluator",
      );
      yield* TestClock.adjust("1 second");
      yield* kanban.editCard(
        card.id,
        { subtasks: [{ id: "s1", text: "Deploy build 42", owner: "evaluator" }] },
        evaluator,
      );
      yield* kanban.answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner);
      const refused = yield* kanban
        .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(refused.detail, "approval");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.each(["Deploy later", "Deploy tomorrow", "Install next week", "Restart next month"])(
  "defers rather than approves: %s",
  (label) => assert.isTrue(isNegativeOption(label)),
);

it.effect("dropping a blocking ask cannot restore a verified stage over an open gate", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Legacy verified",
          prompt: "Work",
          subtasks: [{ text: "Install release", owner: "evaluator" }],
        },
        owner,
      );
      yield* kanban.moveCard(card.id, "verified", "owner", owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Install release?", blocking: true, action: { summary: "Install release" } },
        evaluator,
        "evaluator",
      );
      const dropped = yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      assert.strictEqual(dropped.stage, "completed");
      assert.strictEqual(dropped.subtasks[0]?.state, "open");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
