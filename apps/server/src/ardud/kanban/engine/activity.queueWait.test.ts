import { KanbanCardId, ThreadId, type KanbanCard } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";

import * as Activity from "./activity.ts";
import * as Rules from "./rules.ts";
import {
  BEFORE,
  at,
  crpkoShape,
  fixtureAsk,
  fixtureCard,
  fixtureEvent,
  fixtureInput,
  fixtureSlot,
  fixtureSpans,
  fixtureWait,
  keys,
  legacyPools,
  models,
  readinessBoundaryCount,
} from "./activity.queueWait.testkit.ts";

const totalWait = (queue: ReturnType<typeof Activity.rollup>["pools"]["queueWait"]) =>
  Object.values(queue)
    .flat()
    .filter((value): value is number => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);

const mixedInput = () => {
  const shared = ThreadId.make("detached-shared");
  const cards = [
    fixtureCard("ready"),
    fixtureCard("weighted-full", {
      models: [
        { model: models.secondary, weight: 2 },
        { model: models.primary, weight: 5 },
        { model: models.primary, weight: 1 },
        { model: models.disabled, weight: 20 },
      ],
    }),
    fixtureCard("weighted-free", {
      models: [
        { model: models.primary, weight: 5 },
        { model: models.free, weight: 1 },
      ],
    }),
    fixtureCard("disabled", { model: models.disabled }),
    fixtureCard("reusable", { workThreadId: ThreadId.make("primary-1") }),
    fixtureCard("fixed-route", {
      workThreadId: ThreadId.make("detached"),
      models: [{ model: models.free, weight: 10 }],
    }),
    fixtureCard("backlog", { priority: 5 }),
    fixtureCard("flag-events"),
    fixtureCard("flag-snapshot", {
      stalled: { at: at(0.75), by: { _tag: "owner" }, reason: "flag" },
    }),
    fixtureCard("wait-events"),
    fixtureCard("legacy-wait"),
    fixtureCard("wait-snapshot", { wait: fixtureWait(at(0.25), at(1.75)) }),
    fixtureCard("overlap-asks", {
      asks: [
        fixtureAsk("a", at(0.25), at(1.25)),
        fixtureAsk("b", at(0.75), at(1.5)),
        fixtureAsk("c", at(1.5), at(1.75)),
        fixtureAsk("nonblocking", BEFORE, null, false),
      ],
    }),
    fixtureCard("open-ask", { asks: [fixtureAsk("open", at(0.5), null)] }),
    fixtureCard("chain", { workThreadId: shared, blockedBy: [KanbanCardId.make("middle")] }),
    fixtureCard("middle", {
      stage: "working",
      workThreadId: shared,
      blockedBy: [KanbanCardId.make("root")],
    }),
    fixtureCard("root", { stage: "verified", settledAt: at(1.5), movedAt: at(1.5) }),
    fixtureCard("cycle-a", { workThreadId: shared, blockedBy: [KanbanCardId.make("cycle-b")] }),
    fixtureCard("cycle-b", { workThreadId: shared, blockedBy: [KanbanCardId.make("cycle-a")] }),
    fixtureCard("missing", { blockedBy: [KanbanCardId.make("absent")] }),
    fixtureCard("future-blocker", { blockedBy: [KanbanCardId.make("future")] }),
    fixtureCard("future", { stage: "working", createdAt: at(1.5), movedAt: at(1.5) }),
    fixtureCard("settled-blocker", { blockedBy: [KanbanCardId.make("settled")] }),
    fixtureCard("settled", { stage: "verified", settledAt: BEFORE }),
    fixtureCard("historical-todo", { stage: "working", movedAt: at(5) }),
    fixtureCard("historical-working", { stage: "todo", movedAt: at(5) }),
    fixtureCard("after-todo", { stage: "working", movedAt: at(5) }),
    fixtureCard("settled-inside", { stage: "verified", settledAt: at(1.5), movedAt: at(5) }),
    fixtureCard("retry", {
      retries: [
        {
          kind: "run_failed",
          role: "work",
          runId: "r1",
          reason: "failed",
          state: "waiting",
          at: at(0.5),
        },
        {
          kind: "run_failed",
          role: "work",
          runId: "r2",
          reason: "failed",
          state: "waiting",
          at: at(1.5),
        },
      ],
    }),
    fixtureCard("deciding", { deciding: { since: at(0.75), why: "Wait ended", toldAt: null } }),
  ].map((card, i) => ({ ...card, number: i + 1 }));
  return fixtureInput({
    cards,
    // Input order differs from both id and timestamp order.
    events: [
      fixtureEvent(103, "flag-events", at(1), "flagged", { body: "Cleared" }),
      fixtureEvent(101, "flag-events", at(0.5), "flagged", { body: "flag" }),
      fixtureEvent(102, "flag-events", at(1.5), "flagged", { body: "flag again" }),
      fixtureEvent(104, "flag-events", at(1), "flagged", { body: "flag at same time" }),
      fixtureEvent(105, "flag-events", at(1), "flagged", { body: "Cleared" }),
      fixtureEvent(106, "flag-snapshot", at(1.5), "review", { body: "clear" }),
      fixtureEvent(107, "wait-events", at(0.25), "wait_set"),
      fixtureEvent(108, "wait-events", at(1.25), "wait_cleared"),
      fixtureEvent(109, "legacy-wait", at(0.5), "edited", { body: "Waiting for CI" }),
      fixtureEvent(110, "legacy-wait", at(1.5), "edited", { body: "Wait ended: clear" }),
      fixtureEvent(111, "root", at(1.5), "moved", { fromStage: "working", toStage: "verified" }),
    ],
    readinessBefore: [
      fixtureEvent(1, "legacy-wait", BEFORE, "edited", { body: "Wait ended: clear" }),
      fixtureEvent(2, "flag-snapshot", BEFORE, "flagged", { body: "Cleared" }),
      fixtureEvent(3, "middle", BEFORE, "flagged", { body: "Cleared" }),
    ],
    prior: [
      fixtureEvent(4, "historical-todo", BEFORE, "moved", { toStage: "todo" }),
      fixtureEvent(5, "historical-working", BEFORE, "moved", { toStage: "working" }),
      fixtureEvent(6, "root", BEFORE, "moved", { toStage: "working" }),
      fixtureEvent(7, "settled-inside", BEFORE, "moved", { toStage: "todo" }),
    ],
    after: [
      fixtureEvent(200, "after-todo", at(5), "moved", { fromStage: "todo", toStage: "working" }),
    ],
  });
};

