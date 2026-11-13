import {
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  ThreadId,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanOwnerAsk,
  type KanbanThreadLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as Activity from "./activity.ts";
import * as Rules from "./rules.ts";

const opus = { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" };
const sonnet = { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-sonnet-5-5" };
const before = "2026-11-10T00:00:00.000Z";
const window = { since: "2026-11-12T00:00:00.000Z", until: "2026-11-13T00:00:00.000Z" };
const t = (hhmm: string) => `2026-11-12T${hhmm}:00.000Z`;

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
  createdAt: before,
  updatedAt: before,
  movedAt: before,
  ...patch,
});

let nextId = 1;
const event = (
  cardId: string,
  at: string,
  kind: KanbanCardEvent["kind"],
  fromStage: KanbanCardEvent["fromStage"],
  toStage: KanbanCardEvent["toStage"],
  body: string | null = null,
  head: string | null = null,
): KanbanCardEvent => ({
  id: nextId++,
  cardId: KanbanCardId.make(cardId),
  at,
  actor: { _tag: "system", component: "dispatcher" },
  kind,
  fromStage,
  toStage,
  body,
  head,
});

const ask = (id: string, at: string, patch: Partial<KanbanOwnerAsk> = {}): KanbanOwnerAsk => ({
  id,
  text: `question ${id}`,
  blocking: false,
  by: { _tag: "owner" },
  at,
  seq: null,
  closedAt: null,
  ...patch,
});

const thread = (
  id: string,
  cardId: string,
  role: KanbanThreadLink["role"],
  model: typeof opus,
  startedAt: string,
  endedAt: string | null = null,
): KanbanThreadLink => ({
  threadId: ThreadId.make(id),
  boardId: KanbanBoardId.make("b1"),
  cardId: KanbanCardId.make(cardId),
  role,
  purpose: null,
  discussionId: null,
  model,
  startedAt,
  endedAt,
  paused: null,
});

// #1 moves through work, a findings round, a failed run and a clear review.
const busy = card("a", {
  number: 1,
  title: "Busy card",
  stage: "completed",
  reviewRound: 2,
  asks: [
    ask("q1", t("02:00"), {
      closedAt: t("02:30"),
      answer: { verdict: "approve", by: { _tag: "owner" }, at: t("02:30") },
    }),
    ask("q2", t("10:00"), { closedAt: t("11:00") }),
    ask("q3", t("20:00"), { blocking: true }),
  ],
});
const busyEvents = [
  event("a", t("01:00"), "moved", "todo", "working"),
  event("a", t("02:10"), "comment", null, null, "progress"),
  event("a", t("03:00"), "moved", "working", "needs_review"),
  event("a", t("03:10"), "moved", "needs_review", "in_review"),
  event("a", t("04:10"), "review", "in_review", "todo", "- [P2] fix x", "abcdef1234567"),
  event("a", t("04:15"), "moved", "todo", "working"),
  event("a", t("05:00"), "flagged", "working", "todo", "Run failed: provider boom"),
  event("a", t("06:00"), "flagged", "todo", "todo", "Cleared"),
  event("a", t("06:01"), "moved", "todo", "working"),
  event("a", t("08:00"), "moved", "working", "needs_review"),
  event("a", t("08:01"), "moved", "needs_review", "in_review"),
  event("a", t("09:00"), "review", "in_review", "in_review", "clear", "def0001"),
  event("a", t("09:05"), "moved", "in_review", "completed"),
];
// #2 sits in working all window: it holds a slot and has no events.
const parked = card("b", {
  number: 2,
  title: "Parked",
  stage: "working",
  activeThreadId: ThreadId.make("tb"),
  activePool: Rules.poolKey(opus),
});
// #3 settled long ago.
const old = card("c", {
  number: 3,
  stage: "verified",
  settledAt: before,
  asks: [ask("q1", before, { closedAt: before })],
});
const threads = [
  thread("tw", "a", "work", opus, t("00:59")),
  thread("tr1", "a", "review", sonnet, t("03:10"), t("04:10")),
  thread("tr2", "a", "review", sonnet, t("08:01"), t("09:00")),
  thread("tb", "b", "work", opus, before),
];
const pools = [
  { key: Rules.poolKey(opus), model: opus, slots: 4 },
  { key: Rules.poolKey(sonnet), model: sonnet, slots: 2 },
];
const input = {
  window,
  cards: [busy, parked, old],
  events: busyEvents,
  threads,
  pools,
};

describe("compact rows", () => {
  it("lists only cards active in the window, with what happened", () => {
    const byCard = Activity.groupEvents(busyEvents);
    const active = Activity.activeCards(input.cards, byCard, window);
    expect(active.map((entry) => entry.number)).toEqual([1]);
    const row = Activity.compactRow(busy, byCard.get("a") ?? [], window);
    expect(row).toMatchObject({
      number: 1,
      title: "Busy card",
      stage: "completed",
      path: "todo>work>nrev>rev>todo>work>todo>work>nrev>rev>done",
      verdicts: "FP",
      reviewRound: 2,
      failures: 1,
      lastFailure: "provider boom",
      comments: 1,
      lastEventAt: "2026-11-12T09:05Z",
    });
    expect(row.asks).toEqual([
      {
        id: "q1",
        askedAt: "2026-11-12T02:00Z",
        answeredAt: "2026-11-12T02:30Z",
        verdict: "approve",
        minutes: 30,
      },
      { id: "q2", askedAt: "2026-11-12T10:00Z", closedAt: "2026-11-12T11:00Z" },
      { id: "q3", askedAt: "2026-11-12T20:00Z", open: true, blocking: true, minutes: 240 },
    ]);
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("description");
  });

  it("an open ask from before the window keeps its card listed; a settled card's does not", () => {
    const waiting = card("w", { number: 9, asks: [ask("q1", before)] });
    const settled = card("s", { number: 10, settledAt: before, asks: [ask("q1", before)] });
    const active = Activity.activeCards([waiting, settled], new Map(), window);
    expect(active.map((entry) => entry.number)).toEqual([9]);
  });

  it("pages rows under the character budget and says where to go on", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      number: index + 1,
      title: "x".repeat(2_000),
    }));
    const first = Activity.pageRows(rows, 0, 200, 10_000);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(first.rows).length).toBeLessThan(10_000);
    expect(first.hasMore).toBe(true);
    const second = Activity.pageRows(rows, first.nextAfter!, 200, 10_000);
    expect(second.rows[0]!.number).toBe(first.rows.at(-1)!.number + 1);
    // One row over the budget still comes alone, so the cursor always moves.
    const huge = Activity.pageRows([{ number: 1, title: "y".repeat(20_000) }], 0, 200, 10_000);
    expect(huge.rows).toHaveLength(1);
    expect(huge.hasMore).toBe(false);
    expect(huge.nextAfter).toBeNull();
    const limited = Activity.pageRows(rows, 0, 3);
    expect(limited.rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(limited.nextAfter).toBe(3);
  });
});

