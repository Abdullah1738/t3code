import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  KanbanScriptId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type KanbanSubtask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as KanbanStore from "../store/KanbanStore.ts";
import { approvalProblem, inferGate, isNegativeOption } from "./subtasks.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("asker") };

const goChoiceSubtask: KanbanSubtask = {
  id: "s1",
  step: 1,
  text: "Tag the edge-api main-dev tip and dev-deploy it",
  owner: "evaluator",
  gate: "deploy",
  createdAt: "2026-11-13T14:00:00.000Z",
  state: "open",
  note: null,
  doneBy: null,
  doneAt: null,
};

const goChoiceCard = (
  labels: readonly string[],
  optionIds: readonly string[] = ["o1"],
  subtask = goChoiceSubtask,
): Pick<KanbanCard, "number" | "asks" | "createdAt" | "subtasks"> => ({
  number: 3329,
  createdAt: "2026-11-13T13:00:00.000Z",
  subtasks: [subtask],
  asks: [
    {
      id: "q1",
      kind: "decision",
      text: `For ${subtask.id}, should I tag and deploy the edge-api bundle now, or wait for #4280?`,
      blocking: false,
      by: evaluator,
      at: "2026-11-13T14:01:00.000Z",
      seq: null,
      options: labels.map((label, index) => ({
        id: `o${index + 1}`,
        label,
        recommended: index === 0,
      })),
      closedAt: "2026-11-13T14:08:11.000Z",
      answer: {
        verdict: "picked",
        optionIds: [...optionIds],
        by: owner,
        at: "2026-11-13T14:08:11.000Z",
      },
    },
  ],
});

it.each([
  ...[
    "Tag and deploy now",
    "Merge and deploy",
    "Deploy edge-api now",
    "Yes, tag and release it",
    "Cut the tag and release",
    "Please install edge-api",
    "Go ahead and restart edge-api",
    "Ship edge-api",
    "Approve deployment of edge-api",
  ].map((label) => ({ label, approved: true })),
  ...[
    "Tag and deploy after CI",
    "Deploy only the docs change",
    "Tag and deploy without the read-backs",
    "Prepare the deploy",
    "Wait for #4280",
    "Tag it",
    "Redeploy edge-api",
    ...["if", "unless", "before", "once", "when", "pending", "first", "then"].map(
      (word) => `Tag and deploy ${word} CI passes`,
    ),
    ...[
      "not",
      "no",
      "except",
      "instead",
      "partial",
      "dry-run",
      "dry run",
      "draft",
      "plan",
      "preview",
    ].map((word) => `Tag and deploy ${word} changes`),
  ].map((label) => ({ label, approved: false })),
])("go/hold deploy pick: $label approves=$approved", ({ label, approved }) => {
  const problem = approvalProblem(goChoiceCard([label, "Wait for #4280"]), goChoiceSubtask);
  assert.strictEqual(problem === null, approved);
});

it.each([
  { others: ["Deploy tonight"] },
  { others: ["Tag and deploy production", "Release edge-api"] },
  { others: [] },
])("a new approval path needs a hold option: $others", ({ others }) => {
  // This label also fails the existing paths: it starts with "Tag" and isn't the task text.
  const card = goChoiceCard(["Tag and deploy now", ...others]);
  assert.include(approvalProblem(card, goChoiceSubtask)!, "approval");
});

it.each(["Don't deploy", "Show status"])("a hold can be %s", (hold) => {
  assert.isNull(approvalProblem(goChoiceCard(["Tag and deploy now", hold]), goChoiceSubtask));
});

it.each([
  { label: "Buy it on the 9546 card", approved: true },
  { label: "Buy only one", approved: false },
  { label: "Pay the vendor", approved: true },
  { label: "Purchase the license now", approved: true },
  { label: "Charge the saved card", approved: true },
  { label: "Refund the invoice", approved: true },
  { label: "Transfer the balance", approved: true },
])("go/hold money pick: $label approves=$approved", ({ label, approved }) => {
  const subtask = { ...goChoiceSubtask, text: "Purchase the license", gate: "money" as const };
  assert.strictEqual(
    approvalProblem(goChoiceCard([label, "Leave it"], ["o1"], subtask), subtask) === null,
    approved,
  );
});

