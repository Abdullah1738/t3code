import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  KANBAN_BACKLOG,
  KanbanAnswer,
  KanbanBoard,
  KanbanCardEvent,
  kanbanBlocking,
  kanbanBoardIcon,
  kanbanHeldUpBy,
  KanbanBoardIconImage,
  KANBAN_BOARD_IMAGE_MAX,
  KanbanThreadLink,
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
    subtaskSeq: 0,
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

describe("KanbanCardEvent", () => {
  it("decodes an event stored before head existed as head null", () => {
    const event = Schema.decodeUnknownSync(KanbanCardEvent)({
      id: 1,
      cardId: "card-1",
      at: "2026-10-29T10:00:00.000Z",
      actor: { _tag: "owner" },
      kind: "review",
      fromStage: "in_review",
      toStage: "completed",
      body: "clear",
    });
    expect(event.head).toBeNull();
  });
});

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

describe("kanbanHeldUpBy", () => {
  const evaluatorSubtask = (text: string, state: "open" | "done" = "open") => ({
    id: "s1",
    step: 4,
    text,
    owner: "evaluator" as const,
    state,
    note: null,
    doneBy: null,
    doneAt: null,
  });
  const mergeText =
    "Rebase on latest ardud/main, rerun the box checks if it moved, merge into ardud/main, push origin main";
  const waiter = card("w", { blockedBy: ["b"], workThreadId: "thread-w" as never });
  const byId = (blocker: KanbanCard) => new Map([[blocker.id, blocker]]);

  it("holds a waiter on a completed blocker whose merge subtask is open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBe(blocker);
  });

  it("releases the waiter once the blocker's merge subtask is done", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText, "done")],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("releases a waiter once the merge is done, even with a post-install check still open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [
        evaluatorSubtask(mergeText, "done"),
        evaluatorSubtask(
          "After the next Robob install: check a dependent waits until its blocker's merge subtask is done.",
        ),
      ],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("holds a waiter on the other merge action forms on the board", () => {
    for (const text of [
      "Bring any prefs.md rule text to Abdullah first; merge; deploy robob-watch",
      "merge router.ts into ardud/main",
    ]) {
      const blocker = card("b", {
        stage: "completed",
        workThreadId: "thread-b" as never,
        subtasks: [evaluatorSubtask(text)],
      });
      expect(kanbanHeldUpBy(waiter, byId(blocker))).toBe(blocker);
    }
  });

  it("doesn't hold a waiter on a completed blocker with only a deploy step open", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask("Ask Abdullah to deploy spectrum-bridge")],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("doesn't hold a waiter on a verified blocker", () => {
    const blocker = card("b", {
      stage: "verified",
      workThreadId: "thread-b" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
  });

  it("doesn't hold a waiter on the same thread as a completed blocker awaiting merge", () => {
    const blocker = card("b", {
      stage: "completed",
      workThreadId: "thread-w" as never,
      subtasks: [evaluatorSubtask(mergeText)],
    });
    expect(kanbanHeldUpBy(waiter, byId(blocker))).toBeUndefined();
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
    expect(decodeBoard(stored).iconImage).toBeNull();
  });

  it("takes only small inline pictures as a board image", () => {
    const valid = Schema.is(KanbanBoardIconImage);
    expect(valid("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(valid("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(valid("https://example.com/icon.png")).toBe(false);
    expect(valid(`data:image/png;base64,${"A".repeat(KANBAN_BOARD_IMAGE_MAX)}`)).toBe(false);
  });

describe("own answers", () => {
  it("decodes an answer saved before own words existed with text null", () => {
    const decoded = Schema.decodeUnknownSync(KanbanAnswer)({
      blockId: "q1",
      by: { _tag: "owner" },
      choice: ["o1"],
      at: "2026-10-27T10:00:00.000Z",
    });
    expect(decoded.text).toBeNull();
    expect(decoded.choice).toEqual(["o1"]);
  });
});
});

const decodeThreadLink = Schema.decodeUnknownSync(KanbanThreadLink);

describe("KanbanThreadLink", () => {
  it("decodes a link written before pauses existed as not paused", () => {
    const decoded = decodeThreadLink({
      threadId: "thread-1",
      boardId: "board-1",
      cardId: null,
      role: "work",
      purpose: null,
      discussionId: null,
      model: null,
      startedAt: "2026-10-28T00:00:00.000Z",
      endedAt: null,
    });
    expect(decoded.paused).toBeNull();
  });
});
