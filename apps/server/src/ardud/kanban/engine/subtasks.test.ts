import {
  kanbanEvaluatorStep,
  kanbanOpenStep,
  kanbanStepSubtasks,
  type KanbanOwnerAsk,
  type KanbanSubtask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalProblem,
  checkHandBack,
  checkMark,
  gateOf,
  handBack,
  inferGate,
  markSubtask,
  PACKET_SUBTASK,
  passReview,
  planSubtasks,
  pendingWakeNote,
  subtaskLines,
  withPacketStep,
  workAfterReview,
} from "./subtasks.ts";

const owner = { _tag: "owner" } as const;
const at = "2026-10-26T12:00:00.000Z";
const torsshReview =
  "Review (single GPT-6 Astra xhigh, design chain): torrc injection impossible, token fresh per launch and never logged, only the policy FD inherited, no bridge fallback on PT failure/relaunch, snowflake consent rechecked, #30/#36/#56 lyrebird gates unchanged";
const mergeOnly =
  "Merge into main-dev after clear review at exact head with green CI (test-only, no deploy)";
const repeatedNegationCases = [1, 2, 3, 4].flatMap((count) =>
  [
    ["deploy agent-bridges", "deploy"],
    ["pay the invoice", "money"],
    ["rotate the API key", "secret"],
  ].map(([action, gate]) => ({
    text: `${"not ".repeat(count)}${action}`,
    gate: count % 2 === 0 ? gate : undefined,
  })),
);

const secretObjectPhrases = [
  "the secret token",
  "the secret password",
  "a secret API key",
  "the credential token",
  "a temporary production secret token",
  "users' tokens",
  "users’ tokens",
  "operators' API keys",
  "operators’ API keys",
  ...["users'", "users’", "operators'", "operators’"].flatMap((possessor) =>
    ["new tokens", "old API keys", "new production tokens", "ephemeral signing keys"].map(
      (object) => `${possessor} ${object}`,
    ),
  ),
];
const quotedSecretObjects = [
  ["'", "'"],
  ['"', '"'],
  ["‘", "’"],
  ["“", "”"],
].flatMap(([open, close]) => [
  ...["tokens", "the API key", "users' new tokens"].map((object) => `${open}${object}${close}`),
  ...["the ", "any ", "the new "].map((qualifier) => `${qualifier}${open}token${close}`),
]);
const secretObjectAsideCases = [
  ...secretObjectPhrases.flatMap((object) =>
    ["don't", "never"].flatMap((negation) =>
      [
        ["(", ")"],
        ["'", "'"],
        ["“", "”"],
      ].map(([open, close]) => `${open}${negation} share ${object}${close}`),
    ),
  ),
  ...quotedSecretObjects.map((object) => `(don't share ${object})`),
];
const negativeNounPhrases = [
  ["No LaunchAgent restart", "deploy"],
  ["No deployment restart", "deploy"],
  ["No release install", "deploy"],
  ["No deploy release", "deploy"],
  ["No payment charge", "money"],
  ["No purchase payment", "money"],
  ["No charge refund", "money"],
  ["No refund payment", "money"],
] as const;
const negativeCredentialPhrases = [
  "secret token",
  "secret tokens",
  "credential token",
  "password tokens",
].flatMap((object) => [`Create no ${object}`, `Create a report, no ${object} touched`]);

const affirmativeClauseCases = [
  ...secretObjectAsideCases.map((aside) => [`Generate ${aside} API key`, "secret"] as const),
  ...[
    "user key",
    "temporary key",
    "tokens and passwords",
    "tokens, passwords and API keys",
    "tokens and don't reveal passwords",
  ].map((object) => [`Generate (don't share ${object}) a token`, "secret"] as const),
  ["Create (don't share tokens and rotate the API key) a report", "secret"] as const,
  ["Don't share tokens and passwords; rotate the API key", "secret"] as const,
  ...["my", "your", "our", "their", "his", "her", "its", "John's", "John’s"].flatMap((possessor) =>
    ["never", "don't", "do not yet"].map(
      (negation) => [`Generate (${negation} share ${possessor} key) a token`, "secret"] as const,
    ),
  ),
  ...["Create", "Generate", "Store"].flatMap((verb) =>
    ["new", "a new", "(new)"].flatMap((qualifier) =>
      [",", ":", "—"].flatMap((separator) =>
        ["don't", "never"].map(
          (negation) =>
            [`${verb} ${qualifier}${separator} but ${negation} share tokens`, "secret"] as const,
        ),
      ),
    ),
  ),
  ...["Create", "Generate", "Store"].flatMap((verb) =>
    ["yet", "now", "at all", "under any circumstances"].flatMap((tail) =>
      [
        ["(", ")"],
        ["'", "'"],
        ["—", "—"],
      ].map(
        ([open, close]) =>
          [`${verb} ${open}don't share ${tail}${close} the API key`, "secret"] as const,
      ),
    ),
  ),
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    ["tokens", "passwords", "the API key"].flatMap((inside) =>
      ["never", "don't", "do not yet"].map(
        (negation) => [`${verb} (${negation} share ${inside}) a token`, "secret"] as const,
      ),
    ),
  ),
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    ["an ephemeral", "a single", "a temporary"].flatMap((qualifier) =>
      [
        ["(", ")"],
        ["[", "]"],
        ["'", "'"],
        ["—", "—"],
        ["--", "--"],
      ].flatMap(([open, close]) =>
        ["never", "don't", "do not yet"].map(
          (negation) =>
            [
              `${verb} ${qualifier} ${open}${negation} share${close} the API key`,
              "secret",
            ] as const,
        ),
      ),
    ),
  ),
  ["Prepare a no deploy signing release", "deploy"] as const,
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    ["and", "but", "or", "then", "and then", "but also"].flatMap((joiner) =>
      [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
        ["—", "—"],
        ["--", "--"],
      ].flatMap(([open, close]) =>
        ["don't", "never", "do not yet"].map(
          (negation) =>
            [`${verb} ${joiner} ${open}${negation} share${close} the API key`, "secret"] as const,
        ),
      ),
    ),
  ),
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    ["a ", "a new ", "the ", "new ", "a single ", "an ephemeral ", ""].flatMap((qualifier) =>
      ["no-share", "non-share", "no-store", "non-store"].map(
        (modifier) => [`${verb} ${qualifier}${modifier} token`, "secret"] as const,
      ),
    ),
  ),
  ...["API", "SSH", "private", "signing"].flatMap((type) =>
    ["non-", "non ", "no-", "not-"].flatMap((prefix) =>
      ["key", "keys"].map((noun) => [`Rotate the ${prefix}${type} ${noun}`, "secret"] as const),
    ),
  ),
  ...["no-", "non-", "no ", "non "].flatMap((prefix) => [
    [`Perform a ${prefix}restart deployment`, "deploy"] as const,
    [`Prepare a ${prefix}deploy release`, "deploy"] as const,
    [`Process a ${prefix}refund payment`, "money"] as const,
  ]),
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
      ["—", "—"],
      ["–", "–"],
      ["--", "--"],
      ["'", "'"],
      ['"', '"'],
    ].flatMap(([open, close]) =>
      ["don't", "never", "do not yet"].map(
        (negation) => [`${verb} ${open}${negation} share${close} the API key`, "secret"] as const,
      ),
    ),
  ),
  ...["not without", "never without", "don't not", "do not not", "not non-"].flatMap((prefix) => [
    [`Merge, but ${prefix} a production deploy`, "deploy"] as const,
    [`Review, but ${prefix} a payment`, "money"] as const,
    [`${prefix} rotate the API key`, "secret"] as const,
  ]),
  ...["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
    ["but", "and", "or", "then", "and then", "but also"].flatMap((joiner) =>
      [" ", ", ", ": ", " — ", " – ", " -- "].flatMap((separator) =>
        ["don't", "never", "do not yet"].map(
          (negation) =>
            [`${verb}${separator}${joiner} ${negation} share the API key`, "secret"] as const,
        ),
      ),
    ),
  ),
  ["Don't delay deployment", "deploy"] as const,
  ["Do not defer payment", "money"] as const,
  ["Without hesitation deploy edge-api", "deploy"] as const,
  ["Without delay pay the invoice", "money"] as const,
  ["No objections rotate the API key", "secret"] as const,
  ["Non-prod deploy edge-api", "deploy"] as const,
  ["Non-production payment", "money"] as const,
  ["Rotate the non-production API key", "secret"] as const,
  ...[
    " but ",
    " and ",
    " or ",
    " then ",
    " yet ",
    " however ",
    " instead ",
    " rather ",
    " except ",
    " so ",
    " thus ",
    " hence ",
    " therefore ",
    " otherwise ",
    " -- ",
    "--",
    " — ",
    " – ",
    "\n",
    "\r\n",
  ].flatMap((separator) => [
    [`No payment${separator}deploy edge-api`, "deploy"] as const,
    [`No deploy${separator}pay the invoice`, "money"] as const,
    [`No tokens${separator}rotate the API key`, "secret"] as const,
  ]),
  ...[
    "Not only",
    "Not just",
    "Not merely",
    "Don't forget to",
    "Never fail to",
    "Don't hesitate to",
    "Don't neglect to",
    "Don't skip",
    "Don't avoid",
    "Don't omit",
    "Don't stop",
    "Don't cancel",
    "Don't refuse to",
    "Don't delay",
    "Do not defer",
    "Don't postpone",
    "Don't block",
    "Don't prevent",
    "Don't pause",
    "Don't suspend",
    "Don't hinder",
    "Don't discourage",
    "Don't interrupt",
  ].flatMap((prefix) => [
    [`${prefix} deploy edge-api`, "deploy"] as const,
    [`${prefix} pay the invoice`, "money"] as const,
    [`${prefix} rotate the API key`, "secret"] as const,
  ]),
];