it.each(
  [
    {
      subtask: goChoiceSubtask,
      lead: "Build the bundle",
      verbs: ["deploy", "release", "install", "restart", "ship"],
      hold: "Wait for #4280",
    },
    {
      subtask: { ...goChoiceSubtask, text: "Purchase the license", gate: "money" as const },
      lead: "Check prices",
      verbs: ["pay", "purchase", "buy", "charge", "refund", "transfer"],
      hold: "Leave it",
    },
  ].flatMap(({ verbs, ...fixture }) =>
    verbs.flatMap((verb) =>
      [
        "don't",
        "don’t",
        "dont",
        "DON'T",
        "do not",
        "never",
        "cannot",
        "can't",
        "can’t",
        "won't",
        "won’t",
        "shouldn't",
        "shouldn’t",
        "must not",
      ].map((negation) => ({ ...fixture, label: `${fixture.lead}, ${negation} ${verb} it` })),
    ),
  ),
)("a negated go/hold label cannot approve: $label", ({ subtask, label, hold }) => {
  const card = goChoiceCard([label, hold], ["o1"], subtask);
  assert.include(approvalProblem(card, subtask)!, "approval");
});

it("secret picks keep the strict approval path even with a hold", () => {
  const subtask = { ...goChoiceSubtask, text: "Share the token", gate: "secret" as const };
  const card = goChoiceCard(["Share the key with the worker", "Don't"], ["o1"], subtask);
  assert.include(approvalProblem(card, subtask)!, "approval");
});

it("#3329: the owner's q1 go pick approves the evaluator's dev-deploy step", () => {
  const subtask = { ...goChoiceSubtask, text: "Tag the main-dev tip and dev-deploy it" };
  const card = goChoiceCard(["Tag and deploy now", "Wait for #4280"], ["o1"], subtask);
  assert.isNull(approvalProblem(card, subtask));
});

it.each([
  { labels: ["Tag and deploy now", "Merge and deploy", "Wait for #4280"], approved: false },
  { labels: ["Tag and deploy now", "Approve", "Wait for #4280"], approved: false },
  { labels: ["Deploy now", "Approve", "Wait for #4280"], approved: true },
])("multi-picks keep existing approval paths: $labels", ({ labels, approved }) => {
  const card = goChoiceCard(labels, ["o1", "o2"]);
  assert.strictEqual(approvalProblem(card, goChoiceSubtask) === null, approved);
});

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
          // The alternate action supplies no hold without also matching a bare "go" reply.
          { question: `${task} (s1)?`, blocking: false, options: [label, `Alternate ${task}`] },
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
        `card #${card.number} subtask s1 (deploy: Deploy) needs Abdullah's approval: no owner answer on a deploy ask since ${card.subtasks[0]!.createdAt}; name the subtask id (e.g. s7) in the ask`,
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

