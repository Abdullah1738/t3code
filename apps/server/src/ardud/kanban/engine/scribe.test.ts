import type { KanbanCard, KanbanGoal, KanbanGroup } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  finishedSince,
  goalsFingerprint,
  groupsFingerprint,
  groupsPrompt,
  toGoalUpdates,
  toGroups,
} from "./scribe.ts";

const goal = (patch: Record<string, unknown> = {}) =>
  ({
    id: "goal-a",
    boardId: "board-toy",
    name: "Login",
    status: "active",
    now: null,
    story: [],
    createdAt: "2026-10-25T10:00:00.000Z",
    ...patch,
  }) as unknown as KanbanGoal;

const card = (number: number, patch: Partial<KanbanCard> = {}) =>
  ({
    id: "card-" + number,
    number,
    title: "Card " + number,
    description: "",
    projects: [],
    stage: "todo",
    settledAt: null,
    ...patch,
  }) as unknown as KanbanCard;

describe("scribe", () => {
  it("toGroups keeps known ids, drops unknown cards, repeats and single-card groups", () => {
    const cards = [1, 2, 3, 4, 5].map((n) => card(n)).concat(card(6, { stage: "completed" }));
    const existing = [
      {
        id: "grp-auth",
        name: "Auth",
        summary: "",
        cardIds: ["card-1"],
        updatedAt: "2026-10-25T12:00:00.000Z",
      },
    ] as never as ReadonlyArray<KanbanGroup>;
    const ids = ["grp-new1", "grp-new2"];
    const groups = toGroups(
      {
        groups: [
          { id: "grp-auth", name: " Auth ", summary: "Sign-in.", cards: [1, 2, 99] },
          { id: "grp-auth", name: "Again", summary: "", cards: [3, 4] },
          { id: null, name: "Solo", summary: "", cards: [2, 5] },
          { id: null, name: "Done", summary: "", cards: [6, 5] },
        ],
      },
      cards,
      existing,
      () => ids.shift() ?? "grp-extra",
    );
    expect(groups).toEqual([
      { id: "grp-auth", name: "Auth", summary: "Sign-in.", cardIds: ["card-1", "card-2"] },
      { id: "grp-new1", name: "Again", summary: "", cardIds: ["card-3", "card-4"] },
    ]);
  });

  it("groupsFingerprint ignores finished cards and changes on a rename", () => {
    const base = groupsFingerprint([card(1), card(2, { stage: "completed" })]);
    expect(base).toBe(groupsFingerprint([card(1)]));
    expect(base).not.toBe(groupsFingerprint([card(1, { title: "Renamed" })]));
    expect(groupsFingerprint([card(2, { stage: "completed" })])).toBe("");
  });

  it("groupsPrompt lists open cards and existing groups", () => {
    const cards = [card(1), card(6, { stage: "completed" })];
    const groups = [
      {
        id: "grp-auth",
        name: "Auth",
        summary: "",
        cardIds: ["card-1", "card-6"],
        updatedAt: "2026-10-25T12:00:00.000Z",
      },
    ] as never as ReadonlyArray<KanbanGroup>;
    const prompt = groupsPrompt(cards, groups);
    expect(prompt).toContain("#1 | Card 1 | - |");
    expect(prompt).toContain("grp-auth | Auth |  | #1");
    expect(prompt).not.toContain("#6 |");
  });

  it("finishedSince counts a goal's cards that finished after its last story line", () => {
    const cards = [
      card(1, { goalId: "goal-a", stage: "completed", movedAt: "2026-10-25T11:00:00.000Z" }),
      card(2, { goalId: "goal-a", stage: "working", movedAt: "2026-10-25T11:00:00.000Z" }),
      card(3, { goalId: "goal-a", stage: "verified", movedAt: "2026-10-25T09:00:00.000Z" }),
    ] as unknown as KanbanCard[];
    expect(finishedSince(goal(), cards)).toEqual([1]);
    expect(
      finishedSince(goal({ story: [{ at: "2026-10-25T12:00:00.000Z", text: "x" }] }), cards),
    ).toEqual([]);
  });

  it("toGoalUpdates assigns only goal-less open cards to active goals and drops a story with nothing finished", () => {
    const cards = [
      card(1, { goalId: "goal-a", stage: "working", movedAt: "2026-10-25T11:00:00.000Z" }),
      card(2, { goalId: null }),
      card(3, { goalId: "goal-b" }),
      card(4, { stage: "completed" }),
    ] as unknown as KanbanCard[];
    const goals = [goal(), goal({ id: "goal-b", name: "Old", status: "done" })];
    const updates = toGoalUpdates(
      {
        assign: [
          { card: 2, goal: "goal-a" },
          { card: 2, goal: "goal-a" },
          { card: 3, goal: "goal-a" },
          { card: 4, goal: "goal-a" },
          { card: 9, goal: "goal-a" },
          { card: 2, goal: "goal-b" },
        ],
        goals: [
          { id: "goal-a", now: " In progress. ", story: "Login landed." },
          { id: "goal-b", now: "x", story: null },
        ],
      },
      cards,
      goals,
    );
    expect(updates.assign).toEqual([{ cardId: "card-2", goalId: "goal-a" }]);
    expect(updates.goals).toEqual([{ id: "goal-a", now: "In progress.", story: null }]);
  });

  it("goalsFingerprint is empty without an active goal", () => {
    expect(goalsFingerprint([card(1)] as unknown as KanbanCard[], [goal({ status: "done" })])).toBe(
      "",
    );
    expect(goalsFingerprint([card(1)] as unknown as KanbanCard[], [goal()])).not.toBe("");
  });
});
