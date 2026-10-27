import type { KanbanAnswer, KanbanBlock } from "@t3tools/contracts";
import type { StageBoard } from "@t3tools/client-runtime/ardud/kanban";
import { describe, expect, it } from "vite-plus/test";

import {
  boardLayout,
  boardTabs,
  choiceView,
  COLUMNS_MIN_WIDTH,
  defaultBoardTab,
  kanbanRecordState,
  nextTypingExpiry,
  priorityFill,
  requestTitle,
  toggleChoice,
} from "./logic";

const column = (stage: string, count: number) => ({
  stage,
  label: stage,
  cards: Array.from({ length: count }, () => ({})),
});

const board = (counts: Record<string, number>) =>
  ({
    active: ["todo", "working", "needs_review", "in_review"].map((stage) =>
      column(stage, counts[stage] ?? 0),
    ),
    shipped: ["completed", "deployed", "verified"].map((stage) =>
      column(stage, counts[stage] ?? 0),
    ),
  }) as unknown as StageBoard;

describe("boardTabs", () => {
  it("folds the three shipped stages into one count", () => {
    const tabs = boardTabs(board({ todo: 4, working: 3, completed: 2, deployed: 1, verified: 2 }));
    expect(tabs.map((tab) => [tab.value, tab.count])).toEqual([
      ["todo", 4],
      ["working", 3],
      ["needs_review", 0],
      ["in_review", 0],
      ["shipped", 5],
    ]);
  });

  it("opens on Working, then on the first stage with cards", () => {
    expect(defaultBoardTab(boardTabs(board({ todo: 1, working: 2 })))).toBe("working");
    expect(defaultBoardTab(boardTabs(board({ in_review: 1, verified: 3 })))).toBe("in_review");
    expect(defaultBoardTab(boardTabs(board({})))).toBe("todo");
  });
});

describe("boardLayout", () => {
  it("uses tabs on a phone and a narrow iPad window", () => {
    expect(boardLayout(390).kind).toBe("tabs");
    expect(boardLayout(COLUMNS_MIN_WIDTH - 1).kind).toBe("tabs");
  });

  it("scrolls the stage columns until five fit beside Needs Owner", () => {
    const narrow = boardLayout(COLUMNS_MIN_WIDTH);
    expect(narrow).toMatchObject({ kind: "columns", column: 196, scrolls: true });
    const wide = boardLayout(1366);
    expect(wide).toMatchObject({ kind: "columns", scrolls: false });
    if (wide.kind !== "columns") throw new Error("columns");
    // Five columns and their gaps fit in what Needs Owner leaves.
    expect(wide.column * 5 + 4 * 10).toBeLessThanOrEqual(1366 - wide.owner - 16 - 10);
  });

  it("caps the column width on very wide screens", () => {
    const layout = boardLayout(2400);
    expect(layout).toMatchObject({ kind: "columns", column: 280, scrolls: false });
  });
});

describe("priorityFill", () => {
  it("fills three bars for P1 and none for P4", () => {
    expect([1, 2, 3, 4].map(priorityFill)).toEqual([3, 2, 1, 0]);
  });
});

const pick: Extract<KanbanBlock, { _tag: "choice" }> = {
  _tag: "choice",
  id: "window",
  style: "poll",
  question: "Window?",
  options: [
    { id: "tonight", label: "Tonight 23:00" },
    { id: "sunday", label: "Sunday 07:00" },
  ],
  multi: false,
};

const answer = (
  by: KanbanAnswer["by"],
  choice: string[],
  blockId = "window",
  text: string | null = null,
): KanbanAnswer =>
  ({ blockId, by, choice, text, at: "2026-10-25T09:12:00.000Z" }) as KanbanAnswer;

