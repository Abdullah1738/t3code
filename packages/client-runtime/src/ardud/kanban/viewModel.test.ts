import {
  ThreadId,
  type KanbanBlock,
  type KanbanBoardSnapshot,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanMessage,
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
  askViews,
  canSendChoice,
  cardSteps,
  discussionPresence,
  discussionRows,
  goalPage,
  goalProgress,
  groupCards,
  mergeMessages,
  nextDiscussionWakeMs,
  ownerChoiceAnswer,
  poolViews,
  stageBoard,
  subtaskSteps,
  visibleCards,
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
    titleEditedAt: null,
    settledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    reopenedAt: null,
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
    expect(view.owner.cards[0]!.flag).toEqual({ kind: "ask", label: "Window?", blocking: true });
    expect(view.shipped.flatMap((column) => column.cards.map((c) => c.number))).toEqual([6]);
    expect(view.total).toBe(5);
  });

  it("lists cards with open async asks under Needs Owner too, after the waiting ones", () => {
    const ask = (id: string, text: string, blocking: boolean, closedAt: string | null = null) => ({
      id,
      text,
      blocking,
      by: { _tag: "thread", threadId: "t1" } as never,
      at: "2026-10-25T10:00:00.000Z",
      seq: 1,
      closedAt,
    });
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "working", asks: [ask("q1", "Logo?", false), ask("q2", "Tone?", false)] }),
        card(2, { stage: "needs_owner", question: "Window?", asks: [ask("q1", "Window?", true)] }),
        card(3, { stage: "todo", asks: [ask("q1", "Old", false, "2026-10-25T11:00:00.000Z")] }),
      ]),
    );
    const view = stageBoard(state, NOW);
    expect(view.owner.cards.map((c) => c.number)).toEqual([2, 1]);
    expect(view.owner.cards[1]!.flag).toEqual({
      kind: "ask",
      label: "Tone? (+1)",
      blocking: false,
    });
    const working = view.active.find((column) => column.stage === "working")!;
    expect(working.cards.map((c) => c.number)).toEqual([1]);
    expect(askViews(state.cards.get("card-1")!, NOW).map((a) => [a.id, a.blocking, a.by])).toEqual([
      ["q1", false, "Worker"],
      ["q2", false, "Worker"],
    ]);
    expect(askViews(state.cards.get("card-3")!, NOW)).toEqual([]);
  });

  it("orders todo the way the dispatcher picks: priority, then most blocking, then oldest", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { movedAt: "2026-10-25T09:00:00.000Z" }),
        card(2),
        card(3, { priority: 1, movedAt: "2026-10-25T11:00:00.000Z" }),
        card(4, { stage: "working", blockedBy: ["card-2" as never] }),
      ]),
    );
    const todo = stageBoard(state, NOW).active.find((column) => column.stage === "todo")!;
    expect(todo.cards.map((c) => c.number)).toEqual([3, 2, 1]);
  });

  it("puts to-do cards the dispatcher skips below the ones it can start, and reviews oldest first", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { priority: 1, blockedBy: ["card-4" as never] }),
        card(2, {
          priority: 1,
          stalled: { reason: "x", by: { _tag: "owner" }, at: "2026-10-25T09:00:00.000Z" },
        }),
        card(3, { priority: 3 }),
        card(4, { stage: "working" }),
        card(5, { stage: "needs_review", priority: 1, movedAt: "2026-10-25T11:00:00.000Z" }),
        card(6, { stage: "needs_review", priority: 4, movedAt: "2026-10-25T09:00:00.000Z" }),
        card(7, { priority: 5, movedAt: "2026-10-25T08:00:00.000Z" }),
      ]),
    );
    const columns = stageBoard(state, NOW).active;
    const numbers = (stage: string) =>
      columns.find((column) => column.stage === stage)!.cards.map((c) => c.number);
    expect(numbers("todo")).toEqual([3, 1, 2, 7]);
    const backlog = columns.find((column) => column.stage === "todo")!.cards.at(-1)!;
    expect(backlog.flag).toEqual({ kind: "blocked", label: "In the backlog" });
    expect(numbers("needs_review")).toEqual([6, 5]);
  });

  it("says a card waits on setup while the board's setup runs, and not after it ends", () => {
    const setup = (status: "running" | "done") => ({
      status,
      discussionId: "disc-setup",
      threadId: "t-setup",
      startedAt: "2026-10-25T09:00:00.000Z",
      finishedAt: status === "done" ? "2026-10-25T10:00:00.000Z" : null,
    });
    const withSetup = (status: "running" | "done", cards: KanbanCard[]) => {
      const snap = snapshot(cards);
      return boardStateFromSnapshot({
        ...snap,
        board: { ...snap.board, setup: setup(status) },
      } as KanbanBoardSnapshot);
    };
    const flagOf = (state: ReturnType<typeof withSetup>, n: number) =>
      stageBoard(state, NOW)
        .active.flatMap((column) => column.cards)
        .find((c) => c.number === n)!.flag;

    const waiting = card(1, { priority: 1 });
    const running = card(2, { priority: 1, stage: "working", activeThreadId: "t-work" as never });
    const duringSetup = withSetup("running", [waiting, running]);
    expect(flagOf(duringSetup, 1)).toEqual({ kind: "blocked", label: "Setup is running" });
    expect(flagOf(duringSetup, 2)).toBeNull();
    expect(flagOf(withSetup("done", [waiting, running]), 1)).toBeNull();
  });

  it("counts a card's subtasks, and flags one waiting on the evaluator's step", () => {
    const subtask = (
      id: string,
      step: number,
      owner: "work" | "evaluator",
      state: "open" | "done" = "open",
    ) => ({ id, step, text: id, owner, state, note: null, doneBy: null, doneAt: null });
    const waiting = card(1, {
      subtasks: [subtask("s1", 1, "work", "done"), subtask("s2", 2, "evaluator")],
    });
    const state = boardStateFromSnapshot(snapshot([waiting, card(2)]));
    const todo = stageBoard(state, NOW).active.find((column) => column.stage === "todo")!.cards;
    expect(todo.map((c) => c.number)).toEqual([2, 1]);
    expect(todo[1]!.flag).toEqual({ kind: "blocked", label: "Waits on the evaluator" });
    expect(todo[1]!.subtasks).toEqual({ done: 1, total: 2 });
    expect(todo[0]!.subtasks).toBeNull();
    expect(subtaskSteps(waiting).map((step) => [step.step, step.when])).toEqual([
      [1, "past"],
      [2, "now"],
    ]);
  });

  it("orders a goal's stages and the goal grouping the same way", () => {
    const goal = { goalId: "goal-a" as never };
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { ...goal, priority: 1, blockedBy: ["card-4" as never] }),
        card(3, { ...goal, priority: 3 }),
        card(4, { ...goal, stage: "working" }),
        card(5, {
          ...goal,
          stage: "needs_review",
          priority: 1,
          movedAt: "2026-10-25T11:00:00.000Z",
        }),
        card(6, {
          ...goal,
          stage: "needs_review",
          priority: 4,
          movedAt: "2026-10-25T09:00:00.000Z",
        }),
      ]),
    );
    const page = goalPage(state, "goal-a", NOW)!;
    const stage = (name: string) =>
      page.stages.find((column) => column.stage === name)!.cards.map((c) => c.number);
    expect(stage("todo")).toEqual([3, 1]);
    expect(stage("needs_review")).toEqual([6, 5]);
    expect(groupCards(state, "goal", NOW)[0]!.cards.map((c) => c.number)).toEqual([4, 6, 5, 3, 1]);
  });
});