const negatedSecretCases = ["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
  ["never", "do not", "don't", "do not yet"].flatMap((negation) =>
    ["share tokens", "reveal passwords", "rotate the API key"].map(
      (action) => `${verb} a report, ${negation} ${action}`,
    ),
  ),
);
const negatedAsideCases = ["Create", "Generate", "Store", "Issue"].flatMap((verb) =>
  [
    ["(", ")"],
    ["[", "]"],
    ["'", "'"],
    ["—", "—"],
    ["--", "--"],
  ].flatMap(([open, close]) =>
    ["never", "don't", "do not yet", "without", "not"].flatMap((negation) =>
      [
        "share tokens",
        "reveal passwords",
        "rotate the API key",
        "sharing tokens",
        "revealing passwords",
        "rotating the API key",
        "share my key",
        "share John's token",
        "share John’s password",
      ].map((action) => `${verb} ${open}${negation} ${action}${close} a report`),
    ),
  ),
);

const negatedGateCases = [
  ...negativeCredentialPhrases,
  ...secretObjectAsideCases.map((aside) => `Create ${aside} a report`),
  ...negativeNounPhrases.map(([text]) => text),
  "Create (don't share user key) a report",
  "Create (don't share tokens and passwords) a report",
  "Create (don't share tokens and don't reveal passwords) a report",
  "Create (never share tokens yet) a report",
  "Create 'never share John's tokens' a report",
  ...negatedAsideCases,
  ...["No", "Not", "Without"].flatMap((negation) =>
    [
      "restarting the LaunchAgent",
      "installing the release",
      "deploying the deployment",
      "refunding the charge",
      "purchasing the payment",
      "paying the charge",
    ].map((action) => `${negation} ${action}`),
  ),
  ...["Don't", "Do not", "Never", "Do not yet"].flatMap((negation) =>
    [
      "restart the deployment",
      "pay the charge",
      "pay the payment",
      "refund the charge",
      "charge the purchase",
    ].map((action) => `${negation} ${action}`),
  ),
  ...["Don't", "Do not", "Never", "Do not yet"].flatMap((negation) =>
    ["restart the LaunchAgent", "deploy the new release", "install a release"].map(
      (action) => `${negation} ${action}`,
    ),
  ),
  ...negatedSecretCases,
  mergeOnly,
  "Merge the PR without installing anything",
  "No restart needed",
  "Not a release; docs only",
  "Tag only, no-deploy",
  "No payment involved",
  "Review only, no tokens touched",
  "Once a live build has the merge: read back that a new 'Merge … (test-only, no deploy)' evaluator subtask has no gate, then tell reporter thread dc4a4551 with a stable clientRequestId and record the send here",
  "No prod deploy",
  "Without any restart",
  "No planned production deploy",
  "No money transfer",
  "No purchase needed",
  "No charge involved",
  "No refunds needed",
  "Not a release; release the emulator when done",
  "Rotate no API keys",
  "Store without any tokens",
  "Provide no signing key",
  ...["Do not yet", "Don't yet", "Not just yet", "Not quite yet"].flatMap((prefix) =>
    ["deploy edge-api", "pay the invoice", "rotate the API key"].map(
      (action) => `${prefix} ${action}`,
    ),
  ),
  ...[
    "no",
    "not",
    "non",
    "without",
    "never",
    "don't",
    "don’t",
    "dont",
    "do not",
    "doesn't",
    "doesn’t",
    "won't",
    "won’t",
    "nothing to",
  ].flatMap((negation) =>
    ["deploy", "pay the invoice", "rotate the API key"].map((action) => `${negation} ${action}`),
  ),
  ...["no", "non"].flatMap((negation) =>
    ["deploy", "payment", "tokens"].map((keyword) => `${negation}-${keyword}`),
  ),
];

const resourceReleaseCases = [
  ["Release the device software to production", "deploy"],
  ["Release the phone's firmware to production", "deploy"],
  ["Release the phone’s firmware to production", "deploy"],
  ["Release the devices' software to production", "deploy"],
  ["Release the devices’ software to production", "deploy"],
  ["Release the device operating system", "deploy"],
  ["Release the phone mobile app", "deploy"],
  ["Release the box container image", "deploy"],
  ["Release the device v2", "deploy"],
  ["Release the device something new", "deploy"],
  ["Release the phone-app to production", "deploy"],
  ["Release the device.software to production", "deploy"],
  ["Release the phone/firmware to production", "deploy"],
  ["Release the device\nsoftware to production", "deploy"],
  ["Release the device\r\nsoftware to production", "deploy"],
  ["Release the device\tsoftware to production", "deploy"],
  ["Release the phone hold firmware to production", "deploy"],
  ["Release the phone hold to production", "deploy"],
  ["Release the phone hold/lock software to production", "deploy"],
  ["Release the emulator when done shipping software", "deploy"],
  ["Release the device after the run to production", "deploy"],
  ["Release the device and its software", "deploy"],
  ["Release the device; release the phone's firmware to production", "deploy"],
  ["Release the emulator when done; Release the device software to production", "deploy"],
  ["Release the phone hold when done", undefined],
  ["Release the phone hold/lock after the run", undefined],
  ["Release the device after the run.", undefined],
  ["Release the emulator when done!", undefined],
  ["Release the phone?", undefined],
  ["Release the Run Cloud session; read back its status", undefined],
  ["Release the device. Release the phone hold/lock.", undefined],
] as const;

