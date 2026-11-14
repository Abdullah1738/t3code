import {
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanSubtask,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanOwnerAsk,
  type KanbanThreadLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { SlotEvent } from "../store/KanbanStore.ts";

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
const slot = (
  id: number,
  kind: SlotEvent["kind"],
  threadId: string,
  at: string,
  poolKey = Rules.poolKey(opus),
): SlotEvent => ({
  id,
  boardId: "b1",
  poolKey,
  threadId,
  cardId: null,
  kind,
  at,
  why: kind === "take" ? "start" : "card_left",
});
const slotHistory = {
  recordedSince: before,
  events: [
    slot(1, "take", "tb", before),
    slot(2, "take", "tw", t("01:00")),
    slot(3, "release", "tw", t("03:00")),
    slot(4, "take", "tr1", t("03:10"), Rules.poolKey(sonnet)),
    slot(5, "release", "tr1", t("04:10"), Rules.poolKey(sonnet)),
  ],
};
const input = {
  window,
  cards: [busy, parked, old],
  events: busyEvents,
  threads,
  pools,
  slotHistory,
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

  it("separates open notices and answer latency from decisions", () => {
    const mixed = card("mixed", {
      asks: [
        ask("notice", t("23:00"), { kind: "notice", respond: { ack: true } }),
        ask("old-notice", t("16:00"), { kind: "notice", respond: { ack: true } }),
        ask("approve", t("10:00"), { kind: "approve", blocking: true }),
        ask("pick", t("20:00"), { kind: "pick" }),
        ask("answered-notice", t("01:00"), {
          kind: "notice",
          closedAt: t("09:00"),
          answer: { verdict: "ack", by: { _tag: "owner" }, at: t("09:00") },
        }),
        ask("answered-pick", t("09:00"), {
          kind: "pick",
          blocking: true,
          closedAt: "2026-11-12T09:00:20.000Z",
          answer: { verdict: "picked", by: { _tag: "owner" }, at: "2026-11-12T09:00:20.000Z" },
        }),
        ask("legacy", t("21:00"), { respond: { ack: true } }),
        ask("dropped", t("23:30"), { kind: "approve", closedAt: t("23:40") }),
      ],
    });
    const run = Activity.rollup({ window, cards: [mixed], events: [], threads: [], pools: [] });
    expect(run.asks).toMatchObject({
      open: 3,
      openNotices: 2,
      answered: 2,
      closedWithoutAnswer: 1,
    });
    expect(run.asks.openOver6h).toEqual({
      count: 1,
      items: [{ card: 1, ask: "approve", askedAt: "2026-11-12T10:00Z", hours: 14, blocking: true }],
    });
    expect(run.asks.noticesOver6h).toEqual({ count: 1 });
    expect(run.asks.answerMinutesByKind).toEqual({
      notice: { count: 1, p50: 480, p90: 480, max: 480 },
      pick: { count: 1, p50: 0, p90: 0, max: 0 },
    });
    expect(run.asks.answerMinutesByBlocking).toEqual({
      blocking: { count: 1, p50: 0, p90: 0, max: 0 },
      async: { count: 1, p50: 480, p90: 480, max: 480 },
    });
    // Retains the existing rounded minutes and nearest-rank percentiles overall.
    expect(run.asks.answerMinutes).toEqual({ p50: 480, p90: 480, max: 480 });
    expect(run.asks.answeredItems.map(({ kind, blocking }) => [kind, blocking])).toEqual([
      ["notice", undefined],
      ["pick", true],
    ]);
    expect(run.asks.others.items.map(({ id, kind }) => [id, kind])).toEqual([
      ["legacy", undefined],
      ["pick", "pick"],
      ["approve", "approve"],
      ["dropped", "approve"],
      ["notice", "notice"],
      ["old-notice", "notice"],
    ]);
    expect(run.asks.others.items[0]).not.toHaveProperty("kind");
  });

  it.each([undefined, "question", "custom", "constructor", "__proto__"])(
    "groups answered kind %s without inferring it from respond",
    (kind) => {
      const answered = ask("answered", t("01:00"), {
        ...(kind !== undefined ? { kind } : {}),
        respond: { ack: true },
        closedAt: t("01:20"),
        answer: { verdict: "ack", by: { _tag: "owner" }, at: t("01:20") },
      });
      const run = Activity.rollup({
        window,
        cards: [card("kinds", { asks: [answered] })],
        events: [],
        threads: [],
        pools: [],
      });
      expect(run.asks.answerMinutesByKind).toEqual({
        [kind ?? "question"]: { count: 1, p50: 20, p90: 20, max: 20 },
      });
      expect(run.asks.answerMinutesByBlocking.blocking).toEqual({
        count: 0,
        p50: null,
        p90: null,
        max: null,
      });
      expect(run.asks.answerMinutesByBlocking.async).toEqual({
        count: 1,
        p50: 20,
        p90: 20,
        max: 20,
      });
    },
  );

  it("a notice-only board has no open decisions and ignores settled open notices", () => {
    const notice = ask("notice", before, { kind: "notice", respond: { ack: true } });
    const run = Activity.rollup({
      window,
      cards: [
        card("notice", { asks: [notice] }),
        card("settled", { settledAt: before, asks: [notice] }),
      ],
      events: [],
      threads: [],
      pools: [],
    });
    expect(run.asks.open).toBe(0);
    expect(run.asks.openNotices).toBe(1);
    expect(run.asks.openOver6h).toEqual({ count: 0, items: [] });
    expect(run.asks.noticesOver6h).toEqual({ count: 1 });
    expect(run.asks.answerMinutesByKind).toEqual({});
  });

  it("keeps open decisions ahead of newer notices when the list is capped", () => {
    const notices = Array.from({ length: 160 }, (_, index) =>
      ask(`notice-${index}`, t("23:00"), { kind: "notice" }),
    );
    const run = Activity.rollup({
      window,
      cards: [
        card("capped", { asks: [...notices, ask("decision", t("01:00"), { kind: "approve" })] }),
      ],
      events: [],
      threads: [],
      pools: [],
    });
    expect(run.asks.others.more).toBeGreaterThan(0);
    expect(run.asks.others.items[0]?.id).toBe("decision");
    expect(run.asks.open).toBe(1);
    expect(run.asks.openNotices).toBe(160);
    expect(JSON.stringify(run).length).toBeLessThan(50_000);
  });

  it.each([
    {
      form: "ordinary repeated",
      kinds: Array.from({ length: 300 }, (_, i) => ["notice", "pick", "custom"][i % 3]!),
      cappedKinds: false,
    },
    {
      form: "many long distinct",
      kinds: Array.from({ length: 300 }, (_, i) => `kind-${i}-${"k".repeat(128)}`),
      cappedKinds: true,
    },
    {
      form: "JSON-escaped distinct",
      kinds: Array.from({ length: 300 }, (_, i) => `kind-${i}-${'"\\'.repeat(64)}`),
      cappedKinds: true,
    },
    { form: "one oversized", kinds: ["k".repeat(50_000)], cappedKinds: true },
  ])("bounds the kind breakdown with $form names", ({ kinds, cappedKinds }) => {
    const counts = new Map<string, number>();
    const asks = kinds.map((kind, index) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return ask(`q${index}`, t("01:00"), {
        kind,
        closedAt: t("02:00"),
        answer: { verdict: "done", by: { _tag: "owner" }, at: t("02:00") },
      });
    });
    const run = Activity.rollup({
      window,
      cards: [card("kinds", { asks })],
      events: [],
      threads: [],
      pools: [],
    });
    expect(JSON.stringify({ activity: { boardId: "board-robob", ...run } }).length).toBeLessThan(
      50_000,
    );
    expect(run.asks.answered).toBe(kinds.length);
    expect(run.asks.answerMinutes).toEqual({ p50: 60, p90: 60, max: 60 });
    expect(run.asks.answerMinutesByBlocking.async).toEqual({
      count: kinds.length,
      p50: 60,
      p90: 60,
      max: 60,
    });
    expect(
      Object.keys(run.asks.answerMinutesByKind).length + (run.asks.answerMinutesByKindMore ?? 0),
    ).toBe(counts.size);
    for (const [kind, summary] of Object.entries(run.asks.answerMinutesByKind)) {
      expect(summary).toEqual({ count: counts.get(kind), p50: 60, p90: 60, max: 60 });
    }
    if (cappedKinds) expect(run.asks.answerMinutesByKindMore).toBeGreaterThan(0);
    else expect(run.asks).not.toHaveProperty("answerMinutesByKindMore");
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
    expect(review[3]).toBe(1);
    expect(review[8]).toBe(0);
    expect(result.pools.slotHours[Rules.poolKey(sonnet)]![3]).toBeCloseTo(50 / 60, 2);
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
    expect(run.threads.evaluatorStarts).toEqual({
      count: 3,
      cardsWith2OrMore: { items: [{ card: 15, starts: 3 }] },
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

  it.each([
    { form: "short per-card", askId: "q1", allAnswers: true },
    { form: "UUID", askId: "12345678-1234-4234-8234-123456789012", allAnswers: false },
    { form: "prefixed UUID", askId: "ask-12345678-1234-4234-8234-123456789012", allAnswers: false },
    { form: "long opaque", askId: "x".repeat(512), allAnswers: false },
    { form: "JSON-escaped", askId: 'q"\\'.repeat(128), allAnswers: false },
  ])("stays small: 300 cards with $form ask IDs fit one call", ({ askId, allAnswers }) => {
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
            ask(askId, t("01:00"), {
              kind: index % 2 === 0 ? "notice" : "pick",
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
    expect(JSON.stringify({ activity: { boardId: "board-robob", ...big } }).length).toBeLessThan(
      50_000,
    );
    expect(big.asks.answered).toBe(300);
    expect(big.asks.answeredItems.length + (big.asks.answeredItemsMore ?? 0)).toBe(300);
    expect(big.asks.answeredItems.length).toBeGreaterThan(0);
    expect(big.asks.answeredItems.every((row) => row.id === askId)).toBe(true);
    if (allAnswers) {
      expect(big.asks.answeredItems).toHaveLength(300);
      expect(big.asks).not.toHaveProperty("answeredItemsMore");
    } else expect(big.asks.answeredItemsMore).toBeGreaterThan(0);
    expect(big.asks.answerMinutes).toEqual({ p50: 60, p90: 60, max: 60 });
    expect(big.asks.answerMinutesByKind).toEqual({
      notice: { count: 150, p50: 60, p90: 60, max: 60 },
      pick: { count: 150, p50: 60, p90: 60, max: 60 },
    });
    expect(big.asks.answerMinutesByBlocking.async.count).toBe(300);
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
    expect(page.note).toContain("before: olderEvents");
  });

  it.each(["prompt", "threads"])("pages all 91 events when %s fills the first reply", (field) => {
    const giant = {
      card: card("g", { prompt: field === "prompt" ? "G".repeat(70_000) : "G" }),
      threads:
        field === "threads"
          ? Array.from({ length: 1_000 }, () => ({ threadId: "t".repeat(80) }))
          : [],
    };
    const history = Array.from({ length: 91 }, (_, index) =>
      event("g", t("01:00"), "comment", null, null, `c${index}`),
    );
    const first = Activity.pageCardEvents(giant, history, { limit: 100 });
    expect(first.events).toEqual([]);
    expect(first.olderEvents).toBe(history.at(-1)!.id + 1);
    const { id, number, title, stage, boardId } = giant.card;
    const header = { card: { id, number, title, stage, boardId } };
    const seen = [...first.events];
    const cursors = new Set<number>();
    let cursor = first.olderEvents;
    for (let count = 0; cursor !== null && count < 200; count++) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      const page = Activity.pageCardEvents(header, history, { before: cursor, limit: 20 });
      expect(JSON.stringify({ ...header, ...page }).length).toBeLessThanOrEqual(
        Activity.CARD_GET_CHARS,
      );
      expect(page.eventsTotal).toBe(91);
      if (page.olderEvents !== null) expect(page.olderEvents).toBeLessThan(cursor);
      seen.unshift(...page.events);
      cursor = page.olderEvents;
    }
    expect(cursor).toBeNull();
    expect(seen.map((entry) => entry.id)).toEqual(history.map((entry) => entry.id));
    expect(new Set(seen.map((entry) => entry.id)).size).toBe(91);
  });

  it.each([0, 2, 4])(
    "skips an oversized event at index %i and reads every other event",
    (index) => {
      const history = Array.from({ length: 5 }, (_, i) =>
        event("z", t("01:00"), "comment", null, null, i === index ? "H".repeat(70_000) : `c${i}`),
      );
      const seen: number[] = [];
      const notes: string[] = [];
      let cursor: number | undefined;
      for (let count = 0; count < 20; count++) {
        const page = Activity.pageCardEvents(rest, history, { before: cursor, limit: 2 });
        seen.unshift(...page.events.map((entry) => entry.id));
        if (page.note !== undefined) notes.push(page.note);
        if (page.olderEvents === null) break;
        if (cursor !== undefined) expect(page.olderEvents).toBeLessThan(cursor);
        cursor = page.olderEvents;
        expect(count).toBeLessThan(19);
      }
      expect(seen).toEqual(history.filter((_, i) => i !== index).map((entry) => entry.id));
      expect(notes.join(" ")).toContain(`Event ${history[index]!.id}`);
      expect(notes.join(" ")).toContain('events: "all"');
      expect(Activity.pageCardEvents(rest, history, "all").events).toEqual(history);
    },
  );

  it.each([1, 0.5])(
    "stops instead of repeating or increasing a cursor with offset %s",
    (offset) => {
      const giant = { card: card("g", { prompt: "G".repeat(70_000) }), threads: [] };
      const before = events.at(-1)!.id + offset;
      const page = Activity.pageCardEvents(giant, events, { before });
      expect(page.events).toEqual([]);
      expect(page.olderEvents).toBeNull();
      expect(page.note).toContain("cursor");
      expect(page.note).toContain('events: "all"');
    },
  );

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

describe("ledger pool activity", () => {
  const pool = Rules.poolKey(opus);
  const hourly = { since: t("00:00"), until: t("03:00") };
  const run = (events: SlotEvent[], patch: Partial<Activity.RollupInput> = {}) =>
    Activity.rollup({
      window: hourly,
      cards: [],
      events: [],
      threads: [],
      pools: [{ key: pool, model: opus, slots: 2 }],
      slotHistory: { events, recordedSince: before },
      ...patch,
    }).pools;

  it("replays carry-in, tied events and empty hours without exceeding configured slots", () => {
    const events = [
      slot(1, "take", "t1", before),
      slot(2, "take", "t2", t("00:30")),
      slot(3, "release", "t1", t("00:30")),
      slot(4, "release", "t2", t("01:00")),
    ];
    const result = run(events, {
      cards: [parked, { ...parked, id: KanbanCardId.make("sibling") }],
      threads: Array.from({ length: 88 }, (_, i) =>
        thread(`stale-${i}`, "b", "work", opus, before),
      ),
    });
    expect(result.used[pool]).toEqual([2, 0, 0]);
    expect(result.slotHours[pool]).toEqual([1, 0, 0]);
    expect(result.used[pool]!.every((used) => used !== null && used <= result.slots[pool]!)).toBe(
      true,
    );
    // Replay independently: one slot per identity, never one per card or link.
    const open = new Set<string>();
    for (const event of events) {
      if (event.kind === "take") open.add(event.threadId);
      else open.delete(event.threadId);
    }
    expect(open.size).toBe(0);
  });

  it("counts holds with no cards, ignores duplicate takes and splits pool moves", () => {
    const other = Rules.poolKey(sonnet);
    const result = run([
      slot(1, "take", "held", before),
      slot(2, "take", "held", t("00:15")),
      slot(3, "release", "held", t("01:30")),
      slot(4, "take", "held", t("01:30"), other),
    ]);
    expect(result.used[pool]).toEqual([1, 1, 0]);
    expect(result.slotHours[pool]).toEqual([1, 0.5, 0]);
    expect(result.used[other]).toEqual([0, 1, 1]);
    expect(result.slotHours[other]).toEqual([0, 0.5, 1]);
  });

  it("marks hours before ledger collection unknown and clips partial windows", () => {
    const events = [slot(1, "take", "t1", t("01:30"))];
    const result = run(events, {
      window: { since: t("00:15"), until: t("02:15") },
      slotHistory: { events, recordedSince: t("01:30") },
    });
    expect(result.used[pool]).toEqual([null, 1, 1]);
    expect(result.slotHours[pool]).toEqual([null, 0.5, 0.25]);
    expect(result.recordedSince).toBe(t("01:30"));
    expect(
      run([], { slotHistory: { events: [], recordedSince: null }, cards: [parked], threads }).used,
    ).toEqual({});
  });

  it("measures ready todo card-hours only while the routed pool is full", () => {
    const full = [
      slot(1, "take", "t1", before),
      slot(2, "take", "t2", before),
      slot(3, "release", "t1", t("01:30")),
    ];
    const eligible = card("ready");
    const excluded = [
      card("backlog", { priority: 5 }),
      card("stalled", { stalled: { at: before, reason: "flag", by: { _tag: "owner" } } }),
      card("waiting", { wait: waitOn }),
      card("owner", { asks: [ask("q", before, { blocking: true })] }),
      card("blocked", { blockedBy: [KanbanCardId.make("blocker")] }),
      card("blocker", { stage: "working" }),
      card("joining", { workThreadId: ThreadId.make("t1") }),
      card("disabled", { model: sonnet }),
    ];
    const result = run(full, { cards: [eligible, ...excluded] });
    expect(result.queueWait[pool]).toEqual([1, 0.5, 0]);
    expect(result.queueWaitBasis).toContain("card-hours");
  });

  it("excludes cards outside the current board pause keep list", () => {
    const full = [slot(1, "take", "t1", before), slot(2, "take", "t2", before)];
    const ready = card("ready");
    const board = {
      archivedAt: null,
      setup: null,
      pause: { keep: [], reason: "Wait", by: "owner", at: before },
    };
    expect(run(full, { cards: [ready], board }).queueWait).toEqual({});
    expect(
      run(full, {
        cards: [ready],
        board: { ...board, pause: { ...board.pause, keep: [ready.id] } },
      }).queueWait[pool],
    ).toEqual([1, 1, 1]);
  });

  it("splits queue wait on recorded waits, flags, owner answers and blocker completion", () => {
    const events = [slot(1, "take", "t1", before), slot(2, "take", "t2", before)];
    const waiting = card("w");
    const flags = card("f");
    const owned = card("o", { asks: [ask("q", before, { blocking: true, closedAt: t("01:00") })] });
    const blocker = card("b", { stage: "completed" });
    const blocked = card("blocked", { blockedBy: [blocker.id] });
    const result = run(events, {
      cards: [waiting, flags, owned, blocker, blocked],
      events: [
        event("w", t("00:30"), "wait_set", null, null, "Waiting for CI"),
        event("w", t("01:30"), "wait_cleared", null, null, "Wait ended: cleared"),
        event("f", t("00:30"), "flagged", "todo", "todo", "Run failed: error"),
        event("f", t("01:30"), "flagged", "todo", "todo", "Cleared"),
        event("b", t("02:00"), "moved", "working", "completed"),
      ],
    });
    expect(result.queueWait[pool]).toEqual([1, 2, 4]);
  });

  it.each([
    {
      name: "set before the window",
      at: before,
      expiredAt: null,
      movedAt: before,
      expected: [0, 0, 0],
    },
    {
      name: "set inside the window",
      at: t("00:30"),
      expiredAt: null,
      movedAt: before,
      expected: [0.5, 0, 0],
    },
    {
      name: "expired inside the window",
      at: before,
      expiredAt: t("01:30"),
      movedAt: before,
      expected: [0, 0.5, 1],
    },
    {
      name: "made stale by a move",
      at: before,
      expiredAt: null,
      movedAt: t("01:00"),
      expected: [0, 1, 1],
    },
  ])(
    "queue wait respects a persisted wait $name without wait events",
    ({ at, expiredAt, movedAt, expected }) => {
      const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
        cards: [card("w", { movedAt, wait: { ...waitOn, at, expiredAt } })],
      });
      expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
    },
  );

  it.each(["edited", "wait_set"] as const)("queue wait reads %s wait markers", (kind) => {
    const cleared = kind === "edited" ? "edited" : "wait_cleared";
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [card("w"), card("flag")],
      events: [
        event("w", t("00:30"), kind, null, null, "Waiting for CI on app#12: ci"),
        event("w", t("01:30"), cleared, null, null, "Wait ended: cleared by hand"),
        event("flag", t("01:00"), "flagged", "todo", "todo", "Cleared"),
      ],
    });
    expect(result.queueWait[pool]).toEqual([1.5, 1.5, 2]);
  });

  const waitStyles = [
    {
      name: "legacy clear",
      set: "edited",
      endKind: "edited",
      setBody: "Waiting for CI",
      endBody: "Wait ended: cleared",
    },
    {
      name: "legacy expiry",
      set: "edited",
      endKind: "edited",
      setBody: "Waiting for CI",
      endBody: "Wait expired: CI",
    },
    { name: "typed clear", set: "wait_set", endKind: "wait_cleared", setBody: null, endBody: null },
    {
      name: "typed expiry",
      set: "wait_set",
      endKind: "wait_expired",
      setBody: null,
      endBody: null,
    },
  ] as const;
  const waitStarts = [
    { name: "new wait", prior: null, replace: true, end: true, expected: [1, 0, 1] },
    {
      name: "replacement of carried wait",
      prior: "set",
      replace: true,
      end: true,
      expected: [0, 0, 1],
    },
    { name: "end carried wait", prior: "set", replace: false, end: true, expected: [0, 0, 1] },
    {
      name: "new wait after prior end",
      prior: "end",
      replace: true,
      end: true,
      expected: [1, 0, 1],
    },
    {
      name: "carried replacement still open",
      prior: "set",
      replace: true,
      end: false,
      expected: [0, 0, 0],
    },
    {
      name: "redundant end after prior end",
      prior: "end",
      replace: false,
      end: true,
      expected: [1, 1, 1],
    },
  ] as const;
  it.each(
    waitStyles.flatMap((style) =>
      waitStarts.map((initial) => ({
        ...style,
        ...initial,
        name: `${style.name}: ${initial.name}`,
      })),
    ),
  )(
    "replays wait state across the window: $name",
    ({ prior, replace, end, expected, set, endKind, setBody, endBody }) => {
      const marker = (state: "set" | "end", at: string) =>
        event(
          "w",
          at,
          state === "set" ? set : endKind,
          null,
          null,
          state === "set" ? setBody : endBody,
        );
      const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
        cards: [card("w")],
        readinessBefore: prior === null ? [] : [marker(prior, before)],
        events: [
          ...(replace ? [marker("set", t("01:00"))] : []),
          ...(end ? [marker("end", t("02:00"))] : []),
        ],
      });
      expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
    },
  );

  const flagStarts = [
    {
      name: "redundant clear on ready card",
      prior: null,
      kind: "flagged",
      body: "Cleared",
      expected: [1, 1, 1],
    },
    {
      name: "redundant clear after prior clear",
      prior: "Cleared",
      kind: "flagged",
      body: "Cleared",
      expected: [1, 1, 1],
    },
    {
      name: "clear carried stall",
      prior: "Run failed: error",
      kind: "flagged",
      body: "Cleared",
      expected: [0, 1, 1],
    },
    {
      name: "move clears carried stall",
      prior: "Run failed: error",
      kind: "moved",
      body: null,
      expected: [0, 1, 1],
    },
    {
      name: "review clears carried stall",
      prior: "Run failed: error",
      kind: "review",
      body: null,
      expected: [0, 1, 1],
    },
    {
      name: "new stall after prior clear",
      prior: "Cleared",
      kind: "flagged",
      body: "Run failed: error",
      expected: [1, 0, 0],
    },
  ] as const;
  it.each(flagStarts)(
    "replays flag state across the window: $name",
    ({ prior, kind, body, expected }) => {
      const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
        cards: [card("f")],
        readinessBefore:
          prior === null ? [] : [event("f", before, "flagged", "todo", "todo", prior)],
        events: [event("f", t("01:00"), kind, "todo", "todo", body)],
      });
      expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
    },
  );

  it.each(
    flagStarts.flatMap((state) =>
      (["shared", "chain", "separate", "done"] as const).map((topology) => ({
        ...state,
        topology,
      })),
    ),
  )("replays blocker flags: $name ($topology)", ({ prior, kind, body, expected, topology }) => {
    const shared = ThreadId.make("idle-shared");
    const blocker = card("flagged-blocker", {
      workThreadId: topology === "separate" ? ThreadId.make("other-idle") : shared,
      stage: topology === "done" ? "completed" : "todo",
    });
    const middle = card("middle", { workThreadId: shared, blockedBy: [blocker.id] });
    const waiter = card("dependent", {
      workThreadId: shared,
      blockedBy: [topology === "chain" ? middle.id : blocker.id],
    });
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [blocker, ...(topology === "chain" ? [middle] : []), waiter],
      readinessBefore:
        prior === null ? [] : [event(blocker.id, before, "flagged", null, null, prior)],
      events: [event(blocker.id, t("01:00"), kind, null, null, body)],
    });
    const multiplier = topology === "chain" ? 3 : topology === "shared" ? 2 : 1;
    expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(
      topology === "done" ? [1, 1, 1] : expected.map((value) => value * multiplier),
    );
  });

  it.each([
    {
      name: "clear after the window",
      snapshot: null,
      prior: "Run failed: error",
      marks: [],
      expected: [0, 0, 0],
    },
    {
      name: "flag after the window",
      snapshot: "04:00",
      prior: "Cleared",
      marks: [],
      expected: [2, 2, 2],
    },
    {
      name: "snapshot after a prior clear",
      snapshot: "00:30",
      prior: "Cleared",
      marks: [],
      expected: [1, 0, 0],
    },
    {
      name: "recorded clear after a snapshot",
      snapshot: "00:30",
      prior: "Cleared",
      marks: ["Cleared"],
      expected: [1, 2, 2],
    },
    {
      name: "tied flag then clear",
      snapshot: null,
      prior: "Cleared",
      marks: ["Run failed: error", "Cleared"],
      expected: [2, 2, 2],
    },
    {
      name: "tied clear then flag",
      snapshot: null,
      prior: "Cleared",
      marks: ["Cleared", "Run failed: error"],
      expected: [2, 0, 0],
    },
  ])("keeps blocker flag history stable: $name", ({ snapshot, prior, marks, expected }) => {
    const shared = ThreadId.make("idle-shared");
    const blocker = card("flagged-blocker", {
      workThreadId: shared,
      stalled:
        snapshot === null ? null : { at: t(snapshot), reason: "flag", by: { _tag: "owner" } },
    });
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [blocker, card("dependent", { workThreadId: shared, blockedBy: [blocker.id] })],
      readinessBefore: [event(blocker.id, before, "flagged", null, null, prior)],
      events: marks.map((body) => event(blocker.id, t("01:00"), "flagged", null, null, body)),
    });
    expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
  });

  it.each([
    {
      name: "wait snapshot set after a prior end",
      kind: "wait",
      clear: false,
      expected: [0.5, 0, 0],
    },
    {
      name: "wait snapshot followed by a recorded end",
      kind: "wait",
      clear: true,
      expected: [0.5, 1, 1],
    },
    {
      name: "stall snapshot set after a prior clear",
      kind: "stall",
      clear: false,
      expected: [0.5, 0, 0],
    },
    {
      name: "stall snapshot followed by a recorded clear",
      kind: "stall",
      clear: true,
      expected: [0.5, 1, 1],
    },
  ] as const)("merges a persisted $name with recorded markers", ({ kind, clear, expected }) => {
    const prior = event(
      "s",
      before,
      kind === "wait" ? "wait_cleared" : "flagged",
      null,
      null,
      "Cleared",
    );
    const ended = event(
      "s",
      t("01:00"),
      kind === "wait" ? "wait_cleared" : "flagged",
      null,
      null,
      "Cleared",
    );
    const snapshot =
      kind === "wait"
        ? { wait: { ...waitOn, at: t("00:30") } }
        : { stalled: { reason: "flag", by: { _tag: "owner" as const }, at: t("00:30") } };
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [card("s", snapshot)],
      readinessBefore: [prior],
      events: clear ? [ended] : [],
    });
    expect(result.queueWait[pool]).toEqual(expected);
  });

  const stageCases = [
    {
      name: "todo before later work",
      prior: "todo",
      current: "working",
      created: before,
      settled: null,
      expected: [1, 1, 1],
    },
    {
      name: "todo before later completion",
      prior: "todo",
      current: "completed",
      created: before,
      settled: null,
      expected: [1, 1, 1],
    },
    {
      name: "todo before later settlement",
      prior: "todo",
      current: "verified",
      created: before,
      settled: t("04:00"),
      expected: [1, 1, 1],
    },
    {
      name: "owner-held before later todo",
      prior: "needs_owner",
      current: "todo",
      created: before,
      settled: null,
      expected: [0, 0, 0],
    },
    {
      name: "working before later todo",
      prior: "working",
      current: "todo",
      created: before,
      settled: null,
      expected: [0, 0, 0],
    },
    {
      name: "not yet created",
      prior: null,
      current: "todo",
      created: t("04:00"),
      settled: null,
      expected: [0, 0, 0],
    },
    {
      name: "created on exclusive end",
      prior: null,
      current: "todo",
      created: t("03:00"),
      settled: null,
      expected: [0, 0, 0],
    },
    {
      name: "created within window",
      prior: null,
      current: "todo",
      created: t("01:00"),
      settled: null,
      expected: [0, 1, 1],
    },
    {
      name: "settled before window",
      prior: "todo",
      current: "verified",
      created: before,
      settled: before,
      expected: [0, 0, 0],
    },
  ] as const;
  it.each(stageCases)(
    "uses historical stage: $name",
    ({ prior, current, created, settled, expected }) => {
      const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
        cards: [
          card("history", {
            stage: current,
            createdAt: created,
            settledAt: settled,
            movedAt: t("04:00"),
          }),
        ],
        prior: prior === null ? [] : [event("history", before, "moved", null, prior)],
      });
      expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
    },
  );

  it.each(
    (["todo", "needs_owner"] as const).flatMap((stage) =>
      ["03:00", "04:00"].map((at) => ({ stage, at })),
    ),
  )("uses the first later transition without prior history ($stage at $at)", ({ stage, at }) => {
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [card("history", { stage: "working", movedAt: t(at) })],
      after: [event("history", t(at), "moved", stage, "working")],
    });
    expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(stage === "todo" ? [1, 1, 1] : [0, 0, 0]);
  });

  it("clips stage and queue durations at settlement inside the window", () => {
    const result = Activity.rollup({
      window: hourly,
      cards: [card("history", { stage: "verified", movedAt: t("01:00"), settledAt: t("02:00") })],
      events: [
        event("history", t("00:30"), "moved", "todo", "working"),
        event("history", t("01:00"), "moved", "working", "verified"),
      ],
      threads: [],
      pools: [{ key: pool, model: opus, slots: 2 }],
      slotHistory: {
        recordedSince: before,
        events: [slot(1, "take", "t1", before), slot(2, "take", "t2", before)],
      },
      prior: [event("history", before, "created", null, "todo")],
    });
    expect(result.pools.queueWait[pool]).toEqual([0.5, 0, 0]);
    expect(result.stages.hours.verified?.hours).toBe(1);
  });

  it("retains a window transition tail after later settlement", () => {
    const result = Activity.rollup({
      window: hourly,
      cards: [card("history", { stage: "verified", settledAt: t("04:00") })],
      events: [event("history", t("01:00"), "moved", "todo", "working")],
      threads: [],
      pools,
      prior: [event("history", before, "created", null, "todo")],
    });
    expect(result.stages.hours.todo?.hours).toBe(1);
    expect(result.stages.hours.working?.hours).toBe(2);
    expect(result.stages.withoutThread.items).toEqual([]);
  });

  it.each([
    { prior: "completed", current: "working", expected: [1, 1, 1] },
    { prior: "working", current: "completed", expected: [0, 0, 0] },
  ] as const)(
    "uses historical blocker stages ($prior then $current)",
    ({ prior, current, expected }) => {
      const blocker = card("blocker", { stage: current, movedAt: t("04:00") });
      const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
        cards: [blocker, card("waiter", { blockedBy: [blocker.id] })],
        prior: [event("blocker", before, "moved", null, prior)],
      });
      expect(result.queueWait[pool] ?? [0, 0, 0]).toEqual(expected);
    },
  );

  it("a historical blocker stays clear after settlement", () => {
    const blocker = card("blocker", {
      stage: "verified",
      movedAt: t("01:00"),
      settledAt: t("02:00"),
    });
    const result = run([slot(1, "take", "t1", before), slot(2, "take", "t2", before)], {
      cards: [blocker, card("waiter", { blockedBy: [blocker.id] })],
      prior: [event("blocker", before, "created", null, "working")],
      events: [event("blocker", t("01:00"), "moved", "working", "verified")],
    });
    expect(result.queueWait[pool]).toEqual([0, 1, 1]);
  });

  it("counts weighted alternatives once only when every enabled route is full", () => {
    const other = Rules.poolKey(sonnet);
    const weighted = card("weighted", {
      models: [
        { model: opus, weight: 2 },
        { model: sonnet, weight: 1 },
      ],
    });
    const result = run(
      [
        slot(1, "take", "t1", before),
        slot(2, "take", "t2", before),
        slot(3, "take", "s1", t("01:00"), other),
      ],
      {
        cards: [weighted],
        pools: [
          { key: pool, model: opus, slots: 2 },
          { key: other, model: sonnet, slots: 1 },
        ],
      },
    );
    expect(result.queueWait[pool]).toEqual([0, 1, 1]);
    expect(result.queueWait[other]).toBeUndefined();
  });
});

