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
} from "./subtasks.ts";

const owner = { _tag: "owner" } as const;
const at = "2026-10-26T12:00:00.000Z";
const torsshReview =
  "Review (single GPT-6 Astra xhigh, design chain): torrc injection impossible, token fresh per launch and never logged, only the policy FD inherited, no bridge fallback on PT failure/relaunch, snowflake consent rechecked, #30/#36/#56 lyrebird gates unchanged";

describe("inferGate", () => {
  it.each([
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

  it.each([undefined, "secret", "deploy", "money"] as const)(
    "allows a read-only review with stored gate %s and no asks",
    (gate) => {
      const review = { ...subtask, ...(gate === undefined ? {} : { gate }) };
      expect(gateOf(review)).toBeUndefined();
      expect(approvalProblem(card, review)).toBeNull();
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
        expect(approvalProblem(card, action)).toContain("needs Abdullah's approval");
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
    expect(approvalProblem({ ...card, subtasks: [work] }, work)).toBeNull();
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
      approvalProblem({ ...card, subtasks: [...work, s7], asks: [approvedAsk(text)] }, s7),
    ).toContain("needs Abdullah's approval");
  });

  it("uses unnamed wording only for the single eligible gate", () => {
    const s5 = deploy("s5");
    const s7 = deploy("s7");
    const asks = [approvedAsk("Restart Robob now?")];
    expect(approvalProblem({ ...card, subtasks: [s5], asks }, s5)).toBeNull();
    for (const subtask of [s5, s7]) {
      expect(approvalProblem({ ...card, subtasks: [s5, s7], asks }, subtask)).toContain(
        "name the subtask id (e.g. s7) in the ask",
      );
    }
    const named = { ...card, subtasks: [s5, s7], asks: [approvedAsk("Approve s5")] };
    expect(approvalProblem(named, s5)).toBeNull();
    expect(approvalProblem(named, s7)).toContain("approval");
    const both = { ...named, asks: [approvedAsk("Approve s5 and s7")] };
    expect(approvalProblem(both, s5)).toBeNull();
    expect(approvalProblem(both, s7)).toBeNull();
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
    expect(approvalProblem(namedCard, s5)).toBeNull();
    expect(approvalProblem(namedCard, s7)).toContain("approval");
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
      );
      if (kind === "done" || kind === "legacy") expect(result).toContain("approval");
      else expect(result).toBeNull();
    },
  );

  it("does not match an unknown named id or a partial id through gate wording", () => {
    const s5 = deploy("s5");
    for (const text of ["Restart s99 now?", "Restart s50 now?"]) {
      expect(approvalProblem({ ...card, subtasks: [s5], asks: [approvedAsk(text)] }, s5)).toContain(
        "approval",
      );
    }
  });

  it("does not apply an unnamed ask to a skipped gate even when another gate is the only candidate", () => {
    const s5 = { ...deploy("s5"), state: "skipped" as const };
    const s7 = deploy("s7");
    for (const subtasks of [[s5], [s5, s7]]) {
      expect(
        approvalProblem({ ...card, subtasks, asks: [approvedAsk("Restart Robob now?")] }, s5),
      ).toContain("approval");
      expect(
        approvalProblem({ ...card, subtasks, asks: [approvedAsk("Approve s5")] }, s5),
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
              text: "Restart agent-bridges?",
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
      ["s2", "open", 1],
      ["s1", "done", 1],
      ["s7", "open", 2],
    ]);
  });

  it("refuses unknown or repeated ids and empty text", () => {
    expect(planSubtasks([], [{ id: "s9", text: "x", owner: "work" }])).toMatchObject({
      ok: false,
      reason: "the card has no subtask s9. Existing subtask ids: none",
    });
    const subtasks = planned();
    expect(
      planSubtasks(subtasks, [
        { id: "s1", text: "a", owner: "work" },
        { id: "s1", text: "b", owner: "work" },
      ]),
    ).toMatchObject({ ok: false, reason: "subtask s1 is listed twice" });
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
