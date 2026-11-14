import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  KanbanScriptId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type KanbanOwnerAsk,
  type KanbanSubtask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as KanbanStore from "../store/KanbanStore.ts";
import {
  approvalProblem,
  approvesGate,
  askGateWarning,
  inferGate,
  isNegativeOption,
  secretKindApprovalWarning,
} from "./subtasks.ts";
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

it("#1431 q3: an approval naming s7 and s8 reads as approving deploy", () => {
  assert.isTrue(
    approvesGate("Approve s7 and s8", "deploy", "Add the fix to the release", ["Hold"], "subtask"),
  );
});

const referencedSubtasks: KanbanSubtask[] = [
  { ...goChoiceSubtask, id: "s7", text: "Add the fix to the release" },
  { ...goChoiceSubtask, id: "s8", text: "Check the installed version and report the result" },
];

const referencedChoiceCard = (
  labels: readonly string[],
  optionIds: readonly string[] = ["o1"],
  subtasks = referencedSubtasks,
) => {
  const card = goChoiceCard(labels, optionIds, subtasks[0]!);
  return {
    ...card,
    number: 1431,
    subtasks,
    asks: card.asks.map((ask) => ({ ...ask, id: "q3", text: "Approve s7 and s8?" })),
  };
};

it.each(
  ["Approve", "Go", "Ship", "Yes"].flatMap((verb) =>
    ["s7 and s8", "s7, s8", "s7 + s8", "s7, and s8", "s7, s8 and s9", "S7 AND S8", ", s7 + s8"].map(
      (ids) => `${verb} ${ids}`,
    ),
  ),
)("an explicit approval clears both referenced deploy steps: %s", (label) => {
  const card = referencedChoiceCard([label, "Hold"]);
  for (const subtask of card.subtasks) assert.isNull(approvalProblem(card, subtask));
});

it.each([
  "Approve s7",
  "Go s7",
  "Ship s7",
  "Yes s7",
  "Approve s7 and s80",
  "Yes, s7",
  "Approve: s7",
  "Ship—s7",
  "Go s7!",
])("%s cannot clear s8 even when the question names both steps", (label) => {
  const card = referencedChoiceCard([label, "Hold"]);
  assert.isNull(approvalProblem(card, card.subtasks[0]!));
  assert.isNotNull(approvalProblem(card, card.subtasks[1]!));
});

it.each(["Approve", "Go", "Ship", "Yes"])(
  "%s accepts a subtask's exact step with or without its id",
  (verb) => {
    const subtask = referencedSubtasks[0]!;
    for (const label of [`${verb} ${subtask.text}`, `${verb} s7: ${subtask.text}`]) {
      assert.isNull(approvalProblem(referencedChoiceCard([label, "Hold"]), subtask));
    }
  },
);

it.each([
  "Don't approve s7 and s8",
  "Hold",
  "Skip deploy",
  "Approve later",
  "Approve s7 later",
  "Approve s7 and hold s8",
  "Go s7, wait s8",
  "Ship s7 + skip s8",
  "Yes s7 and s8 if CI passes",
  "Approve s7: A different step",
  "Approve s7 s8",
  "Approve s7 or s8",
  "Approve s7 +",
  "Approve s7,",
])("a refused or ambiguous referenced label stays refused: %s", (label) => {
  const card = referencedChoiceCard([label, "Hold"]);
  for (const subtask of card.subtasks) assert.isNotNull(approvalProblem(card, subtask));
});

it.each(["Hold", "Skip deploy", "Approve later", "Don't approve"])(
  "a referenced approval picked together with %s stays refused",
  (negative) => {
    const card = referencedChoiceCard(["Approve s7 and s8", negative], ["o1", "o2"]);
    for (const subtask of card.subtasks) assert.isNotNull(approvalProblem(card, subtask));
  },
);

it.each(["don't", "do not", "never", "hold", "skip", "wait", "stop", "cancel"])(
  "an id label cannot hide %s in an exact step",
  (negative) => {
    const subtask = {
      ...referencedSubtasks[0]!,
      text: `Deploy the build and ${negative} the restart`,
    };
    const card = goChoiceCard([`Approve s7: ${subtask.text}`, "Hold"], ["o1"], subtask);
    assert.isNotNull(approvalProblem(card, subtask));
  },
);

it("multiple approving picks clear only their referenced steps", () => {
  const card = referencedChoiceCard(["Approve s7", "Approve s8", "Hold"], ["o1", "o2"]);
  for (const subtask of card.subtasks) assert.isNull(approvalProblem(card, subtask));
});

it.each(["Approve", "Go", "Ship", "Yes"])(
  "%s scopes ids only from the leading list, never from the step description",
  (verb) => {
    const text = "Deploy the build produced by s7 for s8";
    const subtasks = referencedSubtasks.map((subtask) => ({ ...subtask, text }));
    const card = referencedChoiceCard([`${verb} s7: ${text}`, "Hold"], ["o1"], subtasks);
    assert.isNull(approvalProblem(card, subtasks[0]!));
    assert.isNotNull(approvalProblem(card, subtasks[1]!));
  },
);

it.each(["Approve", "Go", "Ship", "Yes"])(
  "%s accepts exact step text containing another subtask's id",
  (verb) => {
    const subtask = { ...referencedSubtasks[1]!, text: "Deploy the build produced by s7" };
    const card = referencedChoiceCard([`${verb} ${subtask.text}`, "Hold"], ["o1"], [subtask]);
    assert.isNull(approvalProblem(card, subtask));
  },
);

it.each(["Approve", "Go", "Ship", "Yes"])("%s cannot use the text of s8 to approve s7", (verb) => {
  const subtasks = [
    referencedSubtasks[0]!,
    { ...referencedSubtasks[1]!, text: "Deploy the build for s8" },
  ];
  const card = referencedChoiceCard([`${verb} s7: ${subtasks[1]!.text}`, "Hold"], ["o1"], subtasks);
  for (const subtask of subtasks) assert.isNotNull(approvalProblem(card, subtask));
});

it.each(["Approve", "Go", "Ship", "Yes"])(
  "%s validates multiple full-step picks against their own named tasks",
  (verb) => {
    const labels = referencedSubtasks.map((subtask) => `${verb} ${subtask.id}: ${subtask.text}`);
    const card = referencedChoiceCard([...labels, "Hold"], ["o1", "o2"]);
    for (const subtask of card.subtasks) assert.isNull(approvalProblem(card, subtask));
    const mixed = referencedChoiceCard([...labels, "Hold"], ["o1", "o2", "o3"]);
    for (const subtask of mixed.subtasks) assert.isNotNull(approvalProblem(mixed, subtask));
  },
);

it("an id approval does not become a standing approval", () => {
  assert.isFalse(approvesGate("Approve s7 and s8", "deploy", "Deploy the fix", ["Hold"]));
});