describe("inferGate", () => {
  it.each(repeatedNegationCases)("counts repeated negation: $text", ({ text, gate }) => {
    expect(inferGate(text)).toBe(gate);
  });
  it.each([40, 80, 160])("handles %i punctuation characters without backtracking", (length) => {
    const start = performance.now();
    expect(inferGate(`Create ${"-".repeat(length)} a report, never share tokens`)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it.each(affirmativeClauseCases)("keeps the next affirmative clause: %s → %s", (text, gate) => {
    expect(inferGate(text)).toBe(gate);
  });

  it.each(negatedGateCases)("ignores negated gate wording: %s", (text) => {
    expect(inferGate(text)).toBeUndefined();
  });

  it.each([
    ["Deploy agent-bridges", "deploy"],
    ["Merge, then restart the LaunchAgent", "deploy"],
    ["No docs change; deploy edge-api to dev", "deploy"],
    ["No deploy to prod; restart agent-bridges", "deploy"],
    ["Deploy edge-api; no restart needed", "deploy"],
    ["Not a release; deploy edge-api", "deploy"],
    ["No deploy; release the phone app", "deploy"],
    ["Don't restart the LaunchAgent; deploy edge-api", "deploy"],
    ["Don't deploy the new release; restart Robob", "deploy"],
    ["Don't pay the charge; refund the invoice", "money"],
    ["Don't restart the deployment; deploy edge-api", "deploy"],
    ["Pay the invoice", "money"],
    ["No payment involved; refund the customer", "money"],
    ["Purchase the license; no refunds", "money"],
    ["No deploy; pay the invoice", "money"],
    ["No charge; rotate the API key", "secret"],
    ["Rotate the API key", "secret"],
    ["Don't share tokens; rotate the API key", "secret"],
    ["Rotate the API key; never share tokens", "secret"],
    ["Store no tokens; provide the password", "secret"],
    ["Share no tokens but the password", "secret"],
    ["Share no passwords but tokens", "secret"],
    ["Rotate no API keys but the signing key", "secret"],
    ["Create a report, never share tokens, then rotate the API key", "secret"],
    ["Do not create a report, then rotate the API key", "secret"],
    ...[".", ";", ",", ":", "!", "?"].map(
      (separator) => [`No docs change${separator} deploy edge-api`, "deploy"] as const,
    ),
    ["No deployment: restart agent-bridges", "deploy"],
    ["No payments, charge the card", "money"],
    ["No password; give the token to CI", "secret"],
  ] as const)("keeps real gate mentions: %s → %s", (text, gate) => {
    expect(inferGate(text)).toBe(gate);
  });

  it.each([
    ...resourceReleaseCases,
    ["Rotate the Linear API key", "secret"],
    ["Store the new token in Keychain", "secret"],
    ["Provide the signing key to CI", "secret"],
    ["share the secret with Moni", "secret"],
    ["Enter the password", "secret"],
    ["Paste credentials", "secret"],
    ["Set the API keys", "secret"],
    ["Create a private key", "secret"],
    ["Generate SSH keys", "secret"],
    ["Issue tokens", "secret"],
    ["Regenerate secrets", "secret"],
    ["Revoke the key", "secret"],
    ["Reveal passwords", "secret"],
    ["Send the credential", "secret"],
    ["Give the token to CI", "secret"],
    ["Hand over the secret", "secret"],
    ["Add a signing key", "secret"],
    [torsshReview, undefined],
    ["token fresh per launch and never logged", undefined],
    ["check the key decisions in the doc", undefined],
    ["primary key migration test", undefined],
    ["verify tokens are redacted in logs", undefined],
    ["Store the report. Check the token", undefined],
    ["Create the report; verify credentials", undefined],
    ["Generate a report\nCheck the key", undefined],
    ["Regenerate the report", undefined],
    [`Store${" ".repeat(40)}token`, "secret"],
    [`Store${" ".repeat(41)}token`, undefined],
    ["Release the Run Cloud session", undefined],
    ["release the emulator", undefined],
    ["release the phone hold/lock", undefined],
    ["release the box", undefined],
    ["released the session", undefined],
    ["release session", undefined],
    ["release the sim", undefined],
    ["release the simulator", undefined],
    ["release the hold", undefined],
    ["release the lock", undefined],
    ["release the slot", undefined],
    ["release the device", undefined],
    ["release the boxes", undefined],
    ["release the phone", undefined],
    ["Release the emulator when done", undefined],
    ["release the device after the run", undefined],
    ["release the phone hold", undefined],
    ["Release the phone app to production", "deploy"],
    ["Release the device firmware to production", "deploy"],
    ["release the box image to users", "deploy"],
    ["Release a device build to TestFlight", "deploy"],
    ...[
      "app",
      "apps",
      "firmware",
      "build",
      "builds",
      "binary",
      "binaries",
      "image",
      "images",
      "update",
      "updates",
      "version",
      "versions",
      "release",
      "releases",
    ].map((object) => [`Release the device ${object}`, "deploy"] as const),
    ...["Release", "Releases", "Released"].flatMap((verb) => [
      [`${verb} the phone app`, "deploy"] as const,
      [`${verb} the device to production`, "deploy"] as const,
    ]),
    ["release the box to users", "deploy"],
    ["Release a device to TestFlight", "deploy"],
    ["Release the Run Cloud session; release the phone app to production", "deploy"],
    ["Release the device firmware; release the emulator when done", "deploy"],
    ["Release the emulator when done; release the device after the run", undefined],
    ...["", "the ", "a ", "an "].flatMap((article) =>
      [
        "Run Cloud session",
        "session",
        "emulator",
        "sim",
        "simulator",
        "box",
        "hold",
        "lock",
        "slot",
        "phone hold/lock",
        "device",
      ].map((resource) => [`Release ${article}${resource}`, undefined] as const),
    ),
    ["Install the Robob release", "deploy"],
    ["cut release 0.4.2", "deploy"],
    ["deploy spectrum-bridge", "deploy"],
    ["restart agent-bridges", "deploy"],
  ] as const)("%s → %s", (text, gate) => expect(inferGate(text)).toBe(gate));
});

describe("price and resource-release wording", () => {
  it.each([
    ...["$0.28", "€5", "£12", "$ 5"].map((amount) => `Approve ${amount} total`),
    ...["USD", "AED", "EUR", "GBP", "dirham", "dirhams", "dollar", "dollars"].flatMap(
      (currency) => [
        `Approve ${currency} 45 order`,
        `Approve 12 ${currency}`,
        `Approve 0.02 ${currency}/min`,
        `Approve ${currency}0.28 total`,
      ],
    ),
    "spend up to $5",
    "Approve spending on probes",
    "The sessions are billed per minute",
    "Approve billing for the probes",
  ])("recognizes money: %s", (text) => expect(inferGate(text)).toBe("money"));

  it.each([
    "no spend, dry run only",
    "No spending",
    "No billing",
    "Without paying",
    "No $5 payment",
    "Without AED 45",
    "No 12 USD",
    "Prepare a cost study",
    "Note the session minutes on the card",
    "Note USD rates and 7 session minutes",
    "Record 12 USDT",
  ])("keeps harmless wording ungated: %s", (text) => expect(inferGate(text)).toBeUndefined());

  it.each(
    [
      "session",
      "sessions",
      "emulator",
      "emulators",
      "sim",
      "sims",
      "simulator",
      "simulators",
      "box",
      "boxes",
      "device",
      "devices",
      "phone",
      "phones",
      "hold",
      "holds",
      "lock",
      "locks",
      "slot",
      "slots",
    ].flatMap((resource) =>
      ["both", "them", "each", "all", "it"].flatMap((reference) =>
        ["", " when done", ` ${resource}`, ` ${resource} when done`].map(
          (suffix) => `Use the ${resource}, then release ${reference}${suffix}`,
        ),
      ),
    ),
  )("recognizes a resource reference: %s", (text) => expect(inferGate(text)).toBeUndefined());

  it.each([
    "Release v0.1.12 to both clients",
    "Build it, then release them",
    ...["both", "them", "each", "all", "it"].flatMap((reference) => [
      `Release ${reference}`,
      `Release ${reference} when done`,
      `Release ${reference} sessions`,
      `Release ${reference}, then use two sessions`,
      `Use two sessions, then release ${reference} to production`,
      `Use two sessions, then release ${reference} apps`,
      `Use two sessions, then release ${reference} sessions software`,
    ]),
    "Use two sessions and release both; release v0.1.12",
  ])("preserves deploy wording: %s", (text) => expect(inferGate(text)).toBe("deploy"));

  it("recognizes the reported resource cleanup", () => {
    expect(inferGate("Create two sessions and release both")).toBeUndefined();
  });

  it.each(["evaluator", "script"] as const)("keeps minutes ungated for %s steps", (owner) => {
    expect(
      gateOf({ owner, text: "Note the session minutes on the card" }, ["money", "deploy"]),
    ).toBeUndefined();
  });
});

describe("board gate guessing", () => {
  const cases = [
    ["Tag the main-dev tip and dev-deploy it", "deploy"],
    ["Pay the invoice", "money"],
    ["Share the API key", "secret"],
  ] as const;
  const policies = [
    undefined,
    [],
    ["deploy"],
    ["money"],
    ["secret"],
    ["money", "secret"],
    ["deploy", "money", "secret"],
  ] as const;

  for (const guessedGates of policies) {
    for (const owner of ["evaluator", "script"] as const) {
      it.each(cases)(`${owner}, guesses ${JSON.stringify(guessedGates)}: %s`, (text, kind) => {
        const subtask: KanbanSubtask = {
          id: "s1",
          step: 1,
          text,
          owner,
          state: "open",
          note: null,
          doneBy: null,
          doneAt: null,
        };
        const card = { number: 3329, asks: [], createdAt: at, subtasks: [subtask] };
        const expected =
          guessedGates === undefined || guessedGates.some((gate) => gate === kind)
            ? kind
            : undefined;
        expect(gateOf(subtask, guessedGates)).toBe(expected);
        expect(approvalProblem(card, subtask, [], guessedGates) === null).toBe(
          expected === undefined,
        );
        for (const gate of ["deploy", "money", "secret"] as const) {
          const stored = { ...subtask, gate };
          expect(gateOf(stored, guessedGates)).toBe(gate);
          expect(
            approvalProblem({ ...card, subtasks: [stored] }, stored, [], guessedGates),
          ).toContain("needs Abdullah's approval");
        }
        const plan = planSubtasks([], [{ text, owner }], 0, at, guessedGates);
        expect(plan.ok).toBe(true);
        if (plan.ok) expect(plan.subtasks[0]!.gate).toBe(expected);
        const explicit = planSubtasks([], [{ text, owner, gate: kind }], 0, at, guessedGates);
        expect(explicit).toMatchObject({ ok: true, subtasks: [{ gate: kind }] });
        const edited = planSubtasks([subtask], [{ id: "s1", text }], 1, at, guessedGates);
        expect(edited.ok).toBe(true);
        if (edited.ok) expect(edited.subtasks[0]!.gate).toBe(expected);
        const legacy = planSubtasks(
          [{ ...subtask, gate: kind }],
          [{ id: "s1", text: "Read back" }],
          1,
          at,
          guessedGates,
        );
        expect(legacy).toMatchObject({ ok: true, subtasks: [{ gate: kind }] });
      });
    }
  }
});

it("disabled guesses do not make a stored deploy gate's unnamed approval ambiguous", () => {
  const action: KanbanSubtask = {
    id: "s1",
    step: 1,
    text: "Tag the main-dev tip and dev-deploy it",
    owner: "evaluator",
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  };
  const production = {
    ...action,
    id: "s2",
    step: 2,
    text: "Deploy production",
    gate: "deploy" as const,
  };
  const card = {
    number: 3329,
    createdAt: at,
    subtasks: [action, production],
    asks: [
      {
        id: "q1",
        text: "Deploy production?",
        blocking: false,
        by: owner,
        at,
        seq: null,
        closedAt: at,
        answer: { verdict: "approved" as const, by: owner, at },
      },
    ],
  };
  expect(approvalProblem(card, production, [], ["money", "secret"])).toBeNull();
  expect(approvalProblem(card, production)).toContain("needs Abdullah's approval");
});

describe("approvalProblem", () => {
  const card = { number: 8, asks: [], createdAt: at, subtasks: [] };
  const subtask: KanbanSubtask = {
    id: "s4",
    step: 4,
    text: torsshReview,
    owner: "review",
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  };
  it.each(repeatedNegationCases)(
    "plans and enforces repeated negation: $text",
    ({ text, gate }) => {
      const plan = planSubtasks([], [{ text, owner: "evaluator" }], 0, at);
      if (!plan.ok) throw new Error(plan.reason);
      const action = plan.subtasks[0]!;
      expect(action.gate).toBe(gate);
      const problem = approvalProblem({ ...card, subtasks: plan.subtasks }, action);
      if (gate === undefined) expect(problem).toBeNull();
      else expect(problem).toContain("needs Abdullah's approval");
    },
  );

  it.each(affirmativeClauseCases)(
    "persists and enforces the next clause's gate: %s → %s",
    (text, gate) => {
      const plan = planSubtasks([], [{ text, owner: "evaluator" }], 0, at);
      if (!plan.ok) throw new Error(plan.reason);
      const action = plan.subtasks[0]!;
      expect(action.gate).toBe(gate);
      expect(approvalProblem({ ...card, subtasks: plan.subtasks }, action)).toContain(
        "needs Abdullah's approval",
      );
    },
  );

  it.each(["evaluator", "script"] as const)(
    "allows a %s merge-only subtask without asks, retaining stored gates",
    (owner) => {
      const action = { ...subtask, owner, text: mergeOnly };
      const mergeCard = { ...card, subtasks: [action] };
      expect(approvalProblem(mergeCard, action)).toBeNull();
      for (const gate of ["deploy", "money", "secret"] as const) {
        const stored = { ...action, gate };
        expect(gateOf(stored)).toBe(gate);
        expect(approvalProblem({ ...mergeCard, subtasks: [stored] }, stored)).toContain(
          "needs Abdullah's approval",
        );
      }
    },
  );

  it.each(
    resourceReleaseCases.flatMap(([text, gate]) =>
      (["evaluator", "script"] as const).map((owner) => ({ text, gate, owner })),
    ),
  )("checks no-ask $owner resource release: $text", ({ text, gate, owner }) => {
    const action = { ...subtask, owner, text };
    expect(gateOf(action)).toBe(gate);
    const problem = approvalProblem({ ...card, subtasks: [action] }, action, []);
    if (gate === "deploy") expect(problem).toContain("needs Abdullah's approval");
    else expect(problem).toBeNull();
  });

  it.each([undefined, "secret", "deploy", "money"] as const)(
    "allows a read-only review with stored gate %s and no asks",
    (gate) => {
      const review = { ...subtask, ...(gate === undefined ? {} : { gate }) };
      expect(gateOf(review)).toBeUndefined();
      expect(approvalProblem(card, review, [])).toBeNull();
    },
  );

  it.each(["evaluator", "script"] as const)(
    "still requires approval for real actions owned by %s",
    (owner) => {
      for (const [text, gate] of [
        ["Rotate the Linear API key", "secret"],
        ["Deploy spectrum-bridge", "deploy"],
        ["Purchase the license", "money"],
      ] as const) {
        const action = { ...subtask, owner, text };
        expect(gateOf(action)).toBe(gate);
        expect(approvalProblem(card, action, [])).toContain("needs Abdullah's approval");
        expect(gateOf({ ...action, text: "Do it", gate })).toBe(gate);
      }
    },
  );

  it.each([
    {
      text: "Implement: card_move keeps (re-stamps) or clears the wait; auto-keep for completed/deployed with open evaluator/script subtasks",
      gate: "deploy",
    },
    {
      text: "Focused tests per packet (stale-net wakes, restart doesn't void) + targeted typecheck/lint; open a PR",
    },
    {
      text: "Add gh to the crpko-devops toolchain: install in offbox_crpko_tools",
      gate: "deploy",
    },
    {
      text: "Diagnose why --base torssh:torssh-skeleton-n01 picked boat at 18:40 and server at 18:44 (file:line + logs); answer whether Boat bases were meant to carry over to home; confirm nothing stayed allocated for runs 71da and 8df9; write FINDINGS.md",
      gate: "deploy",
      createdAt: "2026-10-27T12:00:00.000Z",
    },
    {
      text: "money-cases 'charge unconfirmed' case; Push, link the PR",
      gate: "money",
    },
  ] as const)("allows worker sighting: $text", (entry) => {
    const work = { ...subtask, ...entry, owner: "work" as const };
    expect(gateOf(work)).toBeUndefined();
    expect(approvalProblem({ ...card, subtasks: [work] }, work, [])).toBeNull();
  });

  const deploy = (id: string): KanbanSubtask => ({
    ...subtask,
    id,
    owner: "evaluator",
    text: "Restart Robob so the fix goes live",
    gate: "deploy",
    createdAt: at,
  });
  const approvedAsk = (text: string): KanbanOwnerAsk => ({
    id: "q1",
    text,
    blocking: false,
    by: owner,
    at,
    seq: null,
    closedAt: at,
    answer: { verdict: "approved", by: owner, at },
  });

  it.each([
    ...negativeCredentialPhrases,
    ...secretObjectAsideCases.map((aside) => `Create ${aside} a report`),
    ...negatedSecretCases,
    ...negatedAsideCases,
    "Create (don't share user key) a report",
    "Create (don't share tokens and passwords) a report",
    "Create (don't share tokens and don't reveal passwords) a report",
    "Create (never share tokens yet) a report",
    "Create 'never share John's tokens' a report",
  ])("does not reattach negated secret objects in an ask: %s", (text) => {
    const action = {
      ...subtask,
      owner: "evaluator" as const,
      text: "Share tokens",
      gate: "secret" as const,
    };
    expect(
      approvalProblem({ ...card, subtasks: [action], asks: [approvedAsk(`${text}?`)] }, action),
    ).toContain(
      'q1 was approved but doesn\'t name s4; ask again naming the subtask id (e.g. "Approve s4")',
    );
  });

  it.each([
    ["deploy", "Don't deploy yet?", "Deploy now?"],
    ["money", "No payment needed?", "Pay the invoice?"],
    ["secret", "Never share the token?", "Share the token?"],
    ...["No", "Not", "Without"].flatMap((negation) => [
      ...["restarting the LaunchAgent", "installing the release", "deploying the deployment"].map(
        (action) => ["deploy", `${negation} ${action}?`, "Deploy edge-api?"] as const,
      ),
      ...["refunding the charge", "purchasing the payment", "paying the charge"].map(
        (action) => ["money", `${negation} ${action}?`, "Pay the invoice?"] as const,
      ),
    ]),
    ...["Don't", "Do not", "Never", "Do not yet"].flatMap((negation) => [
      ["deploy", `${negation} restart the deployment?`, "Deploy edge-api?"] as const,
      ...["pay the charge", "pay the payment", "refund the charge", "charge the purchase"].map(
        (action) => ["money", `${negation} ${action}?`, "Pay the invoice?"] as const,
      ),
    ]),
    ...["Don't", "Do not", "Never", "Do not yet"].flatMap((negation) =>
      ["restart the LaunchAgent", "deploy the new release", "install a release"].map(
        (action) => ["deploy", `${negation} ${action}?`, "Deploy edge-api?"] as const,
      ),
    ),
    ...["Do not yet", "Don't yet", "Not just yet", "Not quite yet"].flatMap((prefix) => [
      ["deploy", `${prefix} deploy edge-api?`, "Deploy edge-api?"] as const,
      ["money", `${prefix} pay the invoice?`, "Pay the invoice?"] as const,
      ["secret", `${prefix} rotate the API key?`, "Rotate the API key?"] as const,
    ]),
  ] as const)("does not match a negated unnamed %s ask", (gate, negative, positive) => {
    const action = { ...subtask, owner: "evaluator" as const, text: "Do it", gate };
    const gatedCard = { ...card, subtasks: [action] };
    expect(approvalProblem({ ...gatedCard, asks: [approvedAsk(negative)] }, action)).toContain(
      'q1 was approved but doesn\'t name s4; ask again naming the subtask id (e.g. "Approve s4")',
    );
    expect(approvalProblem({ ...gatedCard, asks: [approvedAsk(positive)] }, action)).toBeNull();
  });

  it.each([
    ["'", "'"],
    ['"', '"'],
    ["‘", "’"],
    ["“", "”"],
  ])("consumes quoted negative objects with %s%s", (open, close) => {
    for (const [verb, object, gate] of [
      ["restart", "LaunchAgent", "deploy"],
      ["pay", "charge", "money"],
      ["share", "tokens", "secret"],
    ] as const) {
      for (const qualifier of ["", "the ", "any ", "the new "]) {
        const text = `Don't ${verb} ${qualifier}${open}${object}${close}`;
        expect(inferGate(text)).toBeUndefined();
        const action = { ...subtask, owner: "evaluator" as const, text: "Do it", gate };
        expect(
          approvalProblem({ ...card, subtasks: [action], asks: [approvedAsk(`${text}?`)] }, action),
        ).toContain(
          'q1 was approved but doesn\'t name s4; ask again naming the subtask id (e.g. "Approve s4")',
        );
        expect(inferGate(`${text}; ${verb} ${object}`)).toBe(gate);
      }
    }
  });

  it.each(negativeNounPhrases)(
    "keeps the negative noun phrase %s out of approvals",
    (text, gate) => {
      for (const owner of ["evaluator", "script"] as const) {
        const plan = planSubtasks([], [{ text, owner }], 0, at);
        if (!plan.ok) throw new Error(plan.reason);
        const action = plan.subtasks[0]!;
        expect(action.gate).toBeUndefined();
        expect(approvalProblem({ ...card, subtasks: plan.subtasks }, action)).toBeNull();
        const explicit = { ...action, text: "Do it", gate };
        expect(
          approvalProblem(
            { ...card, subtasks: [explicit], asks: [approvedAsk(`${text}?`)] },
            explicit,
          ),
        ).toContain(
          `q1 was approved but doesn't name ${explicit.id}; ask again naming the subtask id (e.g. "Approve ${explicit.id}")`,
        );
      }
    },
  );

  it.each([
    {
      text: "Approve s1 and s4, the coding steps; the deploy stays separate",
      action: "Ask Abdullah before restarting Robob",
      work: [
        {
          id: "s1",
          text: "Implement: card_move keeps (re-stamps) or clears the wait; auto-keep for completed/deployed with open evaluator/script subtasks",
        },
        {
          id: "s4",
          text: "Focused tests per packet (stale-net wakes, restart doesn't void) + targeted typecheck/lint; open a PR",
        },
      ],
    },
    {
      text: "Approve marking source-edit step s1 complete? The board misclassified the installer function edit as a live deploy.",
      action: "Ask Abdullah before running integrations/offbox/install.zsh",
      work: [
        { id: "s1", text: "Add gh to the crpko-devops toolchain: install in offbox_crpko_tools" },
      ],
    },
  ])("does not approve the real s7 gate: $text", ({ text, action, work: inputs }) => {
    const s7 = { ...deploy("s7"), text: action };
    const work = inputs.map((input) => ({ ...deploy(input.id), ...input, owner: "work" as const }));
    expect(
      approvalProblem({ ...card, subtasks: [...work, s7], asks: [approvedAsk(text)] }, s7, []),
    ).toContain("needs Abdullah's approval");
  });

  it("uses unnamed wording only for the single eligible gate", () => {
    const s5 = deploy("s5");
    const s7 = deploy("s7");
    const asks = [approvedAsk("Restart Robob now?")];
    expect(approvalProblem({ ...card, subtasks: [s5], asks }, s5, [])).toBeNull();
    for (const subtask of [s5, s7]) {
      expect(approvalProblem({ ...card, subtasks: [s5, s7], asks }, subtask, [])).toContain(
        `q1 was approved but doesn't name ${subtask.id}; ask again naming the subtask id (e.g. "Approve ${subtask.id}")`,
      );
    }
    const named = { ...card, subtasks: [s5, s7], asks: [approvedAsk("Approve s5")] };
    expect(approvalProblem(named, s5, [])).toBeNull();
    expect(approvalProblem(named, s7, [])).toContain("approval");
    const both = { ...named, asks: [approvedAsk("Approve s5 and s7")] };
    expect(approvalProblem(both, s5, [])).toBeNull();
    expect(approvalProblem(both, s7, [])).toBeNull();
  });

  it.each(["title", "summary"] as const)("matches ids named only in %s", (field) => {
    const s5 = deploy("s5");
    const s7 = deploy("s7");
    const ask = approvedAsk("Restart Robob now?");
    const named = {
      ...ask,
      ...(field === "title" ? { title: "Approve s5" } : { action: { summary: "Approve s5" } }),
    };
    const namedCard = { ...card, subtasks: [s5, s7], asks: [named] };
    expect(approvalProblem(namedCard, s5, [])).toBeNull();
    expect(approvalProblem(namedCard, s7, [])).toContain("approval");
  });

  it.each(["skipped", "future", "done", "legacy", "work", "review"] as const)(
    "counts eligible fallback candidates: %s",
    (kind) => {
      const s5 = deploy("s5");
      const s7 = {
        ...deploy("s7"),
        ...(kind === "skipped" || kind === "done" ? { state: kind } : {}),
        ...(kind === "work" || kind === "review" ? { owner: kind } : {}),
        ...(kind === "future" ? { createdAt: "2026-10-27T12:00:00.000Z" } : {}),
        ...(kind === "legacy" ? { createdAt: undefined } : {}),
      };
      const result = approvalProblem(
        { ...card, subtasks: [s5, s7], asks: [approvedAsk("Restart Robob now?")] },
        s5,
        [],
      );
      if (kind === "done" || kind === "legacy") expect(result).toContain("approval");
      else expect(result).toBeNull();
    },
  );

  it("does not match an unknown named id or a partial id through gate wording", () => {
    const s5 = deploy("s5");
    for (const text of ["Restart s99 now?", "Restart s50 now?"]) {
      expect(
        approvalProblem({ ...card, subtasks: [s5], asks: [approvedAsk(text)] }, s5, []),
      ).toContain("approval");
    }
  });

  it("does not apply an unnamed ask to a skipped gate even when another gate is the only candidate", () => {
    const s5 = { ...deploy("s5"), state: "skipped" as const };
    const s7 = deploy("s7");
    for (const subtasks of [[s5], [s5, s7]]) {
      expect(
        approvalProblem({ ...card, subtasks, asks: [approvedAsk("Restart Robob now?")] }, s5, []),
      ).toContain("approval");
      expect(
        approvalProblem({ ...card, subtasks, asks: [approvedAsk("Approve s5")] }, s5, []),
      ).toBeNull();
    }
  });

  it("still denies a deploy action after a dropped ask", () => {
    expect(
      approvalProblem(
        {
          ...card,
          asks: [
            {
              id: "q1",
              text: "Restart agent-bridges for s4?",
              blocking: false,
              by: owner,
              at,
              seq: null,
              closedAt: at,
              answer: { verdict: "dropped", by: owner, at },
            },
          ],
        },
        { ...subtask, owner: "evaluator", text: "Restart agent-bridges", gate: "deploy" },
        [],
      ),
    ).toContain("a dropped ask is not approval");
  });
});

const flow = [
  { text: "Write the PR", owner: "work" },
  { text: "Review", owner: "review" },
  { text: "Merge and deploy", owner: "evaluator" },
  { text: "Tell the reporter", owner: "evaluator" as const, step: 4 },
  { text: "Update linked tickets", owner: "evaluator" as const, step: 4 },
  { text: "Read back", owner: "evaluator" },
] as const;

const planned = () => {
  const plan = planSubtasks([], flow);
  if (!plan.ok) throw new Error(plan.reason);
  return plan.subtasks;
};

describe("planSubtasks", () => {
  it.each(["done", "skipped"] as const)("keeps listed %s history unchanged", (state) => {
    const known: KanbanSubtask = {
      ...planned()[2]!,
      step: 7,
      owner: "script",
      script: "land",
      gate: "deploy",
      createdAt: at,
      state,
      note: "PR #4",
      doneBy: owner,
      doneAt: at,
    };
    for (const text of ["x", "", "x".repeat(501)]) {
      const plan = planSubtasks(
        [known],
        [{ id: known.id, text, owner: "work", step: -1, gate: "money", script: "other" }],
        3,
        "2026-10-27T12:00:00.000Z",
      );
      expect(plan).toEqual({ ok: true, subtasks: [known], subtaskSeq: 3 });
    }
  });

  it.each(["evaluator", "script"] as const)(
    "keeps an open %s subtask unchanged with an id alone",
    (owner) => {
      const known: KanbanSubtask = {
        ...planned()[2]!,
        step: 7,
        owner,
        gate: "deploy",
        createdAt: at,
        ...(owner === "script" ? { script: "land" } : {}),
      };
      expect(planSubtasks([known], [{ id: known.id }], 3)).toEqual({
        ok: true,
        subtasks: [known],
        subtaskSeq: 3,
      });
    },
  );

  it("rewords an open id while keeping its omitted owner and step", () => {
    const known = { ...planned()[0]!, step: 7 };
    const plan = planSubtasks([known], [{ id: known.id, text: "  Write the fix  " }]);
    expect(plan.ok && plan.subtasks).toEqual([{ ...known, text: "Write the fix" }]);
  });

  it("changes an open id's owner while keeping its omitted text and step", () => {
    const known = { ...planned()[0]!, step: 7 };
    const plan = planSubtasks([known], [{ id: known.id, owner: "review" }]);
    expect(plan.ok && plan.subtasks).toEqual([{ ...known, owner: "review" }]);
  });

  it("applies a gate to an open id with omitted text and owner", () => {
    const known = { ...planned()[3]!, step: 7 };
    const plan = planSubtasks([known], [{ id: known.id, gate: "money" }], 4, at);
    expect(plan.ok && plan.subtasks).toEqual([{ ...known, gate: "money", createdAt: at }]);
    expect(planSubtasks([planned()[0]!], [{ id: "s1", gate: "money" }])).toMatchObject({
      ok: false,
    });
  });

  it("keeps the text and plan limits on new and edited open entries", () => {
    const inputs = Array.from({ length: 30 }, () => ({
      text: "x".repeat(500),
      owner: "work" as const,
    }));
    const plan = planSubtasks([], inputs);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks).toHaveLength(30);
    expect(planSubtasks([], [...inputs, { text: "Extra", owner: "work" }])).toEqual({
      ok: false,
      reason: "a card has at most 30 subtasks",
    });
    expect(planSubtasks([], [{ text: "x".repeat(501), owner: "work" }])).toEqual({
      ok: false,
      reason: "a subtask is at most 500 characters",
    });
    for (const text of [" ", "x".repeat(501)]) {
      expect(planSubtasks(plan.subtasks, [{ id: "s1", text }])).toMatchObject({ ok: false });
    }
  });

  it.each([{}, { text: "New" }, { owner: "work" as const }])(
    "refuses a new entry without text and owner: %j",
    (input) => {
      const existing = planned();
      const before = structuredClone(existing);
      expect(planSubtasks(existing, [{ id: "s1" }, input])).toEqual({
        ok: false,
        reason: "a new subtask needs text and owner",
      });
      expect(existing).toEqual(before);
    },
  );

  it.each(["open", "done", "skipped"] as const)(
    "adds a new step after kept ids ending in %s",
    (state) => {
      const existing = planned()
        .slice(0, 2)
        .map((subtask, i) => ({
          ...subtask,
          step: i === 0 ? 4 : 7,
          state: i === 0 ? subtask.state : state,
        }));
      const plan = planSubtasks(existing, [
        { id: "s1" },
        { id: "s2" },
        { text: "new", owner: "evaluator" },
      ]);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.subtasks.slice(0, 2)).toEqual(existing);
      expect(plan.subtasks[2]).toMatchObject({ id: "s3", text: "new", step: 8 });
    },
  );

  it.each(["evaluator", "script"] as const)(
    "does not store a guessed gate for a %s merge-only step",
    (owner) => {
      const plan = planSubtasks([], [{ text: mergeOnly, owner }], 0, at);
      if (!plan.ok) throw new Error(plan.reason);
      expect(plan.subtasks[0]).not.toHaveProperty("gate");
    },
  );

  it.each(["deploy", "money", "secret"] as const)(
    "keeps explicit and stored %s gates despite negated wording",
    (gate) => {
      const first = planSubtasks([], [{ text: mergeOnly, owner: "evaluator", gate }], 0, at);
      if (!first.ok) throw new Error(first.reason);
      expect(first.subtasks[0]?.gate).toBe(gate);
      const edited = planSubtasks(
        first.subtasks,
        [{ id: "s1", text: mergeOnly, owner: "evaluator" }],
        first.subtaskSeq,
        at,
      );
      if (!edited.ok) throw new Error(edited.reason);
      expect(edited.subtasks[0]?.gate).toBe(gate);
    },
  );

  it.each([undefined, null])("does not store a gate on new work (gate=%s)", (gate) => {
    const plan = planSubtasks([], [{ text: "Test restart handling", owner: "work", gate }], 0, at);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).not.toHaveProperty("gate");
  });

  it.each(["deploy", "money", "secret"] as const)("refuses explicit worker gate %s", (gate) => {
    expect(planSubtasks([], [{ text: "Test restart handling", owner: "work", gate }])).toEqual({
      ok: false,
      reason:
        'subtask "Test restart handling" is the worker\'s; a deploy, money or secret step must be owned by the evaluator or a script',
    });
  });

  it.each([undefined, "deploy"] as const)("re-saving work strips legacy gate %s", (gate) => {
    const known = { ...planned()[0]!, text: "Test restart handling", createdAt: at, gate };
    const plan = planSubtasks(
      [known],
      [{ id: known.id, text: known.text, owner: "work" }],
      1,
      "2026-10-27T12:00:00.000Z",
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).not.toHaveProperty("gate");
    expect(plan.subtasks[0]?.createdAt).toBe(at);
  });

  it.each([
    { owner: "work", next: "evaluator" },
    { owner: "work", next: "script" },
    { owner: "review", next: "evaluator" },
    { owner: "review", next: "script" },
  ] as const)("re-infers a gate when $owner becomes $next", ({ owner, next }) => {
    const known = {
      ...planned()[0]!,
      text: "Restart Robob",
      owner,
      createdAt: at,
      gate: "deploy" as const,
    };
    const later = "2026-10-27T12:00:00.000Z";
    const plan = planSubtasks([known], [{ id: known.id, text: known.text, owner: next }], 1, later);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).toMatchObject({ gate: "deploy", createdAt: later });
  });

  it.each(["done", "skipped"] as const)("strips a legacy gate from retained %s work", (state) => {
    const known = { ...planned()[0]!, state, gate: "deploy" as const, createdAt: at };
    const plan = planSubtasks([known], [], 1, "2026-10-27T12:00:00.000Z");
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).not.toHaveProperty("gate");
    expect(plan.subtasks[0]).toMatchObject({ state, createdAt: at });
  });

  it("keeps an evaluator's stored gate through rewording and gate:null", () => {
    const known = { ...planned()[2]!, gate: "deploy" as const, createdAt: at };
    const later = "2026-10-27T12:00:00.000Z";
    const plan = planSubtasks(
      [known],
      [{ id: known.id, text: "Read back", owner: "evaluator", gate: null }],
      3,
      later,
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).toMatchObject({ gate: "deploy", createdAt: later });
  });

  it.each([undefined, "secret", "deploy", "money"] as const)(
    "does not store a gate on a new review even with explicit gate %s",
    (gate) => {
      const plan = planSubtasks(
        [],
        [{ text: "Review token rotation", owner: "review", gate }],
        0,
        at,
      );
      if (!plan.ok) throw new Error(plan.reason);
      expect(plan.subtasks[0]).not.toHaveProperty("gate");
    },
  );

  it("removes a stored review gate without refreshing its approval timestamp", () => {
    const known: KanbanSubtask = {
      ...planned()[1]!,
      gate: "secret",
      createdAt: at,
    };
    const plan = planSubtasks(
      [known],
      [{ id: known.id, text: "Review: rotate the token safely", owner: "review", gate: "secret" }],
      0,
      "2026-10-27T12:00:00.000Z",
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.subtasks[0]).not.toHaveProperty("gate");
    expect(plan.subtasks[0]?.createdAt).toBe(at);
  });

  it("numbers steps in order, and keeps a shared step for work in any order", () => {
    const subtasks = planned();
    expect(subtasks.map((subtask) => [subtask.id, subtask.step])).toEqual([
      ["s1", 1],
      ["s2", 2],
      ["s3", 3],
      ["s4", 4],
      ["s5", 4],
      ["s6", 5],
    ]);
    expect(subtasks.every((subtask) => subtask.state === "open")).toBe(true);
  });

  it("keeps what happened when the plan changes, and drops open ones left out", () => {
    const done = markSubtask(planned(), "s1", "done", "PR #4", owner, at);
    const plan = planSubtasks(done, [
      { id: "s2", text: "Review", owner: "review" },
      { text: "Ping the frontend owner", owner: "evaluator" },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.subtasks.map((subtask) => [subtask.id, subtask.state, subtask.step])).toEqual([
      ["s1", "done", 1],
      ["s2", "open", 2],
      ["s7", "open", 3],
    ]);
  });

  it("refuses unknown or repeated ids and empty text", () => {
    expect(planSubtasks([], [{ id: "s9" }])).toMatchObject({
      ok: false,
      reason: "the card has no subtask s9. Existing subtask ids: none",
    });
    const subtasks = planned();
    expect(planSubtasks(subtasks, [{ id: "s1" }, { id: "s1" }])).toMatchObject({
      ok: false,
      reason: "subtask s1 is listed twice",
    });
    expect(planSubtasks([], [{ text: "  ", owner: "work" }])).toMatchObject({ ok: false });
  });
});

