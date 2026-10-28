import type { KanbanBoardSnapshot, KanbanCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardStateFromSnapshot } from "./boardState.ts";
import {
  activeFilterCount,
  boardFilter,
  clearFilters,
  EMPTY_FILTER_PREFS,
  filterFacets,
  sanitizeBoardFilterPrefs,
  toggleFilterValue,
} from "./filters.ts";
import { visibleCards } from "./viewModel.ts";

const opus = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
const haiku = { instanceId: "opencode", model: "opus/cc/claude-haiku-5-5" } as never;

function card(number: number, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: `card-${number}`,
    boardId: "board-toy",
    number,
    title: `Card ${number}`,
    description: "",
    prompt: "",
    stage: "todo",
    priority: 3,
    goalId: null,
    projects: [],
    model: null,
    models: [],
    subtasks: [],
    subtaskSeq: 0,
    projectId: null,
    links: [],
    blockedBy: [],
    stalled: null,
    question: null,
    asks: [],
    reviewChain: null,
    reviewStep: 0,
    reviewRound: 0,
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    workThreadId: null,
    reviewThreadId: null,
    discussionId: null,
    wakeNote: null,
    nudgedAt: null,
    settledAt: null,
    stageChangedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    ...patch,
  } as unknown as KanbanCard;
}

function snapshot(cards: KanbanCard[], goals: Array<{ id: string; name: string; status: string }> = []) {
  return {
    board: { id: "board-toy", name: "Toy" },
    cards,
    goals: goals.map((goal) => ({
      ...goal,
      boardId: "board-toy",
      now: null,
      story: [],
      createdAt: "2026-10-20T00:00:00.000Z",
    })),
    pools: [],
    groups: [],
    threads: [],
    unread: [],
  } as unknown as KanbanBoardSnapshot;
}

const cards = [
  card(1, { priority: 1, goalId: "goal-a" as never, projects: ["Web"], model: opus }),
  card(2, { priority: 2, goalId: "goal-a" as never, projects: ["Web", "Mobile"], model: haiku }),
  card(3, { priority: 3, goalId: null, projects: [] }),
  card(4, { priority: 1, goalId: "goal-b" as never, projects: ["Mobile"], model: haiku }),
  card(5, { priority: 5, goalId: null, projects: ["Web"], model: opus, settledAt: "2026-10-24T10:00:00.000Z" }),
];
const goals = [
  { id: "goal-a", name: "PBV2", status: "active" },
  { id: "goal-b", name: "Finished", status: "done" },
];
const state = boardStateFromSnapshot(snapshot(cards, goals));
const numbers = (prefs: Parameters<typeof boardFilter>[1]) =>
  visibleCards(state, boardFilter(state, prefs, ""))
    .map((entry) => entry.number)
    .sort((a, b) => a - b);

describe("filters", () => {
  it("narrows each facet on its own", () => {
    expect(numbers({ ...EMPTY_FILTER_PREFS, priorities: [1] })).toEqual([1, 4]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, goalIds: ["goal-a"] })).toEqual([1, 2]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, projects: ["Mobile"] })).toEqual([2, 4]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, models: ["Haiku"] })).toEqual([2, 4]);
  });

  it("ORs values within a facet and ANDs across facets", () => {
    expect(numbers({ ...EMPTY_FILTER_PREFS, priorities: [1, 2] })).toEqual([1, 2, 4]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, priorities: [1], models: ["Haiku"] })).toEqual([4]);
    expect(
      numbers({ ...EMPTY_FILTER_PREFS, projects: ["Web", "Mobile"], models: ["Opus"] }),
    ).toEqual([1]);
  });

  it("treats '' as no goal, no project and no model", () => {
    expect(numbers({ ...EMPTY_FILTER_PREFS, goalIds: [""] })).toEqual([3]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, projects: [""] })).toEqual([3]);
    expect(numbers({ ...EMPTY_FILTER_PREFS, models: [""] })).toEqual([3]);
  });

  it("drops a stale goal instead of hiding every card", () => {
    expect(numbers({ ...EMPTY_FILTER_PREFS, goalIds: ["goal-b-gone"] })).toEqual([1, 2, 3, 4]);
    expect(boardFilter(state, { ...EMPTY_FILTER_PREFS, goalIds: ["goal-b-gone"] }, "")).toMatchObject({
      goalIds: [],
    });
  });

  it("lists only active goals, plus No goal when the board has goals", () => {
    const goalFacet = filterFacets(state, "hide").find((view) => view.facet === "goalIds");
    expect(goalFacet?.options).toEqual([
      { value: "goal-a", label: "PBV2", count: 2 },
      { value: "", label: "No goal", count: 1 },
    ]);
  });

  it("counts respect settled but not the other facets", () => {
    const priority = filterFacets(state, "hide").find((view) => view.facet === "priorities");
    expect(priority?.options.map((option) => option.count)).toEqual([2, 1, 1, 0, 0]);
    const withSettled = filterFacets(state, "include").find((view) => view.facet === "priorities");
    expect(withSettled?.options[4]?.count).toBe(1);
  });

  it("omits the project facet when no card has a project, and the model facet when none has a model", () => {
    const bare = boardStateFromSnapshot(snapshot([card(9)], []));
    const facets = filterFacets(bare, "hide").map((view) => view.facet);
    expect(facets).toEqual(["priorities"]);
  });

  it("keeps No project at count 0 so a saved pick still matches", () => {
    const allAssigned = snapshot([card(1, { projects: ["Web"] })]);
    const state = boardStateFromSnapshot(allAssigned);
    const project = filterFacets(state, "hide").find((view) => view.facet === "projects");
    expect(project?.options.find((option) => option.value === "")?.count).toBe(0);

    const prefs = { ...EMPTY_FILTER_PREFS, projects: [""] };
    expect(boardFilter(state, prefs, "").projects).toEqual([""]);
    expect(visibleCards(state, boardFilter(state, prefs, ""))).toEqual([]);
  });

  it("toggles, clears and counts active values", () => {
    let prefs = toggleFilterValue(EMPTY_FILTER_PREFS, "priorities", 1);
    prefs = toggleFilterValue(prefs, "models", "Haiku");
    expect(activeFilterCount(prefs)).toBe(2);
    prefs = toggleFilterValue(prefs, "priorities", 1);
    expect(prefs.priorities).toEqual([]);
    const cleared = clearFilters({ ...prefs, settled: "include" });
    expect(cleared).toEqual({ ...EMPTY_FILTER_PREFS, settled: "include" });
  });

  it("sanitizes junk and keeps valid values", () => {
    expect(sanitizeBoardFilterPrefs(null)).toEqual(EMPTY_FILTER_PREFS);
    expect(
      sanitizeBoardFilterPrefs({
        priorities: [1, 1, 9, "2", 0, 4.5],
        goalIds: ["goal-a", 7],
        projects: "Web",
        models: ["Opus"],
        settled: "everything",
      }),
    ).toEqual({
      priorities: [1],
      goalIds: ["goal-a"],
      projects: [],
      models: ["Opus"],
      settled: "hide",
    });
    expect(sanitizeBoardFilterPrefs({ settled: "only" }).settled).toBe("only");
  });
});
