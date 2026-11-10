import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  KANBAN_BACKLOG,
  KanbanAnswer,
  KanbanBoard,
  KanbanCard,
  KanbanCardEvent,
  kanbanAwaitsMerge,
  kanbanBlocking,
  kanbanBoardClock,
  kanbanBoardIcon,
  kanbanCardFlow,
  kanbanEvaluatorStep,
  kanbanHeldUpBy,
  kanbanPickOrder,
  kanbanRetryNotBefore,
  kanbanRetrying,
  kanbanSchedule,
  kanbanScriptStep,
  kanbanWaitsOnEvaluator,
  KANBAN_AGING_STEP_MS,
  KANBAN_RETRY_BACKOFF_MS,
  KanbanBoardIconImage,
  KANBAN_WAIT_LIMIT_MS,
  KANBAN_CARD_EVENT_KINDS,
  KANBAN_WAIT_CHECK_FAILURES,
  kanbanWait,
  kanbanWaitCheckFailing,
  kanbanWaitDeadlineMs,
  kanbanWaitExpired,
  kanbanWaiting,
  kanbanWaitStale,
  kanbanWithoutWait,
  type KanbanWait,
  KANBAN_BOARD_IMAGE_MAX,
  KanbanSubtask,
  KanbanThreadLink,
} from "./kanban.ts";
import { KanbanCardDetail } from "./kanbanRpc.ts";

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

const decodeCard = Schema.decodeUnknownSync(KanbanCard);
const encodeCard = Schema.encodeSync(KanbanCard);

describe("KanbanCard retries", () => {
  const stored = JSON.parse(JSON.stringify(card("a")));

  it("loads a card stored before retries existed unchanged, with no retry record", () => {
    expect("retries" in stored).toBe(false);
    const decoded = decodeCard(stored);
    expect(decoded.retries).toBeUndefined();
    expect(kanbanRetrying(decoded)).toBeUndefined();
    expect(encodeCard(decoded)).toEqual(stored);
  });

  it("keeps a retry record through storage, and shows it until the card is flagged", () => {
    const retry = {
      kind: "run_failed",
      role: "work",
      runId: "run-1",
      reason: "upstream closed the stream",
      at: "2026-11-10T10:00:00.000Z",
      state: "waiting",
    };
    const decoded = decodeCard(JSON.parse(JSON.stringify({ ...stored, retries: [retry] })));
    expect(decoded.retries).toEqual([retry]);
    expect(encodeCard(decoded).retries).toEqual([retry]);
    expect(kanbanRetrying(decoded)).toEqual(retry);
    expect(
      kanbanRetrying({
        ...decoded,
        stalled: { reason: "Run failed: x", by: { _tag: "owner" }, at: decoded.createdAt },
      }),
    ).toBeUndefined();
  });

  it("says when a failed run's card may start again, and nothing for other cards", () => {
    const at = "2026-11-10T10:00:00.000Z";
    const waiting = {
      kind: "run_failed",
      role: "work",
      runId: "run-1",
      reason: "upstream closed the stream",
      at,
      state: "waiting",
    } as const;
    expect(kanbanRetryNotBefore({ retries: undefined })).toBeNull();
    expect(kanbanRetryNotBefore({ retries: [] })).toBeNull();
    expect(kanbanRetryNotBefore({ retries: [waiting] })).toBe(
      Date.parse(at) + KANBAN_RETRY_BACKOFF_MS,
    );
    // A review started again at once waits for nothing; a stamp that doesn't parse holds nothing back.
    expect(
      kanbanRetryNotBefore({
        retries: [
          { ...waiting, kind: "no_verdict", role: "review", runId: null, state: "restarted" },
        ],
      }),
    ).toBeNull();
    expect(kanbanRetryNotBefore({ retries: [{ ...waiting, at: "not a time" }] })).toBeNull();
  });

  it("gives a caller with no clock the board's newest card stamp", () => {
    expect(kanbanBoardClock([])).toBe(0);
    expect(
      kanbanBoardClock([
        { updatedAt: "2026-11-10T10:00:00.000Z" },
        { updatedAt: "2026-11-10T12:00:00.000Z" },
        { updatedAt: "2026-11-09T23:00:00.000Z" },
      ]),
    ).toBe(Date.parse("2026-11-10T12:00:00.000Z"));
  });
});

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

