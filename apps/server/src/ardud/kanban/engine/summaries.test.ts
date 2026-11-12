import {
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { applyChange, follow, listUpdate, summaries, tallyBoards } from "./summaries.ts";

const opus = { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" };
const at = "2026-10-26T00:00:00Z";

const board = (id: string, name = id): KanbanBoard => ({
  id: KanbanBoardId.make(id),
  slug: id,
  name,
  icon: null,
  iconImage: null,
  defaultProjectId: null,
  managerModel: opus,
  evaluatorModel: opus,
  defaultCardModel: opus,
  reviewChains: [],
  defaultReviewChain: null,
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: null,
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
  titleEditedAt: null,
  settledAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  reopenedAt: null,
});

const thread = ThreadId.make("t1");
const NOW = Date.parse("2026-10-26T12:00:00Z");

const ask = (id: string, patch: Partial<KanbanOwnerAsk> = {}): KanbanOwnerAsk => ({
  id,
  text: id,
  blocking: false,
  by: { _tag: "evaluator", threadId: thread },
  at,
  seq: null,
  closedAt: null,
  ...patch,
});

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
        threadIds: [thread],
      },
      { board: board("b2"), cards: [], discussions: [], threadIds: [] },
    ]);
    expect(
      summaries(tallies, NOW).map(({ board, ...counts }) => ({ id: board.id, ...counts })),
    ).toEqual([
      { id: "b1", needsOwner: 2, running: 1, unread: 3, threadIds: [thread] },
      { id: "b2", needsOwner: 0, running: 0, unread: 0, threadIds: [] },
    ]);
  });

  it("follows changes and reports only those that move a count", () => {
    const tallies = tallyBoards([
      { board: board("b1"), cards: [], discussions: [], threadIds: [] },
    ]);
    const counts = () => {
      const [summary] = summaries(tallies, NOW);
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

  it("keeps every thread a board starts, once", () => {
    const tallies = tallyBoards([
      { board: board("b1"), cards: [], discussions: [], threadIds: [] },
    ]);
    const started = {
      _tag: "thread" as const,
      thread: {
        threadId: thread,
        title: "#1 work",
        running: true,
        needsInput: false,
        lastActivityAt: at,
      },
    };
    expect(applyChange(tallies, "b1", started)).toBe(true);
    expect(applyChange(tallies, "b1", started)).toBe(false);
    expect(summaries(tallies, NOW)[0]?.threadIds).toEqual([thread]);
  });

  it("sends the whole list first, then only changed boards and new threads", () => {
    const tallies = tallyBoards([
      { board: board("b1"), cards: [], discussions: [], threadIds: [thread] },
      { board: board("b2"), cards: [], discussions: [], threadIds: [] },
    ]);
    const shape = (first: boolean) =>
      listUpdate(tallies, first, NOW).map((entry) => [
        entry.boardId,
        entry.board?.name ?? null,
        entry.threadIds,
      ]);
    expect(shape(true)).toEqual([
      ["b1", "b1", [thread]],
      ["b2", "b2", []],
    ]);
    const second = ThreadId.make("t2");
    applyChange(tallies, "b1", {
      _tag: "thread",
      thread: {
        threadId: second,
        title: "#2 work",
        running: true,
        needsInput: false,
        lastActivityAt: at,
      },
    });
    applyChange(tallies, "b2", { _tag: "board", board: board("b2", "Renamed") });
    expect(shape(false)).toEqual([
      ["b1", null, [second]],
      ["b2", "Renamed", []],
    ]);
    expect(shape(false)).toEqual([
      ["b1", null, []],
      ["b2", null, []],
    ]);
  });

  it("adds new boards and renames from board changes", () => {
    const tallies = tallyBoards([
      { board: board("b1"), cards: [], discussions: [], threadIds: [] },
    ]);
    expect(applyChange(tallies, "b1", { _tag: "board", board: board("b1", "Renamed") })).toBe(true);
    expect(applyChange(tallies, "b2", { _tag: "board", board: board("b2") })).toBe(true);
    expect(summaries(tallies, NOW).map((summary) => summary.board.name)).toEqual(["Renamed", "b2"]);
  });

  it.effect("streams the list first, then only changes that move a count", () =>
    Effect.gen(function* () {
      const tallies = tallyBoards([
        { board: board("b1"), cards: [], discussions: [], threadIds: [] },
      ]);
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
      const tallies = tallyBoards([
        { board: board("b1"), cards: [], discussions: [], threadIds: [] },
      ]);
      const owner = (id: string) => ({
        boardId: "b1",
        change: { _tag: "card" as const, card: card(id, { stage: "needs_owner" }) },
      });
      const changes = Stream.fromArrays([owner("c1"), owner("c2"), owner("c3")], [owner("c4")]);
      const lists = yield* Stream.runCollect(follow(tallies, changes));
      expect(Array.from(lists, (list) => list[0]?.needsOwner)).toEqual([0, 3, 4]);
    }),
  );

  it("counts for the owner only cards with an ask he can answer now", () => {
    const later = "2026-10-26T13:00:00Z";
    const tallies = tallyBoards([
      {
        board: board("b1"),
        cards: [
          card("his", { asks: [ask("q1")] }),
          card("held-no-ask", { stage: "needs_owner" }),
          card("handed", { stage: "needs_owner", asks: [ask("q1", { handedAt: at })] }),
          card("clarify", { asks: [ask("q1", { clarifyAskedAt: at })] }),
          card("clarify-running", {
            stage: "working",
            activeThreadId: thread,
            asks: [ask("q1", { clarifyAskedAt: at })],
          }),
          card("expired", { asks: [ask("q1", { expiresAt: at })] }),
          card("expires-later", { asks: [ask("q1", { expiresAt: later })] }),
          card("one-of-two", { asks: [ask("q1", { handedAt: at }), ask("q2")] }),
          card("closed", { asks: [ask("q1", { closedAt: at })] }),
        ],
        discussions: [],
        threadIds: [],
      },
    ]);
    const counts = (nowMs: number) => {
      const [summary] = summaries(tallies, nowMs);
      return [summary?.needsOwner, summary?.running];
    };
    // his, held-no-ask, expires-later, one-of-two.
    expect(counts(NOW)).toEqual([4, 1]);
    // An hour on, the last ask with an expiry has passed it.
    expect(counts(Date.parse(later))).toEqual([3, 1]);

    // Handing an ask over and taking it back moves the count; so does his clarifying reply.
    const set = (asks: ReadonlyArray<KanbanOwnerAsk>) =>
      applyChange(tallies, "b1", { _tag: "card", card: card("his", { asks }) });
    expect(set([ask("q1", { handedAt: at })])).toBe(true);
    expect(counts(NOW)).toEqual([3, 1]);
    expect(set([ask("q1")])).toBe(true);
    expect(set([ask("q1", { clarifyAskedAt: at })])).toBe(true);
    expect(counts(NOW)).toEqual([3, 1]);
  });

  it("leaves a snoozed ask out until its time, and counts it again after", () => {
    const until = "2026-10-26T13:00:00Z";
    const tallies = tallyBoards([
      {
        board: board("b1"),
        cards: [
          card("snoozed", { stage: "needs_owner", asks: [ask("q1", { snoozedUntil: until })] }),
          // One ask snoozed, one not: the card still counts.
          card("mixed", { asks: [ask("q1", { snoozedUntil: until }), ask("q2")] }),
          // Snoozed past its own expiry: never his.
          card("gone", { asks: [ask("q1", { snoozedUntil: until, expiresAt: at })] }),
        ],
        discussions: [],
        threadIds: [],
      },
    ]);
    const needs = (nowMs: number) => summaries(tallies, nowMs)[0]?.needsOwner;
    expect(needs(NOW)).toBe(1);
    expect(needs(Date.parse(until) - 1)).toBe(1);
    expect(needs(Date.parse(until))).toBe(2);
    // Snoozing and unsnoozing are changes that move the count.
    const set = (asks: ReadonlyArray<KanbanOwnerAsk>) =>
      applyChange(tallies, "b1", { _tag: "card", card: card("mixed", { asks }) });
    expect(set([ask("q1", { snoozedUntil: until }), ask("q2", { snoozedUntil: until })])).toBe(
      true,
    );
    expect(needs(NOW)).toBe(0);
    expect(set([ask("q1"), ask("q2", { snoozedUntil: until })])).toBe(true);
    expect(needs(NOW)).toBe(1);
  });

  it.effect("drops an expired ask from the list at the next change", () =>
    Effect.gen(function* () {
      const expiresAt = "2026-10-26T12:30:00Z";
      const tallies = tallyBoards([
        {
          board: board("b1"),
          cards: [card("c1", { asks: [ask("q1", { expiresAt })] })],
          discussions: [],
          threadIds: [],
        },
      ]);
      let nowMs = NOW;
      // A change that moves no count by itself, arriving after the ask expired.
      const changes = Stream.make({
        boardId: "b1",
        change: { _tag: "card" as const, card: card("c2") },
      }).pipe(Stream.tap(() => Effect.sync(() => (nowMs = Date.parse(expiresAt) + 1))));
      const lists = yield* Stream.runCollect(follow(tallies, changes, () => nowMs));
      expect(Array.from(lists).map((list) => list[0]?.needsOwner)).toEqual([1, 0]);
    }),
  );
});
