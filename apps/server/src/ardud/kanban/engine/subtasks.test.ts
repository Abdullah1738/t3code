import { kanbanEvaluatorStep, kanbanOpenStep, kanbanStepSubtasks } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkHandBack,
  checkMark,
  handBack,
  markSubtask,
  PACKET_SUBTASK,
  passReview,
  planSubtasks,
  subtaskLines,
  withPacketStep,
} from "./subtasks.ts";

const owner = { _tag: "owner" } as const;
const at = "2026-10-26T12:00:00.000Z";

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
      reason: "the card has no subtask s9",
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
    expect(checkMark({ number: 2, subtasks: unnamed.subtasks }, "s1", "done", "script", null, "any")).toEqual({
      ok: true,
    });
  });

  it("refuses a script on an evaluator's subtask and on reopening one", () => {
    const card = {
      number: 3,
      subtasks: [
        { id: "s1", step: 1, text: "Tell", owner: "evaluator", script: undefined, state: "open", note: null, doneBy: null, doneAt: null },
      ] as const,
    };
    expect(checkMark(card, "s1", "done", "script", null, "land").ok).toBe(false);
    const done = scriptCard();
    const marked = { ...done, subtasks: done.subtasks.map((subtask, index) => (index === 0 ? { ...subtask, state: "done" as const } : subtask)) };
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
        { id: "s1", step: 1, text: "Tell", owner: "evaluator", state: "open", note: null, doneBy: null, doneAt: null },
      ] as const,
    };
    expect(checkHandBack(evaluatorCard, "s1", "land", "x")).toEqual({
      ok: false,
      reason: "subtask s1 isn't a script's",
    });
    const finished = {
      ...card,
      subtasks: card.subtasks.map((subtask) => (subtask.id === "s1" ? { ...subtask, state: "done" as const } : subtask)),
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

  it("subtaskLines shows a named script as script \"land\"", () => {
    const lines = subtaskLines(scriptCard());
    expect(lines).toContain('- s1 step 1, script "land" (now): Merge the PR');
  });
});