/** The walk kanbanBlocking used before the single-pass graph: one breadth-first search per open card. */
function blockingByWalk(cards: ReadonlyArray<KanbanCard>) {
  const isOpen = (c: KanbanCard) =>
    !["completed", "deployed", "verified"].includes(c.stage) && c.settledAt === null;
  const byId = new Map(cards.map((c) => [c.id as string, c]));
  const waiters = new Map<string, Array<string>>();
  for (const c of cards) {
    if (!isOpen(c) || c.priority === KANBAN_BACKLOG) continue;
    for (const id of c.blockedBy) waiters.set(id, [...(waiters.get(id) ?? []), c.id]);
  }
  const result = new Map<string, { holds: number; urgency: number }>();
  for (const c of cards) {
    if (!isOpen(c)) continue;
    const seen = new Set<string>([c.id]);
    const queue: Array<string> = [c.id];
    let urgency: number = c.priority;
    for (let i = 0; i < queue.length; i += 1) {
      for (const id of waiters.get(queue[i] ?? "") ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
        urgency = Math.min(urgency, byId.get(id)?.priority ?? urgency);
      }
    }
    result.set(c.id, {
      holds: seen.size - 1,
      urgency: c.priority === KANBAN_BACKLOG ? KANBAN_BACKLOG : urgency,
    });
  }
  return result;
}

