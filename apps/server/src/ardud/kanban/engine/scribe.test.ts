import type { KanbanCard, KanbanGroup } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { groupsFingerprint, groupsPrompt, toGroups } from "./scribe.ts";

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
});