describe("rollup", () => {
  const result = Activity.rollup(input);

  it("times every ask from asked to answered", () => {
    expect(result.asks).toMatchObject({
      answered: 1,
      open: 1,
      closedWithoutAnswer: 1,
      answerMinutes: { p50: 30, p90: 30, max: 30 },
    });
    expect(result.asks.items.map((item) => [item.card, item.id, item.minutes])).toEqual([
      [1, "q1", 30],
      [1, "q2", undefined],
      [1, "q3", 240],
    ]);
  });

  it("counts review rounds and verdicts per card", () => {
    expect(result.reviews).toMatchObject({ rounds: 2, pass: 1, findings: 1 });
    expect(result.reviews.items).toEqual([
      { card: 1, title: "Busy card", rounds: 2, pass: 1, findings: 1, totalRounds: 2 },
    ]);
  });

  it("adds up time in each stage, the parked card included", () => {
    // #1: 01:00-03:00, 04:15-05:00, 06:01-08:00 working; #2 the whole day.
    expect(result.stages.hours.working?.hours).toBeCloseTo(2 + 0.75 + 119 / 60 + 24, 1);
    // The clear review keeps it in in_review until it completes at 09:05.
    expect(result.stages.hours.in_review?.hours).toBeCloseTo(1 + 64 / 60, 1);
    expect(result.stages.longest[0]).toMatchObject({ card: 2, stage: "working", ongoing: true });
  });

  it("times a stall until it was cleared", () => {
    expect(result.stalls.items).toEqual([
      {
        card: 1,
        at: "2026-11-12T05:00Z",
        reason: "Run failed: provider boom",
        until: "2026-11-12T06:00Z",
        minutes: 60,
      },
    ]);
  });

  it("puts run failures on the model of the thread that failed", () => {
    expect(result.failures).toEqual({
      count: 1,
      byPool: { [Rules.poolKey(opus)]: { count: 1, reasons: ["provider boom"] } },
    });
  });

  it("counts threads started and a second review thread as a restart", () => {
    expect(result.threads.started).toEqual({
      work: { [Rules.poolKey(opus)]: 1 },
      review: { [Rules.poolKey(sonnet)]: 2 },
    });
    expect(result.threads.restarts.items).toEqual([{ card: 1, role: "review", threads: 2 }]);
  });

  it("reports slots held per hour per pool next to each pool's slots", () => {
    expect(result.pools.slots).toEqual({ [Rules.poolKey(opus)]: 4, [Rules.poolKey(sonnet)]: 2 });
    expect(result.pools.hours).toHaveLength(24);
    expect(result.pools.hours[0]).toBe("2026-11-12T00Z");
    const work = result.pools.used[Rules.poolKey(opus)]!;
    expect(work[0]).toBe(1); // only the parked card
    expect(work[1]).toBe(2); // and #1 working
    expect(work[12]).toBe(1);
    const review = result.pools.used[Rules.poolKey(sonnet)]!;
    expect(review[3]).toBeCloseTo(50 / 60, 2);
    expect(review[8]).toBeCloseTo(59 / 60, 2);
  });

  it("a card left in review with no thread holds no slot and is listed", () => {
    const stuck = card("s", { number: 7, stage: "in_review", movedAt: "2026-11-11T08:00:00.000Z" });
    const stuckRun = Activity.rollup({ ...input, cards: [...input.cards, stuck] });
    expect(stuckRun.stages.withoutThread).toEqual({
      count: 1,
      items: [{ card: 7, stage: "in_review", since: "2026-11-11T08:00Z" }],
    });
    expect(stuckRun.pools.used).toEqual(result.pools.used);
    // Its time still counts as time in review.
    expect(stuckRun.stages.hours.in_review!.hours - result.stages.hours.in_review!.hours).toBeCloseTo(24, 1);
    // A thread that ended mid-span stops holding the slot then.
    const released = { ...parked, activeThreadId: null, activePool: null };
    const ended = Activity.rollup({
      ...input,
      cards: [busy, released, old],
      threads: [...threads.filter((link) => link.threadId !== "tb"), thread("tb", "b", "work", opus, before, t("06:00"))],
    });
    expect(ended.pools.used[Rules.poolKey(opus)]![5]).toBe(1);
    expect(ended.pools.used[Rules.poolKey(opus)]![12]).toBe(0);
    expect(ended.stages.withoutThread.items).toEqual([{ card: 2, stage: "working", since: "2026-11-10T00:00Z" }]);
    // Never marked ended and no active thread: it held nothing after its last event (none here).
    const unmarked = Activity.rollup({ ...input, cards: [busy, released, old] });
    expect(unmarked.pools.used[Rules.poolKey(opus)]![0]).toBe(0);
    expect(unmarked.pools.used[Rules.poolKey(opus)]![1]).toBe(1);
  });

  it("a card parked on a wait holds no slot while it waits, and a thread with two cards counts once", () => {
    const waiting = card("w", {
      number: 8,
      stage: "working",
      activeThreadId: ThreadId.make("tw2"),
      activePool: Rules.poolKey(opus),
    });
    const sibling = card("x", {
      number: 9,
      stage: "working",
      activeThreadId: ThreadId.make("tw2"),
      activePool: Rules.poolKey(opus),
    });
    const waitEvents = [
      event("w", t("02:00"), "wait_set", null, null, "ci"),
      event("w", t("05:00"), "wait_cleared", null, null, "ci passed"),
    ];
    const shared = thread("tw2", "w", "work", opus, before);
    const run = Activity.rollup({
      window,
      cards: [waiting, sibling],
      events: waitEvents,
      threads: [shared, { ...shared, cardId: KanbanCardId.make("x") }],
      pools,
    });
    const row = run.pools.used[Rules.poolKey(opus)]!;
    // #9 (same thread) keeps the slot through #8's wait: one slot either way.
    expect(row[0]).toBe(1);
    expect(row[3]).toBe(1);
    expect(row[12]).toBe(1);
    const alone = Activity.rollup({ window, cards: [waiting], events: waitEvents, threads: [shared], pools });
    expect(alone.pools.used[Rules.poolKey(opus)]![1]).toBe(1);
    expect(alone.pools.used[Rules.poolKey(opus)]![3]).toBe(0);
    expect(alone.pools.used[Rules.poolKey(opus)]![5]).toBe(1);
  });

  it("stays small: a busy day of 300 cards fits one call", () => {
    const cards: Array<KanbanCard> = [];
    const events: Array<KanbanCardEvent> = [];
    for (let index = 0; index < 300; index++) {
      const id = `card-${index}`;
      cards.push(
        card(id, {
          number: index + 1,
          title: `Card ${index} ${"t".repeat(80)}`,
          stage: "working",
          reviewRound: 3,
          asks: [
            ask("q1", t("01:00"), {
              closedAt: t("02:00"),
              answer: { verdict: "approve", by: { _tag: "owner" }, at: t("02:00") },
            }),
          ],
        }),
      );
      events.push(
        event(id, t("01:00"), "moved", "todo", "working"),
        event(id, t("03:00"), "review", "in_review", "todo", "- [P2] ".repeat(200), "abc"),
        event(id, t("04:00"), "flagged", "working", "todo", `Run failed: ${"e".repeat(500)}`),
      );
    }
    const big = Activity.rollup({ window, cards, events, threads: [], pools });
    expect(JSON.stringify(big).length).toBeLessThan(60_000);
    expect(big.asks.answered).toBe(300);
    expect(big.asks.items.length + (big.asks.more ?? 0)).toBe(300);
    expect(big.stalls.count).toBe(300);
    expect(big.reviews.rounds).toBe(300);
  });
});