/** A small seeded generator, so a failing board can be rebuilt. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe("kanbanBlocking on one pass", () => {
  it("matches a walk per card on random boards with loops, done, settled and backlog cards", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seeded(seed);
      const size = 5 + Math.floor(random() * 70);
      const ids = Array.from({ length: size }, (_, i) => `c${i}`);
      const cards = ids.map((id) => {
        const blockedBy = Array.from({ length: Math.floor(random() * 4) }, () =>
          // Any card, itself and later ones included: loops and self-blocks are part of the test.
          random() < 0.05 ? "missing" : ids[Math.floor(random() * size)]!,
        );
        const roll = random();
        return card(id, {
          blockedBy,
          priority: 1 + Math.floor(random() * 5),
          stage: roll < 0.15 ? "completed" : roll < 0.3 ? "working" : "todo",
          settledAt: random() < 0.05 ? "2026-10-26T10:00:00.000Z" : null,
        });
      });
      expect([...kanbanBlocking(cards)], `seed ${seed}`).toEqual([...blockingByWalk(cards)]);
    }
  });

  it("counts every member of a loop for the others, and the cards behind the loop", () => {
    const blocking = kanbanBlocking([
      card("a", { blockedBy: ["c"] }),
      card("b", { blockedBy: ["a"] }),
      card("c", { blockedBy: ["b"], priority: 2 }),
      card("tail", { blockedBy: ["b"], priority: 1 }),
    ]);
    expect(blocking.get("a")).toEqual({ holds: 3, urgency: 1 });
    expect(blocking.get("b")).toEqual({ holds: 3, urgency: 1 });
    expect(blocking.get("tail")).toEqual({ holds: 0, urgency: 1 });
  });

  it("walks a chain thousands of cards long without recursing", () => {
    const cards = Array.from({ length: 20_000 }, (_, i) =>
      card(`c${i}`, { blockedBy: i === 0 ? [] : [`c${i - 1}`] }),
    );
    const blocking = kanbanBlocking(cards);
    expect(blocking.get("c0")?.holds).toBe(19_999);
    expect(blocking.get("c19999")?.holds).toBe(0);
  });

  it("past its memory limit gives upper bounds instead of failing", () => {
    // A diamond: d is reached from a along two paths.
    const cards = [
      card("a"),
      card("b", { blockedBy: ["a"] }),
      card("c", { blockedBy: ["a"], priority: 1 }),
      card("d", { blockedBy: ["b", "c"] }),
    ];
    const exact = kanbanSchedule(cards);
    expect(exact.get("a")?.holds).toBe(3);
    const bounded = kanbanSchedule(cards, { maxWords: 0 });
    expect(bounded.get("b")?.holds).toBe(1);
    // d counted once through b and once through c, capped at the other open cards.
    expect(bounded.get("a")?.holds).toBe(3);
    expect(bounded.get("a")?.urgency).toBe(1);
    const wide = [...cards, card("e", { blockedBy: ["d"] })];
    expect(kanbanSchedule(wide, { maxWords: 0 }).get("a")?.holds).toBe(4);
  });
});

describe("kanbanSchedule", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-10-25T10:00:00.000Z") + ms));

  it("lifts a card one step at 10 held-up cards and two at 100, never above P2", () => {
    const fan = (id: string, count: number, priority: number) => [
      card(id, { priority }),
      ...Array.from({ length: count }, (_, i) =>
        card(`${id}-w${i}`, { blockedBy: [id], priority: 4 }),
      ),
    ];
    const schedule = kanbanSchedule([
      ...fan("nine", 9, 4),
      ...fan("ten", 10, 4),
      ...fan("hundred", 100, 4),
      ...fan("three", 100, 3),
      ...fan("one", 100, 1),
    ]);
    expect(schedule.get("nine")).toMatchObject({ holds: 9, rank: 4, fanoutSteps: 0 });
    expect(schedule.get("ten")).toMatchObject({ holds: 10, rank: 3, fanoutSteps: 1 });
    expect(schedule.get("hundred")).toMatchObject({ holds: 100, rank: 2, fanoutSteps: 2 });
    expect(schedule.get("three")).toMatchObject({ rank: 2, fanoutSteps: 2 });
    expect(schedule.get("one")).toMatchObject({ rank: 1 });
  });

  it("gives a card parked on a wait no age while it is parked, and its full age once the wait is gone", () => {
    const wait = Schema.decodeUnknownSync(KanbanCard)(
      JSON.parse(
        JSON.stringify({
          ...card("x"),
          wait: {
            on: "time",
            until: at(20 * day),
            note: "after the audit",
            by: { _tag: "owner" },
            at: at(1 * day),
          },
        }),
      ),
    ).wait!;
    const parked = card("parked", { priority: 4, movedAt: at(0), wait });
    const nowMs = Date.parse(at(9 * day));
    expect(kanbanSchedule([parked], { nowMs }).get("parked")).toMatchObject({
      rank: 4,
      agingSteps: 0,
      waitingSince: null,
    });
    // The wait ended and the card kept its movedAt: the time it was parked counts.
    const { wait: _wait, ...woken } = parked;
    expect(kanbanSchedule([woken], { nowMs }).get("parked")).toMatchObject({
      rank: 2,
      agingSteps: 2,
      waitingSince: at(0),
    });
    // A wait left behind by a move holds nothing.
    const moved = { ...parked, movedAt: at(2 * day) };
    expect(kanbanSchedule([moved], { nowMs }).get("parked")?.waitingSince).toBe(at(2 * day));
  });

  it("ages a startable To-Do card one step per 3 days, at most two, never above P2", () => {
    const cards = [
      card("fresh", { priority: 4, movedAt: at(8 * day) }),
      card("three", { priority: 4, movedAt: at(6 * day) }),
      card("week", { priority: 4, movedAt: at(0) }),
      card("p3", { priority: 3, movedAt: at(0) }),
      card("p2", { priority: 2, movedAt: at(0) }),
      card("backlog", { priority: KANBAN_BACKLOG, movedAt: at(0) }),
      card("working", { priority: 4, stage: "working", movedAt: at(0) }),
    ];
    const schedule = kanbanSchedule(cards, { nowMs: Date.parse(at(9 * day)) });
    expect(schedule.get("fresh")).toMatchObject({ rank: 4, agingSteps: 0 });
    expect(schedule.get("three")).toMatchObject({ rank: 3, agingSteps: 1 });
    expect(schedule.get("week")).toMatchObject({ rank: 2, agingSteps: 2 });
    expect(schedule.get("p3")).toMatchObject({ rank: 2, agingSteps: 2 });
    expect(schedule.get("p2")).toMatchObject({ rank: 2 });
    expect(schedule.get("backlog")).toMatchObject({ rank: KANBAN_BACKLOG });
    expect(schedule.get("working")).toMatchObject({ rank: 4, agingSteps: 0, waitingSince: null });
  });

  it("counts waiting from when the last blocker finished, and not at all while one is open", () => {
    const cards = [
      card("done", { stage: "deployed", movedAt: at(8 * day) }),
      card("open", { stage: "working", movedAt: at(0) }),
      card("unblocked", { priority: 4, blockedBy: ["done", "gone"], movedAt: at(0) }),
      card("blocked", { priority: 4, blockedBy: ["open"], movedAt: at(0) }),
    ];
    const schedule = kanbanSchedule(cards, { nowMs: Date.parse(at(9 * day)) });
    expect(schedule.get("unblocked")).toMatchObject({ agingSteps: 0, waitingSince: at(8 * day) });
    expect(schedule.get("blocked")).toMatchObject({ agingSteps: 0, waitingSince: null });
    const later = kanbanSchedule(cards, { nowMs: Date.parse(at(11 * day)) });
    expect(later.get("unblocked")).toMatchObject({ agingSteps: 1, rank: 3 });
  });

  it("with no clock given measures against the board's newest card stamp", () => {
    const old = card("old", { priority: 4, movedAt: at(0), updatedAt: at(0) });
    const touched = card("touched", { updatedAt: at(KANBAN_AGING_STEP_MS) });
    expect(kanbanSchedule([old]).get("old")?.agingSteps).toBe(0);
    expect(kanbanSchedule([old, touched]).get("old")?.agingSteps).toBe(1);
    expect(kanbanSchedule([]).size).toBe(0);
  });

  it("orders by rank, then held-up cards, then the longest wait, then number", () => {
    const cards = [
      card("young", { movedAt: at(2), number: 1 }),
      card("old", { movedAt: at(1), number: 2 }),
      card("twin", { movedAt: at(1), number: 3 }),
      card("holder", { movedAt: at(3), number: 4 }),
      card("waiter", { blockedBy: ["holder"], movedAt: at(0), priority: 4, number: 5 }),
      card("urgent", { priority: 1, movedAt: at(4), number: 6 }),
    ];
    const order = cards
      .filter((c) => c.blockedBy.length === 0)
      .toSorted(kanbanPickOrder(cards))
      .map((c) => c.id);
    expect(order).toEqual(["urgent", "holder", "old", "twin", "young"]);
  });
});

describe("kanbanCardFlow", () => {
  it("says what a card unblocks, whether it is ready and which unfinished cards it waits on", () => {
    const cards = [
      card("a"),
      card("b", { blockedBy: ["a", "shipped"] }),
      card("c", { blockedBy: ["b"] }),
      card("shipped", { stage: "deployed" }),
      card("flagged", {
        stalled: { reason: "x", by: { _tag: "owner" }, at: "2026-10-25T10:00:00.000Z" },
      }),
    ];
    const byId = new Map(cards.map((c) => [c.id as string, c]));
    const schedule = kanbanSchedule(cards);
    const flow = (id: string) => kanbanCardFlow(byId.get(id)!, byId, schedule);
    expect(flow("a")).toMatchObject({ unblocks: 2, ready: true, waitsOn: [], rank: 3 });
    expect(flow("b")).toMatchObject({ unblocks: 1, ready: false });
    expect(flow("b").waitsOn.map((c) => c.id)).toEqual(["a"]);
    expect(flow("b").heldUpBy?.id).toBe("a");
    expect(flow("flagged").ready).toBe(false);
    expect(flow("shipped")).toMatchObject({ unblocks: 0, ready: false, waitsOn: [] });
  });

  it("is not ready while parked on a wait, or (given a clock) inside a failed run's backoff", () => {
    const failedAt = "2026-11-10T10:00:00.000Z";
    const wait = Schema.decodeUnknownSync(KanbanCard)(
      JSON.parse(
        JSON.stringify({
          ...card("x"),
          wait: {
            on: "time",
            until: "2026-12-01T00:00:00.000Z",
            note: "after the audit",
            by: { _tag: "owner" },
            at: failedAt,
          },
        }),
      ),
    ).wait!;
    const cards = [
      card("parked", { wait, movedAt: "2026-11-09T10:00:00.000Z" }),
      card("holds", { blockedBy: ["parked"] }),
      card("retrying", {
        retries: [
          {
            kind: "run_failed",
            role: "work",
            runId: "run-1",
            reason: "upstream closed the stream",
            at: failedAt,
            state: "waiting",
          },
        ],
      }),
    ];
    const byId = new Map(cards.map((c) => [c.id as string, c]));
    const schedule = kanbanSchedule(cards);
    const due = Date.parse(failedAt) + KANBAN_RETRY_BACKOFF_MS;
    // Parked: not ready, and still what the card behind it waits on.
    expect(kanbanCardFlow(byId.get("parked")!, byId, schedule)).toMatchObject({
      ready: false,
      unblocks: 1,
    });
    expect(kanbanCardFlow(byId.get("retrying")!, byId, schedule, due - 1).ready).toBe(false);
    expect(kanbanCardFlow(byId.get("retrying")!, byId, schedule, due).ready).toBe(true);
    // With no clock only the card's own state counts.
    expect(kanbanCardFlow(byId.get("retrying")!, byId, schedule).ready).toBe(true);
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

  it("decodes a pause written before run ids existed", () => {
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
      paused: { at: "2026-10-28T01:00:00.000Z", message: "provider down" },
    });
    expect(decoded.paused).toEqual({
      at: "2026-10-28T01:00:00.000Z",
      message: "provider down",
      runId: null,
    });
  });
});

const scriptSubtask = (
  id: string,
  step: number,
  text: string,
  owner: "script" | "evaluator" | "work",
  state: "open" | "done" = "open",
) => ({
  id,
  step,
  text,
  owner,
  ...(owner === "script" ? { script: "land" } : {}),
  state,
  note: null,
  doneBy: null,
  doneAt: null,
});

describe("board script steps", () => {
  it("a script-only step is the script's, and a mixed one still wakes the evaluator", () => {
    const scriptOnly = { subtasks: [scriptSubtask("s1", 1, "Merge the PR", "script")] };
    expect(kanbanScriptStep(scriptOnly)).toBe(true);
    expect(kanbanEvaluatorStep(scriptOnly)).toBe(false);

    const mixed = {
      subtasks: [
        scriptSubtask("s1", 1, "Merge the PR", "script"),
        scriptSubtask("s2", 1, "Tell the reporter", "evaluator"),
      ],
    };
    expect(kanbanScriptStep(mixed)).toBe(false);
    expect(kanbanEvaluatorStep(mixed)).toBe(true);
  });

  it("an evaluator-only step, or evaluator plus script, wakes the evaluator", () => {
    expect(kanbanEvaluatorStep({ subtasks: [scriptSubtask("s1", 1, "Tell", "evaluator")] })).toBe(
      true,
    );
    expect(
      kanbanEvaluatorStep({
        subtasks: [
          scriptSubtask("s1", 1, "Merge", "evaluator"),
          scriptSubtask("s2", 1, "Deploy", "script"),
        ],
      }),
    ).toBe(true);
  });

  it("a todo card on a script-only step is left to its script", () => {
    expect(
      kanbanWaitsOnEvaluator({
        stage: "todo",
        wakeNote: null,
        subtasks: [scriptSubtask("s1", 1, "Merge the PR", "script")],
      }),
    ).toBe(true);
  });

  it("a completed card with an open script merge subtask awaits its merge", () => {
    expect(
      kanbanAwaitsMerge({
        stage: "completed",
        subtasks: [scriptSubtask("s3", 3, "Merge the PR", "script")],
      }),
    ).toBe(true);
  });

  it("a subtask saved without a script name still decodes", () => {
    const decoded = Schema.decodeUnknownSync(KanbanSubtask)({
      id: "s1",
      step: 1,
      text: "Write the PR",
      owner: "work",
      state: "open",
      note: null,
      doneBy: null,
      doneAt: null,
    });
    expect(decoded.script).toBeUndefined();
  });
});

describe("KanbanCard wait", () => {
  const stored = (extra: Record<string, unknown> = {}) => ({
    ...Schema.encodeSync(KanbanCard)(card("stored")),
    ...extra,
  });
  const wait = (patch: Partial<KanbanWait> = {}): KanbanWait => ({
    on: "push",
    pr: "https://github.com/acme/app/pull/12" as never,
    card: null,
    ask: null,
    until: null,
    sinceHead: "a1b2c3d4",
    note: "author to push the fix",
    by: { _tag: "owner" },
    at: "2026-10-25T10:00:00.000Z" as never,
    wakeRole: null,
    expiredAt: null,
    script: null,
    args: null,
    status: null,
    lastCheckedAt: null,
    failures: 0,
    problem: null,
    ...patch,
  });

  it("decodes a card stored before waits existed, and encodes it back without a wait key", () => {
    const encoded = stored();
    expect("wait" in encoded).toBe(false);
    const decoded = Schema.decodeUnknownSync(KanbanCard)(encoded);
    expect(decoded.wait).toBeUndefined();
    expect(kanbanWait(decoded)).toBeNull();
    expect(kanbanWaiting(decoded)).toBe(false);
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(KanbanCard)(decoded)))).toEqual(encoded);
  });

  it("fills the optional parts of a stored wait", () => {
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "merge",
          pr: "https://github.com/acme/app/pull/12",
          note: "parent PR",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
        },
      }),
    );
    expect(decoded.wait).toEqual({
      on: "merge",
      pr: "https://github.com/acme/app/pull/12",
      card: null,
      ask: null,
      until: null,
      sinceHead: null,
      note: "parent PR",
      by: { _tag: "owner" },
      at: "2026-10-25T10:00:00.000Z",
      wakeRole: null,
      expiredAt: null,
      script: null,
      args: null,
      status: null,
      lastCheckedAt: null,
      failures: 0,
      problem: null,
    });
  });

  it("decodes a script wait with its args and check state", () => {
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "script",
          script: "linear-state",
          args: { issue: "ENG-123", state: "Done", everyMs: 600000 },
          note: "ENG-123 to reach Done",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
          status: "In Review",
          lastCheckedAt: "2026-10-25T10:05:00.000Z",
          failures: 3,
          problem: "Linear said 401",
        },
      }),
    );
    expect(decoded.wait).toMatchObject({
      on: "script",
      script: "linear-state",
      args: { issue: "ENG-123", state: "Done", everyMs: 600000 },
      status: "In Review",
      failures: 3,
    });
    expect(kanbanWaitCheckFailing(decoded.wait!)).toBe(true);
    expect(kanbanWaitCheckFailing({ failures: KANBAN_WAIT_CHECK_FAILURES - 1 })).toBe(false);
  });

  it("drops a wait of a kind this build doesn't know instead of failing the card", () => {
    // A newer server may add kinds; an older client must still load the board.
    const decoded = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "deploy",
          note: "prod deploy",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
        },
      }),
    );
    expect(decoded.wait).toBeUndefined();
    expect(decoded.id).toBe("stored");
    // So does a field it never heard of on a wait it does know.
    const extra = Schema.decodeUnknownSync(KanbanCard)(
      stored({
        wait: {
          on: "time",
          until: "2026-10-26T10:00:00.000Z",
          note: "recheck",
          by: { _tag: "owner" },
          at: "2026-10-25T10:00:00.000Z",
          somethingNew: { nested: true },
        },
      }),
    );
    expect(extra.wait?.on).toBe("time");
  });

  it("decodes an event kind this build doesn't know as a generic event", () => {
    const event = (kind: string) =>
      Schema.decodeUnknownSync(KanbanCardEvent)({
        id: 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: "Something a newer server logged",
      });
    expect(event("wait_failing").kind).toBe("other");
    expect(event("").kind).toBe("other");
    expect(event("moved").kind).toBe("moved");
    expect(event("wait_failing").body).toBe("Something a newer server logged");
    // A whole card history with one unknown kind in it still loads.
    const detail = Schema.decodeUnknownSync(Schema.Array(KanbanCardEvent))(
      ["created", "from_the_future", "comment"].map((kind, index) => ({
        id: index + 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: null,
      })),
    );
    expect(detail.map((entry) => entry.kind)).toEqual(["created", "other", "comment"]);
    expect(KANBAN_CARD_EVENT_KINDS).toContain("other");
  });

  it("decodes the wait event kinds", () => {
    for (const kind of ["wait_set", "wait_cleared", "wait_expired"]) {
      const event = Schema.decodeUnknownSync(KanbanCardEvent)({
        id: 1,
        cardId: "card-1",
        at: "2026-10-29T10:00:00.000Z",
        actor: { _tag: "owner" },
        kind,
        fromStage: null,
        toStage: null,
        body: "PR merged",
      });
      expect(event.kind).toBe(kind);
    }
  });

  it("counts a card as waiting only with no thread, unsettled and unmoved since", () => {
    const waiting = card("w", { stage: "in_review", wait: wait() });
    expect(kanbanWaiting(waiting)).toBe(true);
    expect(kanbanWaiting({ ...waiting, activeThreadId: "thread-1" as never })).toBe(false);
    expect(kanbanWaiting({ ...waiting, settledAt: "2026-10-26T10:00:00.000Z" as never })).toBe(
      false,
    );
    const moved = { ...waiting, movedAt: "2026-10-25T11:00:00.000Z" as never };
    expect(kanbanWaitStale(moved)).toBe(true);
    expect(kanbanWaiting(moved)).toBe(false);
  });

  it("an old-shape client reads a waiting card's detail while wait events are written as edits", () => {
    // A build from before the tolerant decoder: a closed event-kind list and no wait field.
    const { wait: _wait, ...oldCardFields } = KanbanCard.fields;
    const OldCardDetail = Schema.Struct({
      card: Schema.Struct(oldCardFields),
      events: Schema.Array(
        Schema.Struct({
          ...KanbanCardEvent.fields,
          kind: Schema.Literals([
            "created",
            "moved",
            "edited",
            "linked",
            "flagged",
            "comment",
            "thread",
            "review",
            "subtask",
          ]),
        }),
      ),
      threads: KanbanCardDetail.fields.threads,
    });
    const event = (id: number, kind: KanbanCardEvent["kind"], body: string): KanbanCardEvent => ({
      id: id as KanbanCardEvent["id"],
      cardId: "stored" as KanbanCardEvent["cardId"],
      at: "2026-10-25T10:00:00.000Z" as KanbanCardEvent["at"],
      actor: { _tag: "system", component: "waits" },
      kind,
      fromStage: null,
      toStage: null,
      body,
      head: null,
    });
    const detail = (events: ReadonlyArray<KanbanCardEvent>): unknown =>
      JSON.parse(
        JSON.stringify(
          Schema.encodeSync(KanbanCardDetail)({
            card: card("stored", {
              wait: wait({
                on: "script",
                pr: null,
                sinceHead: null,
                script: "linear-state" as never,
                args: { issue: "ENG-123" },
                status: "In Review",
                failures: 3,
              }),
            }),
            events,
            threads: [],
          }),
        ),
      );
    // What the server writes while its event-kind switch is off.
    const asEdits = detail([
      event(1, "edited", "Waiting for the linear-state script's check: ENG-123 to be Done"),
      event(2, "edited", "Wait check failing: 3 failures in a row"),
      event(3, "edited", "Wait expired: waited 7d with no change"),
      event(4, "edited", "Wait ended: ENG-123 is Done"),
    ]);
    const old = Schema.decodeUnknownSync(OldCardDetail)(asEdits);
    expect(old.events.map((entry) => entry.kind)).toEqual(["edited", "edited", "edited", "edited"]);
    expect(old.card.id).toBe("stored");
    expect("wait" in old.card).toBe(false);
    // The same history under its own kinds fails that client's whole card read.
    const asKinds = detail([event(1, "wait_set", "Waiting for ENG-123 to be Done")]);
    expect(() => Schema.decodeUnknownSync(OldCardDetail)(asKinds)).toThrow();
    // This build reads both, with the wait.
    expect(Schema.decodeUnknownSync(KanbanCardDetail)(asKinds).events[0]?.kind).toBe("wait_set");
    expect(Schema.decodeUnknownSync(KanbanCardDetail)(asEdits).card.wait?.script).toBe(
      "linear-state",
    );
  });

  it("drops the wait key, not sets it to undefined", () => {
    const cleared = kanbanWithoutWait(card("w", { wait: wait() }));
    expect("wait" in cleared).toBe(false);
    const plain = card("p");
    expect(kanbanWithoutWait(plain)).toBe(plain);
  });

  it("expires by the kind's limit, the wait's own until, or never for a time wait", () => {
    const at = Date.parse("2026-10-25T10:00:00.000Z");
    expect(kanbanWaitDeadlineMs(wait())).toBe(at + KANBAN_WAIT_LIMIT_MS.push!);
    expect(kanbanWaitExpired(wait(), at + KANBAN_WAIT_LIMIT_MS.push! - 1)).toBe(false);
    expect(kanbanWaitExpired(wait(), at + KANBAN_WAIT_LIMIT_MS.push!)).toBe(true);
    const own = wait({ until: "2026-10-25T12:00:00.000Z" as never });
    expect(kanbanWaitDeadlineMs(own)).toBe(Date.parse("2026-10-25T12:00:00.000Z"));
    const time = wait({ on: "time", pr: null, until: "2026-10-25T12:00:00.000Z" as never });
    expect(kanbanWaitDeadlineMs(time)).toBeNull();
    expect(kanbanWaitExpired(time, at + 365 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(kanbanWaitExpired(wait({ expiredAt: "2026-10-25T10:05:00.000Z" as never }), at)).toBe(
      true,
    );
  });
});