describe("poolViews", () => {
  it("counts a busy slot per thread, not per card", () => {
    const base = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "working", activeThreadId: "t-a" as never, activePool: "opencode/opus" }),
        card(2, { stage: "working", activeThreadId: "t-a" as never, activePool: "opencode/opus" }),
        card(3, {
          stage: "in_review",
          activeThreadId: "t-b" as never,
          activePool: "opencode/opus",
        }),
        card(4, { stage: "todo", workThreadId: "t-c" as never }),
      ]),
    );
    const state = { ...base, pools: [{ key: "opencode/opus", model, slots: 3 }] };
    expect(poolViews(state).map((pool) => [pool.busy, pool.slots])).toEqual([[2, 3]]);
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

describe("cardSteps", () => {
  const completed = (number: number, movedAt: string) =>
    card(number, { stage: "completed", movedAt });

  it("steps through a stage column in board order and stops at the ends", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        completed(1, "2026-10-25T09:00:00.000Z"),
        completed(2, "2026-10-25T10:00:00.000Z"),
        completed(3, "2026-10-25T11:00:00.000Z"),
      ]),
    );
    const steps = (id: string) => cardSteps(state, NOW, {}, "stage", id);
    // Newest first: 3, 2, 1.
    expect(steps("card-3")).toMatchObject({ previous: null, next: "card-2" });
    expect(steps("card-2")).toMatchObject({ previous: "card-3", next: "card-1" });
    expect(steps("card-1")).toMatchObject({ previous: "card-2", next: null });
  });

  it("steps a Needs Owner card through Needs Owner, and a Working card with an open ask through Working", () => {
    const ask = {
      id: "q1",
      text: "Which window?",
      blocking: false,
      by: { _tag: "thread", threadId: "t1" } as never,
      at: "2026-10-25T10:00:00.000Z",
      closedAt: null,
    };
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "needs_owner", question: "Window?", priority: 2 }),
        card(2, { stage: "needs_owner", question: "Scope?", priority: 2 }),
        card(3, { stage: "working", asks: [ask] as never }),
        card(4, { stage: "working" }),
      ]),
    );
    expect(cardSteps(state, NOW, {}, "stage", "card-1")).toMatchObject({
      previous: null,
      next: "card-2",
    });
    expect(cardSteps(state, NOW, {}, "stage", "card-3")).toMatchObject({
      previous: null,
      next: "card-4",
    });
  });

  it("skips cards the filter hides, and gives null for an unknown card", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "todo", title: "alpha" }),
        card(2, { stage: "todo", title: "beta" }),
        card(3, { stage: "todo", title: "alpha two" }),
      ]),
    );
    const steps = cardSteps(state, NOW, { query: "alpha" }, "stage", "card-1");
    expect(steps.next).toBe("card-3");
    expect(cardSteps(state, NOW, { query: "alpha" }, "stage", "card-2")).toMatchObject({
      previous: null,
      next: null,
    });
    expect(cardSteps(state, NOW, {}, "stage", "card-99")).toMatchObject({
      previous: null,
      next: null,
    });
  });

  it("steps within a card's goal group only when grouped by goal", () => {
    const state = boardStateFromSnapshot(
      snapshot([
        card(1, { stage: "todo", goalId: "goal-a" as never }),
        card(2, { stage: "todo", goalId: "goal-a" as never }),
        card(3, { stage: "todo" }),
      ]),
    );
    const steps = cardSteps(state, NOW, {}, "goal", "card-2");
    expect(steps.previous !== null || steps.next !== null).toBe(true);
    expect([steps.previous, steps.next]).not.toContain("card-3");
    expect(cardSteps(state, NOW, {}, "goal", "card-3")).toMatchObject({
      previous: null,
      next: null,
    });
  });

  it("opens the next open Verified card after settling, and closes when none is left", () => {
    const verified = (number: number, movedAt: string, settledAt: string | null = null) =>
      card(number, { stage: "verified", movedAt, settledAt: settledAt as never });
    // Newest first: A (12:00), B (11:00), C (10:00).
    const state = boardStateFromSnapshot(
      snapshot([
        verified(1, "2026-10-25T12:00:00.000Z"),
        verified(2, "2026-10-25T11:00:00.000Z"),
        verified(3, "2026-10-25T10:00:00.000Z"),
      ]),
    );
    expect(cardSteps(state, NOW, {}, "stage", "card-2").afterSettle).toBe("card-3");
    expect(cardSteps(state, NOW, {}, "stage", "card-3").afterSettle).toBe("card-2");

    const lone = boardStateFromSnapshot(snapshot([verified(1, "2026-10-25T12:00:00.000Z")]));
    expect(cardSteps(lone, NOW, {}, "stage", "card-1").afterSettle).toBeNull();

    const withSettled = boardStateFromSnapshot(
      snapshot([
        verified(1, "2026-10-25T12:00:00.000Z"),
        verified(2, "2026-10-25T11:00:00.000Z", "2026-10-25T11:30:00.000Z"),
        verified(3, "2026-10-25T10:00:00.000Z"),
      ]),
    );
    expect(cardSteps(withSettled, NOW, { settled: "include" }, "stage", "card-1").afterSettle).toBe(
      "card-3",
    );

    expect(cardSteps(state, NOW, {}, "goal", "card-2").afterSettle).toBeNull();
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

describe("card search", () => {
  const cards = [
    card(1, { title: "Login page", description: "Fix the OTP field" }),
    card(2, { prompt: "Rewrite the webhook handler" }),
    card(3, {
      links: [
        {
          kind: "pr",
          url: "https://github.com/acme/app/pull/77",
          label: "Billing PR",
          state: "open",
          checkedAt: null,
        },
      ],
    }),
    card(12, { title: "Old work", settledAt: "2026-10-24T10:00:00.000Z" }),
  ];
  const state = boardStateFromSnapshot(snapshot(cards));
  const numbers = (filter: Parameters<typeof visibleCards>[1]) =>
    visibleCards(state, filter)
      .map((entry) => entry.number)
      .sort((a, b) => a - b);

  it("matches description, prompt, link labels and urls, and #number", () => {
    expect(numbers({ query: "otp" })).toEqual([1]);
    expect(numbers({ query: "webhook" })).toEqual([2]);
    expect(numbers({ query: "billing" })).toEqual([3]);
    expect(numbers({ query: "pull/77" })).toEqual([3]);
    expect(numbers({ query: "#1" })).toEqual([1]);
  });

  it("needs every word, in any order, like the agents' card_search", () => {
    expect(numbers({ query: "otp login" })).toEqual([1]);
    expect(numbers({ query: "otp webhook" })).toEqual([]);
  });

  it("hides settled cards unless asked", () => {
    expect(numbers({})).toEqual([1, 2, 3]);
    expect(numbers({ settled: "only" })).toEqual([12]);
    expect(numbers({ settled: "include", query: "#1" })).toEqual([1, 12]);
  });
});

describe("discussions", () => {
  it("tracks unread from discussion changes and clears it when the owner reads", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [discussion(3, 1)]);
    state = withDiscussions(state, [], [message(3, false, "Window?")]);
    expect(discussionRows(state, NOW).active).toMatchObject([
      { id: "disc-1", unread: 2, preview: "Evaluator: Window?" },
    ]);
    state = applyKanbanChange(state, { _tag: "discussion", discussion: discussion(4, 1) });
    expect(state.unread.get("disc-1")).toBe(3);
    state = withOwnerRead(state, "disc-1", 4);
    expect(state.unread.get("disc-1")).toBe(0);
  });

  it("groups settled and snoozed discussions, and wakes a lapsed snooze", () => {
    const named = (id: string, patch: Partial<KanbanDiscussion>) =>
      ({ ...discussion(1, 1), id, title: id, ...patch }) as KanbanDiscussion;
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [
      named("plain", {}),
      named("parked", { settledAt: "2026-10-25T11:30:00.000Z" }),
      named("later", { snoozedUntil: "2026-10-25T15:00:00.000Z" }),
      named("lapsed", { snoozedUntil: "2026-10-25T11:59:00.000Z" }),
      // Settled wins over a snooze still on the record.
      named("both", {
        settledAt: "2026-10-25T11:30:00.000Z",
        snoozedUntil: "2026-10-25T15:00:00.000Z",
      }),
    ]);
    const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id).sort();
    const groups = discussionRows(state, NOW);
    expect(ids(groups.active)).toEqual(["lapsed", "plain"]);
    expect(ids(groups.snoozed)).toEqual(["later"]);
    expect(ids(groups.settled)).toEqual(["both", "parked"]);
    expect(groups.active.find((row) => row.id === "lapsed")?.snoozedUntil).toBeNull();
    expect(nextDiscussionWakeMs(state, NOW)).toBe(Date.parse("2026-10-25T15:00:00.000Z"));
    expect(ids(discussionRows(state, Date.parse("2026-10-25T16:00:00.000Z")).active)).toEqual([
      "lapsed",
      "later",
      "plain",
    ]);
  });

  it("puts pinned discussions in their own group and can hide card discussions", () => {
    const named = (id: string, patch: Partial<KanbanDiscussion>) =>
      ({ ...discussion(1, 1), id, title: id, ...patch }) as KanbanDiscussion;
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [
      named("plain", {}),
      named("pinned", { pinnedAt: "2026-10-25T10:00:00.000Z" }),
      // Settled wins over a pin on the record.
      named("parked-pinned", {
        pinnedAt: "2026-10-25T10:00:00.000Z",
        settledAt: "2026-10-25T11:30:00.000Z",
      }),
      named("snoozed-pinned", {
        pinnedAt: "2026-10-25T10:00:00.000Z",
        snoozedUntil: "2026-10-25T15:00:00.000Z",
      }),
      named("card-chat", { cardId: "card-1" as KanbanDiscussion["cardId"] }),
      named("channel", { cardId: null }),
    ]);
    const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id).sort();
    const groups = discussionRows(state, NOW);
    expect(ids(groups.pinned)).toEqual(["pinned"]);
    expect(ids(groups.settled)).toEqual(["parked-pinned"]);
    expect(ids(groups.snoozed)).toEqual(["snoozed-pinned"]);
    expect(ids(groups.active)).toEqual(["card-chat", "channel", "plain"]);

    const hidden = discussionRows(state, NOW, { hideCards: true });
    const visible = [
      ...hidden.pinned,
      ...hidden.active,
      ...hidden.snoozed,
      ...hidden.settled,
    ].map((row) => row.id);
    expect(visible).not.toContain("card-chat");
    expect(visible).toContain("channel");
    expect(ids(hidden.active)).toEqual(["channel", "plain"]);
  });

  it("keeps only unread discussions with unreadOnly", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [discussion(3, 1)]);
    state = withDiscussions(state, [], [message(3, false, "Window?")]);
    expect(discussionRows(state, NOW, { unreadOnly: true }).active.map((row) => row.id)).toEqual([
      "disc-1",
    ]);
    state = withOwnerRead(state, "disc-1", 3);
    expect(discussionRows(state, NOW, { unreadOnly: true }).active).toEqual([]);
  });

  it("searches discussions by title and latest message", () => {
    let state = boardStateFromSnapshot(snapshot([]));
    state = withDiscussionList(state, [
      discussion(3, 3),
      { ...discussion(1, 1), id: "disc-2" as KanbanDiscussion["id"], title: "Deploy" },
    ]);
    state = withDiscussions(state, [], [message(3, false, "Which window frame?")]);
    expect(discussionRows(state, NOW, { query: "deploy" }).active.map((row) => row.id)).toEqual([
      "disc-2",
    ]);
    expect(discussionRows(state, NOW, { query: "FRAME" }).active.map((row) => row.id)).toEqual([
      "disc-1",
    ]);
    expect(discussionRows(state, NOW, { query: "nothing" }).active).toEqual([]);
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

describe("own answers on a choice block", () => {
  type Choice = Extract<KanbanBlock, { _tag: "choice" }>;
  const choice = (style: "poll" | "pick", multi: boolean): Choice => ({
    _tag: "choice",
    id: "q1",
    style,
    question: "Ship?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    multi,
  });

  it("allows a poll only with options, a single pick with one of the two, a multi pick with either", () => {
    const poll = choice("poll", false);
    expect(canSendChoice(poll, ["yes"], "")).toBe(true);
    expect(canSendChoice(poll, ["yes"], "maybe")).toBe(false);
    expect(canSendChoice(poll, [], "maybe")).toBe(false);

    const single = choice("pick", false);
    expect(canSendChoice(single, ["yes"], "")).toBe(true);
    expect(canSendChoice(single, [], "Wait")).toBe(true);
    expect(canSendChoice(single, ["yes"], "Wait")).toBe(false);
    expect(canSendChoice(single, [], "   ")).toBe(false);
    expect(canSendChoice(single, [], "")).toBe(false);

    const multi = choice("pick", true);
    expect(canSendChoice(multi, ["yes", "no"], "")).toBe(true);
    expect(canSendChoice(multi, ["yes"], "and more")).toBe(true);
    expect(canSendChoice(multi, [], "only words")).toBe(true);
    expect(canSendChoice(multi, [], "  ")).toBe(false);
  });

  it("finds only the owner's answer on this block", () => {
    const block = choice("pick", false);
    const at = "2026-10-27T10:00:00.000Z";
    const answers = [
      { blockId: "other", by: { _tag: "owner" as const }, choice: ["yes"], text: null, at },
      {
        blockId: "q1",
        by: { _tag: "evaluator" as const, threadId: ThreadId.make("t1") },
        choice: ["no"],
        text: null,
        at,
      },
      { blockId: "q1", by: { _tag: "owner" as const }, choice: [], text: "Wait", at },
    ];
    expect(ownerChoiceAnswer(block, answers)?.text).toBe("Wait");
    expect(ownerChoiceAnswer(block, answers.slice(0, 2))).toBeNull();
  });
});
});