const expectLegacyEquality = (input: Activity.RollupInput) => {
  const expected = legacyPools(input);
  const actual = Activity.rollup(input).pools;
  expect(actual.queueWait).not.toHaveProperty("omitted");
  expect(actual).toEqual(expected);
  return actual;
};

const graphThread = ThreadId.make("detached-graph");
const graphInput = (cards: ReadonlyArray<KanbanCard>) =>
  fixtureInput({
    window: { since: at(0), until: at(1) },
    // Full board dispatch diagnostics have a separate recursive blocker walk.
    board: { archivedAt: null, setup: null, pause: null },
    dispatchCards: [],
    cards: cards.map((card, i) => ({
      ...card,
      number: i + 1,
      createdAt: at(0),
      movedAt: at(0),
      updatedAt: at(0),
    })),
    pools: [{ key: keys.primary, model: models.primary, slots: 1 }],
    slotHistory: {
      recordedSince: BEFORE,
      events: [fixtureSlot(1, "take", "unrelated-holder", BEFORE)],
    },
  });

const diamondCards = (layers: number): KanbanCard[] => {
  const id = (layer: number, branch: number) => KanbanCardId.make(`diamond-${layer}-${branch}`);
  return [
    fixtureCard("diamond-root", {
      workThreadId: graphThread,
      blockedBy: [id(0, 0), id(0, 1)],
    }),
    ...Array.from({ length: layers * 2 }, (_, i) => {
      const layer = Math.floor(i / 2);
      return fixtureCard(id(layer, i % 2), {
        workThreadId: graphThread,
        blockedBy: layer + 1 < layers ? [id(layer + 1, 0), id(layer + 1, 1)] : [],
      });
    }),
  ];
};

