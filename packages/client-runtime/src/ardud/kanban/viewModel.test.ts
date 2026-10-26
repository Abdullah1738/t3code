import type {
  KanbanBoardSnapshot,
  KanbanCard,
  KanbanDiscussion,
  KanbanMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyKanbanChange,
  boardStateFromSnapshot,
  withDiscussionList,
  withDiscussions,
  withOwnerRead,
} from "./boardState.ts";
import {
  discussionPresence,
  discussionRows,
  goalProgress,
  groupCards,
  mergeMessages,
  stageBoard,
} from "./viewModel.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;

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
    model,
    projectId: null,
    links: [],
    blockedBy: [],
    stalled: null,
    question: null,
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
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    ...patch,
  } as KanbanCard;
}

function snapshot(cards: KanbanCard[]): KanbanBoardSnapshot {
  return {
    board: { id: "board-toy", name: "Toy" },
    cards,
    goals: [
      {
        id: "goal-a",
        boardId: "board-toy",
        name: "PBV2",
        status: "active",
        now: null,
        story: [],
        createdAt: "2026-10-20T00:00:00.000Z",
      },
    ],
    pools: [],
    groups: [{ id: "g1", name: "Auth", summary: "Login work", cardIds: ["card-2"], updatedAt: "" }],
    threads: [],
    unread: [],
  } as never;
}

function discussion(lastSeq: number, ownerRead: number): KanbanDiscussion {
  return {
    id: "disc-1",
    boardId: "board-toy",
    cardId: null,
    title: "Window",
    evaluatorThreadId: null,
    participants: [
      {
        actor: { _tag: "owner" },
        name: "You",
        lastReadSeq: ownerRead,
        typingUntil: null,
        owes: null,
      },
      {
        actor: { _tag: "evaluator", threadId: "t-1" },
        name: "Evaluator",
        lastReadSeq: lastSeq,
        typingUntil: "2026-10-25T12:00:30.000Z",
        owes: null,
      },
    ],
    lastSeq,
    lastMessageAt: "2026-10-25T11:00:00.000Z",
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T09:00:00.000Z",
    archivedAt: null,
  } as never;
}

function message(seq: number, owner: boolean, text = `m${seq}`): KanbanMessage {
  return {
    discussionId: "disc-1",
    seq,
    author: owner ? { _tag: "owner" } : { _tag: "evaluator", threadId: "t-1" },
    authorName: owner ? "You" : "Evaluator",
    blocks: [{ _tag: "md", text }],
    answers: [],
    createdAt: "2026-10-25T11:00:00.000Z",
  } as never;
}

describe("stageBoard", () => {
  it("puts cards in stage columns, flags blocked and stalled cards, hides settled ones", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "working", priority: 2 }),
        card(2, { blockedBy: ["card-1" as never], goalId: "goal-a" as never }),
        card(3, {
          stage: "working",
          priority: 1,
          stalled: { reason: "quiet", by: { _tag: "owner" }, at: "2026-10-25T09:00:00.000Z" },
        }),
        card(4, { stage: "verified", settledAt: "2026-10-25T11:00:00.000Z" }),
        card(5, { stage: "needs_owner", question: "Window?" }),
        card(6, { stage: "deployed" }),
      ]),
    );
    const view = stageBoard(state, NOW);
    const working = view.active.find((column) => column.stage === "working")!;
    expect(working.cards.map((c) => c.number)).toEqual([3, 1]);
    expect(working.cards[0]!.flag).toEqual({ kind: "stalled", label: "Stalled 3h" });
    const todo = view.active.find((column) => column.stage === "todo")!;
    expect(todo.cards[0]!.flag).toEqual({ kind: "blocked", label: "After #1" });
    expect(todo.cards[0]!.goal?.name).toBe("PBV2");
    expect(view.owner.cards[0]!.flag).toEqual({ kind: "ask", label: "Window?" });
    expect(view.shipped.flatMap((column) => column.cards.map((c) => c.number))).toEqual([6]);
    expect(view.total).toBe(5);
  });
});

describe("groupCards", () => {
  it("groups by scribe groups with the rest ungrouped, and by goal with no goal last", () => {
    const state = boardStateFromSnapshot(
      snapshot([card(1), card(2, { goalId: "goal-a" as never, stage: "working" })]),
    );
    expect(groupCards(state, "similar", NOW).map((g) => [g.label, g.cards.length])).toEqual([
      ["Auth", 1],
      ["Ungrouped", 1],
    ]);
    expect(groupCards(state, "goal", NOW).map((g) => g.label)).toEqual(["PBV2", "No goal"]);
  });
});

describe("goalProgress", () => {
  it("counts verified, shipped, active and todo cards of a goal", () => {
    const goal = { goalId: "goal-a" as never };
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { ...goal, stage: "verified" }),
        card(2, { ...goal, stage: "deployed" }),
        card(3, { ...goal, stage: "in_review" }),
        card(4, { ...goal }),
        card(5),
      ]),
    );
    expect(goalProgress(state, "goal-a")).toEqual({
      verified: 1,
      shipped: 1,
      active: 1,
      todo: 1,
      total: 4,
    });
  });
});

describe("discussions", () => {
  it("tracks unread from discussion changes and clears it when the owner reads", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [discussion(3, 1)]);
    state = withDiscussions(state, [], [message(3, false, "Window?")]);
    expect(discussionRows(state)).toMatchObject([
      { id: "disc-1", unread: 2, preview: "Evaluator: Window?" },
    ]);
    state = applyKanbanChange(state, { _tag: "discussion", discussion: discussion(4, 1) });
    expect(state.unread.get("disc-1")).toBe(3);
    state = withOwnerRead(state, "disc-1", 4);
    expect(state.unread.get("disc-1")).toBe(0);
  });

  it("keeps a live change that landed during a list read, and drops stale entries", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [
      discussion(2, 2),
      { ...discussion(1, 1), id: "disc-old" as KanbanDiscussion["id"] },
    ]);
    const touched = new Set<string>();
    // The read starts, then a live change lands before it answers.
    state = applyKanbanChange(state, { _tag: "discussion", discussion: discussion(5, 5) });
    touched.add("disc-1");
    state = withDiscussionList(state, [discussion(3, 1)], touched);
    expect(state.discussions.get("disc-1")?.lastSeq).toBe(5);
    expect(state.unread.get("disc-1")).toBe(0);
    expect(state.discussions.has("disc-old")).toBe(false);
  });

  it("replaces held discussions on a later read with no live change", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [discussion(2, 2)]);
    state = boardStateFromSnapshot(snapshot([]), state);
    state = withDiscussionList(state, [discussion(6, 2)]);
    expect(state.discussions.get("disc-1")?.lastSeq).toBe(6);
    expect(state.unread.get("disc-1")).toBe(4);
  });

  it("merges messages by seq and reports seen and typing", () => {
    const merged = mergeMessages([message(1, true), message(2, false)], [message(2, false, "x")]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2]);
    expect(merged[1]!.blocks).toEqual([{ _tag: "md", text: "x" }]);
    const presence = discussionPresence(discussion(2, 2), merged, NOW);
    expect(presence.seenBy.map((p) => p.name)).toEqual(["Evaluator"]);
    expect(presence.typing.map((p) => p.letter)).toEqual(["E"]);
  });
});
