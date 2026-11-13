import { assert, it } from "@effect/vitest";
import { ThreadId, type KanbanActor, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as KanbanStore from "../store/KanbanStore.ts";
import { approvalProblem, inferGate, isNegativeOption } from "./subtasks.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };
const worker: KanbanActor = { _tag: "thread", threadId: ThreadId.make("worker") };

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
  ...["Sign off", "Yes, sign off", "Ok, sign off", "Sign-off", "Signoff", "Signed off"].map(
    (label) => ({
      task: "Merge the pair and deploy both to dev",
      label,
      reply: label,
      approved: true,
    }),
  ),
  ...[
    "Sign off later",
    "Don't sign off",
    "Sign off once CI is green",
    "Sign off after the readback",
    "Confirm",
    "Accept",
    "Ship it",
  ].map((label) => ({
    task: "Merge the pair and deploy both to dev",
    label,
    reply: label,
    approved: false,
  })),
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
          { question: `${task} (s1)?`, blocking: false, options: [label, "No"] },
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
  { task: "Provide the API key", neutral: "Check the key", approve: "Provide the API key" },
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

it.effect("#3917: a Sign off decision after a dropped draft allows verification", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const store = yield* KanbanStore.KanbanStore;
      const card = yield* kanban.createCard(
        board.id,
        { title: "Pair merge", prompt: "Work" },
        owner,
      );
      const draft = { text: "Ready to merge.", format: "markdown" as const };
      const ask = {
        text: "Approve the dev deploy draft?",
        blocking: false,
        by: evaluator,
        at: "2026-11-11T00:00:00.000Z",
        seq: null,
        closedAt: "2026-11-12T09:27:00.000Z",
      };
      const subtask = {
        id: "s4",
        step: 4,
        text: "Pair merge: merge bf#258 first, then bc#546, and dev-deploy both",
        owner: "evaluator" as const,
        state: "done" as const,
        note: null,
        doneBy: evaluator,
        doneAt: "2026-11-12T10:00:00.000Z",
      };
      const legacy: KanbanCard = {
        ...card,
        number: 3917,
        createdAt: "2026-11-11T00:00:00.000Z",
        stage: "deployed",
        subtasks: [subtask],
        subtaskSeq: 4,
        asks: [
          {
            ...ask,
            id: "q1",
            draft,
            answer: { verdict: "approved", by: owner, at: "2026-11-12T09:26:00.000Z" },
          },
          {
            ...ask,
            id: "q2",
            draft,
            answer: { verdict: "dropped", by: evaluator, at: "2026-11-12T09:27:00.000Z" },
          },
          {
            ...ask,
            id: "q3",
            text: "Merge the pair?",
            kind: "action",
            title: "Pair merge",
            // oxlint-disable-next-line unicorn/no-thenable -- The action contract's string field must not count as gate approval.
            action: { summary: "Merge bf#258 and bc#546", then: "Dev deploy both" },
            closedAt: "2026-11-12T09:29:00.000Z",
            answer: { verdict: "approved", by: owner, at: "2026-11-12T09:29:00.000Z" },
          },
        ],
      };
      assert.include(approvalProblem(legacy, subtask)!, "the latest decision, q2, was dropped");
      const signedOff: KanbanCard = {
        ...legacy,
        asks: [
          ...legacy.asks,
          {
            ...ask,
            id: "q4",
            kind: "decision",
            text: "Will you sign off the merge and dev deploy of backoffice-frontend#258 and backoffice-core#546 so card #3917 can be marked verified?",
            at: "2026-11-13T14:00:00.000Z",
            options: [
              {
                id: "o1",
                label: "Sign off",
                detail: "Counts as the s4 approval.",
                recommended: true,
              },
              { id: "o2", label: "Leave it" },
            ],
            closedAt: "2026-11-13T14:08:00.000Z",
            answer: {
              verdict: "picked",
              optionIds: ["o1"],
              by: owner,
              at: "2026-11-13T14:08:00.000Z",
            },
          },
        ],
      };
      assert.isNull(approvalProblem(signedOff, subtask));
      yield* store.putCard(signedOff);
      assert.strictEqual(
        (yield* kanban.moveCard(card.id, "verified", "evaluator", evaluator)).stage,
        "verified",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a missing decision names the gate and the subtask's time bound", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        { title: "No answer", prompt: "Work", subtasks: [{ text: "Deploy", owner: "evaluator" }] },
        owner,
      );
      const refused = yield* kanban
        .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.strictEqual(
        refused.detail,
        `card #${card.number} subtask s1 (deploy: Deploy) needs Abdullah's approval: no owner answer on a deploy ask since ${card.subtasks[0]!.createdAt}; name the subtask id (e.g. s7) in the ask or set approves: [s1] on the go option`,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([
  { verdict: "rejected", suffix: "was rejected" },
  {
    verdict: "picked",
    suffix:
      'picked "Show status, Leave it", which doesn\'t read as approving deploy; ask again with an Approve option or an action ask',
  },
])("the refusal names the deciding ask for $verdict", ({ verdict, suffix }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        { title: "Refusal", prompt: "Work", subtasks: [{ text: "Deploy", owner: "evaluator" }] },
        owner,
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Deploy?", blocking: false },
        evaluator,
        "evaluator",
      );
      yield* kanban.changeAsk(card.id, "q1", "drop", evaluator, "evaluator");
      yield* TestClock.adjust("1 second");
      yield* kanban.askOwner(
        card.id,
        {
          question: "Deploy?",
          blocking: false,
          ...(verdict === "picked"
            ? { multi: true, options: ["Show status", "Leave it"] }
            : { action: { summary: "Deploy" } }),
        },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(
        card.id,
        "q2",
        { verdict, ...(verdict === "picked" ? { optionIds: ["o1", "o2"] } : {}), revision: 0 },
        owner,
      );
      const refused = yield* kanban
        .markSubtask(card.id, "s1", "done", null, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.strictEqual(
        refused.detail,
        `card #${card.number} subtask s1 (deploy: Deploy) needs Abdullah's approval: the latest decision, q2, ${suffix}`,
      );
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
          assert.strictEqual(
            refused.detail,
            `card #${card.number} subtask s1 (deploy: Restart LaunchAgent) needs Abdullah's approval: the latest decision, q1, was dropped (a dropped ask is not approval)`,
          );
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
  ["secret", undefined],
  ["token", undefined],
  ["key", undefined],
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

const approvalAt = "2026-11-13T10:00:00.000Z";
const decisionAt = "2026-11-13T15:13:16.000Z";
const laterDecisionAt = "2026-11-13T16:17:14.000Z";
const gatedStep = (id: string, text = "Install the skill") => ({
  id,
  text,
  step: 1,
  owner: "evaluator" as const,
  state: "open" as const,
  note: null,
  doneBy: null,
  doneAt: null,
});
const pickedAsk = (text: string, approves?: ReadonlyArray<string>): KanbanCard["asks"][number] => ({
  id: "q5",
  text,
  kind: "change",
  by: evaluator,
  at: approvalAt,
  blocking: true,
  seq: null,
  changes: [{ label: "Rule", before: "Old", after: "New", format: "markdown" }],
  options: [
    {
      id: "o1",
      label: "Add just these lines to the live skill now",
      ...(approves === undefined ? {} : { approves }),
    },
    { id: "o2", label: "Wait for #73, then run install.zsh" },
    { id: "o3", label: "Change the wording" },
    { id: "o4", label: "Drop it" },
  ],
  closedAt: decisionAt,
  answer: { verdict: "picked", optionIds: ["o1"], by: owner, at: decisionAt },
});
const approvalCard = (
  subtasks: KanbanCard["subtasks"],
  asks: KanbanCard["asks"],
): Pick<KanbanCard, "number" | "subtasks" | "asks" | "createdAt"> => ({
  number: 83,
  createdAt: approvalAt,
  subtasks,
  asks,
});

it.each([true, false])("Agent Tools #83 q4/q5/s9: explicit approval %s", (explicit) => {
  const s9 = gatedStep(
    "s9",
    "Ask owner (card_ask, before/after) to approve the skill wording change and running integrations/run-cloud/install.zsh; install after OK",
  );
  const q4: KanbanCard["asks"][number] = {
    ...pickedAsk("Approve one final Android session capped at 7 minutes/$0.14"),
    id: "q4",
    kind: "action",
    action: { summary: "Purchase one Android session" },
    closedAt: "2026-11-13T12:01:29.000Z",
    answer: { verdict: "dropped", by: worker, at: "2026-11-13T12:01:29.000Z" },
  };
  const q5 = pickedAsk(
    "The Android typing warning is merged into the fork. How should it reach the live Run Cloud skill?",
    explicit ? ["s9"] : undefined,
  );
  const result = approvalProblem(approvalCard([s9], [q4, q5]), s9);
  if (explicit) assert.isNull(result);
  else {
    assert.include(result!, "no owner answer on a deploy ask");
    assert.include(result!, "or set approves: [s9] on the go option");
    assert.notInclude(result!, "q4");
  }
});

it.each([true, false])("Dia #18 q1/s4: explicit approval %s", (explicit) => {
  const s4 = gatedStep(
    "s4",
    "After his yes: re-read main, replay onto it if it moved (compare HEAD^{tree} with the tested head or re-run offbox full suite), move main with update-ref <new> <expected-old> per wiki dia-bridge-source-and-go-live. No new dependency expected; if there is one, install it in live node_modules first.",
  );
  const q1 = {
    ...pickedAsk(
      "Put the outside-navigation guard live in the Dia bridge (move main to the reviewed branch), with the tool wording below?",
    ),
    id: "q1",
    title: "#18 go-live: Dia bridge stops before acting on a tab someone else navigated",
    batchKey: "dia-go-live",
    options: [
      { id: "o1", label: "Approve", recommended: true, ...(explicit ? { approves: ["s4"] } : {}) },
      { id: "o2", label: "Change" },
      { id: "o3", label: "Drop" },
    ],
  };
  const done = (id: string, text: string) => ({ ...gatedStep(id, text), state: "done" as const });
  const result = approvalProblem(
    approvalCard(
      [
        done(
          "s3",
          "Ask Abdullah for go-live (card_ask, blocking, options Approve / Change / Drop) with the exact before/after tool description text (dia_tab_focus, the new acknowledgeNavigation param) and what changes for agents. Batch with other pending Dia go-lives if one is open (batchKey dia-go-live).",
        ),
        s4,
        done(
          "s5",
          "Read-back on a fresh bridge process: own Personal agent window at example.com; dia_navigate + dia_page_state show no flag; navigate the target from a separate raw CDP websocket (scratch script in mktemp -d) to https://example.com/?outside; next dia_evaluate returns actionPerformed:false with navigatedOutsideSession; repeat with acknowledgeNavigation runs. Close the window. Then update the wiki page.",
        ),
      ],
      [q1],
    ),
    s4,
  );
  if (explicit) assert.isNull(result);
  else assert.include(result!, "or set approves: [s4] on the go option");
});

it.each([owner, worker, evaluator])(
  "only a matching drop by $_tag blocks an earlier approval",
  (by) => {
    const s9 = gatedStep("s9");
    const approved = pickedAsk("Install s9?", ["s9"]);
    const dropped = (
      text: string,
      approves?: ReadonlyArray<string>,
    ): KanbanCard["asks"][number] => ({
      ...pickedAsk(text, approves),
      id: "q6",
      closedAt: laterDecisionAt,
      answer: { verdict: "dropped", by, at: laterDecisionAt },
    });
    for (const drop of [dropped("Install s9?"), dropped("Put it live?", ["s9"])]) {
      assert.include(approvalProblem(approvalCard([s9], [approved, drop]), s9)!, "q6, was dropped");
    }
    assert.isNull(
      approvalProblem(approvalCard([s9], [approved, dropped("Purchase a session?")]), s9),
    );
  },
);

it("an explicit list replaces wording matching and needs a single picked option", () => {
  const s7 = gatedStep("s7");
  const s9 = gatedStep("s9");
  const ask = pickedAsk("Install s9?", ["s7"]);
  const card = approvalCard([s7, s9], [ask]);
  assert.isNull(approvalProblem(card, s7));
  assert.include(approvalProblem(card, s9)!, "no owner answer");
  const multi = { ...ask, answer: { ...ask.answer!, optionIds: ["o1", "o3"] } };
  assert.isNotNull(approvalProblem({ ...card, asks: [multi] }, s7));
  const other = { ...ask, answer: { ...ask.answer!, optionIds: ["o3"] } };
  assert.isNotNull(approvalProblem({ ...card, asks: [other] }, s9));
  const empty = pickedAsk("Install s9?", []);
  assert.isNotNull(approvalProblem({ ...card, asks: [empty] }, s9));
});

it("explicit approval obeys owner, draft, timestamps and later matched decisions", () => {
  const s9 = { ...gatedStep("s9"), createdAt: decisionAt };
  const ask = { ...pickedAsk("Put it live?", ["s9"]), at: decisionAt };
  const check = (candidate: KanbanCard["asks"][number]) =>
    approvalProblem(approvalCard([s9], [candidate]), s9);
  assert.isNull(check(ask));
  for (const candidate of [
    { ...ask, answer: { ...ask.answer!, by: evaluator } },
    { ...ask, draft: { text: "The text to send", format: "markdown" as const } },
    { ...ask, at: approvalAt },
    { ...ask, answer: { ...ask.answer!, at: approvalAt } },
  ])
    assert.isNotNull(check(candidate));
  assert.isNull(check({ ...ask, at: approvalAt, revisedAt: decisionAt }));
  const later = {
    ...pickedAsk("Install s9?"),
    id: "q6",
    at: laterDecisionAt,
    closedAt: laterDecisionAt,
    answer: { verdict: "rejected" as const, by: owner, at: laterDecisionAt },
  };
  assert.isNotNull(approvalProblem(approvalCard([s9], [later, ask]), s9));
});

it.effect("ask create and revise validate approval ids before saving", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Scoped go",
          prompt: "Work",
          subtasks: [{ text: "Install the skill", owner: "evaluator" }],
        },
        owner,
      );
      const unknown = { label: "Approve", approves: ["s99"] };
      const refused = yield* kanban
        .askOwner(
          card.id,
          {
            question: "Put it live?",
            blocking: false,
            options: [unknown, "Change"],
          },
          evaluator,
          "evaluator",
        )
        .pipe(Effect.flip);
      assert.include(
        refused.detail,
        `option o1 approves s99, which isn't a subtask on card #${card.number}`,
      );
      assert.lengthOf((yield* kanban.card(card.id)).card.asks, 0);
      yield* kanban.askOwner(
        card.id,
        {
          question: "Put it live?",
          blocking: false,
          options: [{ label: "Approve", approves: ["s1"] }, "Change"],
        },
        evaluator,
        "evaluator",
      );
      const edit = yield* kanban
        .editAsk(card.id, "q1", { options: [unknown, "Change"] }, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(edit.detail, "approves s99");
      yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "picked", optionIds: ["o1"], revision: 0 },
        owner,
      );
      const done = yield* kanban.markSubtask(
        card.id,
        "s1",
        "done",
        "Explicit approval",
        evaluator,
        "evaluator",
      );
      assert.strictEqual(done.subtasks[0]?.state, "done");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.each(["Deploy the skill", "Purchase a session", "Share the API key"])(
  "explicit options also clear the gate for %s",
  (text) => {
    for (const owner of ["evaluator", "script"] as const) {
      const subtask = { ...gatedStep("s7", text), owner };
      const ask = pickedAsk("Put it live?", ["s7"]);
      assert.isNull(approvalProblem(approvalCard([subtask], [ask]), subtask));
    }
  },
);

it.each(["none", "text", "title"] as const)(
  "Agent Tools #83 q7/s9: subtask id in %s after unrelated q4 drop",
  (namedIn) => {
    const s9 = gatedStep(
      "s9",
      "Ask owner (card_ask, before/after) to approve the skill wording change and running integrations/run-cloud/install.zsh; install after OK",
    );
    const q4: KanbanCard["asks"][number] = {
      id: "q4",
      kind: "action",
      text: "Approve one final Android session capped at 7 minutes/$0.14?",
      action: { summary: "Purchase one Android session" },
      by: worker,
      at: approvalAt,
      blocking: false,
      seq: null,
      closedAt: "2026-11-13T12:01:29.000Z",
      answer: { verdict: "dropped", by: worker, at: "2026-11-13T12:01:29.000Z" },
    };
    const answeredAt = "2026-11-13T17:35:11.000Z";
    const q7: KanbanCard["asks"][number] = {
      id: "q7",
      kind: "action",
      by: evaluator,
      at: decisionAt,
      blocking: true,
      seq: null,
      title: `#83: one tap to close the card (your q5 pick is already done)${namedIn === "title" ? " s9" : ""}`,
      text: `Approve the live-skill edit you picked in q5? It's already in place, and the board needs a yes/no to close the card.${namedIn === "text" ? " s9" : ""}`,
      action: {
        summary:
          "Keep the two approved additions in the live run-cloud SKILL.md (already applied, matches fork 9226b391ee).",
      },
      closedAt: answeredAt,
      answer: { verdict: "approved", by: owner, at: answeredAt },
    };
    const result = approvalProblem(approvalCard([s9], [q4, q7]), s9);
    if (namedIn !== "none") assert.isNull(result);
    else {
      assert.include(result!, "no owner answer on a deploy ask");
      assert.include(result!, "name the subtask id");
      assert.include(result!, "or set approves: [s9] on the go option");
      assert.notInclude(result!, "q4");
    }
  },
);

it.each([
  "Approve s1, s2, s3",
  "Yes, tick s1 and s2",
  "Ok, clear s1 and s2",
  "Approved s1, s2",
  "Go ahead, do s1 and s2",
])("a consent label scopes its approval: %s", (label) => {
  const s1 = gatedStep("s1");
  const s2 = gatedStep("s2");
  const s3 = gatedStep("s3");
  const s5 = gatedStep("s5");
  const ask = {
    ...pickedAsk("Install these steps?"),
    options: [
      { id: "o1", label },
      { id: "o2", label: "Drop" },
    ],
  };
  const card = approvalCard([s1, s2, s3, s5], [ask]);
  assert.isNull(approvalProblem(card, s1));
  assert.isNull(approvalProblem(card, s2));
  assert.isNotNull(approvalProblem(card, s5));
  const multi = { ...ask, answer: { ...ask.answer!, optionIds: ["o1", "o2"] } };
  assert.isNotNull(approvalProblem({ ...card, asks: [multi] }, s1));
});

it.each([
  { label: "Approve s4", approved: true },
  { label: "Yes, tick s4", approved: true },
  { label: "  Go ahead, clear s4 and s99", approved: true },
  { label: "Approve s99", approved: false },
  { label: "Approve s40", approved: false },
  { label: "Don't approve s4", approved: false },
  { label: "Wait, s4 later", approved: false },
  { label: "Approve s4 later", approved: false },
  { label: "Review s4", approved: false },
])("#1334 explicit s4 label $label: $approved", ({ label, approved }) => {
  const s4 = gatedStep("s4");
  const ask = {
    ...pickedAsk("Put the fix live?"),
    options: [
      { id: "o1", label },
      { id: "o2", label: "Drop" },
    ],
  };
  const result = approvalProblem(approvalCard([s4], [ask]), s4);
  if (approved) assert.isNull(result);
  else assert.isNotNull(result);
});

it("an approves field stays authoritative when a consent label names different ids", () => {
  const s4 = gatedStep("s4");
  const s5 = gatedStep("s5");
  const ask = {
    ...pickedAsk("Install s4?"),
    options: [{ id: "o1", label: "Approve s4", approves: ["s5"] }],
  };
  const card = approvalCard([s4, s5], [ask]);
  assert.isNotNull(approvalProblem(card, s4));
  assert.isNull(approvalProblem(card, s5));
});

it.each(["Drop", "Wait"])(
  "review regression: a newer %s pick supersedes an earlier approval",
  (label) => {
    const s4 = gatedStep("s4");
    const earlier = {
      ...pickedAsk("Install s4?"),
      id: "q1",
      options: [
        { id: "o1", label: "Approve" },
        { id: "o2", label: "Drop" },
      ],
    };
    const later = {
      ...pickedAsk("Install s4?", ["s4"]),
      id: "q2",
      options: [
        { id: "o1", label: "Approve", approves: ["s4"] },
        { id: "o2", label },
      ],
      closedAt: laterDecisionAt,
      answer: { verdict: "picked" as const, optionIds: ["o2"], by: owner, at: laterDecisionAt },
    };
    assert.isNotNull(approvalProblem(approvalCard([s4], [earlier, later]), s4));
  },
);

it.each(["Approve s4 after the review", "Yes, do not approve s4", "Approve s1, not s4"])(
  "review regression: qualified consent never grants s4: %s",
  (label) => {
    const s1 = gatedStep("s1");
    const s4 = gatedStep("s4");
    const ask = {
      ...pickedAsk("Install s4?"),
      options: [
        { id: "o1", label },
        { id: "o2", label: "Drop" },
      ],
    };
    assert.isNotNull(approvalProblem(approvalCard([s1, s4], [ask]), s4));
  },
);

it.each([
  { scopedBy: "field", go: { id: "o1", label: "Approve", approves: ["s4", "s5"] } },
  { scopedBy: "label", go: { id: "o1", label: "Approve s4 and s5" } },
])("refusals supersede all $scopedBy scopes, go choices retain their own scope", ({ go }) => {
  const s4 = gatedStep("s4");
  const s5 = gatedStep("s5");
  const s7 = gatedStep("s7");
  const earlier = pickedAsk("Put these live?", ["s4", "s5", "s7"]);
  for (const label of ["Drop", "Wait", "Change", "Don't approve", "Wait for the review"]) {
    const later = {
      ...pickedAsk("Put these live?"),
      id: "q6",
      options: [go, { id: "o2", label }],
      answer: { verdict: "picked" as const, optionIds: ["o2"], by: owner, at: laterDecisionAt },
    };
    const card = approvalCard([s4, s5, s7], [earlier, later]);
    for (const target of [s4, s5]) {
      const result = approvalProblem(card, target);
      assert.include(result!, "the latest decision, q6");
      assert.include(result!, label);
    }
    assert.isNull(approvalProblem(card, s7));
  }
  const scopedGo = {
    ...pickedAsk("Install s5 and s7?"),
    id: "q6",
    options: [go, { id: "o2", label: "Approve s7" }],
    answer: { verdict: "picked" as const, optionIds: ["o2"], by: owner, at: laterDecisionAt },
  };
  const rejected = {
    ...pickedAsk("Install s4?", ["s4"]),
    id: "q5",
    answer: { verdict: "rejected" as const, by: owner, at: decisionAt },
  };
  const card = approvalCard([s4, s5, s7], [rejected, scopedGo]);
  assert.include(approvalProblem(card, s4)!, "q5");
  assert.isNull(approvalProblem(card, s7));
});

it.each([
  "Yes, do not approve s4",
  "Yes, don't approve s4",
  "Yes, don’t approve s4",
  "Approve s1, not s4",
  "Approve s1 but not s4",
  "Approve s1 except s4",
  "Approve s1 without s4",
  "Yes, no approval for s4",
  "Yes, never approve s4",
  "Yes, we won't approve s4",
  "Yes, we can’t approve s4",
  "Yes, we cannot approve s4",
  "Approve s4 after the review",
  "Approve s4 before the review",
  "Approve s4 if reviewed",
  "Approve s4 unless review fails",
  "Approve s4 once reviewed",
  "Approve s4 when reviewed",
  "Approve s4 pending review",
  "Approve s4, first review",
  "Approve s4, then review",
  "Approve s4 later",
  "Approve s4 tomorrow",
  "Approve s4 next week",
  "Approve s4 next month",
  "Approve s1; reject s4",
  "Approve s1; hold s4",
  "Approve s1; wait for s4",
  "Approve s1, cancel s4",
  "Approve s1, skip s4",
  "Approve s1; decline s4",
  "Yes, approve s4 only if needed",
])("a qualified label cannot grant any explicit scope: %s", (label) => {
  const s1 = gatedStep("s1");
  const s4 = gatedStep("s4");
  const ask = {
    ...pickedAsk("Install s1 and s4?"),
    options: [
      { id: "o1", label },
      { id: "o2", label: "Drop" },
    ],
  };
  const card = approvalCard([s1, s4], [ask]);
  for (const target of [s1, s4]) assert.isNotNull(approvalProblem(card, target));
  const earlier = pickedAsk("Put it live?", ["s4"]);
  const later = {
    ...ask,
    id: "q6",
    options: [...ask.options, { id: "o3", label: "Approve", approves: ["s1", "s4"] }],
    answer: { ...ask.answer!, at: laterDecisionAt },
  };
  assert.include(approvalProblem(approvalCard([s1, s4], [earlier, later]), s4)!, "q6");
  for (const verdict of ["picked", "approved"] as const) {
    const signoff = {
      ...ask,
      id: "q7",
      kind: "signoff",
      answer: { verdict, optionIds: ["o1"], by: owner, at: laterDecisionAt },
    };
    const result = approvalProblem(approvalCard([s1, s4], [earlier, signoff]), s4);
    assert.include(result!, "the latest decision, q7");
  }
});

it.each(["field", "label"])("Crpko #3868 signoff approved with one %s-scoped option", (scope) => {
  const s4 = gatedStep("s4");
  const s5 = gatedStep("s5");
  const go =
    scope === "field"
      ? { id: "o1", label: "Approve", approves: ["s4"] }
      : { id: "o1", label: "Approve s4" };
  const ask: KanbanCard["asks"][number] = {
    ...pickedAsk("Sign off so the card can close this step?"),
    id: "q1",
    kind: "signoff",
    title: "Sign off: quick-setup frontend is on dev",
    options: [go, { id: "o2", label: "Change" }, { id: "o3", label: "Drop" }],
    answer: { verdict: "approved", optionIds: ["o1"], by: owner, at: decisionAt },
  };
  const card = approvalCard([s4, s5], [ask]);
  assert.isNull(approvalProblem(card, s4));
  assert.isNotNull(approvalProblem(card, s5));
  for (const optionIds of [undefined, [], ["o1", "o2"], ["o2"], ["unknown"]]) {
    const candidate = {
      ...ask,
      answer: {
        verdict: "approved" as const,
        ...(optionIds === undefined ? {} : { optionIds }),
        by: owner,
        at: laterDecisionAt,
      },
    };
    const earlier = pickedAsk("Install s4?", ["s4"]);
    const result = approvalProblem({ ...card, asks: [earlier, candidate] }, s4);
    assert.include(result!, "the latest decision, q1");
    assert.include(result!, "pick exactly one option naming s4");
  }
  for (const candidate of [
    { ...ask, answer: { ...ask.answer!, by: evaluator } },
    { ...ask, draft: { text: "Text to send", format: "markdown" as const } },
    { ...ask, answer: { ...ask.answer!, at: "2026-11-12T00:00:00.000Z" } },
  ])
    assert.isNotNull(approvalProblem({ ...card, asks: [candidate] }, s4));
});

it.effect("signoff persists approved plus optionIds and clears only the selected scope", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Signoff approval",
          prompt: "Work",
          subtasks: [{ text: "Install the skill", owner: "evaluator" }],
        },
        owner,
      );
      yield* kanban.askOwner(
        card.id,
        {
          question: "Sign off so the card can close this step?",
          kind: "signoff",
          blocking: false,
          options: [{ label: "Approve", approves: ["s1"] }, "Change", "Drop"],
        },
        evaluator,
        "evaluator",
      );
      const answered = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "approved", optionIds: ["o1"], revision: 0 },
        owner,
      );
      assert.strictEqual(answered.card.asks[0]?.answer?.verdict, "approved");
      assert.deepStrictEqual(answered.card.asks[0]?.answer?.optionIds, ["o1"]);
      const done = yield* kanban.markSubtask(
        card.id,
        "s1",
        "done",
        "Scoped signoff",
        evaluator,
        "evaluator",
      );
      assert.strictEqual(done.subtasks[0]?.state, "done");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.each([
  "Approve s1,s4",
  "Approve s1 and s4",
  "Approve s1, and s4",
  "Approve s1; s4",
  "Approve s1 / s4",
  "Approve s1 & s4",
  "Approve s1 + s4",
  "Approve s1 s4",
  "Yes, tick s1 and s4",
  "Ok: clear s1 and s4",
  "Approved s1 and s4 now!",
  "Go ahead, do s1 and s4.",
])("direct id-list consent works for picked and approved: %s", (label) => {
  const s1 = gatedStep("s1");
  const s4 = gatedStep("s4");
  const s5 = gatedStep("s5");
  for (const verdict of ["picked", "approved"] as const) {
    const ask = {
      ...pickedAsk("Put it live?"),
      options: [
        { id: "o1", label },
        { id: "o2", label: "Drop" },
      ],
      answer: { verdict, optionIds: ["o1"], by: owner, at: decisionAt },
    };
    const card = approvalCard([s1, s4, s5], [ask]);
    assert.isNull(approvalProblem(card, s1));
    assert.isNull(approvalProblem(card, s4));
    assert.isNotNull(approvalProblem(card, s5));
  }
});

it.each([
  "Don't approve s4",
  "Wait, s4 later",
  "Yes, do not approve s4",
  "Approve s4 after the review",
])("an approved answer cannot bypass a qualified selected label: %s", (label) => {
  const s4 = gatedStep("s4");
  const ask = {
    ...pickedAsk("Install s4?"),
    kind: "signoff",
    options: [
      { id: "o1", label },
      { id: "o2", label: "Change" },
    ],
    answer: { verdict: "approved" as const, optionIds: ["o1"], by: owner, at: decisionAt },
  };
  assert.isNotNull(approvalProblem(approvalCard([s4], [ask]), s4));
});