describe("queued current-state rollup", () => {
  const board: KanbanBoard = {
    id: KanbanBoardId.make("b1"),
    slug: "queued",
    name: "Queued",
    icon: null,
    iconImage: null,
    defaultProjectId: null,
    managerModel: sonnet,
    evaluatorModel: opus,
    defaultCardModel: opus,
    reviewChains: [{ name: "Default", steps: [opus] }],
    defaultReviewChain: "Default",
    standingApprovals: [],
    instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
    setup: null,
    pause: null,
    createdAt: before,
    nightlyReview: null,
    archivedAt: null,
  };
  const pools = [{ key: Rules.poolKey(opus), model: opus, slots: 1 }];
  it("keeps current queued rows even when they never moved in the window", () => {
    const holder = card("held", {
      number: 44,
      stage: "working",
      activeRole: "work",
      activePool: Rules.poolKey(opus),
      activeThreadId: ThreadId.make("held"),
    });
    const review = card("review", {
      number: 42,
      priority: 4,
      stage: "needs_review",
      analyticsStageEnteredAt: t("10:00"),
    });
    const todo = card("todo", { number: 47, priority: 3, analyticsStageEnteredAt: t("12:00") });
    const waiting = card("waiting", {
      number: 48,
      movedAt: t("20:00"),
      wait: { ...waitOn, at: t("20:00") },
    });
    const result = Activity.rollup({
      board,
      window,
      cards: [holder, todo, waiting, review],
      pools,
      threads: [],
      events: [],
    });
    expect(result.stages.queued).toMatchObject({
      count: 3,
      byReason: { pool_full: 2, "wait:ci": 1 },
      items: [
        {
          card: 42,
          hours: 14,
          reason: "pool_full",
          rank: 2,
          ahead: { count: 1, items: [47] },
          held: [{ card: 44, role: "work" }],
        },
        { card: 47, hours: 12, reason: "pool_full", rank: 1 },
        { card: 48, hours: 4, reason: "wait:ci" },
      ],
    });
    expect(result.stages.queuedOver6h).toMatchObject({
      count: 2,
      items: [{ card: 42 }, { card: 47 }],
    });
    expect(JSON.stringify(result.stages.queued)).not.toContain('"title"');
    expect(JSON.stringify(result.stages.queued)).not.toContain('"prompt"');
  });
  it("uses live reservations and masked dispatch pools separately from history", () => {
    const todo = card("todo");
    const read = { board, window, cards: [todo], pools, threads: [], events: [] };
    expect(Activity.rollup(read).stages.queued.items[0]?.reason).toBe("would_start");
    expect(
      Activity.rollup({ ...read, holds: new Map([["reserved", Rules.poolKey(opus)]]) }).stages
        .queued.items[0]?.reason,
    ).toBe("pool_full");
    expect(
      Activity.rollup({ ...read, dispatchPools: pools.map((pool) => ({ ...pool, slots: 0 })) })
        .stages.queued.items[0]?.reason,
    ).toBe("no_pool");
  });
  it("measures gates and stage ages at the requested window end", () => {
    const todo = card("retry", { movedAt: t("03:00") });
    const read = {
      board,
      cards: [todo],
      pools,
      threads: [],
      events: [],
      assignmentWakeRetries: new Map([
        [todo.id, { movedAt: todo.movedAt, attempts: 1, retryAt: Date.parse(t("12:00")) }],
      ]),
    };
    const before = Activity.rollup({ ...read, window: { ...window, until: t("11:00") } });
    expect(before.stages.queued.items[0]).toMatchObject({ reason: "retry_backoff", hours: 8 });
    const after = Activity.rollup({ ...read, window: { ...window, until: t("14:00") } });
    expect(after.stages.queued.items[0]).toMatchObject({ reason: "would_start", hours: 11 });
    expect(after.stages.queuedOver6h.count).toBe(1);
  });

  it("caps both queued lists while retaining full counts", () => {
    const cards = Array.from({ length: 200 }, (_, i) => card(`q${i}`, { number: i + 1 }));
    const result = Activity.rollup({ board, window, cards, pools, threads: [], events: [] });
    expect(result.stages.queued.count).toBe(200);
    expect(result.stages.queued.items.length).toBeLessThan(200);
    expect(result.stages.queued.byReason).toEqual({ would_start: 1, pool_full: 199 });
    expect(result.stages.queuedOver6h.count).toBe(200);
    expect(result.stages.queuedOver6h.items.length).toBeLessThan(200);
  });
});

