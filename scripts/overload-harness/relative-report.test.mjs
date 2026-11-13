import { describe, expect, it } from "vite-plus/test";
import { baseMean, relativeFailures, selectReference } from "./relative-report.mjs";
const make = (i, values = {}) => ({
  offboxRunId: i === 0 ? "run-1114-000117-d5e7" : `run-${i}`,
  offboxBoxId: `box-${i}`,
  offboxBoxSize: "xlarge",
  conditions: { verified: true, coLoads: [] },
  wallMs: 600000,
  busy: 0.2,
  gcMs: 12000,
  delayMs: { p99: 25, max: 200 },
  physical: { openCardRows: 600000 },
  cacheBefore: { discussion: { misses: 0 } },
  cacheAfter: { discussion: { misses: 60000 } },
  logical: {
    "offered:events": 100,
    "completed:commands": 80,
    "persisted:events": 100,
    tickSteps: 6000,
    dispatchDecisions: 0,
  },
  resultSizes: { cards: 3900, asks: 44 },
  backlog: [{ pending: 0, outbox: 0, dispatcher: 0 }],
  backlogSlopes: { pending: 0, outbox: 0, dispatcher: 0 },
  stalls: [],
  ...values,
});
const better = () =>
  make(3, {
    busy: 0.15,
    gcMs: 9000,
    delayMs: { p99: 20, max: 200 },
    physical: { openCardRows: 500000 },
    cacheAfter: { discussion: { misses: 50000 } },
  });
describe("relative .11 line", () => {
  it("uses the arithmetic mean and inclusive busy/p99 boundaries", () => {
    const mean = baseMean([make(0, { busy: 0.1 }), make(1), make(2, { busy: 0.3 })]);
    expect(mean.busy).toBeCloseTo(0.2);
    expect(relativeFailures(better(), mean)).toEqual([]);
    expect(
      relativeFailures(
        { ...better(), busy: mean.busy, delayMs: { p99: mean.p99, max: 200 } },
        mean,
      ),
    ).toEqual([]);
  });
  it.each([
    ["busy", (r) => ({ ...r, busy: 0.21 }), "main-thread busy"],
    ["lag", (r) => ({ ...r, delayMs: { p99: 26, max: 200 } }), "event-loop p99"],
    ["hard lag ceiling", (r) => ({ ...r, delayMs: { p99: 101, max: 200 } }), "event-loop p99"],
    ["histogram stall", (r) => ({ ...r, delayMs: { p99: 20, max: 1000 } }), "stall"],
    ["GC did not fall", (r) => ({ ...r, gcMs: 12000 }), "#1343"],
    ["card reads did not fall", (r) => ({ ...r, physical: { openCardRows: 600000 } }), "#1342"],
    [
      "discussion misses did not fall",
      (r) => ({ ...r, cacheAfter: { discussion: { misses: 60000 } } }),
      "#1341",
    ],
    [
      "dropped work",
      (r) => ({ ...r, logical: { ...r.logical, "persisted:events": 89 } }),
      "logical work",
    ],
    ["missing work", (r) => ({ ...r, logical: {} }), "logical work"],
    [
      "changed result size",
      (r) => ({ ...r, resultSizes: { cards: 3899, asks: 44 } }),
      "logical result size",
    ],
    [
      "end backlog",
      (r) => ({ ...r, backlog: [{ pending: 1, outbox: 0, dispatcher: 0 }] }),
      "pending backlog",
    ],
    [
      "rising outbox",
      (r) => ({ ...r, backlogSlopes: { pending: 0, outbox: 0.001, dispatcher: 0 } }),
      "outbox backlog",
    ],
  ])("rejects %s", (_, change, reason) =>
    expect(
      relativeFailures(change(better()), baseMean([make(0), make(1), make(2)])).some((x) =>
        x.includes(reason),
      ),
    ).toBe(true),
  );
  it("uses3 bases only for five separate idle boxes", () => {
    const bases = [make(0), make(1), make(2)],
      candidates = [make(3), make(4), make(5)];
    expect(selectReference(bases, candidates).selected).toHaveLength(3);
    candidates[1].offboxBoxId = candidates[0].offboxBoxId;
    expect(selectReference(bases, candidates).selected).toHaveLength(2);
  });
  it("falls back for co-load and reports >10% harness noise", () => {
    const bases = [make(0), make(1, { busy: 0.23, gcMs: 14000 }), make(2)],
      candidates = [make(3), make(4), make(5)];
    candidates[0].conditions.coLoads = [{ runId: "other" }];
    const result = selectReference(bases, candidates);
    expect(result.selected.map((r) => r.offboxRunId)).toEqual(["run-1", "run-2"]);
    expect(result.noise.map((x) => x.metric)).toEqual(["busy", "GC ms/min"]);
  });
});