describe("choiceView", () => {
  it("shares out the answers to this block and marks the owner's", () => {
    const view = choiceView(pick, [
      answer({ _tag: "owner" }, ["tonight"]),
      answer({ _tag: "evaluator", threadId: "t1" } as never, ["tonight"]),
      answer({ _tag: "script", scriptId: "s1" } as never, ["sunday"]),
      answer({ _tag: "owner" }, ["sunday"], "other-block"),
    ]);
    expect(view.answered).toBe(3);
    expect(view.mine).toEqual(["tonight"]);
    expect(view.options.map((option) => [option.id, option.percent, option.mine])).toEqual([
      ["tonight", 67, true],
      ["sunday", 33, false],
    ]);
  });

  it("shows zero for every option before anyone answers", () => {
    expect(choiceView(pick, []).options.map((option) => option.percent)).toEqual([0, 0]);
  });

  it("returns the owner's own words for a words-only answer", () => {
    const view = choiceView(pick, [answer({ _tag: "owner" }, [], "window", "after nine")]);
    expect(view.mine).toEqual([]);
    expect(view.mineText).toBe("after nine");
    expect(view.answered).toBe(1);
  });

  it("ignores other people's words and words on other blocks", () => {
    const view = choiceView(pick, [
      answer({ _tag: "evaluator", threadId: "t1" } as never, ["tonight"], "window", "not mine"),
      answer({ _tag: "owner" }, ["sunday"], "other-block", "elsewhere"),
    ]);
    expect(view.mineText).toBeNull();
    expect(view.mine).toEqual([]);
  });

  it("returns null words when the owner only picked options", () => {
    expect(choiceView(pick, [answer({ _tag: "owner" }, ["tonight"])]).mineText).toBeNull();
  });
});

describe("toggleChoice", () => {
  it("replaces a single pick and clears it on a second tap", () => {
    expect(toggleChoice([], "a", false)).toEqual(["a"]);
    expect(toggleChoice(["a"], "b", false)).toEqual(["b"]);
    expect(toggleChoice(["a"], "a", false)).toEqual([]);
  });

  it("adds and removes options of a multi pick", () => {
    expect(toggleChoice(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleChoice(["a", "b"], "a", true)).toEqual(["b"]);
  });
});

describe("nextTypingExpiry", () => {
  const now = Date.parse("2026-10-25T09:00:00.000Z");
  it("returns the soonest marker still in the future", () => {
    expect(
      nextTypingExpiry(
        [
          { typingUntil: "2026-10-25T09:00:20.000Z" },
          { typingUntil: "2026-10-25T09:00:05.000Z" },
          { typingUntil: "2026-10-25T08:59:00.000Z" },
          { typingUntil: null },
        ],
        now,
      ),
    ).toBe(5_000);
  });

  it("is null when nobody is typing", () => {
    expect(nextTypingExpiry([{ typingUntil: "2026-10-25T08:00:00.000Z" }], now)).toBeNull();
  });
});

describe("requestTitle", () => {
  it("takes the first written line without markdown marks", () => {
    expect(requestTitle("\n## Kafka TLS renewal\nb-1 and b-2 expire")).toBe("Kafka TLS renewal");
  });

  it("shortens a long line and falls back for empty text", () => {
    expect(requestTitle("x".repeat(80))).toHaveLength(60);
    expect(requestTitle("   ")).toBe("Request");
  });
});

describe("kanbanRecordState", () => {
  it("needs a board, and an id for cards and goals", () => {
    expect(kanbanRecordState({ kind: "card", boardId: "b", id: "c1" })).toEqual({
      kind: "card",
      boardId: "b",
      id: "c1",
    });
    expect(kanbanRecordState({ kind: "discussion", boardId: "b" })).toEqual({
      kind: "discussion",
      boardId: "b",
      id: null,
    });
    expect(kanbanRecordState({ kind: "card", boardId: "b" })).toBeNull();
    expect(kanbanRecordState({ kind: "room", boardId: "b", id: "x" })).toBeNull();
    expect(kanbanRecordState({ kind: "goal", id: "g" })).toBeNull();
  });
});
