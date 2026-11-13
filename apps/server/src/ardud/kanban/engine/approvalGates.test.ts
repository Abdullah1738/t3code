import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { inferGate, isNegativeOption } from "./subtasks.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };

const consentReplies = [
  { task: "Purchase the license", label: "Yes, buy it", reply: "yes", approved: true },
  { task: "Purchase the license", label: "Yes, buy this", reply: "yes", approved: true },
  { task: "Purchase the license", label: "Yes, buy that now", reply: "yes", approved: true },
  { task: "Purchase the licenses", label: "Yes, buy these", reply: "yes", approved: true },
  { task: "Purchase the licenses", label: "Yes, buy those now", reply: "yes", approved: true },
  { task: "Purchase the license", label: "Yes, purchase it", reply: "yes", approved: true },
  { task: "Purchase the license", label: "Yes, please buy it", reply: "yes", approved: true },
  { task: "Purchase the license", label: "Yes, go ahead and buy it", reply: "yes", approved: true },
  { task: "Restart the bridge LaunchAgent", label: "Yes, go ahead", reply: "yes", approved: true },
  { task: "Restart the bridge LaunchAgent", label: "Yes, go for it", reply: "yes", approved: true },
  { task: "Restart the bridge LaunchAgent", label: "Yes, do it", reply: "yes", approved: true },
  { task: "Share the token", label: "Yes, share it", reply: "yes", approved: true },
  ...[
    " and read back its version",
    ", then read back its version",
    " read back its version",
    " and read-back it",
    ", verify the result",
    " then check it",
    " and then confirm the result",
    ", then test it",
    " and report back",
  ].map((followup) => ({
    task: `Deploy Robob build 41${followup}`,
    label: "Deploy Robob build 41",
    reply: "go",
    approved: true,
  })),
  {
    task: "Deploy Robob build 41 and read back its version",
    label: "Deploy Robob build 41 now",
    reply: "go",
    approved: true,
  },
  ...[
    "; read back its version",
    " — read back its version",
    " (read back its version)",
    ". Read back its version",
    " and read back its token",
    " and verify the deployment",
    " and check the result and restart",
    " and test unknown words",
    " and report back the result and purchase",
    " and read back its version now",
    " and the test",
    " and the check",
    " and then the test",
  ].map((followup) => ({
    task: `Deploy Robob build 41${followup}`,
    label: "Deploy Robob build 41",
    reply: "go",
    approved: false,
  })),
  {
    task: "Purchase the license and record the receipt",
    label: "Buy the license",
    reply: "Buy the license",
    approved: false,
  },
  {
    task: "Share the API key and confirm the connection",
    label: "Share the API key",
    reply: "Share the API key",
    approved: false,
  },
  { task: "Purchase the license", label: "Yes, show the price", reply: "yes", approved: false },
  {
    task: "Purchase the license",
    label: "Yes, please show the price",
    reply: "yes",
    approved: false,
  },
  {
    task: "Purchase the license",
    label: "Yes, go ahead and show the price",
    reply: "yes",
    approved: false,
  },
  {
    task: "Purchase the license",
    label: "Yes, compare purchase options",
    reply: "yes",
    approved: false,
  },
  { task: "Share the token", label: "Yes, show token permissions", reply: "yes", approved: false },
  { task: "Deploy the release", label: "Yes, review release notes", reply: "yes", approved: false },
  { task: "Purchase the license", label: "Yes, buy it if needed", reply: "yes", approved: false },
  { task: "Restart LaunchAgent", label: "Yes, go ahead later", reply: "yes", approved: false },
  {
    task: "Deploy Robob build 41 and read back its version",
    label: "Deploy Robob build 42",
    reply: "go",
    approved: false,
  },
  { task: "Deploy Robob build 410", label: "Deploy Robob build 41", reply: "go", approved: false },
  { task: "Deploy Robob build 41.1", label: "Deploy Robob build 41", reply: "go", approved: false },
  {
    task: "Deploy Robob build 41-beta",
    label: "Deploy Robob build 41",
    reply: "go",
    approved: false,
  },
];

