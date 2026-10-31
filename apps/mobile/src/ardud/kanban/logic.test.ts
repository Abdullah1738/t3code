import type { KanbanAnswer, KanbanBlock } from "@t3tools/contracts";
import type { BoardColumnPrefs, StageBoard } from "@t3tools/client-runtime/ardud/kanban";
import { describe, expect, it } from "vite-plus/test";

import {
  applyColumnAction,
  boardLayout,
  columnActionId,
  parseColumnAction,
  boardTabs,
  choiceView,
  COLUMNS_MIN_WIDTH,
  defaultBoardTab,
  filterActionId,
  kanbanLinkTarget,
  kanbanRecordState,
  nextTypingExpiry,
  parseFilterAction,
  priorityFill,
  firstSendText,
  groupBlockRuns,
  requestTitle,
  sendBlocks,
  toggleChoice,
  type StoredAttachment,
} from "./logic";

const photo: StoredAttachment = {
  type: "image",
  id: "att-photo",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const pdf: StoredAttachment = {
  type: "file",
  id: "att-pdf",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 20,
};

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
    expect(narrow).toMatchObject({ kind: "columns", scrolls: true });
    if (narrow.kind !== "columns") throw new Error("columns");
    expect(narrow.columns.todo).toBe(196);
    const wide = boardLayout(1366);
    expect(wide).toMatchObject({ kind: "columns", scrolls: false });
    if (wide.kind !== "columns") throw new Error("columns");
    // Five columns and their gaps fit in what Needs Owner leaves.
    const widths = Object.values(wide.columns).reduce((total, width) => total + width, 0);
    expect(widths + 5 * 10).toBeLessThanOrEqual(1366 - wide.owner - 16);
  });

  it("caps the column width on very wide screens", () => {
    const layout = boardLayout(2400);
    expect(layout).toMatchObject({ kind: "columns", scrolls: false });
    if (layout.kind !== "columns") throw new Error("columns");
    expect(layout.columns.working).toBe(280);
  });

  it("gives no prefs the same numbers as before", () => {
    const layout = boardLayout(1366);
    if (layout.kind !== "columns") throw new Error("columns");
    expect(layout.owner).toBe(264);
    expect(layout.hidden).toEqual([]);
    expect(layout.ownerHidden).toBe(false);
    expect(Object.values(layout.columns).every((width) => width === 207)).toBe(true);
  });

  it("honours saved widths, clamped to the column range", () => {
    const layout = boardLayout(1366, {
      widths: { working: 300, todo: 100 },
      hidden: [],
      groupWidth: null,
    });
    if (layout.kind !== "columns") throw new Error("columns");
    // Saved widths clamp to the shared range (140-560): 300 stays, 100 rises to 140.
    expect(layout.columns.working).toBe(300);
    expect(layout.columns.todo).toBe(140);
    expect(layout.columns.needs_review).toBe(207);
    const capped = boardLayout(1366, { widths: { in_review: 900 }, hidden: [], groupWidth: null });
    if (capped.kind !== "columns") throw new Error("columns");
    expect(capped.columns.in_review).toBe(560);
  });

  it("drops hidden columns and lets the rest reflow", () => {
    const layout = boardLayout(1366, {
      widths: {},
      hidden: ["shipped", "todo"],
      groupWidth: null,
    });
    if (layout.kind !== "columns") throw new Error("columns");
    expect(layout.hidden).toEqual(["todo", "shipped"]);
    expect(Object.keys(layout.columns).sort()).toEqual(["in_review", "needs_review", "working"]);
    expect(layout.scrolls).toBe(false);
  });

  it("stops scrolling once hiding columns frees the room", () => {
    const all = boardLayout(1000);
    expect(all).toMatchObject({ scrolls: true });
    const fewer = boardLayout(1000, {
      widths: {},
      hidden: ["todo", "shipped"],
      groupWidth: null,
    });
    expect(fewer).toMatchObject({ kind: "columns", scrolls: false });
  });

  it("a hidden Needs Owner gives the rail width", () => {
    const layout = boardLayout(1366, {
      widths: {},
      hidden: ["needs_owner"],
      groupWidth: null,
    });
    if (layout.kind !== "columns") throw new Error("columns");
    expect(layout.ownerHidden).toBe(true);
    expect(layout.owner).toBe(36);
    // The stages get the room the wider pane gave back.
    expect(Object.values(layout.columns)[0]).toBeGreaterThan(207);
  });
});