describe("subtask ids stay unique for the life of a card", () => {
  it("never hands out a dropped open id again", () => {
    const first = planSubtasks([], flow);
    if (!first.ok) throw new Error(first.reason);
    // Drop the open s4 (and s5), keep the rest, then add one new step.
    const second = planSubtasks(
      first.subtasks,
      [
        { id: "s1", text: "Write the PR", owner: "work" },
        { id: "s2", text: "Review", owner: "review" },
        { id: "s3", text: "Merge and deploy", owner: "evaluator" },
        { text: "A new step", owner: "evaluator" },
      ],
      first.subtaskSeq,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.subtasks.map((subtask) => subtask.id)).toEqual(["s1", "s2", "s3", "s7"]);
    expect(second.subtaskSeq).toBe(7);
  });

  it("never reuses the highest id once it is dropped in an earlier save", () => {
    const first = planSubtasks([], flow);
    if (!first.ok) throw new Error(first.reason);
    expect(first.subtasks.map((subtask) => subtask.id)).toContain("s6");
    // Save 1: drop s6, the highest id, with nothing above it still on the card.
    const dropped = planSubtasks(
      first.subtasks,
      [
        { id: "s1", text: "Write the PR", owner: "work" },
        { id: "s2", text: "Review", owner: "review" },
        { id: "s3", text: "Merge and deploy", owner: "evaluator" },
        { id: "s4", text: "Tell the reporter", owner: "evaluator" },
        { id: "s5", text: "Update linked tickets", owner: "evaluator" },
      ],
      first.subtaskSeq,
    );
    if (!dropped.ok) throw new Error(dropped.reason);
    expect(dropped.subtasks.map((subtask) => subtask.id)).not.toContain("s6");
    expect(dropped.subtaskSeq).toBe(6);
    // Save 2, a later edit: the new step must not take the dropped s6.
    const added = planSubtasks(
      dropped.subtasks,
      [
        { id: "s1", text: "Write the PR", owner: "work" },
        { id: "s2", text: "Review", owner: "review" },
        { id: "s3", text: "Merge and deploy", owner: "evaluator" },
        { id: "s4", text: "Tell the reporter", owner: "evaluator" },
        { id: "s5", text: "Update linked tickets", owner: "evaluator" },
        { text: "Ping the frontend owner", owner: "evaluator" },
      ],
      dropped.subtaskSeq,
    );
    if (!added.ok) throw new Error(added.reason);
    expect(added.subtasks.map((subtask) => subtask.id)).toContain("s7");
    expect(added.subtasks.map((subtask) => subtask.id)).not.toContain("s6");
  });

  it("defaults to the highest id still on the card for a card saved without a counter", () => {
    const plan = planSubtasks(planned(), [{ text: "Extra", owner: "evaluator" }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.subtasks.map((subtask) => subtask.id)).toContain("s7");
    expect(plan.subtaskSeq).toBe(7);
  });
});

describe("marking subtasks", () => {
  it.each(["work", "evaluator", "script"] as const)(
    "passes the first open review step behind an unfinished %s step",
    (firstOwner) => {
      const plan = planSubtasks(
        [],
        [
          { text: "Earlier task", owner: firstOwner, step: 1 },
          { text: "First review", owner: "review", step: 2 },
          { text: "Same review step", owner: "review", step: 2 },
          { text: "Later review", owner: "review", step: 4 },
        ],
      );
      if (!plan.ok) throw new Error(plan.reason);
      const subtasks = passReview({ subtasks: plan.subtasks }, owner, at);
      expect(subtasks.map((subtask) => subtask.state)).toEqual(["open", "done", "done", "open"]);
      expect(workAfterReview({ subtasks })).toBe(firstOwner === "work");
      const finishedEarlier = markSubtask(subtasks, "s1", "done", null, owner, at);
      expect(kanbanOpenStep({ subtasks: finishedEarlier })).toBe(4);
    },
  );

  it("leaves a plan without an open review unchanged", () => {
    const subtasks = planned().filter((subtask) => subtask.owner !== "review");
    expect(passReview({ subtasks }, owner, at)).toEqual(subtasks);
  });

  it.each(["open", "done", "skipped"] as const)(
    "a later worker step that is %s bounds which review can pass",
    (state) => {
      for (const workStep of [4, 5]) {
        const plan = planSubtasks(
          [],
          [
            { text: "Earlier evaluator task", owner: "evaluator", step: 3 },
            { text: "Future work", owner: "work", step: workStep },
            { text: "Future review", owner: "review", step: 5 },
          ],
        );
        if (!plan.ok) throw new Error(plan.reason);
        const subtasks =
          state === "open"
            ? plan.subtasks
            : markSubtask(plan.subtasks, "s2", state, "Handled", owner, at);
        const passed = passReview({ subtasks }, owner, at);
        expect(passed[2]?.state).toBe(state === "open" ? "open" : "done");
      }
    },
  );

  it("lets each role mark only its own kind, in the step the card is on", () => {
    const card = { number: 3, subtasks: planned() };
    expect(checkMark(card, "s1", "done", "work", null)).toEqual({ ok: true });
    expect(checkMark(card, "s3", "done", "work", null)).toMatchObject({
      ok: false,
      reason: "subtask s3 is for the evaluator, not you",
    });
    const later = { number: 3, subtasks: planned().map((s) => ({ ...s, owner: "work" as const })) };
    expect(checkMark(later, "s2", "done", "work", null)).toMatchObject({
      ok: false,
      reason: "subtask s2 is in step 2; finish step 1 first",
    });
    expect(checkMark(card, "s4", "done", "evaluator", null)).toEqual({ ok: true });
    expect(checkMark(card, "s1", "skipped", "work", " ")).toMatchObject({ ok: false });
    expect(checkMark(card, "s1", "open", "work", null)).toMatchObject({ ok: false });
    // A review never marks its own; its verdict does.
    expect(checkMark(card, "s2", "done", "review", null)).toMatchObject({ ok: false });
  });

  it("moves through the steps as they finish, and a review pass ticks the review", () => {
    let card = { subtasks: planned() };
    expect(kanbanOpenStep(card)).toBe(1);
    card = { subtasks: markSubtask(card.subtasks, "s1", "done", "PR #4", owner, at) };
    expect(kanbanOpenStep(card)).toBe(2);
    card = { subtasks: passReview(card, owner, at) };
    expect(kanbanOpenStep(card)).toBe(3);
    expect(kanbanEvaluatorStep(card)).toBe(true);
    card = { subtasks: markSubtask(card.subtasks, "s3", "done", "deployed", owner, at) };
    expect(kanbanStepSubtasks(card).map((subtask) => subtask.id)).toEqual(["s4", "s5"]);
    card = { subtasks: markSubtask(card.subtasks, "s5", "skipped", "no tickets", owner, at) };
    expect(kanbanOpenStep(card)).toBe(4);
    expect(subtaskLines(card)).toContain("s5 step 4, evaluator (skipped: no tickets)");
  });
});

describe("withPacketStep", () => {
  it("puts the evaluator's packet first and moves the given steps one later", () => {
    const plan = planSubtasks(
      [],
      withPacketStep([
        { text: "Fix it", owner: "work" },
        { text: "Tell QA", owner: "evaluator", step: 2 },
        { text: "Ping the owner", owner: "evaluator", step: 2 },
      ]),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.subtasks.map((subtask) => [subtask.step, subtask.owner])).toEqual([
      [1, "evaluator"],
      [2, "work"],
      [3, "evaluator"],
      [3, "evaluator"],
    ]);
    expect(plan.subtasks[0]?.text).toBe(PACKET_SUBTASK);
  });
});

describe("board script subtasks", () => {
  const scriptFlow = [
    { text: "Merge the PR", owner: "script" as const, script: "land" },
    { text: "Deploy", owner: "script" as const, script: "land", step: 2 },
    { text: "Tell the reporter", owner: "evaluator" as const, step: 3 },
  ];
  const scriptCard = () => {
    const plan = planSubtasks([], scriptFlow);
    if (!plan.ok) throw new Error(plan.reason);
    return { number: 1, subtasks: plan.subtasks };
  };

  it("keeps a trimmed script name on a script subtask and refuses it on another owner", () => {
    const plan = planSubtasks([], [{ text: "Merge", owner: "script", script: "  land  " }]);
    expect(plan.ok && plan.subtasks[0]?.script).toBe("land");
    const refused = planSubtasks([], [{ text: "Merge", owner: "work", script: "land" }]);
    expect(refused.ok).toBe(false);
  });

  it("drops the script name when an edit leaves it out", () => {
    const first = planSubtasks([], [{ text: "Merge", owner: "script", script: "land" }]);
    if (!first.ok) throw new Error(first.reason);
    const edited = planSubtasks(
      first.subtasks,
      [{ id: "s1", text: "Merge", owner: "script" }],
      first.subtaskSeq,
    );
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.subtasks[0]).not.toHaveProperty("script");
  });

  it("lets a script tick its own subtask, named or not, and refuses another script's", () => {
    const card = scriptCard();
    expect(checkMark(card, "s1", "done", "script", null, "land")).toEqual({ ok: true });
    expect(checkMark(card, "s1", "done", "script", null, "other")).toEqual({
      ok: false,
      reason: 'subtask s1 is for the script "land"',
    });
    const unnamed = planSubtasks([], [{ text: "Anything", owner: "script" }]);
    if (!unnamed.ok) throw new Error(unnamed.reason);
    expect(
      checkMark({ number: 2, subtasks: unnamed.subtasks }, "s1", "done", "script", null, "any"),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses a script on an evaluator's subtask and on reopening one", () => {
    const card = {
      number: 3,
      subtasks: [
        {
          id: "s1",
          step: 1,
          text: "Tell",
          owner: "evaluator",
          script: undefined,
          state: "open",
          note: null,
          doneBy: null,
          doneAt: null,
        },
      ] as const,
    };
    expect(checkMark(card, "s1", "done", "script", null, "land").ok).toBe(false);
    const done = scriptCard();
    const marked = {
      ...done,
      subtasks: done.subtasks.map((subtask, index) =>
        index === 0 ? { ...subtask, state: "done" as const } : subtask,
      ),
    };
    expect(checkMark(marked, "s1", "open", "script", null, "land")).toEqual({
      ok: false,
      reason: "only an evaluator reopens a subtask",
    });
  });

  it("checkHandBack refuses a blank note, a non-script subtask, a done one, another name and a later step", () => {
    const card = scriptCard();
    expect(checkHandBack(card, "s1", "land", "  ")).toEqual({
      ok: false,
      reason: "say what failed or didn't match",
    });
    const evaluatorCard = {
      number: 4,
      subtasks: [
        {
          id: "s1",
          step: 1,
          text: "Tell",
          owner: "evaluator",
          state: "open",
          note: null,
          doneBy: null,
          doneAt: null,
        },
      ] as const,
    };
    expect(checkHandBack(evaluatorCard, "s1", "land", "x")).toEqual({
      ok: false,
      reason: "subtask s1 isn't a script's",
    });
    const finished = {
      ...card,
      subtasks: card.subtasks.map((subtask) =>
        subtask.id === "s1" ? { ...subtask, state: "done" as const } : subtask,
      ),
    };
    expect(checkHandBack(finished, "s1", "land", "x")).toEqual({
      ok: false,
      reason: "subtask s1 is already done",
    });
    expect(checkHandBack(card, "s1", "other", "x")).toEqual({
      ok: false,
      reason: 'subtask s1 is for the script "land"',
    });
    expect(checkHandBack(card, "s2", "land", "x")).toEqual({
      ok: false,
      reason: "subtask s2 is in step 2; finish step 1 first",
    });
  });

  it("handBack makes the subtask the evaluator's, open, with the note", () => {
    const card = scriptCard();
    const handed = handBack(card.subtasks, "s1", "deploy failed: exit 1");
    expect(handed[0]).toMatchObject({
      owner: "evaluator",
      state: "open",
      note: "deploy failed: exit 1",
    });
    expect(handed[0]).not.toHaveProperty("script");
  });

  it('subtaskLines shows a named script as script "land"', () => {
    const lines = subtaskLines(scriptCard());
    expect(lines).toContain('- s1 step 1, script "land" (now): Merge the PR');
  });
});

it.each([
  ["Owner says keep 2%", "Owner says keep 2%"],
  ["Review findings (round 1): fix rate", "Review findings (round 1): fix rate"],
  ["Do s1 again", null],
  ["s1: build it", null],
  ["Do S13 again", null],
  [
    "Do this step's work subtasks, mark each with subtask_done, then card_move to needs_review.",
    null,
  ],
])("pending wake cleanup: %s", (wakeNote, expected) => {
  const subtasks = markSubtask(planned(), "s1", "done", null, owner, at);
  expect(pendingWakeNote({ subtasks, wakeNote })).toBe(expected);
});

describe.each(["done", "skipped", "removed", "evaluator"] as const)(
  "pending wake preserves bundled context when its requested task is %s",
  (obsolete) => {
    it.each([
      ["Do s1 again.\n\nFor s3, use 2%.", "For s3, use 2%."],
      ["s1: build again\nFor s3, use 2%.", "For s3, use 2%."],
      ["Do S1 again.\r\n\r\nOwner says use 2%.", "Owner says use 2%."],
      ["Do s1 again. For s3, use 2%.", "For s3, use 2%."],
      ["For s3, use 2%. Do s1 again.", "For s3, use 2%."],
      ["Do s1 again; For s3, use 2%.", "For s3, use 2%."],
      ["- Do s1 again.\n- Do s3 with 2%.", "- Do s3 with 2%."],
      ["1. Do s1 again.\n2. Do s3 with 2%.", "2. Do s3 with 2%."],
      [
        "Review findings (round 1):\nDo s1 again.\nKeep 2.5% for s3.",
        "Review findings (round 1):\nDo s1 again.\nKeep 2.5% for s3.",
      ],
    ])("%s", (wakeNote, expected) => {
      const subtasks = planned().flatMap((s) =>
        s.id === "s1"
          ? obsolete === "removed"
            ? []
            : [
                {
                  ...s,
                  state: obsolete === "evaluator" ? ("open" as const) : obsolete,
                  owner: obsolete === "evaluator" ? ("evaluator" as const) : s.owner,
                },
              ]
          : [{ ...s, ...(s.id === "s3" ? { owner: "work" as const } : {}) }],
      );
      expect(pendingWakeNote({ subtasks, wakeNote })).toBe(expected);
    });
  },
);

it.each([
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
  ["LINE SEPARATOR", "\u2028"],
  ["PARAGRAPH SEPARATOR", "\u2029"],
])("pending wake line separators: %s", (_name, separator) => {
  const subtasks = markSubtask(planned(), "s1", "done", null, owner, at);
  const wakeNote = ["Owner says keep 2.5%.", "Do s1 again.", "Use 2% for the next task."].join(
    separator,
  );
  expect(pendingWakeNote({ subtasks, wakeNote })).toBe(
    "Owner says keep 2.5%.\n\nUse 2% for the next task.",
  );
});

it.each([
  "s1 established the rate as 2.5%; use that same rate for s3.",
  "s1 is complete. Use the same rate for s3.",
  "S1 established 2.5%.\nUse it for s3.",
])("pending wake preserves descriptive context: %s", (wakeNote) => {
  const subtasks = markSubtask(planned(), "s1", "done", null, owner, at);
  expect(pendingWakeNote({ subtasks, wakeNote })).toBe(wakeNote);
});

describe("standing deploy approvals", () => {
  it.each([
    {
      name: "owner-only with revised text",
      input: { text: "Change evaluator instructions", ownerOnly: true },
    },
    { name: "owner-only with unchanged text", input: { ownerOnly: true } },
    { name: "explicit deploy gate", input: { gate: "deploy" as const } },
    { name: "newly inferred deploy gate", input: { text: "Restart Robob" } },
  ])("refreshes the approval bound for $name", ({ input }) => {
    const before: KanbanSubtask = {
      id: "s1",
      step: 1,
      text: "Read the instructions",
      owner: "evaluator",
      createdAt: at,
      state: "open",
      note: null,
      doneBy: null,
      doneAt: null,
    };
    const later = "2026-10-27T12:00:00.000Z";
    const plan = planSubtasks([before], [{ id: "s1", ...input }], 1, later);
    if (!plan.ok) throw Error(plan.reason);
    const revised = plan.subtasks[0]!;
    expect(revised.createdAt).toBe(later);
    const ask: KanbanOwnerAsk = {
      id: "q1",
      text: "Approve s1",
      blocking: false,
      by: owner,
      at,
      seq: null,
      closedAt: at,
      answer: { verdict: "approved", by: owner, at },
    };
    expect(
      approvalProblem({ number: 1, createdAt: at, subtasks: [revised], asks: [ask] }, revised, []),
    ).toContain(`since ${later}`);
  });
  it.each(["work", "review"] as const)("keeps owner-only actions out of %s checklists", (owner) => {
    expect(planSubtasks([], [{ text: "Restart Robob", owner, ownerOnly: true }])).toMatchObject({
      ok: false,
    });
  });
  const standing = [
    {
      id: "sa-one",
      gate: "deploy" as const,
      quote: "Tool boards may release",
      sourceThreadId: "owner-thread",
      saidAt: at,
      approvedAsk: { cardId: "card-1", askId: "q1" },
      recordedAt: at,
      recordedBy: "evaluator",
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    },
  ];
  const base: KanbanSubtask = {
    id: "s7",
    step: 1,
    text: "Deploy spectrum-bridge with integrations/deploy.zsh",
    owner: "evaluator",
    createdAt: at,
    state: "open",
    note: null,
    doneBy: null,
    doneAt: null,
  };
  const card = { number: 1, asks: [] as KanbanOwnerAsk[], createdAt: at, subtasks: [base] };
  it.each([undefined, "deploy"] as const)("clears inferred and explicit gates: %s", (gate) => {
    const subtask = { ...base, ...(gate ? { gate } : {}) };
    expect(approvalProblem(card, subtask, standing)).toBeNull();
    expect(approvalProblem(card, subtask, [])).toContain("no standing deploy approval");
    expect(approvalProblem(card, subtask, [{ ...standing[0]!, revokedAt: at }])).toContain(
      "no standing deploy approval",
    );
  });
  it.each(["open", "dropped"] as const)("ignores a %s owner ask", (state) => {
    const ask: KanbanOwnerAsk = {
      id: "q2",
      text: "Deploy s7?",
      blocking: false,
      by: owner,
      at,
      seq: null,
      closedAt: state === "open" ? null : at,
      answer: state === "open" ? undefined : { verdict: "dropped", by: owner, at },
    };
    expect(approvalProblem({ ...card, asks: [ask] }, base, standing)).toBeNull();
  });
  it.each([
    { text: "Pay the invoice" },
    { text: "Refund the customer's charge" },
    { text: "Do this", gate: "secret" as const },
  ])("does not clear money or secret: $text", (fields) => {
    const subtask = { ...base, ...fields };
    expect(approvalProblem({ ...card, subtasks: [subtask] }, subtask, standing)).toContain(
      "needs Abdullah's approval",
    );
  });
  it("keeps owner-only steps on-card and never infers ownerOnly", () => {
    const subtask = { ...base, text: "Restart Robob to pick up the watcher", ownerOnly: true };
    expect(approvalProblem({ ...card, subtasks: [subtask] }, subtask, standing)).toContain(
      "marked owner-only",
    );
    const ask: KanbanOwnerAsk = {
      id: "q1",
      text: "Approve s7",
      blocking: false,
      by: owner,
      at,
      seq: null,
      closedAt: at,
      answer: { verdict: "approved", by: owner, at },
    };
    expect(
      approvalProblem({ ...card, subtasks: [subtask], asks: [ask] }, subtask, standing),
    ).toBeNull();
    const plan = planSubtasks([subtask], [{ id: "s7", text: subtask.text }]);
    expect(plan).toMatchObject({ ok: true, subtasks: [{ ownerOnly: true }] });
    expect(planSubtasks([subtask], [{ id: "s7", ownerOnly: false }])).toMatchObject({
      ok: true,
      subtasks: [{ ownerOnly: false }],
    });
    const inferred = planSubtasks([], [{ text: subtask.text, owner: "evaluator" }]);
    if (!inferred.ok) throw Error(inferred.reason);
    expect(inferred.subtasks[0]?.ownerOnly).toBeUndefined();
    expect(gateOf({ ...subtask, text: "Do this" })).toBe("deploy");
  });

  describe.each([false, true])("owner-only ask binding (standing approval: %s)", (active) => {
    it.each([
      { name: "unrelated deploy wording", text: "Deploy spectrum-bridge now?", allowed: false },
      { name: "matching action without an id", text: "Restart Robob now?", allowed: false },
      { name: "another id", text: "Approve s8", allowed: false },
      { name: "partial id", text: "Approve s70", allowed: false },
      { name: "id in text", text: "Approve s7", allowed: true },
      {
        name: "id in title",
        text: "Approve this change?",
        title: "Rules change s7",
        allowed: true,
      },
      {
        name: "id in action summary",
        text: "Approve this change?",
        summary: "Change the evaluator rules in AGENTS.md (s7)",
        allowed: true,
      },
      { name: "multiple explicit ids", text: "Approve s6 and s7", allowed: true },
    ])("$name", ({ text, title, summary, allowed }) => {
      const subtask = {
        ...base,
        ownerOnly: true,
        text:
          text === "Restart Robob now?"
            ? "Restart Robob"
            : "Change the evaluator rules in AGENTS.md",
      };
      const ask: KanbanOwnerAsk = {
        id: "q1",
        text,
        ...(title ? { title } : {}),
        ...(summary ? { action: { summary } } : {}),
        blocking: false,
        by: owner,
        at,
        seq: null,
        closedAt: at,
        answer: { verdict: "approved", by: owner, at },
      };
      for (const intent of ["do", "skip"] as const) {
        const result = approvalProblem(
          { ...card, subtasks: [subtask], asks: [ask] },
          subtask,
          active ? standing : [],
          undefined,
          intent,
        );
        if (allowed) expect(result).toBeNull();
        else expect(result).toContain("subtask id");
      }
    });
  });

  it("keeps owner-only steps gated when the board disables inferred gates", () => {
    const subtask = { ...base, text: "Change evaluator instructions", ownerOnly: true };
    expect(gateOf(subtask, [])).toBe("deploy");
    expect(approvalProblem({ ...card, subtasks: [subtask] }, subtask, standing, [])).toContain(
      "marked owner-only",
    );
  });
});
