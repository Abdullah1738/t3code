import { kanbanEvaluatorStep, kanbanOpenStep, kanbanStepSubtasks } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkMark,
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