it.effect.each([
  { task: "Deploy staging and production", narrow: "Deploy staging" },
  {
    task: "Purchase the basic license and the enterprise add-on",
    narrow: "Purchase the basic license",
  },
  { task: "Deploy staging, production too", narrow: "Deploy staging" },
  { task: "Deploy staging and production", narrow: "Deploy" },
  { task: "Purchase a test", narrow: "Purchase" },
  { task: "Deploy the check", narrow: "Deploy" },
])("$narrow cannot approve all of $task", ({ task, narrow }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Scoped approval",
          prompt: "Work",
          subtasks: [{ text: task, owner: "evaluator" }],
        },
        owner,
      );
      yield* kanban.askOwner(
        card.id,
        { question: `${task}?`, blocking: false },
        evaluator,
        "evaluator",
      );
      yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      yield* kanban.askOwner(
        card.id,
        { question: `${narrow} only, or ${task}?`, blocking: false, options: [narrow, task] },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(
        card.id,
        "q2",
        { verdict: "picked", optionIds: ["o1"], revision: 0 },
        owner,
      );
      for (const state of ["done", "skipped"] as const) {
        const refused = yield* kanban
          .markSubtask(card.id, "s1", state, "Narrower choice", evaluator, "evaluator")
          .pipe(Effect.flip);
        assert.include(refused.detail, "needs Abdullah's approval");
      }
      const refused = yield* kanban
        .moveCard(card.id, "verified", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.include(refused.detail, "approval");
      assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]?.state, "open");
      yield* kanban.askOwner(
        card.id,
        { question: `${task}?`, blocking: false, options: [narrow, task] },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(
        card.id,
        "q3",
        { verdict: "picked", optionIds: ["o2"], revision: 0 },
        owner,
      );
      assert.strictEqual(
        (yield* kanban.markSubtask(card.id, "s1", "done", "Full approval", evaluator, "evaluator"))
          .subtasks[0]?.state,
        "done",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(
  consentReplies.flatMap((fixture) =>
    (["done", "skipped"] as const).map((state) => ({ ...fixture, state })),
  ),
)(
  "$reply selects $label; $state requires consent ($approved)",
  ({ task, label, reply, approved, state }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Consent wording",
            prompt: "Work",
            subtasks: [{ text: task, owner: "evaluator" }],
          },
          owner,
        );
        yield* kanban.askOwner(
          card.id,
          { question: `${task}?`, blocking: false },
          evaluator,
          "evaluator",
        );
        yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
        yield* kanban.askOwner(
          card.id,
          { question: `${task}?`, blocking: false, options: [label, "No"] },
          evaluator,
          "evaluator",
        );
        yield* kanban.replyOnAsk(card.id, "q2", owner, [{ _tag: "md", text: reply }], "owner");
        const answered = (yield* kanban.card(card.id)).card.asks.at(-1)!;
        assert.isNotNull(answered.closedAt);
        assert.strictEqual(answered.answer?.verdict, "picked");
        assert.deepStrictEqual(answered.answer?.optionIds, ["o1"]);
        const complete = kanban.markSubtask(
          card.id,
          "s1",
          state,
          "Owner replied",
          evaluator,
          "evaluator",
        );
        if (approved) {
          assert.strictEqual((yield* complete).subtasks[0]?.state, state);
          assert.strictEqual(
            (yield* kanban.moveCard(card.id, "verified", "evaluator", evaluator)).stage,
            "verified",
          );
        } else {
          assert.include((yield* complete.pipe(Effect.flip)).detail, "approval");
          assert.include(
            (yield* kanban.moveCard(card.id, "verified", "evaluator", evaluator).pipe(Effect.flip))
              .detail,
            "approval",
          );
          assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]?.state, "open");
        }
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([
  { task: "Purchase the license", neutral: "Show the price", approve: "Purchase now" },
  { task: "Purchase the license", neutral: "Compare purchase options", approve: "Buy the license" },
  { task: "Pay the invoice", neutral: "Check the invoice", approve: "Pay now" },
  { task: "Refund the charge", neutral: "Review the refund", approve: "Refund now" },
  { task: "Make a money transfer", neutral: "Show the balance", approve: "Transfer now" },
  { task: "Deploy the release", neutral: "Show the deployment plan", approve: "Deploy now" },
  { task: "Install the release", neutral: "Staging", approve: "Install the release" },
  { task: "Restart LaunchAgent", neutral: "Check status first", approve: "Restart now" },
  { task: "Share the token", neutral: "Explain the token permissions", approve: "Share the token" },
  { task: "Use the API key", neutral: "Check the key", approve: "Use the API key" },
  { task: "Purchase the license", neutral: "Purchase after review", approve: "Approve" },
  { task: "Deploy the release", neutral: "Deploy if tests pass", approve: "Yes" },
  { task: "Deploy the release", neutral: "Deploy later", approve: "Go" },
  { task: "Deploy the release", neutral: "Release notes", approve: "Approve deployment" },
  { task: "Deploy the release", neutral: "Deployment plan", approve: "Approve the deployment" },
  { task: "Deploy the release", neutral: "Deploy details", approve: "Approve the release" },
  {
    task: "Share the token",
    neutral: "Show token permissions",
    approve: "Approve sharing the token",
  },
  { task: "Purchase the license", neutral: "Purchase details", approve: "Yes, purchase now" },
  {
    task: "Purchase the license",
    neutral: "Approve purchase price",
    approve: "Approve the purchase",
  },
  ...[",", ":", ";", ".", "-", "–", "—", ""].map((separator) => ({
    task: "Deploy the release",
    neutral: `Yes${separator} show the deployment plan`,
    approve: `Yes${separator} deploy now`,
  })),
  ...[
    { task: "Make a money transfer", neutral: "Show the balance" },
    { task: "Deploy the release", neutral: "Release notes" },
    { task: "Purchase the license", neutral: "Purchase details" },
    { task: "Share the token", neutral: "Show token permissions" },
  ].flatMap(({ task, neutral }) =>
    ["", " now", " now.", " now!"].map((suffix) => ({
      task,
      neutral,
      approve: `${task}${suffix}`,
    })),
  ),
])("$neutral does not approve $task after a drop", ({ task, neutral, approve }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Action approval",
          prompt: "Work",
          subtasks: [{ text: task, owner: "evaluator" }],
        },
        owner,
      );
      yield* kanban.askOwner(
        card.id,
        { question: `${task}?`, blocking: false },
        evaluator,
        "evaluator",
      );
      yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      for (const [id, optionId] of [
        ["q2", "o1"],
        ["q3", "o2"],
      ] as const) {
        yield* kanban.askOwner(
          card.id,
          { question: `${task}?`, blocking: false, options: [neutral, approve] },
          evaluator,
          "evaluator",
        );
        yield* kanban.answerAsk(
          card.id,
          id,
          { verdict: "picked", optionIds: [optionId], revision: 0 },
          owner,
        );
        if (optionId === "o1") {
          for (const state of ["done", "skipped"] as const) {
            const refused = yield* kanban
              .markSubtask(card.id, "s1", state, "Owner chose information", evaluator, "evaluator")
              .pipe(Effect.flip);
            assert.include(refused.detail, "approval");
          }
          const verify = yield* kanban
            .moveCard(card.id, "verified", "evaluator", evaluator)
            .pipe(Effect.flip);
          assert.include(verify.detail, "approval");
          assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]?.state, "open");
        } else {
          const done = yield* kanban.markSubtask(
            card.id,
            "s1",
            "done",
            null,
            evaluator,
            "evaluator",
          );
          assert.strictEqual(done.subtasks[0]?.state, "done");
        }
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

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