describe("column menu actions", () => {
  it("round-trips each action id through the menu", () => {
    const actions = [
      { kind: "toggle", key: "shipped" },
      { kind: "show-all" },
      { kind: "reset" },
    ] as const;
    for (const action of actions) {
      expect(parseColumnAction(columnActionId(action))).toEqual(action);
    }
    expect(parseColumnAction("column:bogus")).toBeNull();
    expect(parseColumnAction("priority:1")).toBeNull();
  });

  it("applies one pick to the prefs", () => {
    const base: BoardColumnPrefs = { widths: { todo: 200 }, hidden: ["shipped"], groupWidth: null };
    expect(applyColumnAction(base, { kind: "toggle", key: "todo" }).hidden).toEqual([
      "shipped",
      "todo",
    ]);
    expect(applyColumnAction(base, { kind: "show-all" }).hidden).toEqual([]);
    expect(applyColumnAction(base, { kind: "reset" }).widths).toEqual({});
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
): KanbanAnswer => ({ blockId, by, choice, text, at: "2026-10-25T09:12:00.000Z" }) as KanbanAnswer;

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

describe("kanbanLinkTarget", () => {
  const board = {
    cards: new Map([["c1", {}]]),
    discussions: new Map([["d1", {}]]),
  };

  it("opens a card or discussion on this board with the board id the record needs", () => {
    const card = kanbanLinkTarget({ kind: "kanban-card", id: "c1" }, "b", board);
    expect(card).toEqual({ kind: "card", boardId: "b", id: "c1" });
    expect(kanbanRecordState(card ?? undefined)).toEqual({
      kind: "card",
      boardId: "b",
      id: "c1",
    });
    const discussion = kanbanLinkTarget({ kind: "kanban-discussion", id: "d1" }, "b", board);
    expect(discussion).toEqual({ kind: "discussion", boardId: "b", id: "d1" });
    expect(kanbanRecordState(discussion ?? undefined)).toEqual({
      kind: "discussion",
      boardId: "b",
      id: "d1",
    });
  });

  it("leaves a reference that isn't on this board inert", () => {
    expect(kanbanLinkTarget({ kind: "kanban-card", id: "other" }, "b", board)).toBeNull();
    expect(kanbanLinkTarget({ kind: "kanban-discussion", id: "other" }, "b", board)).toBeNull();
    expect(kanbanLinkTarget({ kind: "kanban-goal", id: "c1" }, "b", board)).toBeNull();
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

describe("sendBlocks", () => {
  it("posts only the text when there are no files", () => {
    expect(sendBlocks("  hello  ", [])).toEqual([{ _tag: "md", text: "hello" }]);
  });

  it("posts only the attachments when there is no text", () => {
    expect(sendBlocks("   ", [photo, pdf])).toEqual([
      { _tag: "attachment", attachment: photo },
      { _tag: "attachment", attachment: pdf },
    ]);
  });

  it("puts the text first, then the files in order", () => {
    expect(sendBlocks("see these", [pdf, photo])).toEqual([
      { _tag: "md", text: "see these" },
      { _tag: "attachment", attachment: pdf },
      { _tag: "attachment", attachment: photo },
    ]);
  });

  it("posts nothing for an empty send", () => {
    expect(sendBlocks("", [])).toEqual([]);
  });
});

describe("firstSendText", () => {
  it("titles a discussion from its text", () => {
    expect(firstSendText(" plan ", [pdf])).toBe("plan");
  });

  it("falls back to the first file's name when there is no text", () => {
    expect(firstSendText("", [pdf, photo])).toBe("spec.pdf");
  });

  it("is empty when there is neither text nor a file", () => {
    expect(firstSendText("  ", [])).toBe("");
  });
});

describe("groupBlockRuns", () => {
  it("wraps consecutive attachments into one run and leaves other blocks alone", () => {
    const blocks = [
      { _tag: "md" as const, text: "hi" },
      { _tag: "attachment" as const, attachment: photo },
      { _tag: "attachment" as const, attachment: pdf },
      { _tag: "md" as const, text: "after" },
      { _tag: "attachment" as const, attachment: photo },
    ];
    expect(groupBlockRuns(blocks)).toEqual([
      { kind: "block", index: 0, block: blocks[0] },
      { kind: "attachments", index: 1, attachments: [photo, pdf] },
      { kind: "block", index: 3, block: blocks[3] },
      { kind: "attachments", index: 4, attachments: [photo] },
    ]);
  });
});

describe("parseFilterAction", () => {
  it("reads back every id filterActionId writes", () => {
    const actions = [
      { kind: "toggle", facet: "priorities", value: 2 },
      { kind: "toggle", facet: "goalIds", value: "goal-1" },
      { kind: "toggle", facet: "projects", value: "" },
      { kind: "toggle", facet: "models", value: "Opus" },
      { kind: "clear" },
    ] as const;
    for (const action of actions) {
      expect(parseFilterAction(filterActionId(action))).toEqual(action);
    }
  });

  it("rejects priorities outside 1-5 and unknown keys", () => {
    expect(parseFilterAction("priority:9")).toBeNull();
    expect(parseFilterAction("priority:x")).toBeNull();
    expect(parseFilterAction("colour:red")).toBeNull();
    expect(parseFilterAction("nothing")).toBeNull();
  });
});