describe("#1875 queue wait replay", () => {
  it("matches the independent legacy ledger across mixed readiness and routing history", () => {
    expect(totalWait(expectLegacyEquality(mixedInput()).queueWait)).toBeGreaterThan(0);
  });

  it.each(["late coverage", "partial window", "no coverage", "paused", "archived", "free pools"])(
    "matches the legacy ledger with %s",
    (variant) => {
      const input = mixedInput();
      const slots = input.slotHistory!;
      const patch: Partial<Activity.RollupInput> =
        variant === "late coverage"
          ? { slotHistory: { ...slots, recordedSince: at(1.25) } }
          : variant === "partial window"
            ? { window: { since: at(0.25), until: at(3.75) } }
            : variant === "no coverage"
              ? { slotHistory: { ...slots, recordedSince: null } }
              : variant === "paused"
                ? {
                    board: {
                      archivedAt: null,
                      setup: null,
                      pause: {
                        keep: [input.cards[0]!.id],
                        reason: "Hold",
                        by: "owner",
                        at: BEFORE,
                      },
                    },
                  }
                : variant === "archived"
                  ? { board: { archivedAt: BEFORE, setup: null, pause: null } }
                  : { slotHistory: { ...slots, events: [] } };
      const result = expectLegacyEquality({ ...input, ...patch });
      if (variant === "no coverage" || variant === "archived" || variant === "free pools")
        expect(result.queueWait).toEqual({});
    },
  );

  it("keeps event-id precedence for tied and out-of-order flag timestamps", () => {
    const input = fixtureInput({
      cards: [fixtureCard("flags")],
      events: [
        fixtureEvent(4, "flags", at(1.5), "flagged", { body: "Cleared" }),
        fixtureEvent(2, "flags", at(0.5), "flagged", { body: "Cleared" }),
        fixtureEvent(3, "flags", at(1.5), "flagged", { body: "flag at tie" }),
        fixtureEvent(1, "flags", at(1), "flagged", { body: "flag at later time, earlier id" }),
      ],
    });
    expect(expectLegacyEquality(input).queueWait).toEqual({ [keys.primary]: [1, 1, 0, 1] });
  });

  it("splits on retry backoff ends and deciding expiry with overlapping owner asks", () => {
    const retry: NonNullable<KanbanCard["retries"]>[number] = {
      kind: "run_failed",
      role: "work",
      runId: "retry",
      reason: "failed",
      state: "waiting",
      at: at(0.5),
    };
    const input = fixtureInput({
      cards: [
        fixtureCard("retry", { retries: [retry] }),
        fixtureCard("deciding", { deciding: { since: at(0.75), why: "Wait ended", toldAt: null } }),
        fixtureCard("asks", {
          asks: [
            fixtureAsk("one", at(0.25), at(1.25)),
            fixtureAsk("two", at(0.75), at(1.5)),
            fixtureAsk("adjacent", at(1.5), at(1.75)),
            fixtureAsk("async", BEFORE, null, false),
          ],
        }),
      ],
    });
    // Retry holds one minute; deciding holds half an hour; the asks form one 90-minute interval.
    expect(expectLegacyEquality(input).queueWait).toEqual({ [keys.primary]: [1.98, 2, 0, 3] });
  });

  it("preserves slot-id order when ties and earlier timestamps follow a release", () => {
    const input = fixtureInput({
      cards: [fixtureCard("ready")],
      slotHistory: {
        recordedSince: BEFORE,
        events: [
          fixtureSlot(5, "take", "primary-2", at(1.5)),
          fixtureSlot(3, "release", "primary-2", at(1)),
          fixtureSlot(1, "take", "primary-1", BEFORE),
          fixtureSlot(6, "release", "primary-2", at(0.75)),
          fixtureSlot(2, "take", "primary-2", BEFORE),
          fixtureSlot(4, "take", "primary-2", at(1)),
        ],
      },
    });
    expect(expectLegacyEquality(input).queueWait).toEqual({ [keys.primary]: [1, 0.5, 0, 0] });
  });

  it.each([899, 900])(
    "omits only queue wait when its clock reaches the 900ms budget (%dms)",
    (elapsed) => {
      const input = fixtureInput({
        cards: Array.from({ length: 80 }, (_, i) => fixtureCard(`budget-${i}`, { number: i + 1 })),
      });
      const expected = legacyPools(input);
      const clock = vi.spyOn(performance, "now").mockReturnValue(100 + elapsed);
      clock.mockReturnValueOnce(100);
      try {
        const result = Activity.rollup(input).pools;
        expect(clock.mock.calls.length).toBeGreaterThan(1);
        expect(result).toEqual({
          ...expected,
          queueWait: elapsed >= 900 ? { omitted: "budget" } : expected.queueWait,
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["clear", "cycle", "blocked leaf", "stalled leaf"] as const)(
    "matches the legacy ledger on a five-layer diamond with %s",
    (variant) => {
      const cards = diamondCards(5);
      const leafIndex = cards.length - 2;
      const leaf = cards[leafIndex]!;
      if (variant === "cycle") cards[leafIndex] = { ...leaf, blockedBy: [cards[0]!.id] };
      else if (variant === "blocked leaf")
        cards[leafIndex] = { ...leaf, workThreadId: ThreadId.make("other-worker") };
      else if (variant === "stalled leaf")
        cards[leafIndex] = {
          ...leaf,
          stalled: { at: BEFORE, by: { _tag: "owner" }, reason: "Blocked" },
        };
      const result = expectLegacyEquality(graphInput(cards));
      const ready = variant === "clear" ? cards.length : variant === "blocked leaf" ? 2 : 1;
      expect(result.queueWait).toEqual({ [keys.primary]: [ready] });
    },
  );

  it("rolls up a clear 35-layer diamond in under 1000ms without omitting queue wait", () => {
    const cards = diamondCards(35);
    const input = graphInput(cards);
    const started = performance.now();
    const result = Activity.rollup(input);
    const elapsed = performance.now() - started;
    expect(result.pools.queueWait).not.toHaveProperty("omitted");
    expect(result.pools.queueWait).toEqual({ [keys.primary]: [cards.length] });
    expect(totalWait(result.pools.queueWait)).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("replays a 12000-deep same-thread blocker chain without overflowing the stack", () => {
    const depth = 12_000;
    const root = fixtureCard("chain-root", {
      workThreadId: graphThread,
      blockedBy: [KanbanCardId.make("chain-0")],
    });
    const blockers = Array.from({ length: depth }, (_, i) =>
      fixtureCard(`chain-${i}`, {
        stage: "working",
        workThreadId: graphThread,
        // Keep these out of idle-card diagnostics, which use the canonical recursive walk.
        activeThreadId: graphThread,
        activeRole: "work",
        activePool: keys.primary,
        blockedBy: i + 1 < depth ? [KanbanCardId.make(`chain-${i + 1}`)] : [],
      }),
    );
    const input = graphInput([root, ...blockers]);
    expect(fixtureSpans(input).filter((span) => span.stage === "todo")).toHaveLength(1);
    const result = Activity.rollup(input);
    expect(result.pools.queueWait).toEqual({ [keys.primary]: [1] });
  });

  it("enforces the budget within one blocker walk with two spans and many edges", () => {
    const leaf = fixtureCard("budget-leaf", { workThreadId: graphThread });
    const root = fixtureCard("budget-root", {
      workThreadId: graphThread,
      blockedBy: Array.from({ length: 512 }, () => leaf.id),
    });
    const input = graphInput([root, leaf]);
    const expected = legacyPools(input);
    expect(fixtureSpans(input)).toHaveLength(2);
    let elapsed = 0;
    const cardFlow = Rules.cardFlow;
    const flow = vi.spyOn(Rules, "cardFlow").mockImplementation((...args) => {
      const result = cardFlow(...args);
      // Collection has finished; the first root's blocker walk must enforce the new deadline.
      elapsed = 900;
      return result;
    });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    try {
      const result = Activity.rollup(input).pools;
      expect(flow).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ...expected, queueWait: { omitted: "budget" } });
    } finally {
      clock.mockRestore();
      flow.mockRestore();
    }
  });

  it.effect("rolls up the Crpko 24-hour shape in under 1000ms without omitting queue wait", () =>
    Effect.gen(function* () {
      const input = crpkoShape();
      expect(input.cards).toHaveLength(4_728);
      expect(input.events).toHaveLength(6_224);
      expect(input.readinessBefore).toHaveLength(5_465);
      expect(fixtureSpans(input).filter((span) => span.stage === "todo")).toHaveLength(1_335);
      expect(readinessBoundaryCount(input)).toBe(4_835);
      const started = performance.now();
      const result = Activity.rollup(input);
      const elapsed = performance.now() - started;
      yield* Console.log(
        `#1875 Crpko rollup: ${elapsed.toFixed(2)}ms; 4728 cards, 1335 todo spans, 4835 boundaries, 6224 events, 5465 readinessBefore`,
      ).pipe(Effect.provideService(Console.Console, globalThis.console));
      expect(result.pools.queueWait).not.toHaveProperty("omitted");
      expect(totalWait(result.pools.queueWait)).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1_000);
    }),
  );

  it.effect.skipIf(process.env.QUEUE_WAIT_LEGACY_BENCHMARK !== "1")(
    "benchmarks the full legacy Crpko shape offbox and matches the optimized result",
    () =>
      Effect.gen(function* () {
        expect(
          process.env.OFFBOX_RUN_ID,
          "Full legacy benchmark must run through offbox --no-fallback",
        ).toBeTruthy();
        const input = crpkoShape();
        const started = performance.now();
        const expected = legacyPools(input);
        const elapsed = performance.now() - started;
        yield* Console.log(
          `#1875 legacy b6990f1f6ee6 Crpko ledger: ${elapsed.toFixed(2)}ms; 4728 cards, 1335 todo spans, 4835 boundaries, 6224 events, 5465 readinessBefore`,
        ).pipe(Effect.provideService(Console.Console, globalThis.console));
        expect(totalWait(expected.queueWait)).toBeGreaterThan(0);
        const actual = Activity.rollup(input).pools;
        expect(actual.queueWait).not.toHaveProperty("omitted");
        expect(actual).toEqual(expected);
      }),
    20 * 60_000,
  );
});
