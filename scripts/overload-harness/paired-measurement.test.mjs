import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import { instrumentHarness, instrumentSqlite, makeMeasurement } from "./paired-measurement.mjs";

const clock = () => {
  let time = 0;
  const measurement = makeMeasurement({
    now: () => time,
    wallNow: () => 1794610000000 + time,
    elu: () => ({ active: time / 4, idle: (time * 3) / 4 }),
  });
  return {
    measurement,
    advance: (ms) => {
      time += ms;
    },
    time: () => time,
  };
};
const parent = {
  _tag: "Span",
  name: "KanbanStore.write",
  attributes: new Map([["kanban.operation", "put card"]]),
  parent: { _tag: "None" },
};

describe("paired measurement", () => {
  it("times each native invocation exactly once by statement and caller, including failure", () => {
    const c = clock();
    const sql = "UPDATE cards SET data = ? WHERE id = ?";
    c.measurement.native(sql, "run", parent, () => c.advance(99));
    c.measurement.start(c.time());
    expect(
      c.measurement.native(sql, "run", parent, () => {
        c.advance(4);
        return 23;
      }),
    ).toBe(23);
    expect(() =>
      c.measurement.native(sql, "run", parent, () => {
        c.advance(7);
        throw new Error("synthetic");
      }),
    ).toThrow("synthetic");
    const rows = c.measurement.snapshot().statements;
    expect(rows).toHaveLength(1);
    expect(rows[0].caller).toBe("KanbanStore.write:put card");
    expect(rows[0].samples.map((x) => [x.durationMs, x.success])).toEqual([
      [4, true],
      [7, false],
    ]);
    expect(rows[0].sql).toBe(sql);
  });
  it("retains worker execution separately and excludes warm-up and final in-flight completions", () => {
    const c = clock();
    const warm = c.measurement.capture();
    c.measurement.start(0);
    c.measurement.reader("SELECT id FROM cards", parent, 9, warm, { rows: [] });
    const offered = c.measurement.capture();
    c.measurement.reader("SELECT id FROM cards", parent, 3, offered, { rows: [] });
    c.measurement.stop(0);
    c.measurement.reader("SELECT id FROM cards", parent, 15, offered, { rows: [] });
    expect(c.measurement.snapshot().statements[0].samples).toEqual([
      { seconds: 0, durationMs: 3, success: true },
    ]);
  });
  it.each([
    ["cancelled-before-start", { error: { notStarted: true } }, "cancelled-before-start"],
    [
      "requeued",
      { overloadSynthetic: "requeue-before-start", error: { notStarted: true } },
      "requeue-before-start",
    ],
    ["cleanup", { overloadSynthetic: "transaction-cleanup", rows: [] }, "transaction-cleanup"],
    [
      "retired after start",
      { overloadSynthetic: "worker-retired-after-start", error: {} },
      "worker-retired-after-start",
    ],
    ["missing emitted timing", { rows: [] }, "missing-worker-execution-timing"],
  ])("never counts %s as a completed worker execution", (_, reply, reason) => {
    const c = clock();
    c.measurement.start(0);
    const offered = c.measurement.capture();
    c.measurement.reader("SELECT id FROM cards", parent, undefined, offered, reply);
    expect(c.measurement.snapshot().statements).toEqual([]);
    expect(c.measurement.snapshot().nonExecutionReplies[0].reason).toBe(reason);
    c.measurement.reader("SELECT id FROM cards", parent, 3, offered, { rows: [] });
    expect(c.measurement.snapshot().statements[0].samples).toHaveLength(1);
  });
  it("counts a worker execution that ran and failed, with its real duration", () => {
    const c = clock();
    c.measurement.start(0);
    c.measurement.reader("SELECT id FROM cards", parent, 7, c.measurement.capture(), {
      error: { operation: "execute" },
    });
    expect(c.measurement.snapshot().statements[0].samples).toEqual([
      { seconds: 0, durationMs: 7, success: false },
    ]);
  });
  it("retains warning text and distinguishes warm-up from the measured window", () => {
    const c = clock();
    c.measurement.warning(
      { logLevel: "Warn", message: ["Slow EventSink transaction", { ms: 6000n }] },
      false,
    );
    c.measurement.start(0);
    c.measurement.warning({ logLevel: "Warn", message: "kanban tick step skipped" }, true);
    c.measurement.warning({ logLevel: "Info", message: "irrelevant" }, true);
    const warnings = c.measurement.snapshot().warnings;
    expect(warnings).toHaveLength(2);
    expect(warnings[0].text).toContain("6000n");
    expect(warnings.map((x) => x.steady)).toEqual([false, true]);
    expect(() => JSON.stringify(c.measurement.snapshot())).not.toThrow();
  });
  it("retains cumulative ELU for intervals including a delayed probe and the final boundary", () => {
    const c = clock();
    c.measurement.start(0);
    c.advance(100);
    c.measurement.interval(c.time());
    c.advance(900);
    c.measurement.interval(c.time());
    c.advance(14000);
    c.measurement.interval(c.time());
    c.advance(200);
    c.measurement.stop(c.time());
    expect(
      c.measurement.snapshot().intervals.map((x) => [x.seconds, x.activeMs, x.idleMs]),
    ).toEqual([
      [0, 0, 0],
      [1, 250, 750],
      [15, 3750, 11250],
      [15.2, 3800, 11400],
    ]);
  });
  it("instruments the frozen harness without moving or duplicating the lag finalizer", async () => {
    const source = await NodeFSP.readFile(
      new URL("../../apps/server/scripts/overload-harness.ts", import.meta.url),
      "utf8",
    );
    const patched = instrumentHarness(source);
    expect(patched.match(/lag.disable\(\)/g)).toHaveLength(1);
    expect(patched).toContain("Statement.SpanPropagationEnabled, true");
    expect(patched).toContain("warning(options, measuring)");
    expect(patched).toContain("pairedMeasurement:");
  });
  it("fails closed on drifted measurement boundaries", () => {
    expect(() => instrumentHarness("wrong source")).toThrow("no longer matches");
    expect(() => instrumentSqlite("wrong source")).toThrow("no longer matches");
  });
});

it("records both actual DB identities outside steady ELU boundaries", () => {
  let now = 100;
  const paths = { statev2: "/fixture/statev2.sqlite", boards: "/fixture/boards.sqlite" };
  const observed = [];
  const m = makeMeasurement({
    now: () => now,
    wallNow: () => now,
    elu: () => ({ active: 0, idle: now }),
    filesystemSnapshot: (p) => {
      observed.push(p);
      now += 2;
      return Object.entries(p).map(([name, path]) => ({ name, path }));
    },
  });
  m.filesystems(paths, "start");
  m.start(now);
  now += 600000;
  m.stop(now);
  m.filesystems(paths, "end");
  const result = m.snapshot();
  expect(observed).toEqual([paths, paths]);
  expect(result.version).toBe(3);
  expect(result.filesystems.map((x) => [x.boundary, x.beforeEpochMs, x.afterEpochMs])).toEqual([
    ["start", 100, 102],
    ["end", 600102, 600104],
  ]);
  expect(result.intervals.at(-1).idleMs).toBe(600000);
});
