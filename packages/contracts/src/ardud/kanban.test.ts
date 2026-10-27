import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  KANBAN_BACKLOG,
  KanbanBoard,
  kanbanBlocking,
  kanbanBoardIcon,
  type KanbanCard,
} from "./kanban.ts";

type CardPatch = Partial<Omit<KanbanCard, "blockedBy">> & { readonly blockedBy?: string[] };

function card(id: string, patch: CardPatch = {}): KanbanCard {
  const { blockedBy = [], ...rest } = patch;
  return {
    id: id as KanbanCard["id"],
    boardId: "board-toy" as KanbanCard["boardId"],
    number: 1,
    title: id,
    description: "",
    prompt: "",
    stage: "todo",
    priority: 3,
    goalId: null,
    projects: [],
    model: { instanceId: "opencode" as never, model: "opus/claude-opus-5-5" },
    models: [],
    subtasks: [],
    projectId: null,
    links: [],
    blockedBy: blockedBy as never,
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
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    movedAt: "2026-10-25T10:00:00.000Z",
    ...rest,
  };
}

describe("kanbanBlocking", () => {
  it("counts a diamond of waiters once each and takes the most urgent one's priority", () => {
    const blocking = kanbanBlocking([
      card("a"),
      card("b", { blockedBy: ["a"] }),
      card("c", { blockedBy: ["a"], priority: 1 }),
      card("d", { blockedBy: ["b", "c"] }),
      card("e", { blockedBy: ["missing", "e"] }),
      card("f", { blockedBy: ["a"], stage: "completed" }),
    ]);
    expect(blocking.get("a")).toEqual({ holds: 3, urgency: 1 });
    expect(blocking.get("b")).toEqual({ holds: 1, urgency: 3 });
    expect(blocking.get("e")).toEqual({ holds: 0, urgency: 3 });
    expect(blocking.has("f")).toBe(false);
  });

  it("leaves backlog cards out of the waiting, and at the bottom", () => {
    const blocking = kanbanBlocking([
      card("a"),
      card("b", { blockedBy: ["a"], priority: KANBAN_BACKLOG }),
      card("c", { priority: KANBAN_BACKLOG }),
      card("d", { blockedBy: ["c"], priority: 1 }),
    ]);
    expect(blocking.get("a")).toEqual({ holds: 0, urgency: 3 });
    expect(blocking.get("c")).toEqual({ holds: 1, urgency: KANBAN_BACKLOG });
  });
});

const decodeBoard = Schema.decodeUnknownSync(KanbanBoard);

describe("kanbanBoardIcon", () => {
  const opus = { instanceId: "opencode", model: "opus/claude-opus-5-5" };
  const stored = {
    id: "board-toy",
    slug: "toy",
    name: "Toy",
    defaultProjectId: null,
    managerModel: opus,
    evaluatorModel: opus,
    defaultCardModel: opus,
    reviewChains: [],
    defaultReviewChain: null,
    instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
    createdAt: "2026-10-27T00:00:00.000Z",
    archivedAt: null,
  };

  it("reads a board saved before icons as having none, and drops names it doesn't know", () => {
    expect(kanbanBoardIcon(decodeBoard(stored))).toBeNull();
    expect(kanbanBoardIcon(decodeBoard({ ...stored, icon: "rocket" }))).toBe("rocket");
    expect(kanbanBoardIcon(decodeBoard({ ...stored, icon: "retired" }))).toBeNull();
  });
});