it.each(
  ["missing decision", "unnamed approval", "later unnamed approval"].flatMap((scenario) =>
    ["Add the fix to the release", "Deploy the build and then verify it", "Deploy after CI"].map(
      (text) => ({ scenario, text }),
    ),
  ),
)("every suggested approval wording round-trips after $scenario: $text", ({ scenario, text }) => {
  const subtasks = [{ ...referencedSubtasks[0]!, text }, referencedSubtasks[1]!];
  const card = referencedChoiceCard(["Hold", "Approve"], ["o1"], subtasks);
  const ask = card.asks[0]!;
  const unnamed: KanbanOwnerAsk = {
    ...ask,
    id: "q4",
    text: "Close the card?",
    at: "2026-11-13T14:09:00.000Z",
    closedAt: "2026-11-13T14:10:00.000Z",
    answer: { verdict: "approved", by: owner, at: "2026-11-13T14:10:00.000Z" },
  };
  const asks =
    scenario === "missing decision"
      ? []
      : scenario === "unnamed approval"
        ? [unnamed]
        : [ask, unnamed];
  const subtask = card.subtasks[0]!;
  const problem = approvalProblem({ ...card, asks }, subtask)!;
  const suggestions = [...problem.matchAll(/e\.g\. "([^"]+)"/g)];
  assert.isNotEmpty(suggestions);
  for (const [, wording] of suggestions) {
    const label = wording!;
    const retry = referencedChoiceCard([label, "Hold"], ["o1"], subtasks);
    retry.asks[0]!.text = label;
    assert.isNull(approvalProblem(retry, subtask));
  }
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

const probeAskText =
  "Approve up to two Android probe sessions at $0.02/min, each capped at 7 minutes, maximum $0.28 total?";
const probeAskTitle = "#94: approve two short Run Cloud Android typing probes";
const probeAskSummary =
  "Create at most two Android sessions, run the public-text probes, clear clipboards and release both.";
const probeSubtask: KanbanSubtask = {
  ...goChoiceSubtask,
  text: "Approve up to two Android probe sessions, each capped at 7 min, $0.28 total (rate $0.02/min)",
  gate: "money",
  createdAt: "2026-11-13T18:41:50.644Z",
};

const probeCard = (optionId = "o1") => {
  const base = goChoiceCard(["Approve", "Skip paid probes"], [optionId], probeSubtask);
  const ask: KanbanOwnerAsk = {
    ...base.asks[0]!,
    id: "q2",
    kind: "action",
    text: probeAskText,
    title: probeAskTitle,
    action: { summary: probeAskSummary },
    at: "2026-11-14T06:40:00.000Z",
    closedAt: "2026-11-14T06:46:23.000Z",
    answer: {
      verdict: "picked",
      optionIds: [optionId],
      by: owner,
      at: "2026-11-14T06:46:23.000Z",
    },
  };
  return { ...base, asks: [ask] };
};

it("#94 q2 infers money from its exact text, title and cleanup summary", () => {
  assert.strictEqual(inferGate(`${probeAskText} ${probeAskTitle} ${probeAskSummary}`), "money");
});

it.each(["evaluator", "script"] as const)(
  "#94 price approval clears a single %s money step",
  (owner) => {
    const subtask = { ...probeSubtask, owner };
    assert.isNull(approvalProblem({ ...probeCard(), subtasks: [subtask] }, subtask));
  },
);

it("#94 Skip paid probes does not approve the paid step", () => {
  assert.isTrue(isNegativeOption("Skip paid probes"));
  assert.include(approvalProblem(probeCard("o2"), probeSubtask)!, 'picked "Skip paid probes"');
});

it("an unnamed price approval cannot clear two money steps", () => {
  const second = { ...probeSubtask, id: "s2", text: "Approve AED 45 order" };
  const card = { ...probeCard(), subtasks: [probeSubtask, second] };
  for (const subtask of card.subtasks) assert.isNotNull(approvalProblem(card, subtask));
});

it("a named price approval clears only its own step", () => {
  const base = probeCard();
  const second = { ...probeSubtask, id: "s2", text: "Approve AED 45 order" };
  const card = {
    ...base,
    asks: [{ ...base.asks[0]!, text: `For s1: ${probeAskText}` }],
    subtasks: [probeSubtask, second],
  };
  assert.isNull(approvalProblem(card, probeSubtask));
  assert.isNotNull(approvalProblem(card, second));
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
      const current = (yield* kanban.card(card.id)).card;
      assert.isNull(approvalProblem(current, current.subtasks[0]!, [], undefined, "skip"));
      const actionDenied = yield* kanban
        .markSubtask(card.id, "s1", "done", "Narrower choice", evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(actionDenied.detail, "needs Abdullah's approval");
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
  "$reply selects $label; $state follows owner answer (action approval=$approved)",
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
        if (state === "skipped" || approved) {
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
          const current = (yield* kanban.card(card.id)).card;
          assert.isNull(approvalProblem(current, current.subtasks[0]!, [], undefined, "skip"));
          const actionDenied = yield* kanban
            .markSubtask(card.id, "s1", "done", "Owner chose information", evaluator, "evaluator")
            .pipe(Effect.flip);
          assert.include(actionDenied.detail, "approval");
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
      assert.include(approvalProblem(legacy, subtask, [])!, "the latest decision, q2, was dropped");
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
      assert.isNull(approvalProblem(signedOff, subtask, []));
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
        `card #${card.number} subtask s1 (deploy: Deploy) needs Abdullah's approval: no owner answer on a deploy ask since ${card.subtasks[0]!.createdAt}; ask with card_ask naming s1 (e.g. "Approve s1") (this board has no standing deploy approval); for a guessed gate on an evaluator/script step, an evaluator can pass clearGate with a reason on s1; a gate set on purpose still needs Abdullah's answer naming s1`,
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
        `card #${card.number} subtask s1 (deploy: Deploy) needs Abdullah's approval: the latest decision, q2, ${suffix} (this board has no standing deploy approval); for a guessed gate on an evaluator/script step, an evaluator can pass clearGate with a reason on s1; a gate set on purpose still needs Abdullah's answer naming s1`,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([owner, evaluator])(
  "$_tag drop cannot complete, remove or verify a deploy gate",
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
        for (const state of ["done"] as const) {
          const refused = yield* kanban
            .markSubtask(card.id, "s1", state, "Dropped", evaluator, "evaluator")
            .pipe(Effect.flip);
          assert.strictEqual(
            refused.detail,
            `card #${card.number} subtask s1 (deploy: Restart LaunchAgent) needs Abdullah's approval: the latest decision, q1, was dropped (a dropped ask is not approval) (this board has no standing deploy approval); this gate was set on purpose and still needs Abdullah's answer naming s1`,
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
      const oldAction = yield* kanban
        .markSubtask(card.id, "s1", "done", "Old approval", evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(oldAction.detail, "needs Abdullah's approval");
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
        .markSubtask(card.id, "s1", "done", "text", evaluator, "evaluator")
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

it.each([
  { verdict: "picked", by: "owner", skip: true, done: false },
  { verdict: "rejected", by: "owner", skip: true, done: false },
  { verdict: "approved", by: "owner", skip: true, done: true },
  { verdict: "answered", by: "owner", skip: true, done: false },
  { verdict: "dropped", by: "owner", skip: false, done: false },
  { verdict: "picked", by: "evaluator", skip: false, done: false },
  { verdict: "absent", by: "owner", skip: false, done: false },
] as const)("gate intent: $by $verdict", ({ verdict, by, skip, done }) => {
  const at = "2026-11-13T18:00:00.000Z";
  const subtask: KanbanCard["subtasks"][number] = {
    id: "s6",
    step: 2,
    text: "Ask Abdullah to deploy",
    owner: "evaluator",
    gate: "deploy",
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  };
  const card: Pick<KanbanCard, "number" | "createdAt" | "subtasks" | "asks"> = {
    number: 19,
    createdAt: at,
    subtasks: [subtask],
    asks:
      verdict === "absent"
        ? []
        : [
            {
              id: "q2",
              text: "Skip s6 deploy?",
              blocking: false,
              by: evaluator,
              at,
              seq: null,
              closedAt: at,
              options: [
                { id: "o1", label: "Skip deploy" },
                { id: "o2", label: "Deploy anyway" },
              ],
              answer: { verdict, by: by === "owner" ? owner : evaluator, at, optionIds: ["o1"] },
            },
          ],
  };
  assert.strictEqual(approvalProblem(card, subtask, [], undefined, "skip") === null, skip);
  assert.strictEqual(approvalProblem(card, subtask, [], undefined, "do") === null, done);
  assert.strictEqual(
    approvalProblem(card, subtask, [], undefined, "do"),
    approvalProblem(card, subtask),
  );
  if (!skip)
    assert.include(
      approvalProblem(card, subtask, [], undefined, "skip")!,
      "needs Abdullah's answer before it can be skipped",
    );
  if (verdict === "picked" && by === "owner") {
    assert.strictEqual(
      approvalProblem(card, subtask),
      `card #19 subtask s6 (deploy: Ask Abdullah to deploy) needs Abdullah's approval: the latest decision, q2, picked "Skip deploy", which doesn't read as approving deploy; ask again with an Approve option or an action ask (this board has no standing deploy approval); for a guessed gate on an evaluator/script step, an evaluator can pass clearGate with a reason on s6; a gate set on purpose still needs Abdullah's answer naming s6`,
    );
  }
});

const skippedDeploySubtask: KanbanSubtask = {
  ...goChoiceSubtask,
  id: "s6",
  text: "Ask Abdullah to deploy",
  state: "skipped",
};

const unnamedSkipDeployCard = (): Pick<
  KanbanCard,
  "number" | "createdAt" | "subtasks" | "asks"
> => ({
  number: 19,
  createdAt: "2026-11-13T13:00:00.000Z",
  subtasks: [skippedDeploySubtask],
  asks: [
    {
      id: "q2",
      text: 'Can I close 9router #19\'s deploy step as "not needed"?',
      blocking: false,
      by: evaluator,
      at: "2026-11-13T17:00:00.000Z",
      seq: null,
      closedAt: "2026-11-13T18:23:01.000Z",
      options: [
        { id: "o1", label: "Skip deploy" },
        { id: "o2", label: "Deploy anyway" },
      ],
      answer: {
        verdict: "picked",
        by: owner,
        at: "2026-11-13T18:23:01.000Z",
        optionIds: ["o1"],
      },
    },
    {
      id: "q3",
      text: "OK to skip s6 (the deploy step)?",
      blocking: false,
      by: evaluator,
      at: "2026-11-13T17:30:00.000Z",
      seq: null,
      closedAt: "2026-11-13T17:58:51.000Z",
      answer: { verdict: "dropped", by: evaluator, at: "2026-11-13T17:58:51.000Z" },
    },
  ],
});

it.each(["open", "skipped"] as const)(
  "9router #19: the unnamed owner answer permits s6 to stay %s under skip intent",
  (state) => {
    const subtask = { ...skippedDeploySubtask, state };
    const card = { ...unnamedSkipDeployCard(), subtasks: [subtask] };
    assert.isNull(approvalProblem(card, subtask, [], undefined, "skip"));
  },
);

it("9router #19: the unnamed Skip deploy answer still refuses doing s6", () => {
  const subtask = { ...skippedDeploySubtask, state: "done" as const };
  const card = { ...unnamedSkipDeployCard(), subtasks: [subtask] };
  assert.include(
    approvalProblem(card, subtask, [], undefined, "do")!,
    'q2, picked "Skip deploy", which doesn\'t read as approving deploy',
  );
});

it.each(["dropped only", "no answer"])(
  "9router #19: a skipped s6 with %s still needs the owner's answer",
  (scenario) => {
    const card = unnamedSkipDeployCard();
    const asks = scenario === "dropped only" ? card.asks.filter(({ id }) => id === "q3") : [];
    assert.include(
      approvalProblem({ ...card, asks }, skippedDeploySubtask, [], undefined, "skip")!,
      scenario === "dropped only"
        ? "the latest decision, q3, was dropped (a dropped ask is not approval)"
        : "no owner answer on a deploy ask since",
    );
  },
);

it.each(
  (["open", "skipped"] as const).flatMap((state) =>
    (["open", "done", "skipped"] as const).map((otherState) => ({ state, otherState })),
  ),
)(
  "the unnamed skip answer for s6 ($state) ignores s5 only when skipped ($otherState)",
  ({ state, otherState }) => {
    const other = {
      ...skippedDeploySubtask,
      id: "s5",
      text: "Deploy the earlier build",
      state: otherState,
    };
    const subtask = { ...skippedDeploySubtask, state };
    const card = {
      ...unnamedSkipDeployCard(),
      subtasks: [other, subtask],
    };
    assert.strictEqual(
      approvalProblem(card, subtask, [], undefined, "skip") === null,
      otherState === "skipped",
    );
    if (state === "open")
      assert.include(
        approvalProblem(card, other, [], undefined, "skip")!,
        "no owner answer on a deploy ask since",
      );
  },
);

const relevanceSubtask: KanbanSubtask = {
  ...goChoiceSubtask,
  id: "s5",
  text: "Provide the SSH key",
  gate: "secret",
};

const relevanceAsk = (overrides: Partial<KanbanOwnerAsk> = {}): KanbanOwnerAsk => ({
  id: "q4",
  text: "Approve s5",
  blocking: false,
  by: evaluator,
  at: "2026-11-13T14:01:00.000Z",
  seq: null,
  closedAt: "2026-11-13T14:03:00.000Z",
  answer: { verdict: "approved", by: owner, at: "2026-11-13T14:03:00.000Z" },
  ...overrides,
});

const relevanceCard = (
  asks: readonly KanbanOwnerAsk[],
): Pick<KanbanCard, "number" | "createdAt" | "subtasks" | "asks"> => ({
  number: 14,
  createdAt: "2026-11-13T13:00:00.000Z",
  subtasks: [relevanceSubtask],
  asks,
});

const billingSubtask: KanbanSubtask = {
  ...goChoiceSubtask,
  text: "Owner fixes the failed payment or Actions spending limit",
  gate: "money",
  createdAt: "2026-11-14T09:00:30.000Z",
};

const duplicateBillingCard = (title = "Close #4319 as a duplicate of #4315 Blacksmith") => ({
  ...relevanceCard([
    relevanceAsk({
      id: "q1",
      text: "Actions payments failed: fix the spending limit or billing?",
      blocking: true,
      at: "2026-11-14T09:01:00.000Z",
      closedAt: "2026-11-14T09:03:51.000Z",
      answer: {
        verdict: "answered",
        text: "Blacksmith migration is ongoing please follow it",
        by: owner,
        at: "2026-11-14T09:03:51.000Z",
      },
    }),
    relevanceAsk({
      id: "q2",
      kind: "question",
      text: "Close #4319 as a duplicate of #4315, with no billing change on Equicom-Crypto?",
      title,
      at: "2026-11-14T09:04:00.000Z",
      closedAt: "2026-11-14T09:07:54.000Z",
      answer: { verdict: "approved", by: owner, at: "2026-11-14T09:07:54.000Z" },
    }),
  ]),
  number: 4319,
  subtasks: [billingSubtask],
});

it("#4319: the reported billing title concerns the money step after #1418", () => {
  const card = duplicateBillingCard(
    "Close #4319 (Actions billing) as a duplicate of #4315 Blacksmith",
  );
  assert.isNull(approvalProblem(card, billingSubtask));
});

it.each([
  { verdict: "answered", reason: "was answered" },
  { verdict: "rejected", reason: "was rejected" },
  { verdict: "dropped", reason: "was dropped (a dropped ask is not approval)" },
  {
    verdict: "picked",
    reason:
      'picked "Wait", which doesn\'t read as approving money; ask again with an Approve option or an action ask',
  },
] as const)(
  "#4319: later unnamed approval explains refusal after q1 $verdict",
  ({ verdict, reason }) => {
    const card = duplicateBillingCard();
    const q1 = card.asks[0]!;
    const q2 = card.asks[1]!;
    const asks = [
      {
        ...q1,
        options: [{ id: "wait", label: "Wait" }],
        answer: { ...q1.answer!, verdict, optionIds: verdict === "picked" ? ["wait"] : [] },
      },
      q2,
    ];
    assert.strictEqual(inferGate(`${q2.text} ${q2.title}`), undefined);
    assert.include(
      approvalProblem({ ...card, asks }, billingSubtask)!,
      `the latest decision, q1, ${reason}; q2 (approved later) doesn't name s1, so it doesn't count; ask again naming s1`,
    );
  },
);

it("#4319: naming s1 makes the later approval count; skipping needs only q1's owner answer", () => {
  const card = duplicateBillingCard();
  assert.isNotNull(approvalProblem(card, billingSubtask));
  assert.isNull(approvalProblem(card, billingSubtask, [], undefined, "skip"));
  const named = {
    ...card,
    asks: card.asks.map((ask) =>
      ask.id === "q2" ? { ...ask, text: `Approve s1: ${ask.text}` } : ask,
    ),
  };
  assert.isNull(approvalProblem(named, billingSubtask));
});

it.each(["2026-11-14T09:03:50.000Z", "2026-11-14T09:03:51.000Z"])(
  "#4319: an unnamed approval at %s does not shadow the later or simultaneous q1 answer",
  (at) => {
    const card = duplicateBillingCard();
    const q2 = card.asks[1]!;
    const asks = [
      card.asks[0]!,
      { ...q2, at: "2026-11-14T09:02:00.000Z", closedAt: at, answer: { ...q2.answer!, at } },
    ];
    assert.strictEqual(
      approvalProblem({ ...card, asks }, billingSubtask),
      approvalProblem({ ...card, asks: [asks[0]!] }, billingSubtask),
    );
  },
);

it("#4319: a later unnamed picked approval keeps the naming hint", () => {
  const card = duplicateBillingCard();
  const q2 = card.asks[1]!;
  const asks = [
    card.asks[0]!,
    {
      ...q2,
      options: [{ id: "go", label: "Approve" }],
      answer: { ...q2.answer!, verdict: "picked" as const, optionIds: ["go"] },
    },
  ];
  assert.include(
    approvalProblem({ ...card, asks }, billingSubtask)!,
    "q2 (approved later) doesn't name s1",
  );
});

it.each(
  ["2026-11-13T14:02:00.000Z", "2026-11-13T14:04:00.000Z"].flatMap((at) =>
    ["Check the CI run", "Approve s6", "Deploy the bundle"].flatMap((text) =>
      (["do", "skip"] as const).map((intent) => ({ at, text, intent })),
    ),
  ),
)("an unrelated drop at $at ($text) does not block $intent", ({ at, text, intent }) => {
  const card = relevanceCard([
    relevanceAsk({
      id: "q1",
      text,
      closedAt: at,
      answer: { verdict: "dropped", by: evaluator, at },
    }),
    relevanceAsk(),
  ]);
  assert.isNull(approvalProblem(card, relevanceSubtask, [], undefined, intent));
});

it.each(
  [owner, evaluator].flatMap((dropper) =>
    [false, true].flatMap((draft) =>
      ["text", "title", "summary"].flatMap((field) =>
        (["do", "skip"] as const).map((intent) => ({ dropper, draft, field, intent })),
      ),
    ),
  ),
)(
  "a relevant $field drop by $dropper._tag (draft=$draft) revokes approval for $intent",
  ({ dropper, draft, field, intent }) => {
    const card = relevanceCard([
      relevanceAsk({ id: "q1" }),
      relevanceAsk({
        id: "q2",
        text: field === "text" ? "Approve s5" : "Check the CI run",
        ...(field === "title" ? { title: "Approve s5" } : {}),
        ...(field === "summary" ? { action: { summary: "Approve s5" } } : {}),
        ...(draft ? { draft: { text: "Ready to send", format: "markdown" } } : {}),
        closedAt: "2026-11-13T14:04:00.000Z",
        answer: { verdict: "dropped", by: dropper, at: "2026-11-13T14:04:00.000Z" },
      }),
    ]);
    assert.include(
      approvalProblem(card, relevanceSubtask, [], undefined, intent)!,
      "the latest decision, q2, was dropped",
    );
  },
);

it.each(["do", "skip"] as const)(
  "an unnamed approval gives a subtask-specific reason for %s",
  (intent) => {
    const card = relevanceCard([
      relevanceAsk({
        id: "q3",
        kind: "signoff",
        title: "Close #14",
        text: "Close the card",
      }),
      relevanceAsk({
        id: "q1",
        text: "Check the CI run",
        closedAt: "2026-11-13T14:04:00.000Z",
        answer: { verdict: "dropped", by: evaluator, at: "2026-11-13T14:04:00.000Z" },
      }),
      relevanceAsk({
        id: "q2",
        text: "Close the card",
        closedAt: "2026-11-13T14:02:00.000Z",
        answer: { verdict: "approved", by: owner, at: "2026-11-13T14:02:00.000Z" },
      }),
    ]);
    const problem = approvalProblem(card, relevanceSubtask, [], undefined, intent)!;
    assert.include(
      problem,
      'q3 was approved but doesn\'t name s5; ask again naming the subtask id (e.g. "Approve s5")',
    );
    assert.notInclude(problem, "q1");
  },
);

it.each([
  { label: "draft", ask: relevanceAsk({ text: "Close", draft: { text: "Done", format: "text" } }) },
  {
    label: "non-owner",
    ask: relevanceAsk({
      text: "Close",
      answer: { verdict: "approved", by: evaluator, at: "2026-11-13T14:03:00.000Z" },
    }),
  },
  { label: "old ask", ask: relevanceAsk({ text: "Close", at: "2026-11-13T13:59:00.000Z" }) },
  {
    label: "old answer",
    ask: relevanceAsk({
      text: "Close",
      answer: { verdict: "approved", by: owner, at: "2026-11-13T13:59:00.000Z" },
    }),
  },
  { label: "open ask", ask: relevanceAsk({ text: "Close", closedAt: null }) },
  { label: "another subtask", ask: relevanceAsk({ text: "Approve s6" }) },
])("a $label approval keeps the missing-answer reason", ({ ask }) => {
  for (const intent of ["do", "skip"] as const) {
    assert.include(
      approvalProblem(relevanceCard([ask]), relevanceSubtask, [], undefined, intent)!,
      "no owner answer on a secret ask since",
    );
  }
});

it.each(["do", "skip"] as const)(
  "a relevant drop before the time bound does not revoke %s",
  (intent) => {
    const card = relevanceCard([
      relevanceAsk(),
      relevanceAsk({
        id: "q1",
        closedAt: "2026-11-13T13:59:00.000Z",
        answer: { verdict: "dropped", by: evaluator, at: "2026-11-13T13:59:00.000Z" },
      }),
    ]);
    assert.isNull(approvalProblem(card, relevanceSubtask, [], undefined, intent));
  },
);

it.each(["do", "skip"] as const)("an inferred relevant drop still revokes %s", (intent) => {
  const card = relevanceCard([
    relevanceAsk(),
    relevanceAsk({
      id: "q2",
      text: "Provide the SSH key",
      closedAt: "2026-11-13T14:04:00.000Z",
      answer: { verdict: "dropped", by: evaluator, at: "2026-11-13T14:04:00.000Z" },
    }),
  ]);
  assert.include(
    approvalProblem(card, relevanceSubtask, [], undefined, intent)!,
    "the latest decision, q2, was dropped",
  );
  const other = { ...relevanceSubtask, id: "s6" };
  assert.isNull(
    approvalProblem(
      { ...card, subtasks: [...card.subtasks, other] },
      relevanceSubtask,
      [],
      undefined,
      intent,
    ),
  );
});

it("a later dropped decision still blocks skipping after the owner's earlier approval", () => {
  const at = "2026-11-13T18:00:00.000Z";
  const subtask: KanbanCard["subtasks"][number] = {
    id: "s6",
    step: 2,
    text: "Deploy",
    owner: "evaluator",
    gate: "deploy",
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  };
  const asks: KanbanCard["asks"] = (["approved", "dropped"] as const).map((verdict, index) => ({
    id: `q${index + 1}`,
    text: "s6 deploy",
    blocking: false,
    by: owner,
    at,
    seq: null,
    closedAt: at,
    answer: {
      verdict,
      by: owner,
      at: index === 0 ? at : "2026-11-13T18:01:00.000Z",
    },
  }));
  assert.include(
    approvalProblem(
      { number: 19, createdAt: at, subtasks: [subtask], asks },
      subtask,
      [],
      undefined,
      "skip",
    )!,
    "the latest decision, q2, was dropped",
  );
});

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

const mergeSubtask: KanbanSubtask = {
  ...goChoiceSubtask,
  id: "s4",
  text: "Merge after a clear review at the exact head with green CI (CI/test only, no deploy)",
};

it("#4297: sign-off must name the merge subtask with a stored deploy gate", () => {
  const ask = relevanceAsk({
    id: "q1",
    kind: "signoff",
    title: "Sign off: PR #1288 merged into native-v1 (CI/test only)",
    text: "Do you approve the merge?",
  });
  const card = { ...relevanceCard([ask]), number: 4297, subtasks: [mergeSubtask] };
  for (const intent of ["do", "skip"] as const) {
    assert.include(
      approvalProblem(card, mergeSubtask, [], undefined, intent)!,
      "q1 was approved but doesn't name s4",
    );
    assert.isNull(
      approvalProblem(
        { ...card, asks: [{ ...ask, text: "Approve s4: merge PR #1288" }] },
        mergeSubtask,
        [],
        undefined,
        intent,
      ),
    );
  }
});

it.each([
  { label: "Approve", hint: true },
  { label: "Change", hint: false },
  { label: "Drop", hint: false },
])("#4281: unnamed decision pick $label approval hint=$hint", ({ label, hint }) => {
  const subtask = { ...mergeSubtask, text: "Write the wiki note" };
  const ask = relevanceAsk({
    id: "q1",
    kind: "decision",
    text: "Close the card?",
    options: ["Approve", "Change", "Drop"].map((label) => ({ id: label, label })),
    answer: { verdict: "picked", optionIds: [label], by: owner, at: "2026-11-13T14:03:00.000Z" },
  });
  const card = { ...relevanceCard([ask]), number: 4281, subtasks: [subtask] };
  const problem = approvalProblem(card, subtask)!;
  assert.strictEqual(problem.includes("q1 was approved but doesn't name s4"), hint);
  if (!hint) assert.include(problem, "no owner answer on a deploy ask");
});

it("explains how to ask when a gated step has no approval", () => {
  const card = { ...relevanceCard([]), subtasks: [mergeSubtask] };
  assert.include(
    approvalProblem(card, mergeSubtask)!,
    'ask with card_ask naming s4 (e.g. "Approve s4")',
  );
});

it.each([
  [mergeSubtask.text, undefined],
  ["Merge (no deploy)", undefined],
  ["Merge (no deploy), then restart Robob", "deploy"],
  ["Deploy after CI (no restart)", "deploy"],
] as const)("merge gate regression: %s", (text, gate) => assert.strictEqual(inferGate(text), gate));

it.each([
  { text: "Close the card?", warning: true },
  { text: "Approve s4: merge PR #1288", warning: false },
  { text: "Deploy the build?", warning: false },
  { text: "Approve s5", warning: true },
])("ask gate warning: $text", ({ text, warning }) => {
  const card = { ...relevanceCard([]), subtasks: [mergeSubtask] };
  const note = askGateWarning(card, relevanceAsk({ text }));
  assert.strictEqual(note !== undefined, warning);
  if (warning)
    assert.strictEqual(note, "This ask won't clear s4 (deploy). Name s4 in the text if it should.");
});

it.each(["done", "skipped"] as const)("a %s gate needs no ask warning", (state) => {
  const card = { ...relevanceCard([]), subtasks: [{ ...mergeSubtask, state }] };
  assert.isUndefined(askGateWarning(card, relevanceAsk({ text: "Close the card?" })));
});

it.each([
  { kind: "secret", state: "open", gate: "secret", warning: true },
  { kind: "decision", state: "open", gate: "secret", warning: false },
  { kind: "action", state: "open", gate: "secret", warning: false },
  { kind: "secret", state: "done", gate: "secret", warning: false },
  { kind: "secret", state: "skipped", gate: "secret", warning: false },
  { kind: "secret", state: "open", gate: undefined, warning: false },
  { kind: "secret", state: "open", gate: "deploy", warning: false },
] as const)(
  "secret-kind approval warning: $kind / $state / $gate",
  ({ kind, state, gate, warning }) => {
    const card = {
      subtasks: [{ ...relevanceSubtask, id: "s3", text: "Check access", gate, state }],
    };
    const note = secretKindApprovalWarning(card, relevanceAsk({ kind, text: "Approve s3" }));
    assert.strictEqual(note !== undefined, warning);
    if (warning)
      assert.strictEqual(
        note,
        'Kind "secret" asks Abdullah to type a secret value. To approve s3, ask a decision naming s3 instead.',
      );
  },
);

it("a real secret request on an ungated card needs no warning", () => {
  assert.isUndefined(secretKindApprovalWarning({ subtasks: [] }, relevanceAsk({ kind: "secret" })));
});

it("a secret-kind warning lists only open secret-gated ids", () => {
  const card = {
    subtasks: [
      { ...relevanceSubtask, id: "s3" },
      { ...relevanceSubtask, id: "s4", state: "done" as const },
      { ...relevanceSubtask, id: "s7" },
      mergeSubtask,
    ],
  };
  assert.strictEqual(
    secretKindApprovalWarning(card, relevanceAsk({ kind: "secret", text: "Approve s3 and s7" })),
    'Kind "secret" asks Abdullah to type a secret value. To approve s3, s7, ask a decision naming the intended subtask id instead.',
  );
});

it.each(["work", "review"] as const)("a stored secret gate on $owner needs no warning", (owner) => {
  const card = { subtasks: [{ ...relevanceSubtask, owner }] };
  assert.isUndefined(secretKindApprovalWarning(card, relevanceAsk({ kind: "secret" })));
});

it("a secret-kind warning respects enabled inferred gates and explicit gates", () => {
  const ask = relevanceAsk({ kind: "secret" });
  const card = { subtasks: [{ ...relevanceSubtask, gate: undefined }] };
  assert.isDefined(secretKindApprovalWarning(card, ask, ["secret"]));
  assert.isUndefined(secretKindApprovalWarning(card, ask, []));
  assert.isDefined(secretKindApprovalWarning({ subtasks: [relevanceSubtask] }, ask, []));
});

it("ambiguous inferred wording warns and naming one gate avoids the warning", () => {
  const card = { ...relevanceCard([]), subtasks: [mergeSubtask, { ...mergeSubtask, id: "s6" }] };
  assert.include(
    askGateWarning(card, relevanceAsk({ text: "Deploy the build?" }))!,
    "s4 (deploy), s6 (deploy)",
  );
  assert.isUndefined(askGateWarning(card, relevanceAsk({ text: "Approve s6" })));
});

it("ask kind and context cannot replace the gate's wording", () => {
  const card = { ...relevanceCard([]), subtasks: [mergeSubtask] };
  assert.isDefined(
    askGateWarning(
      card,
      relevanceAsk({ text: "Close the card?", kind: "deploy", context: "Approve s4" }),
    ),
  );
});

it.each([
  { label: "Keep it", hint: true },
  { label: "Revert it", hint: false },
])("Watchers #49: unnamed $label pick approval hint=$hint", ({ label, hint }) => {
  const subtask = { ...mergeSubtask, id: "s5", text: "Merge into ardud/main and push origin main" };
  const ask = relevanceAsk({
    id: "q2",
    kind: "decision",
    title: "#49: keep the test-only merge I already pushed to main?",
    text: "Keep it, or revert it?",
    options: ["Keep it", "Revert it"].map((label) => ({ id: label, label })),
    answer: { verdict: "picked", optionIds: [label], by: owner, at: "2026-11-13T14:03:00.000Z" },
  });
  const card = { ...relevanceCard([ask]), number: 49, subtasks: [subtask] };
  assert.strictEqual(
    approvalProblem(card, subtask)!.includes("q2 was approved but doesn't name s5"),
    hint,
  );
  const named = { ...card, asks: [{ ...ask, text: "For s5: keep it, or revert it?" }] };
  assert.strictEqual(approvalProblem(named, subtask) === null, hint);
});

it.each([
  { task: "Deploy the build", gate: "deploy", hold: "Revert it" },
  { task: "Purchase the license", gate: "money", hold: "Revert it" },
  { task: "Merge into ardud/main", gate: "deploy", hold: "Wait" },
] as const)("Keep it cannot approve $task against $hold", ({ task, gate, hold }) => {
  const subtask = { ...mergeSubtask, text: task, gate };
  assert.isNotNull(approvalProblem(goChoiceCard(["Keep it", hold], ["o1"], subtask), subtask));
});

it.each([
  { owner: "evaluator", gate: "deploy", text: "Check CI" },
  { owner: "script", gate: "money", text: "Check prices" },
  { owner: "evaluator", gate: "secret", text: "Check access" },
] as const)("warns for an explicit $gate gate owned by $owner", ({ owner, gate, text }) => {
  const subtask = { ...mergeSubtask, owner, gate, text };
  const card = { ...relevanceCard([]), subtasks: [subtask] };
  assert.include(
    askGateWarning(card, relevanceAsk({ text: "Close the card?" }), [])!,
    `s4 (${gate})`,
  );
});

it("warns for enabled inferred script gates", () => {
  const subtask = {
    ...mergeSubtask,
    owner: "script" as const,
    gate: undefined,
    text: "Deploy the build",
  };
  const card = { ...relevanceCard([]), subtasks: [subtask] };
  assert.isDefined(askGateWarning(card, relevanceAsk({ text: "Close the card?" }), ["deploy"]));
  assert.isUndefined(askGateWarning(card, relevanceAsk({ text: "Close the card?" }), []));
});

it.each(["Keep it", "Keep it!", "Yes, keep it", "Please keep it"])(
  "%s retains one merge without granting standing deploy permission",
  (label) => {
    const task = "Merge the watchers test-only change for s5";
    assert.isTrue(approvesGate(label, "deploy", task, ["Revert it"], "subtask"));
    assert.isFalse(approvesGate(label, "deploy", task, ["Revert it"]));
    assert.isFalse(approvesGate(label, "deploy", task, ["Revert it"], "standing"));
  },
);

it.effect("retaining a merge cannot become a board-wide standing approval", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard("watchers");
      const store = yield* KanbanStore.KanbanStore;
      const threadId = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Check standing approval",
      });
      const actor: KanbanActor = { _tag: "evaluator", threadId };
      const card = yield* kanban.createCard(
        board.id,
        { title: "Keep merge", prompt: "Work" },
        owner,
      );
      for (const field of ["text", "summary"] as const) {
        for (const label of ["Keep it", "Keep it!", "Yes, keep it", "Please keep it"]) {
          const wording = "Merge the watchers test-only change for s5: keep it, or revert it?";
          const ask = relevanceAsk({
            id: "q1",
            text: field === "text" ? wording : "Keep it, or revert it?",
            ...(field === "summary" ? { action: { summary: wording } } : {}),
            options: [
              { id: "keep", label },
              { id: "revert", label: "Revert it" },
            ],
            answer: {
              verdict: "picked",
              optionIds: ["keep"],
              by: owner,
              at: "2026-11-13T14:03:00.000Z",
            },
          });
          yield* store.putCard({ ...card, asks: [ask] });
          const denied = yield* kanban
            .standingApproval(
              board.id,
              {
                action: "grant",
                cardId: card.id,
                ask: "q1",
                quote: label,
                sourceThreadId: "owner-thread",
                saidAt: ask.answer!.at,
              },
              actor,
            )
            .pipe(Effect.flip);
          assert.strictEqual(denied.code, "denied", `${field}: ${label}`);
          assert.include(denied.detail, "grant needs a closed ask approved by the owner");
          assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.standingApprovals, []);
        }
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.each(["open", "done", "skipped"] as const)(
  "a recorded gate skip exempts only the skipped state: %s",
  (state) => {
    const subtask: KanbanSubtask = {
      ...goChoiceSubtask,
      gateSource: "set",
      state,
      gateSkipped: {
        gate: "deploy",
        reason: "Only edits fork code",
        by: evaluator,
        at: "2026-11-14T00:00:00.000Z",
        text: goChoiceSubtask.text,
      },
    };
    const card = { ...goChoiceCard([], [], subtask), asks: [] };
    assert.strictEqual(approvalProblem(card, subtask) === null, state === "skipped");
    const { gateSkipped: _skip, ...legacy } = subtask;
    assert.include(approvalProblem(card, legacy)!, "needs Abdullah's approval");
  },
);

it.effect.each(
  (["deploy", "money", "secret"] as const).flatMap((gate) =>
    (["evaluator", "script"] as const).flatMap((subtaskOwner) =>
      (["set", "guessed"] as const).map((gateSource) => ({ gate, subtaskOwner, gateSource })),
    ),
  ),
)("evaluator skips $gate $gateSource gate on $subtaskOwner, but cannot do it", (row) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const text = {
        deploy: "Edit fork source",
        money: "Pay the invoice",
        secret: "Share the token",
      }[row.gate];
      const created = yield* kanban.createCard(
        board.id,
        {
          title: "Mistaken explicit gate (#1372 shape)",
          prompt: "Work",
          subtasks: [
            { text: "Write the change", owner: "evaluator" },
            { text: "Read the change", owner: "evaluator" },
            { text, owner: row.subtaskOwner, gate: row.gate },
          ],
        },
        owner,
      );
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putCard({
        ...created,
        subtasks: created.subtasks.map((s) =>
          s.id === "s3" ? { ...s, gateSource: row.gateSource } : s,
        ),
      });
      yield* kanban.markSubtask(created.id, "s1", "done", null, evaluator, "evaluator");
      yield* kanban.markSubtask(created.id, "s2", "done", null, evaluator, "evaluator");
      const reason = "Only edits fork code";
      const skipped = yield* kanban.markSubtask(
        created.id,
        "s3",
        "skipped",
        `  ${reason}  `,
        evaluator,
        "evaluator",
      );
      const entry = skipped.subtasks[2]!;
      assert.strictEqual(entry.state, "skipped");
      assert.strictEqual(entry.note, reason);
      assert.deepStrictEqual(entry.gateSkipped, {
        gate: row.gate,
        reason,
        by: evaluator,
        at: skipped.updatedAt,
        text,
      });
      assert.lengthOf(skipped.asks, 1);
      const repeated = yield* kanban
        .markSubtask(created.id, "s3", "skipped", reason, evaluator, "evaluator")
        .pipe(Effect.flip);
      assert.include(repeated.detail, "already skipped");
      assert.lengthOf((yield* kanban.card(created.id)).card.asks, 1);
      assert.deepStrictEqual(skipped.asks[0], {
        id: "q1",
        text: `An evaluator skipped s3, a ${row.gate}-gated step, without your approval: "${text}". Reason: ${reason}. It was not done; marking it done still needs your OK.`,
        blocking: false,
        by: evaluator,
        at: skipped.updatedAt,
        seq: null,
        closedAt: null,
        kind: "notice",
        respond: { ack: true },
        title: `Gate skipped on #${created.number} s3`,
        batchKey: "gate-skipped",
      });
      assert.isTrue(
        (yield* kanban.askFeed({ boardId: board.id })).open.some(
          (item) => item.cardId === created.id && item.kind === "notice" && item.ask.id === "q1",
        ),
      );
      assert.lengthOf(
        (yield* kanban.card(created.id)).events.filter(
          (event) =>
            event.kind === "comment" &&
            event.body ===
              `Skipped ${row.gate}-gated s3 ("${text}") without owner approval: ${reason}`,
        ),
        1,
      );
      const edited = yield* kanban.editCard(
        created.id,
        { subtasks: [{ id: "s1" }, { id: "s2" }, { id: "s3", text: "Reword the skipped step" }] },
        evaluator,
      );
      assert.deepStrictEqual(edited.subtasks[2], entry);
      assert.strictEqual(
        (yield* kanban.moveCard(created.id, "verified", "evaluator", evaluator)).stage,
        "verified",
      );
      const done = () =>
        kanban
          .markSubtask(created.id, "s3", "done", "Performed", evaluator, "evaluator")
          .pipe(Effect.flip);
      assert.include((yield* done()).detail, "needs Abdullah's approval");
      const reopened = yield* kanban.markSubtask(
        created.id,
        "s3",
        "open",
        null,
        evaluator,
        "evaluator",
      );
      assert.isUndefined(reopened.subtasks[2]!.gateSkipped);
      assert.strictEqual(reopened.subtasks[2]!.state, "open");
      assert.include((yield* done()).detail, "needs Abdullah's approval");
      const twice = yield* kanban.markSubtask(
        created.id,
        "s3",
        "skipped",
        reason,
        evaluator,
        "evaluator",
      );
      assert.lengthOf(twice.asks, 2);
      yield* kanban.markSubtask(created.id, "s3", "open", null, evaluator, "evaluator");
      yield* kanban.askOwner(
        created.id,
        { question: "Approve s3?", blocking: false, action: { summary: text } },
        evaluator,
        "evaluator",
      );
      yield* kanban.answerAsk(created.id, "q3", { verdict: "approved", revision: 0 }, owner);
      const approved = yield* kanban.markSubtask(
        created.id,
        "s3",
        "done",
        "Owner approved",
        evaluator,
        "evaluator",
      );
      assert.strictEqual(approved.subtasks[2]!.state, "done");
      assert.isUndefined(approved.subtasks[2]!.gateSkipped);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([null, "", "     ", "short", "x".repeat(9), "x".repeat(301)])(
  "gated evaluator skip needs a reason of 10–300 trimmed characters: %s",
  (note) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(
          board.id,
          {
            prompt: "Work",
            subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
          },
          owner,
        );
        const before = yield* kanban.card(card.id);
        const refused = yield* kanban
          .markSubtask(card.id, "s1", "skipped", note, evaluator, "evaluator")
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "invalid");
        assert.strictEqual(
          refused.detail,
          "skipping a gated step needs a reason of 10 to 300 characters in note",
        );
        assert.deepStrictEqual(yield* kanban.card(card.id), before);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([10, 300])("gated skip accepts a %s-character reason", (length) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Work",
          subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
        },
        owner,
      );
      const skipped = yield* kanban.markSubtask(
        card.id,
        "s1",
        "skipped",
        ` ${"x".repeat(length)} `,
        evaluator,
        "evaluator",
      );
      assert.strictEqual(skipped.subtasks[0]!.gateSkipped?.reason.length, length);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([
  {
    actor: { _tag: "thread", threadId: ThreadId.make("worker") } as KanbanActor,
    role: "work" as const,
  },
  {
    actor: { _tag: "script", scriptId: KanbanScriptId.make("script") } as KanbanActor,
    role: "evaluator" as const,
  },
  {
    actor: { _tag: "thread", threadId: ThreadId.make("reviewer") } as KanbanActor,
    role: "review" as const,
  },
])("$actor._tag/$role cannot use evaluator gate skips", ({ actor, role }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Work",
          subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
        },
        owner,
      );
      const refused = yield* kanban
        .markSubtask(card.id, "s1", "skipped", "Only edits fork code", actor, role)
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "denied");
      assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]!.state, "open");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("owner skips still require no approval and add no notice", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Work",
          subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
        },
        owner,
      );
      const skipped = yield* kanban.markSubtask(card.id, "s1", "skipped", "No", owner, "evaluator");
      assert.strictEqual(skipped.subtasks[0]!.state, "skipped");
      assert.isUndefined(skipped.subtasks[0]!.gateSkipped);
      assert.lengthOf(skipped.asks, 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("dropping a later blocking ask returns a skipped gate card to verified", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Work",
          subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
        },
        owner,
      );
      yield* kanban.markSubtask(
        card.id,
        "s1",
        "skipped",
        "Only edits fork code",
        evaluator,
        "evaluator",
      );
      yield* kanban.moveCard(card.id, "verified", "evaluator", evaluator);
      yield* kanban.askOwner(
        card.id,
        { question: "Any follow-up?", blocking: true },
        evaluator,
        "evaluator",
      );
      const returned = yield* kanban.changeAsk(card.id, "q2", "drop", owner, "owner");
      assert.strictEqual(returned.stage, "verified");
      assert.strictEqual(returned.subtasks[0]!.state, "skipped");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a board script cannot skip its own gated step without approval", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const store = yield* KanbanStore.KanbanStore;
      const scriptId = KanbanScriptId.make("script-gated");
      yield* store.putScript({
        id: scriptId,
        boardId: board.id,
        name: "gated",
        path: "/unused/gated.sh",
        trigger: { _tag: "manual" },
        enabled: true,
        createdBy: owner,
        createdAt: "2026-11-14T00:00:00.000Z",
        lastRun: null,
      });
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Work",
          subtasks: [
            { text: "Edit fork source", owner: "script", gate: "deploy", script: "gated" },
          ],
        },
        owner,
      );
      const refused = yield* kanban
        .markSubtask(
          card.id,
          "s1",
          "skipped",
          "Only edits fork code",
          { _tag: "script", scriptId },
          "script",
        )
        .pipe(Effect.flip);
      assert.include(refused.detail, "needs Abdullah's answer before it can be skipped");
      assert.lengthOf((yield* kanban.card(card.id)).card.asks, 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "skipping an owner-only deploy records no release and keeps standing approvals intact",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const store = yield* KanbanStore.KanbanStore;
        const at = "2026-11-13T00:00:00.000Z";
        yield* store.putBoard({
          ...board,
          standingApprovals: [
            {
              id: "sa-skip-regression",
              gate: "deploy",
              quote: "Boards may release",
              sourceThreadId: "owner-thread",
              saidAt: at,
              approvedAsk: { cardId: "source", askId: "q1" },
              recordedAt: at,
              recordedBy: "evaluator",
              minIntervalHours: 4,
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
            },
          ],
        });
        const card = yield* kanban.createCard(
          board.id,
          {
            prompt: "Work",
            subtasks: [
              {
                text: "Edit fork source",
                owner: "evaluator",
                gate: "deploy",
                ownerOnly: true,
                interrupting: true,
              },
            ],
          },
          evaluator,
        );
        const skipped = yield* kanban.markSubtask(
          card.id,
          "s1",
          "skipped",
          "Only edits fork code",
          evaluator,
          "evaluator",
        );
        assert.isDefined(skipped.subtasks[0]!.gateSkipped);
        assert.lengthOf(skipped.asks, 1);
        assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger ?? [], 0);
        const denied = yield* kanban
          .markSubtask(card.id, "s1", "done", "Done", evaluator, "evaluator")
          .pipe(Effect.flip);
        assert.include(denied.detail, "marked owner-only");
        const actual = yield* kanban.createCard(
          board.id,
          {
            prompt: "Ship",
            subtasks: [
              {
                text: "Deploy the release",
                owner: "evaluator",
                gate: "deploy",
                interrupting: true,
              },
            ],
          },
          evaluator,
        );
        const done = yield* kanban.markSubtask(
          actual.id,
          "s1",
          "done",
          "Shipped",
          evaluator,
          "evaluator",
        );
        assert.include(done.subtasks[0]!.note!, "cleared by standing approval sa-skip-regression");
        const savedBoard = (yield* kanban.snapshot(board.id)).board;
        assert.lengthOf(savedBoard.releaseLedger!, 1);
        assert.strictEqual(savedBoard.releaseLedger![0]!.cardId, actual.id);
        assert.strictEqual(savedBoard.releaseLedger![0]!.approvalId, "sa-skip-regression");
        assert.lengthOf(savedBoard.standingApprovals, 1);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