describe("card_get bounded events", () => {
  const events = Array.from({ length: 100 }, (_, index) =>
    event("z", t("01:00"), "comment", null, null, index === 99 ? "b".repeat(5_000) : `c${index}`),
  );

  it("returns the newest events with a cursor to older ones", () => {
    const first = Activity.boundedEvents(events, 40, undefined);
    expect(first.events).toHaveLength(40);
    expect(first.events.at(-1)!.id).toBe(events.at(-1)!.id);
    expect(first.events.at(-1)!.body!.length).toBe(Activity.CARD_EVENT_BODY_CHARS);
    expect(first.events.at(-1)!.bodyChars).toBe(5_000);
    expect(first.eventsMore).toEqual({ before: events[60]!.id, older: 60 });
    const second = Activity.boundedEvents(events, 40, first.eventsMore!.before);
    expect(second.events.at(-1)!.id).toBe(events[59]!.id);
    const last = Activity.boundedEvents(events, 40, events[10]!.id);
    expect(last.events).toHaveLength(10);
    expect(last.eventsMore).toBeUndefined();
  });

  it("stops before the character budget even when every event is big", () => {
    const big = Array.from({ length: 60 }, () =>
      event("z", t("01:00"), "comment", null, null, "d".repeat(1_900)),
    );
    const page = Activity.boundedEvents(big, 60, undefined);
    expect(JSON.stringify(page.events).length).toBeLessThan(Activity.COMPACT_READ_CHARS / 2 + 3_000);
    expect(page.eventsMore?.older).toBe(60 - page.events.length);
  });

  it("strips closed asks to their answer and keeps open ones whole", () => {
    const withAsks = card("y", {
      asks: [
        ask("q1", before, {
          closedAt: before,
          context: "c".repeat(10_000),
          answer: { verdict: "approve", by: { _tag: "owner" }, at: before, text: "a".repeat(2_000) },
        }),
        ask("q2", before, { context: "keep me" }),
      ],
    });
    const compact = Activity.compactAsks(withAsks);
    expect(compact.asks[0]).not.toHaveProperty("context");
    expect(compact.asks[0]!.answer?.text?.length).toBe(500);
    expect(compact.asks[1]!.context).toBe("keep me");
  });
});

describe("parseWindow", () => {
  const now = Date.parse(window.until);
  it("defaults to the last 24 hours, now included", () => {
    expect(Activity.parseWindow(undefined, undefined, now - 1)).toEqual(window);
    expect(Activity.parseWindow(undefined, window.until, now)).toEqual(window);
  });
  it.each([
    ["not a time", undefined, "since must be an ISO time."],
    [undefined, "nope", "until must be an ISO time."],
    ["2026-11-13T01:00:00Z", undefined, "since must be before until."],
    ["2026-11-01T00:00:00Z", undefined, "The window is at most 72 hours."],
  ])("refuses since=%s until=%s", (since, until, message) => {
    expect(Activity.parseWindow(since, until, now)).toBe(message);
  });
  it("accepts a 72 hour window", () => {
    expect(Activity.parseWindow("2026-11-10T00:00:00Z", window.until, now)).toEqual({
      since: "2026-11-10T00:00:00.000Z",
      until: window.until,
    });
  });
});