it.effect.each([owner, evaluator])("$_tag clears guessed gates with an audit trail", (actor) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Clear guessed gate",
          prompt: "Work",
          subtasks: [{ text: "Tell the reporter once installed", owner: "evaluator" }],
        },
        owner,
      );
      const reason = "Only reports the result; no live operation";
      const edited = yield* kanban.editCard(
        card.id,
        { subtasks: [{ id: "s1", clearGate: reason }] },
        actor,
      );
      assert.isUndefined(edited.subtasks[0]!.gate);
      assert.deepStrictEqual(edited.subtasks[0]!.gateCleared?.by, actor);
      const events = (yield* kanban.card(card.id)).events;
      assert.lengthOf(
        events.filter(
          (event) =>
            event.body ===
            `Cleared guessed deploy gate on s1 ("Tell the reporter once installed"): ${reason}`,
        ),
        1,
      );
      assert.lengthOf(edited.asks, actor._tag === "owner" ? 0 : 1);
      if (actor._tag === "evaluator") {
        assert.deepStrictEqual(edited.asks[0], {
          id: "q1",
          text: `An evaluator cleared the deploy gate the board guessed on s1: "Tell the reporter once installed". Reason: ${reason}.`,
          blocking: false,
          by: actor,
          at: edited.updatedAt,
          seq: null,
          closedAt: null,
          kind: "notice",
          respond: { ack: true },
          title: `Gate cleared on #${card.number} s1`,
          batchKey: "gate-cleared",
        });
        const feed = yield* kanban.askFeed({ boardId: board.id });
        assert.isTrue(
          feed.open.some(
            (item) => item.cardId === card.id && item.ask.id === "q1" && item.kind === "notice",
          ),
        );
      }
      // Retrying the clear must not send a second notice or append another clear event.
      const retry = yield* kanban.editCard(
        card.id,
        { subtasks: [{ id: "s1", clearGate: reason }] },
        actor,
      );
      assert.lengthOf(retry.asks, edited.asks.length);
      const dropped = yield* kanban.editCard(card.id, { subtasks: [] }, evaluator);
      assert.lengthOf(dropped.subtasks, 0);
      // Exercise completion independently of removal on the same saved clear.
      yield* KanbanStore.KanbanStore.pipe(Effect.flatMap((store) => store.putCard(edited)));
      const done = yield* kanban.markSubtask(
        card.id,
        "s1",
        "done",
        "Reporter told",
        evaluator,
        "evaluator",
      );
      assert.strictEqual(done.subtasks[0]!.state, "done");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "legacy clears name the missing origin, and acknowledgements cannot approve a later gate",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const store = yield* KanbanStore.KanbanStore;
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Legacy",
            prompt: "Work",
            subtasks: [{ text: "Read the card and tell the 9router threads", owner: "evaluator" }],
          },
          owner,
        );
        yield* store.putCard({
          ...card,
          subtasks: card.subtasks.map((s) => ({ ...s, gate: "deploy" })),
        });
        const cleared = yield* kanban.editCard(
          card.id,
          { subtasks: [{ id: "s1", clearGate: "A report to threads, nothing goes live" }] },
          evaluator,
        );
        assert.include(cleared.asks[0]!.text, "(origin not recorded: an older gate)");
        yield* TestClock.adjust("1 second");
        const regated = yield* kanban.editCard(
          card.id,
          { subtasks: [{ id: "s1", text: "Restart Robob now" }] },
          evaluator,
        );
        const ack = {
          ...regated.asks[0]!,
          closedAt: regated.updatedAt,
          at: regated.updatedAt,
          answer: { verdict: "approved" as const, by: owner, at: regated.updatedAt },
        };
        for (const ask of [ack, { ...ack, kind: "custom" }, { ...ack, respond: undefined }]) {
          assert.include(
            approvalProblem({ ...regated, asks: [ask] }, regated.subtasks[0]!)!,
            "no owner answer",
          );
        }
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("deliberate deploy, money and secret gates cannot be cleared or bypassed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      for (const gate of ["deploy", "money", "secret"] as const) {
        const card = yield* kanban.createCard(
          board.id,
          {
            title: `Deliberate ${gate}`,
            prompt: "Work",
            subtasks: [{ text: "Do the operation", owner: "evaluator", gate }],
          },
          owner,
        );
        for (const patch of [
          { subtasks: [{ id: "s1", clearGate: "This gate was set by mistake" }] },
          { subtasks: [{ id: "s1", text: "Read result", gate: null }] },
          {
            subtasks: [
              { id: "s1", owner: "work" as const, clearGate: "Give it back to the worker" },
            ],
          },
          { subtasks: [] },
        ]) {
          const result = yield* kanban.editCard(card.id, patch, evaluator).pipe(Effect.result);
          // Rewording keeps the deliberate gate; removing it needs an owner answer.
          if (patch.subtasks[0] && "text" in patch.subtasks[0]) {
            assert.strictEqual(result._tag, "Success");
            if (result._tag === "Success")
              assert.strictEqual(result.success.subtasks[0]!.gate, gate);
          } else {
            assert.strictEqual(result._tag, "Failure");
          }
        }
        const saved = (yield* kanban.card(card.id)).card;
        assert.lengthOf(saved.asks, 0);
        assert.strictEqual(saved.subtasks[0]!.gateSource, "set");
        const before = yield* kanban.card(card.id);
        for (const actor of [evaluator, owner]) {
          const denied = yield* kanban
            .editCard(
              card.id,
              { subtasks: [{ id: "s1", clearGate: "This gate was set by mistake" }] },
              actor,
            )
            .pipe(Effect.flip);
          assert.strictEqual(denied.code, "denied");
          assert.include(denied.detail, "only Abdullah's answer clears it (card_ask naming s1)");
          assert.deepStrictEqual(yield* kanban.card(card.id), before);
        }
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("work, script and system actors cannot pass clearGate", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Actor guard",
          prompt: "Work",
          subtasks: [{ text: "Restart Robob", owner: "evaluator" }],
        },
        owner,
      );
      for (const actor of [
        { _tag: "thread", threadId: ThreadId.make("work") },
        { _tag: "script", scriptId: KanbanScriptId.make("script") },
        { _tag: "system", component: "test" },
      ] as const) {
        const denied = yield* kanban
          .editCard(
            card.id,
            { subtasks: [{ id: "s1", clearGate: "This gate was guessed wrong" }] },
            actor,
          )
          .pipe(Effect.flip);
        assert.strictEqual(denied.code, "denied");
        assert.strictEqual(denied.detail, "only the board evaluator can clear a guessed gate");
        assert.deepStrictEqual((yield* kanban.card(card.id)).card, card);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a rejected model edit leaves no clear event or notice, including retries", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const other = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opus/gpt-6-astra",
        options: [{ id: "variant", value: "xhigh" }],
      };
      yield* kanban.setPool(board.id, other, 1);
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Rejected clear",
          prompt: "Work",
          subtasks: [{ text: "Tell the reporter once installed", owner: "evaluator" }],
        },
        owner,
      );
      const before = yield* kanban.card(card.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = yield* kanban
          .editCard(
            card.id,
            {
              model: other,
              models: [{ model: card.model, weight: 1 }],
              subtasks: [{ id: "s1", clearGate: "Only reports the result; no live operation" }],
            },
            evaluator,
          )
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "invalid");
        assert.include(refused.detail, "different work model");
        assert.deepStrictEqual(yield* kanban.card(card.id), before);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "Crpko #3329 dev rollout follows board guesses while stored deploy gates stay enforced",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const text = "Tag the main-dev tip and dev-deploy it";
        const legacy = yield* kanban.createCard(
          board.id,
          {
            prompt: "Legacy rollout",
            subtasks: [{ text, owner: "evaluator" }],
          },
          owner,
        );
        assert.strictEqual(legacy.subtasks[0]!.gate, "deploy");
        yield* kanban.updateBoard(board.id, { guessedGates: ["money", "secret"] });
        const card = yield* kanban.createCard(
          board.id,
          {
            prompt: "Crpko #3329 rollout",
            subtasks: [{ text, owner: "evaluator" }],
          },
          owner,
        );
        assert.isUndefined(card.subtasks[0]!.gate);
        const done = yield* kanban.markSubtask(
          card.id,
          "s1",
          "done",
          "Dev rollout complete",
          evaluator,
          "evaluator",
        );
        assert.strictEqual(done.subtasks[0]!.state, "done");
        const edited = yield* kanban.createCard(board.id, { prompt: "Edited rollout" }, owner);
        const planned = yield* kanban.editCard(
          edited.id,
          {
            subtasks: [{ text, owner: "evaluator" }],
          },
          evaluator,
        );
        assert.isUndefined(planned.subtasks[0]!.gate);
        yield* kanban.markSubtask(
          edited.id,
          "s1",
          "done",
          "Dev rollout complete",
          evaluator,
          "evaluator",
        );
        for (const input of [
          { text, owner: "evaluator", gate: "deploy" },
          { text: "Pay the invoice", owner: "evaluator" },
        ] as const) {
          const gated = yield* kanban.createCard(
            board.id,
            { prompt: input.text, subtasks: [input] },
            owner,
          );
          const result = yield* Effect.result(
            kanban.markSubtask(gated.id, "s1", "done", "Done", evaluator, "evaluator"),
          );
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.include(result.failure.detail, "needs Abdullah's approval");
        }
        const old = yield* Effect.result(
          kanban.markSubtask(legacy.id, "s1", "done", "Done", evaluator, "evaluator"),
        );
        assert.strictEqual(old._tag, "Failure");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
