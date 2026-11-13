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
      { card: 1, rounds: 2, pass: 1, findings: 1, totalRounds: 2 },
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
        kind: "run_failed",
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

  it("gives median, p95 and max dwell per stage from each stage's real start", () => {
    // #1 entered todo on 10 Nov (its last move before the window).
    const prior = [event("a", "2026-11-10T00:00:00.000Z", "moved", "working", "todo")];
    const withPrior = Activity.rollup({ ...input, prior });
    const todo = withPrior.stages.hours.todo!.dwell!;
    // todo spans: 10 Nov 00:00 -> 12 Nov 01:00 (49h), 04:10->04:15, 05:00->06:01.
    expect(todo.count).toBe(3);
    expect(todo.maxHours).toBeCloseTo(49, 1);
    expect(todo.medianHours).toBeCloseTo(61 / 60, 1);
    const working = withPrior.stages.hours.working!.dwell!;
    expect(working.count).toBe(3);
    expect(working.maxHours).toBeCloseTo(2, 1);
    expect(working.p95Hours).toBeCloseTo(2, 1);
    // Without the prior move the first span's start is unknown, so it isn't a dwell.
    expect(result.stages.hours.todo!.dwell!.count).toBe(2);
  });

  it("lists open cards over 24 hours in one stage with their stall flag and wait kind", () => {
    const waiting = card("w", {
      number: 11,
      stage: "working",
      movedAt: "2026-11-11T00:00:00.000Z",
      wait: {
        on: "ci",
        script: null,
        args: null,
        pr: "https://example.com/pr/1",
        card: null,
        ask: null,
        until: null,
        sinceHead: null,
        note: "CI",
        by: { _tag: "owner" },
        at: "2026-11-11T00:00:00.000Z",
        wakeRole: null,
        expiredAt: null,
        status: null,
        lastCheckedAt: null,
        failures: 0,
        problem: null,
      },
    });
    const stalled = card("s", {
      number: 12,
      movedAt: "2026-11-10T12:00:00.000Z",
      stalled: { reason: "secret words", by: { _tag: "owner" }, at: "2026-11-10T12:00:00.000Z" },
    });
    const backlog = card("k", { number: 13, priority: 5, movedAt: before });
    const fresh = card("f", { number: 14, movedAt: t("12:00") });
    const done = card("v", { number: 16, stage: "verified", movedAt: before });
    const run = Activity.rollup({ ...input, cards: [waiting, stalled, backlog, fresh, done] });
    expect(run.stages.openOver24h).toEqual({
      count: 2,
      byStage: { todo: 1, working: 1 },
      items: [
        { card: 12, stage: "todo", hours: 60, stalled: true, wait: "stalled" },
        { card: 11, stage: "working", hours: 48, wait: "ci" },
      ],
    });
    expect(JSON.stringify(run)).not.toContain("secret words");
  });

  it("lists open asks older than 6 hours and counts evaluator wakes per card", () => {
    expect(result.asks.openOver6h).toEqual({ count: 0, items: [] });
    const asking = card("o", {
      number: 15,
      asks: [ask("q1", t("10:00"), { blocking: true }), ask("q2", t("20:00"))],
    });
    const evaluator = (id: string, at: string) => thread(id, "o", "evaluator", opus, at);
    const run = Activity.rollup({
      ...input,
      cards: [...input.cards, asking],
      threads: [...threads, evaluator("e1", t("01:00")), evaluator("e2", t("09:00")), evaluator("e3", t("23:00")), evaluator("e0", before)],
    });
    // #15's q2 and #1's q3 are 4 hours old: not listed.
    expect(run.asks.openOver6h).toEqual({
      count: 1,
      items: [{ card: 15, ask: "q1", askedAt: "2026-11-12T10:00Z", hours: 14, blocking: true }],
    });
    expect(run.threads.evaluatorWakes).toEqual({
      count: 3,
      cardsWith2OrMore: { items: [{ card: 15, wakes: 3 }] },
    });
  });

  it("carries no card titles or text", () => {
    const secret = card("x", {
      number: 20,
      title: "TOP SECRET TITLE",
      prompt: "PROMPT WORDS",
      description: "DESCRIPTION WORDS",
      stage: "working",
      reviewRound: 1,
      stalled: { reason: "STALL WORDS", by: { _tag: "owner" }, at: t("01:00") },
      asks: [ask("q1", t("01:00"), { text: "ASK WORDS" })],
    });
    const run = Activity.rollup({
      window,
      cards: [secret],
      events: [
        event("x", t("01:00"), "comment", null, null, "COMMENT WORDS"),
        event("x", t("02:00"), "review", "in_review", "todo", "REVIEW WORDS"),
        event("x", t("03:00"), "flagged", "working", "todo", "FLAG WORDS"),
      ],
      threads: [],
      pools,
    });
    const text = JSON.stringify(run);
    for (const words of ["SECRET", "PROMPT", "DESCRIPTION", "STALL", "ASK WORDS", "COMMENT", "REVIEW WORDS", "FLAG"])
      expect(text).not.toContain(words);
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

describe("card_get events page", () => {
  const events = Array.from({ length: 50 }, (_, index) =>
    event("z", t("01:00"), "comment", null, null, `c${index}`),
  );
  const rest = { card: card("z"), threads: [] };

  it("defaults to the newest 20 and pages back to the first with no gaps or repeats", () => {
    const first = Activity.pageCardEvents(rest, events, undefined);
    expect(first.events.map((entry) => entry.id)).toEqual(events.slice(-20).map((entry) => entry.id));
    expect(first.eventsTotal).toBe(50);
    expect(first.olderEvents).toBe(events[30]!.id);
    const seen = [...first.events];
    let cursor = first.olderEvents;
    while (cursor !== null) {
      const page = Activity.pageCardEvents(rest, events, { before: cursor });
      seen.unshift(...page.events);
      cursor = page.olderEvents;
    }
    expect(seen.map((entry) => entry.id)).toEqual(events.map((entry) => entry.id));
  });

  it("all returns every event; limit is capped at 200", () => {
    expect(Activity.pageCardEvents(rest, events, "all").events).toHaveLength(50);
    expect(Activity.pageCardEvents(rest, events, { limit: 5 }).events).toHaveLength(5);
    const many = Array.from({ length: 300 }, () => event("z", t("01:00"), "moved", "todo", "working"));
    expect(Activity.pageCardEvents(rest, many, { limit: 1_000 }).events).toHaveLength(200);
  });

  it("keeps the whole card and drops the oldest events whole to stay under 60,000 characters", () => {
    const big = { card: card("p", { prompt: "P".repeat(40_000) }), threads: [] };
    const comments = Array.from({ length: 20 }, (_, index) =>
      event("p", t("01:00"), "comment", null, null, `${index} ${"c".repeat(2_000)}`),
    );
    const page = Activity.pageCardEvents(big, comments, undefined);
    const reply = { ...big, ...page };
    expect(JSON.stringify(reply).length).toBeLessThanOrEqual(Activity.CARD_GET_CHARS);
    expect(reply.card.prompt).toHaveLength(40_000);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThan(20);
    expect(page.events.at(-1)!.id).toBe(comments.at(-1)!.id);
    for (const entry of page.events) expect(entry.body!.length).toBeGreaterThan(2_000);
    expect(page.olderEvents).toBe(page.events[0]!.id);
  });

  it("skips one event too big to send with the card, and says so", () => {
    const huge = [
      event("q", t("01:00"), "comment", null, null, "small"),
      event("q", t("02:00"), "comment", null, null, "h".repeat(70_000)),
    ];
    const page = Activity.pageCardEvents(rest, huge, undefined);
    expect(page.events).toEqual([]);
    expect(page.olderEvents).toBe(huge[1]!.id);
    expect(page.note).toContain(`Event ${huge[1]!.id}`);
    const next = Activity.pageCardEvents(rest, huge, { before: page.olderEvents! });
    expect(next.events.map((entry) => entry.id)).toEqual([huge[0]!.id]);
    expect(next.olderEvents).toBeNull();
  });

  it("a card that fills the reply alone comes back whole with no events and a note", () => {
    const giant = { card: card("g", { prompt: "G".repeat(70_000) }), threads: [] };
    const page = Activity.pageCardEvents(giant, events, undefined);
    expect(page.events).toEqual([]);
    expect(page.note).toContain('events: "all"');
  });

  it("a card with no events", () => {
    expect(Activity.pageCardEvents(rest, [], undefined)).toEqual({
      events: [],
      eventsTotal: 0,
      olderEvents: null,
    });
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
