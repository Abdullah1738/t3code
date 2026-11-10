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
  KANBAN_BOARD_IMAGE_MAX,
  KanbanSubtask,
  KanbanThreadLink,
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