const activityBoard: KanbanBoard = {
  id: KanbanBoardId.make("b1"),
  slug: "test",
  name: "Test",
  icon: null,
  iconImage: null,
  defaultProjectId: null,
  managerModel: opus,
  evaluatorModel: sonnet,
  defaultCardModel: opus,
  reviewChains: [{ name: "Default", steps: [sonnet] }],
  defaultReviewChain: "Default",
  standingApprovals: [],
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: null,
  createdAt: before,
  nightlyReview: null,
  archivedAt: null,
};
const subtask = (
  owner: KanbanSubtask["owner"],
  patch: Partial<KanbanSubtask> = {},
): KanbanSubtask => ({
  id: owner,
  step: 1,
  text: "Finish",
  owner,
  createdAt: before,
  state: "open",
  note: null,
  doneBy: null,
  doneAt: null,
  ...patch,
});
const flag = (reason: string, by: KanbanCard["createdBy"] = { _tag: "owner" }) => ({
  reason,
  by,
  at: before,
});

// Newer stuck cards must remain visible next to older intentionally parked cards.
describe("without-thread reasons", () => {
  const blocker = card("blocker");
  const step = [subtask("evaluator"), subtask("script")];
  const candidates = [
    card("wait", { number: 1, wait: waitOn, asks: [ask("q", before, { blocking: true })] }),
    card("ask", {
      number: 2,
      asks: [ask("q", before, { blocking: true })],
      blockedBy: [blocker.id],
    }),
    card("blocked", { number: 3, blockedBy: [blocker.id], priority: 5 }),
    card("paused", { number: 4, priority: 5, subtasks: step }),
    card("evaluator", { number: 5, subtasks: step, stalled: flag("Stopped") }),
    card("failed", { number: 6, stalled: flag("Run failed: timeout") }),
    card("flagged", { number: 7, stalled: flag("Stopped") }),
    card("refused", {
      number: 8,
      stalled: flag("Review verdict refused: stale", { _tag: "system", component: "dispatcher" }),
    }),
    card("none", { number: 9, movedAt: t("20:00") }),
    card("expired", {
      number: 10,
      movedAt: t("21:00"),
      wait: { ...waitOn, expiredAt: t("22:00") },
    }),
  ].map((row) => ({ ...row, stage: "working" as const }));

  it("reports reasons in precedence order, full counts and independently listed none items", () => {
    const run = Activity.rollup({
      window,
      cards: [...candidates, blocker],
      events: [],
      threads: [],
      pools,
      board: activityBoard,
    });
    const section = run.stages.withoutThread;
    expect(section.byReason).toEqual({
      "wait:ci": 1,
      owner_ask: 1,
      blocked: 1,
      paused: 1,
      evaluator_step: 1,
      "stalled:run_failed": 1,
      "stalled:flagged": 1,
      "stalled:verdict_refused": 1,
      none: 2,
    });
    expect(section.count).toBe(10);
    expect(section.items.map((row) => row.card)).toEqual([9, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(section.none).toEqual({
      count: 2,
      items: [
        { card: 9, stage: "working", since: "2026-11-12T20:00Z", reason: "none", hours: 4 },
        {
          card: 10,
          stage: "working",
          since: "2026-11-12T21:00Z",
          reason: "none",
          hours: 3,
          expiredWait: "ci",
        },
      ],
    });
  });

  it.each(["push", "merge", "ci", "card", "time", "owner_go", "script"] as const)(
    "keeps an open %s wait ahead of an ask, but lets an expired wait expose it",
    (on) => {
      const waiting = card(on, {
        stage: "working",
        wait: { ...waitOn, on },
        asks: [ask("q", before, { blocking: true })],
      });
      const read = (row: KanbanCard) =>
        Activity.rollup({ window, cards: [row], events: [], threads: [], pools }).stages
          .withoutThread.items[0];
      expect(read(waiting)?.reason).toBe(`wait:${on}`);
      expect(read({ ...waiting, wait: { ...waitOn, on, expiredAt: t("22:00") } })).toMatchObject({
        reason: "owner_ask",
        expiredWait: on,
      });
    },
  );

  it.each([
    ["closed ask", { asks: [ask("q", before, { blocking: true, closedAt: t("01:00") })] }],
    ["nonblocking ask", { asks: [ask("q", before)] }],
    ["stale wait", { movedAt: t("01:00"), wait: waitOn }],
    ["missing blocker", { blockedBy: [KanbanCardId.make("missing")] }],
    ["mixed worker step", { subtasks: [...step, subtask("work")] }],
    ["review step", { subtasks: [subtask("review")] }],
    ["no open steps", { subtasks: [subtask("evaluator", { state: "done" })] }],
    ["pending findings", { subtasks: step, reviewFindingsPending: true }],
    ["old note", { wakeNote: "Review findings: fix this" }],
  ] satisfies Array<[string, Partial<KanbanCard>]>)(
    "does not hide a stuck card behind %s",
    (_, patch) => {
      const row = card("stuck", { stage: "working", ...patch });
      expect(Activity.withoutThreadReason(row, { byId: new Map([[row.id, row]]), pools })).toBe(
        "none",
      );
    },
  );

  it.each([
    ["Run failed: timeout", "owner", "run_failed"],
    ["Reviewer stopped without a verdict", "system", "run_failed"],
    ["Reviewer stopped without a verdict", "owner", "flagged"],
    ["Review verdict refused: stale", "system", "verdict_refused"],
    ["Review verdict refused: stale", "owner", "flagged"],
    ["Stopped", "system", "flagged"],
  ] as const)("shares the stall category for %s by %s", (reason, actor, kind) => {
    const by =
      actor === "system"
        ? { _tag: "system" as const, component: "dispatcher" }
        : { _tag: "owner" as const };
    const row = card("stall", { stage: "working", stalled: flag(reason, by) });
    expect(Activity.withoutThreadReason(row, { byId: new Map(), pools })).toBe(`stalled:${kind}`);
  });

  it.each(["evaluator", "script"] as const)("reuses the %s-only step rule", (owner) => {
    const row = card(owner, { stage: "working", subtasks: [subtask(owner)] });
    expect(Activity.withoutThreadReason(row, { byId: new Map(), pools })).toBe("evaluator_step");
  });

  it("uses board pause keep lists and the current review model's paused pool", () => {
    const row = card("pause", { stage: "in_review" });
    const paused = {
      ...activityBoard,
      pause: { keep: [], reason: "Hold", by: "owner" as const, at: before },
    };
    const context = { byId: new Map(), pools, board: paused };
    expect(Activity.withoutThreadReason(row, context)).toBe("paused");
    expect(
      Activity.withoutThreadReason(row, {
        ...context,
        board: { ...paused, pause: { ...paused.pause, keep: [row.id] } },
      }),
    ).toBe("none");
    expect(
      Activity.withoutThreadReason(row, {
        ...context,
        board: activityBoard,
        pools: pools.map((pool) => ({ ...pool, slots: pool.model === sonnet ? 0 : pool.slots })),
      }),
    ).toBe("paused");
  });

  it("does not call a multi-model worker paused while an alternative pool is open", () => {
    const row = card("alternatives", {
      stage: "working",
      models: [
        { model: opus, weight: 2 },
        { model: sonnet, weight: 1 },
      ],
    });
    const context = {
      byId: new Map(),
      pools: pools.map((pool) => ({ ...pool, slots: pool.model === opus ? 0 : pool.slots })),
    };
    expect(Activity.withoutThreadReason(row, context)).toBe("none");
    expect(
      Activity.withoutThreadReason({ ...row, workThreadId: ThreadId.make("pinned") }, context),
    ).toBe("paused");
    expect(Activity.withoutThreadReason(row, { ...context, pools: [] })).toBe("none");
  });

  it.each(["completed", "deployed", "verified"] as const)(
    "follows the dispatcher's %s blocker settlement and pending merge rules",
    (stage) => {
      const dependency = { ...blocker, stage };
      const row = card("waiting", { stage: "working", blockedBy: [dependency.id] });
      const reason = (dep: KanbanCard) =>
        Activity.withoutThreadReason(row, { byId: new Map([[dep.id, dep]]), pools });
      expect(reason(dependency)).toBe("none");
      expect(
        reason({ ...dependency, subtasks: [subtask("evaluator", { text: "Merge into main" })] }),
      ).toBe(stage === "completed" ? "blocked" : "none");
    },
  );

  it("caps the unexplained list separately and preserves counts for omitted rows", () => {
    const parked = Array.from({ length: 170 }, (_, index) =>
      card(`parked${index}`, { number: index, stage: "working", wait: waitOn }),
    );
    const stuck = Array.from({ length: 170 }, (_, index) =>
      card(`stuck${index}`, { number: index + 200, stage: "in_review", movedAt: t("23:00") }),
    );
    const section = Activity.rollup({
      window,
      cards: [...parked, ...stuck],
      events: [],
      threads: [],
      pools,
    }).stages.withoutThread;
    expect(section.count).toBe(340);
    expect(section.byReason).toEqual({ "wait:ci": 170, none: 170 });
    expect(section.none.count).toBe(170);
    expect(section.none.items.length).toBeLessThan(170);
    expect(section.none.items.length + (section.none.more ?? 0)).toBe(170);
    expect(section.items.length + (section.more ?? 0)).toBe(340);
    expect(section.items.every((row) => row.reason === "none")).toBe(true);
    expect(section.none.items).toEqual(section.items);
  });
});
