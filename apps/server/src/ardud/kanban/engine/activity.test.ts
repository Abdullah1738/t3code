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
import * as DateTime from "effect/DateTime";

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

const waitOn: NonNullable<KanbanCard["wait"]> = {
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
};

it("#1483 lists evaluator-only orphaned reviews with full stage age and last wake", () => {
  const reviewed = card("reviewed", {
    stage: "in_review",
    reviewStep: 1,
    movedAt: "2026-11-10T00:00:00.000Z",
    nudgedAt: t("18:00"),
    subtasks: [
      {
        id: "s1",
        step: 1,
        owner: "evaluator",
        text: "Merge",
        state: "open",
        createdAt: before,
        note: null,
        doneBy: null,
        doneAt: null,
      },
    ],
  });
  const script = card("script", {
    ...reviewed,
    id: KanbanCardId.make("script"),
    number: 2,
    nudgedAt: null,
    subtasks: reviewed.subtasks.map((s) => ({ ...s, owner: "script" })),
  });
  const excluded = [
    card("wait", { ...reviewed, wait: waitOn }),
    card("work", {
      ...reviewed,
      subtasks: [
        ...reviewed.subtasks,
        { ...reviewed.subtasks[0]!, id: "s2", owner: "work", step: 2 },
      ],
    }),
    card("review", {
      ...reviewed,
      subtasks: reviewed.subtasks.map((s) => ({ ...s, owner: "review" })),
    }),
    card("not-passed", { ...reviewed, reviewStep: 0 }),
    card("empty", { ...reviewed, subtasks: [] }),
  ];
  const result = Activity.rollup({
    window,
    cards: [reviewed, script, ...excluded],
    events: [],
    threads: [],
    pools: [],
  });
  expect(result.stages.inReviewNoThreadWithEvaluatorStepsOnly).toEqual({
    count: 2,
    items: [
      { card: 1, hours: 72, lastWake: "2026-11-12T18:00Z" },
      { card: 2, hours: 72, lastWake: null },
    ],
  });
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
    // Inside a wrapper, the whole reply stays under the limit, not just the rows.
    const many = Array.from({ length: 400 }, (_, index) => ({
      number: index + 1,
      title: "z".repeat(300),
    }));
    const wrapped = Activity.pageRowsInReply(many, 0, 500, (cards, cursor) => ({
      legend: "w".repeat(5_000),
      cards,
      page: cursor,
    }));
    expect(JSON.stringify(wrapped).length).toBeLessThanOrEqual(Activity.COMPACT_READ_CHARS);
    expect(JSON.stringify(wrapped).length).toBeGreaterThan(Activity.COMPACT_READ_CHARS - 1_000);
    expect(wrapped.page.hasMore).toBe(true);
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
    expect(result.asks.answeredItems.map((item) => [item.card, item.id, item.minutes])).toEqual([
      [1, "q1", 30],
    ]);
    // The rest newest first, so a long day cuts the oldest.
    expect(result.asks.others.items.map((item) => [item.card, item.id, item.minutes])).toEqual([
      [1, "q3", 240],
      [1, "q2", undefined],
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
      byKind: { stalled: 1 },
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
    expect(
      stuckRun.stages.hours.in_review!.hours - result.stages.hours.in_review!.hours,
    ).toBeCloseTo(24, 1);
    // A thread that ended mid-span stops holding the slot then.
    const released = { ...parked, activeThreadId: null, activePool: null };
    const ended = Activity.rollup({
      ...input,
      cards: [busy, released, old],
      threads: [
        ...threads.filter((link) => link.threadId !== "tb"),
        thread("tb", "b", "work", opus, before, t("06:00")),
      ],
    });
    expect(ended.pools.used[Rules.poolKey(opus)]![5]).toBe(1);
    expect(ended.pools.used[Rules.poolKey(opus)]![12]).toBe(0);
    expect(ended.stages.withoutThread.items).toEqual([
      { card: 2, stage: "working", since: "2026-11-10T00:00Z" },
    ]);
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
    // Stored as waits are today: plain edits (WAIT_EVENT_KINDS_LIVE is off).
    const waitEvents = [
      event("w", t("02:00"), "edited", null, null, "Waiting for CI on app#12: ci"),
      event("w", t("05:00"), "edited", null, null, "Wait ended: CI on app#12 passed"),
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
    const alone = Activity.rollup({
      window,
      cards: [waiting],
      events: waitEvents,
      threads: [shared],
      pools,
    });
    expect(alone.pools.used[Rules.poolKey(opus)]![1]).toBe(1);
    expect(alone.pools.used[Rules.poolKey(opus)]![3]).toBe(0);
    expect(alone.pools.used[Rules.poolKey(opus)]![5]).toBe(1);
    // The wait kinds, once live, read the same.
    const kinds = [
      event("w", t("02:00"), "wait_set", null, null, "Waiting for CI on app#12: ci"),
      event("w", t("05:00"), "wait_cleared", null, null, "Wait ended: cleared by hand"),
    ];
    expect(
      Activity.rollup({ window, cards: [waiting], events: kinds, threads: [shared], pools }).pools
        .used,
    ).toEqual(alone.pools.used);
    // A wait set before the window, still set, holds nothing all window; one that expired counts.
    const parkedWait = { ...waiting, wait: { ...waitOn, at: before } };
    expect(
      Activity.rollup({ window, cards: [parkedWait], events: [], threads: [shared], pools }).pools
        .used,
    ).toEqual({});
    const expired = { ...waiting, wait: { ...waitOn, at: before, expiredAt: before } };
    expect(
      Activity.rollup({ window, cards: [expired], events: [], threads: [shared], pools }).pools
        .used[Rules.poolKey(opus)]![0],
    ).toBe(1);
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
      wait: waitOn,
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
      threads: [
        ...threads,
        evaluator("e1", t("01:00")),
        evaluator("e2", t("09:00")),
        evaluator("e3", t("23:00")),
        evaluator("e0", before),
      ],
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

  it("counts retried, fresh-thread and no-verdict runs as failures, not a fresh start someone asked for", () => {
    const failing = card("f", { number: 30, stage: "todo", model: opus });
    const asked = {
      ...event(
        "f",
        t("07:00"),
        "moved",
        "working",
        "todo",
        "Thread too long; the next run starts on a fresh thread: owner said so",
      ),
      actor: { _tag: "owner" as const },
    };
    const events = [
      event("f", t("01:00"), "moved", "working", "todo", "Run failed, retrying once: rate limited"),
      event(
        "f",
        t("02:00"),
        "moved",
        "working",
        "todo",
        "Thread too long; the next run starts on a fresh thread: context full",
      ),
      event(
        "f",
        t("03:00"),
        "moved",
        "working",
        "todo",
        "Thread too long; the next run starts on a fresh thread: compaction failed",
      ),
      event(
        "f",
        t("04:00"),
        "moved",
        "in_review",
        "needs_review",
        "Reviewer stopped without a verdict, retrying once",
      ),
      event("f", t("05:00"), "flagged", "working", "todo", "Run failed: provider boom"),
      event("f", t("06:00"), "moved", "todo", "working"),
      asked,
    ];
    const run = Activity.rollup({ window, cards: [failing], events, threads: [], pools });
    expect(run.failures.count).toBe(5);
    expect(run.failures.byKind).toEqual({ retried: 1, fresh_thread: 2, no_verdict: 1, stalled: 1 });
    expect(run.failures.byPool).toEqual({
      [Rules.poolKey(opus)]: {
        count: 4,
        reasons: ["rate limited", "context full", "compaction failed"],
      },
      "review (model unknown)": {
        count: 1,
        reasons: ["Reviewer stopped without a verdict, retrying once"],
      },
    });
    const row = Activity.compactRow(failing, Activity.groupEvents(events).get("f") ?? [], window);
    expect(row).toMatchObject({ failures: 5, lastFailure: "provider boom" });
  });

  it("counts both no-verdict events: the restart and the stall that follows the second", () => {
    const review = card("n", { number: 31, stage: "needs_review", stalled: null });
    const events = [
      event(
        "n",
        t("01:00"),
        "moved",
        "in_review",
        "needs_review",
        "Reviewer stopped without a verdict, retrying once",
      ),
      event("n", t("01:01"), "moved", "needs_review", "in_review"),
      event(
        "n",
        t("02:00"),
        "flagged",
        "in_review",
        "needs_review",
        "Reviewer stopped without a verdict",
      ),
      event("n", t("03:00"), "moved", "needs_review", "in_review"),
      // The same words flagged by a person are a flag, not a failure.
      {
        ...event(
          "n",
          t("06:00"),
          "flagged",
          "in_review",
          "needs_review",
          "Reviewer stopped without a verdict",
        ),
        actor: { _tag: "owner" as const },
      },
    ];
    const run = Activity.rollup({ window, cards: [review], events, threads: [], pools });
    expect(run.failures.count).toBe(2);
    expect(run.failures.byKind).toEqual({ no_verdict: 2 });
    expect(run.failures.byPool).toEqual({
      "review (model unknown)": {
        count: 2,
        reasons: [
          "Reviewer stopped without a verdict, retrying once",
          "Reviewer stopped without a verdict",
        ],
      },
    });
    expect(run.stalls.items.map((item) => [item.at, item.kind, item.minutes])).toEqual([
      ["2026-11-12T02:00Z", "run_failed", 60],
      ["2026-11-12T06:00Z", "flagged", undefined],
    ]);
    const row = Activity.compactRow(review, Activity.groupEvents(events).get("n") ?? [], window);
    expect(row).toMatchObject({ failures: 2, lastFailure: "Reviewer stopped without a verdict" });
  });

  it("ends a stall at whatever cleared it: a move, a verdict, a wait, a new flag", () => {
    const at = (cardId: string, list: Array<KanbanCardEvent>, patch: Partial<KanbanCard> = {}) =>
      Activity.rollup({
        window,
        cards: [card(cardId, { number: 40, ...patch })],
        events: list,
        threads: [],
        pools,
      }).stalls.items;
    // An answered ask or a retry moves it, sometimes within the same stage.
    expect(
      at("m", [
        event("m", t("01:00"), "flagged", "working", "todo", "Run failed: x"),
        event("m", t("01:30"), "moved", "todo", "todo", "Owner replied"),
      ]),
    ).toEqual([
      {
        card: 40,
        at: "2026-11-12T01:00Z",
        kind: "run_failed",
        until: "2026-11-12T01:30Z",
        minutes: 30,
      },
    ]);
    expect(
      at("r", [
        event("r", t("01:00"), "flagged", "in_review", "in_review", "Blocked on a decision"),
        event("r", t("02:00"), "review", "in_review", "todo", "- [P2] x"),
      ])[0],
    ).toMatchObject({ kind: "flagged", until: "2026-11-12T02:00Z", minutes: 60 });
    expect(
      at("w", [
        event("w", t("01:00"), "flagged", "working", "todo", "Run failed: x"),
        event("w", t("01:10"), "edited", null, null, "Waiting for CI on app#12"),
      ])[0],
    ).toMatchObject({ until: "2026-11-12T01:10Z", minutes: 10 });
    // A second flag ends the first; the second is still on the card.
    expect(
      at(
        "f",
        [
          event("f", t("01:00"), "flagged", "working", "todo", "Run failed: x"),
          event("f", t("03:00"), "flagged", "todo", "todo", "Run failed: y"),
        ],
        { stalled: { reason: "Run failed: y", by: { _tag: "owner" }, at: t("03:00") } },
      ),
    ).toEqual([
      {
        card: 40,
        at: "2026-11-12T01:00Z",
        kind: "run_failed",
        until: "2026-11-12T03:00Z",
        minutes: 120,
      },
      { card: 40, at: "2026-11-12T03:00Z", kind: "run_failed", ongoing: true, minutes: 1260 },
    ]);
    // Cleared with nothing in the history and no stall now: no made-up duration.
    expect(
      at("u", [event("u", t("01:00"), "flagged", "working", "todo", "Run failed: x")]),
    ).toEqual([{ card: 40, at: "2026-11-12T01:00Z", kind: "run_failed", endUnrecorded: true }]);
  });

  it("counts a card that sat all day in needs_review or needs_owner", () => {
    const queued = card("q", { number: 50, stage: "needs_review", movedAt: before });
    const owner = card("o", {
      number: 51,
      stage: "needs_owner",
      movedAt: "2026-11-11T12:00:00.000Z",
    });
    const run = Activity.rollup({ window, cards: [queued, owner], events: [], threads: [], pools });
    expect(run.stages.hours.needs_review).toMatchObject({ hours: 24, spans: 1 });
    expect(run.stages.hours.needs_owner).toMatchObject({ hours: 24, spans: 1 });
    expect(run.stages.longest.map((row) => [row.card, row.stage])).toEqual([
      [50, "needs_review"],
      [51, "needs_owner"],
    ]);
    expect(run.pools.used).toEqual({});
  });

  it("an old thread never marked ended stops when the next one starts; only the active one runs on", () => {
    const restarted = card("r", {
      number: 60,
      stage: "working",
      activeThreadId: ThreadId.make("new"),
      activePool: Rules.poolKey(opus),
    });
    const run = Activity.rollup({
      window,
      cards: [restarted],
      events: [],
      threads: [
        thread("old1", "r", "work", opus, before),
        thread("old2", "r", "work", opus, t("04:00")),
        thread("new", "r", "work", opus, t("08:00")),
      ],
      pools,
    });
    // One slot all day, never two or three.
    expect(run.pools.used[Rules.poolKey(opus)]!.every((value) => value === 1)).toBe(true);
  });

  it("a card left in review with a stale thread holds a slot only while that thread wrote events", () => {
    const stale = card("s", { number: 61, stage: "in_review", movedAt: before });
    const link = thread("rev-old", "s", "review", sonnet, before);
    const byEvaluator = {
      ...event("s", t("20:00"), "comment", null, null, "chasing"),
      actor: { _tag: "evaluator" as const, threadId: ThreadId.make("ev") },
    };
    const quiet = Activity.rollup({
      window,
      cards: [stale],
      events: [byEvaluator],
      threads: [link],
      pools,
    });
    expect(quiet.pools.used).toEqual({});
    const byReviewer = {
      ...event("s", t("05:00"), "comment", null, null, "still reading"),
      actor: { _tag: "thread" as const, threadId: ThreadId.make("rev-old") },
    };
    const wrote = Activity.rollup({
      window,
      cards: [stale],
      events: [byReviewer, byEvaluator],
      threads: [link],
      pools,
    });
    const row = wrote.pools.used[Rules.poolKey(sonnet)]!;
    expect(row[4]).toBe(1);
    expect(row[5]).toBe(0);
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
    for (const words of [
      "SECRET",
      "PROMPT",
      "DESCRIPTION",
      "STALL",
      "ASK WORDS",
      "COMMENT",
      "REVIEW WORDS",
      "FLAG",
    ])
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
    // Every ask answered in the window is listed, however long the day.
    expect(big.asks.answeredItems).toHaveLength(300);
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
    expect(first.events.map((entry) => entry.id)).toEqual(
      events.slice(-20).map((entry) => entry.id),
    );
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
    const many = Array.from({ length: 300 }, () =>
      event("z", t("01:00"), "moved", "todo", "working"),
    );
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
    ["not a time", undefined, "since must be an ISO time or a relative time like now-24h or 24h."],
    [undefined, "nope", "until must be an ISO time or a relative time like now-24h or 24h."],
    [
      "2026-11-13T01:00:00Z",
      undefined,
      "since 2026-11-13T01:00:00.000Z is not before until 2026-11-13T00:00:00.000Z (now, server clock, UTC).",
    ],
    ["2026-11-01T00:00:00Z", undefined, "The window is at most 72 hours."],
    ["now-73h", undefined, "The window is at most 72 hours."],
    ["7d", undefined, "The window is at most 72 hours."],
  ])("refuses since=%s until=%s", (since, until, message) => {
    expect(Activity.parseWindow(since, until, now)).toBe(message);
  });
  it.each(["now-24h", "24h", " NOW-24H ", "\t24H\n", "now-1d", "1D", "1440m"])(
    "resolves %s to the last 24 hours",
    (since) => {
      expect(Activity.parseWindow(since, "now", now)).toEqual(
        Activity.parseWindow(undefined, "now", now),
      );
      expect(Activity.parseWindow(since, undefined, now)).toEqual({
        since: window.since,
        until: "2026-11-13T00:00:00.001Z",
      });
    },
  );
  it.each(["now-90m", "90m", " NOW-90M "])("resolves %s from the server clock", (since) => {
    expect(Activity.parseWindow(since, undefined, now)).toEqual({
      since: "2026-11-12T22:30:00.000Z",
      until: "2026-11-13T00:00:00.001Z",
    });
  });
  it.each(["now-24h", "24h", " NOW-24H "])("resolves until=%s from now too", (until) => {
    expect(Activity.parseWindow("now-48h", until, now)).toEqual({
      since: "2026-11-11T00:00:00.000Z",
      until: window.since,
    });
    expect(Activity.parseWindow(undefined, until, now)).toEqual({
      since: "2026-11-11T00:00:00.000Z",
      until: window.since,
    });
  });
  it.each(["now", "now-0h", "0h", "0m", "now-0d"])("refuses zero duration %s", (since) => {
    expect(Activity.parseWindow(since, undefined, now)).toBe(
      "since 2026-11-13T00:00:00.000Z is not before until 2026-11-13T00:00:00.000Z (now, server clock, UTC).",
    );
  });
  it.each(["now-24x", "24x", "yesterday", "now-10000m", "10000h", "now-1.5h", "now+1h"])(
    "refuses invalid time %s for either bound",
    (value) => {
      expect(Activity.parseWindow(value, undefined, now)).toBe(
        "since must be an ISO time or a relative time like now-24h or 24h.",
      );
      expect(Activity.parseWindow(undefined, value, now)).toBe(
        "until must be an ISO time or a relative time like now-24h or 24h.",
      );
    },
  );
  it("identifies an explicit until in reversed-window errors", () => {
    expect(Activity.parseWindow("now-24h", "now-48h", now)).toBe(
      "since 2026-11-12T00:00:00.000Z is not before until 2026-11-11T00:00:00.000Z (explicit until, UTC).",
    );
  });
  it("normalizes offset timestamps to UTC", () => {
    expect(Activity.parseWindow("2026-11-12T04:00:00+04:00", "now", now)).toEqual(window);
  });
  it("keeps Date.parse behavior for timestamps without an offset", () => {
    const since = "2026-11-12T04:00:00";
    expect(Activity.parseWindow(since, "now", now)).toEqual({
      since: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(since))),
      until: window.until,
    });
  });
  it("accepts a 72 hour window", () => {
    expect(Activity.parseWindow("2026-11-10T00:00:00Z", window.until, now)).toEqual({
      since: "2026-11-10T00:00:00.000Z",
      until: window.until,
    });
    for (const since of ["now-72h", "72h", "3d", "4320m"]) {
      expect(Activity.parseWindow(since, "now", now)).toEqual({
        since: "2026-11-10T00:00:00.000Z",
        until: window.until,
      });
    }
  });
});

it("reports a refused verdict separately from no verdict and ordinary flags", () => {
  const reason = "Review verdict refused: needs approval";
  const reviewing = card("refused", {
    stage: "needs_review",
    stalled: { reason, by: { _tag: "system", component: "dispatcher" }, at: t("02:00") },
  });
  const attempted = {
    ...event(
      "refused",
      t("01:00"),
      "comment",
      null,
      null,
      "Review verdict refused: clear at abcdef12: needs approval",
      "abcdef1234",
    ),
    actor: { _tag: "thread" as const, threadId: ThreadId.make("reviewer") },
  };
  const flag = event("refused", t("02:00"), "flagged", "in_review", "needs_review", reason);
  expect(Activity.failureKind(attempted)).toBeNull();
  expect(Activity.failureKind(flag)).toBe("verdict_refused");
  expect(Activity.failureKind({ ...flag, actor: { _tag: "owner" } })).toBeNull();
  const events = [attempted, flag];
  const result = Activity.rollup({ window, cards: [reviewing], events, threads: [], pools });
  expect(result.failures.byKind).toEqual({ verdict_refused: 1 });
  expect(result.stalls.items).toMatchObject([{ kind: "verdict_refused", ongoing: true }]);
  expect(Activity.compactRow(reviewing, events, window)).toMatchObject({
    failures: 1,
    lastFailure: reason,
  });
});
