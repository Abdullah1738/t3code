import {
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { applyChange, follow, summaries, tallyBoards } from "./summaries.ts";

const opus = { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" };
const at = "2026-10-26T00:00:00Z";

const board = (id: string, name = id): KanbanBoard => ({
  id: KanbanBoardId.make(id),
  slug: id,
  name,
  defaultProjectId: null,
  managerModel: opus,
  evaluatorModel: opus,
  defaultCardModel: opus,
  reviewChains: [],
  defaultReviewChain: null,
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  createdAt: at,
  archivedAt: null,
});

const card = (id: string, patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: KanbanCardId.make(id),
  boardId: KanbanBoardId.make("b1"),
  number: 1,
  title: id,
  description: "",
  prompt: "do it",
  stage: "todo",
  priority: 3,
  goalId: null,
  projects: [],
  model: opus,
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
  createdAt: at,
  updatedAt: at,
  movedAt: at,
  ...patch,
});

const discussion = (id: string, lastSeq: number, ownerRead: number): KanbanDiscussion => ({
  id: KanbanDiscussionId.make(id),
  boardId: KanbanBoardId.make("b1"),
  cardId: null,
  title: id,
  evaluatorThreadId: null,
  participants: [
    {
      actor: { _tag: "owner" },
      name: "Owner",
      lastReadSeq: ownerRead,
      typingUntil: null,
      owes: null,
    },
  ],
  lastSeq,
  lastMessageAt: null,
  createdBy: { _tag: "owner" },
  createdAt: at,
  archivedAt: null,
});

const thread = ThreadId.make("t1");

describe("board summaries", () => {
  it("counts cards waiting on the owner, running cards and unread messages", () => {
    const tallies = tallyBoards([
      {
        board: board("b1"),
        cards: [
          card("waits", { stage: "needs_owner" }),
          card("waits-held", { stage: "needs_owner", activeThreadId: thread }),
          card("runs", { stage: "working", activeThreadId: thread }),
          card("settled", { stage: "needs_owner", settledAt: at }),
          card("idle"),
        ],
        discussions: [discussion("d1", 5, 2), discussion("d2", 4, 4)],
      },
      { board: board("b2"), cards: [], discussions: [] },
    ]);
    expect(summaries(tallies).map(({ board, ...counts }) => ({ id: board.id, ...counts }))).toEqual(
      [
        { id: "b1", needsOwner: 2, running: 1, unread: 3 },
        { id: "b2", needsOwner: 0, running: 0, unread: 0 },
      ],
    );
  });

  it("follows changes and reports only those that move a count", () => {
    const tallies = tallyBoards([{ board: board("b1"), cards: [], discussions: [] }]);
    const counts = () => {
      const [summary] = summaries(tallies);
      return summary && [summary.needsOwner, summary.running, summary.unread];
    };

    // A new idle card and an edit to it move no count.
    expect(applyChange(tallies, "b1", { _tag: "card", card: card("c1") })).toBe(false);
    expect(applyChange(tallies, "b1", { _tag: "card", card: card("c1", { title: "new" }) })).toBe(
      false,
    );
    applyChange(tallies, "b1", {
      _tag: "card",
      card: card("c1", { stage: "working", activeThreadId: thread }),
    });
    expect(counts()).toEqual([0, 1, 0]);

    applyChange(tallies, "b1", { _tag: "card", card: card("c1", { stage: "needs_owner" }) });
    expect(counts()).toEqual([1, 0, 0]);

    applyChange(tallies, "b1", { _tag: "discussion", discussion: discussion("d1", 3, 0) });
    expect(counts()).toEqual([1, 0, 3]);
    // Typing indicators save the discussion too; the count stays put.
    expect(
      applyChange(tallies, "b1", { _tag: "discussion", discussion: discussion("d1", 3, 0) }),
    ).toBe(false);
    applyChange(tallies, "b1", { _tag: "discussion", discussion: discussion("d1", 3, 3) });
    expect(counts()).toEqual([1, 0, 0]);

    expect(
      applyChange(tallies, "b1", { _tag: "cardRemoved", cardId: KanbanCardId.make("c1") }),
    ).toBe(true);
    expect(counts()).toEqual([0, 0, 0]);
    expect(applyChange(tallies, "b9", { _tag: "card", card: card("c2") })).toBe(false);
  });

  it("adds new boards and renames from board changes", () => {
    const tallies = tallyBoards([{ board: board("b1"), cards: [], discussions: [] }]);
    expect(applyChange(tallies, "b1", { _tag: "board", board: board("b1", "Renamed") })).toBe(true);
    expect(applyChange(tallies, "b2", { _tag: "board", board: board("b2") })).toBe(true);
    expect(summaries(tallies).map((summary) => summary.board.name)).toEqual(["Renamed", "b2"]);
  });

  it.effect("streams the list first, then only changes that move a count", () =>
    Effect.gen(function* () {
      const tallies = tallyBoards([{ board: board("b1"), cards: [], discussions: [] }]);
      const changes = Stream.fromIterable([
        { boardId: "b1", change: { _tag: "card" as const, card: card("c1") } },
        {
          boardId: "b1",
          change: { _tag: "card" as const, card: card("c1", { stage: "needs_owner" }) },
        },
        {
          boardId: "b1",
          change: { _tag: "discussion" as const, discussion: discussion("d1", 0, 0) },
        },
      ]);
      const lists = yield* Stream.runCollect(follow(tallies, changes));
      expect(Array.from(lists, (list) => list[0]?.needsOwner)).toEqual([0, 1]);
    }),
  );

  it.effect("sends one list for a burst of changes that arrive together", () =>
    Effect.gen(function* () {
      const tallies = tallyBoards([{ board: board("b1"), cards: [], discussions: [] }]);
      const owner = (id: string) => ({
        boardId: "b1",
        change: { _tag: "card" as const, card: card(id, { stage: "needs_owner" }) },
      });
      const changes = Stream.fromArrays([owner("c1"), owner("c2"), owner("c3")], [owner("c4")]);
      const lists = yield* Stream.runCollect(follow(tallies, changes));
      expect(Array.from(lists, (list) => list[0]?.needsOwner)).toEqual([0, 3, 4]);
    }),
  );
});
