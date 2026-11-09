import { test } from "node:test";
import assert from "node:assert/strict";
import { percentiles, phaseMetrics } from "./metrics.ts";
import { compare, median, pairedBootstrap } from "./compare.ts";
import type { Run } from "./metrics.ts";
const runs = (sha: string, value: number | null): Run[] =>
  Array.from({ length: 10 }, (_, repeat) => ({
    gateVersion: "paired-bootstrap-v2",
    sha,
    repeat,
    fixtureHash: "f",
    runtimeHash: "r",
    hardwareHash: "h",
    seed: 42,
    agents: 32,
    scale: "1x",
    correctness: "pass",
    ownerAnswers: { workload: "owner-writes-v3", rpcAnswers: 40, consumedAsks: 40, routedAsks: 40, launchedEvaluators: 10, mockProvider: "acp-local", mockDelivered: 40, liveDelivery: "unmeasured" },
    ownerMessagePosts: { workload: "owner-writes-v3", rpcPosts: 40, persistedPosts: 40, consumedAsks: 40, routedPosts: 40, launchedEvaluators: 10, mockProvider: "acp-local", mockDelivered: 40, liveDelivery: "unmeasured" },
    metrics: { latency: value },
    gaps: [],
  }));
test("nearest rank handles small samples and rejects invalid timings", () => {
  assert.equal(percentiles([5, 1, 3, 2, 4])?.p95, 5);
  assert.equal(percentiles([]), null);
  assert.throws(() => percentiles([NaN]));
});
test("Kanban serial admission waits stay separate from total span duration", () => {
  const phases = phaseMetrics([
    { name: "KanbanService.serial", spanId: "r", durationMs: 200,
      attributes: { "serial.queue": "routing", "serial.key": "discussion-1", "serial.wait_ms": 15 } },
    { name: "KanbanService.serial", spanId: "e", durationMs: 900,
      attributes: { "serial.queue": "evaluating", "serial.key": "board-0:discussion-1", "serial.wait_ms": 30 } },
  ]);
  assert.equal(phases.kanbanRoutingAdmission?.p95, 15);
  assert.equal(phases.kanbanEvaluatingAdmission?.p95, 30);
  assert.equal(phaseMetrics([]).kanbanRoutingAdmission, null);
});
test("missing metrics cannot pass; regressions fail even within an absolute budget", () => {
  const budgets = { metrics: { latency: { max: 200 } } };
  assert.equal(compare(runs("base", 100), runs("new", 111), budgets).budgetVerdict, "fail");
  assert.equal(compare(runs("base", 100), runs("new", null), budgets).budgetVerdict, "incomplete");
  assert.equal(compare(runs("base", 100), runs("new", 90), budgets).budgetVerdict, "incomplete");
});
test("mismatched hardware or duplicate repeats are rejected", () => {
  const b = runs("new", 90);
  b[0]!.hardwareHash = "different";
  assert.throws(() => compare(runs("base", 100), b, { metrics: {} }));
  const c = runs("new", 90);
  c[0]!.repeat = 1;
  assert.throws(() => compare(runs("base", 100), c, { metrics: {} }));
});

test("rejects mixed artifacts under one revision", () => {
  const candidate = runs("candidate", 90);
  candidate[0]!.serverHash = "different";
  assert.throws(() => compare(runs("base", 100), candidate, { metrics: {} }));
});

test("event loop p99 regression is checked independently of response latency", () => {
  const base = runs("base", 10),
    candidate = runs("new", 10);
  for (const run of base) run.metrics["eventLoop.p99.ms"] = 40;
  for (const run of candidate) run.metrics["eventLoop.p99.ms"] = 51;
  assert.equal(
    compare(base, candidate, { metrics: { "eventLoop.p99.ms": { max: 50 } } }).budgetVerdict,
    "fail",
  );
});

test("attribution burst runs cannot satisfy acceptance", () => {
  const base = runs("base", 10),
    candidate = runs("new", 10);
  candidate[0]!.workloadMode = "legacy-burst";
  assert.throws(() => compare(base, candidate, { metrics: {} }), /Attribution-only/);
});

test("a single noisy maximum does not fail the median gate", () => {
  const b = runs("new", 100);
  b[9]!.metrics.latency = 10000;
  assert.partialDeepStrictEqual(compare(runs("base", 100), b, { metrics: {} }), {
    metrics: { latency: { verdict: "pass", ratio: 1 } },
  });
});
test("a real twenty percent shift fails", () => {
  assert.equal(
    compare(runs("base", 100), runs("new", 120), { metrics: {} }).performanceVerdict,
    "fail",
  );
});
test("paired bootstrap preserves pairs and pooled tails", () => {
  const a = runs("base", 100),
    b = runs("new", 100);
  a.forEach((r) => (r.requests = { latency: Array(40).fill(100) }));
  b.forEach((r) => (r.requests = { latency: Array(40).fill(140) }));
  assert.equal(compare(a, b, { metrics: {} }).performanceVerdict, "fail");
  assert.throws(() => compare(a.slice(0, 5), b.slice(0, 5), { metrics: {} }, 5), /at least 10/);
  b[0]!.repeat = 100;
  assert.throws(() => compare(a, b, { metrics: {} }), /Unmatched/);
});
test("event loop fails on a significant increase below ten percent", () => {
  const a = runs("base", 100),
    b = runs("new", 100);
  a.forEach((r) => (r.metrics["eventLoop.p99.ms"] = 10));
  b.forEach((r) => (r.metrics["eventLoop.p99.ms"] = 10.5));
  assert.equal(compare(a, b, { metrics: {} }).performanceVerdict, "fail");
});
test("WAL high-water and absolute budgets remain informational", () => {
  const a = runs("base", 100),
    b = runs("new", 100);
  a.forEach((r) => (r.metrics["wal.bytes"] = 100));
  b.forEach((r) => (r.metrics["wal.bytes"] = 1000));
  assert.equal(
    compare(a, b, { metrics: { latency: { max: 50 } } }).performanceVerdict,
    "incomplete",
  );
});

test("median averages the middle observations and bootstrap keeps correlation", () => {
  assert.equal(median([1000, 4, 2, 6]), 5);
  assert.throws(() => median([]));
  const a = Array.from({ length: 10 }, (_, i) => [10 ** (i / 2)]);
  const stats = pairedBootstrap(
    a,
    a.map((r) => [r[0]! * 1.2]),
  );
  assert.ok(Math.abs(stats.ratio - 1.2) < 1e-10);
  stats.ci95.forEach((v) => assert.ok(Math.abs(v - 1.2) < 1e-10));
});

test("twenty percent tail change respects pooled twenty-five percent threshold", () => {
  const a = runs("base", 100),
    b = runs("new", 100);
  for (const r of [...a, ...b])
    r.requests = Object.fromEntries(
      ["boards", "board", "discussion", "post", "move", "answer", "messagePost"].map((n) => [
        n + ".response.ms",
        Array(40).fill(100),
      ]),
    );
  b.forEach((r) => {
    r.requests!["boards.response.ms"] = Array.from({ length: 40 }, (_, i) => (i < 36 ? 100 : 120));
    r.metrics["boards.response.ms.p95"] = 120;
  });
  a.forEach((r) => (r.metrics["boards.response.ms.p95"] = 100));
  assert.partialDeepStrictEqual(compare(a, b, { metrics: {} }), {
    tails: { "boards.response.ms": { verdict: "pass" } },
  });
  b[0]!.requests!["boards.response.ms"] = [100];
  assert.equal(compare(a, b, { metrics: {} }).performanceVerdict, "incomplete");
});

test("complete relative evidence stays separate from native correctness gaps", () => {
  const a = runs("base", 100),
    b = runs("new", 100);
  for (const r of [...a, ...b]) {
    r.requests = Object.fromEntries(
      ["boards", "board", "discussion", "post", "move", "answer", "messagePost"].map((n) => [
        n + ".response.ms",
        Array(40).fill(100),
      ]),
    );
    Object.assign(r.metrics, Object.fromEntries(Object.keys(r.requests).map((k) => [k, 100])), {
      "eventLoop.p99.ms": 10,
      "eventLoop.max.ms": 20,
      "wal.writeBytesPerOp": 100,
    });
  }
  const result = compare(a, b, { metrics: { "native.paint.ms": { max: 16 } } });
  assert.equal(result.performanceVerdict, "pass");
  assert.equal(result.budgetVerdict, "incomplete");
});

test("source artifact identity follows the entry checkout and runtime manifests", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { artifactHash } = await import("./metrics.ts");
  const temp = mkdtempSync(join(tmpdir(), "source-hash-"));
  try {
    const entries = ["one", "two"].map((name) => {
      const root = join(temp, name);
      mkdirSync(join(root, "apps/server/src"), { recursive: true });
      mkdirSync(join(root, "packages"));
      for (const file of [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "apps/server/package.json",
      ])
        writeFileSync(join(root, file), "{}");
      const entry = join(root, "apps/server/src/bin.ts");
      writeFileSync(entry, "export const value = 1;");
      writeFileSync(join(root, "apps/server/src/other.ts"), "export const value = 1;");
      return { root, entry };
    });
    const first = await artifactHash(entries[0]!.entry);
    assert.equal(first, await artifactHash(entries[1]!.entry));
    writeFileSync(entries[1]!.entry, "export const value = 2;");
    assert.notEqual(first, await artifactHash(entries[1]!.entry));
    assert.equal(first, await artifactHash(entries[0]!.entry));
    writeFileSync(join(entries[0]!.root, "apps/server/package.json"), '{"version":"changed"}');
    assert.notEqual(first, await artifactHash(entries[0]!.entry));
    assert.notEqual(
      await artifactHash(entries[0]!.entry),
      await artifactHash(join(entries[0]!.root, "apps/server/src/other.ts")),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("request p50 companions are informational while primary p95 and pooled p99 stay gated", () => {
  const base = runs("base", 100),
    candidate = runs("candidate", 100);
  for (const [group, low] of [
    [base, 10],
    [candidate, 20],
  ] as const) {
    for (const run of group) {
      const values = [...Array(21).fill(low), ...Array(19).fill(100)];
      const summary = percentiles(values)!;
      run.metrics["auth.response.ms"] = summary.p95;
      run.metrics["auth.response.ms.p50"] = summary.p50;
      run.requests = { "auth.response.ms": values };
    }
  }
  const result = compare(base, candidate, { metrics: {} });
  assert.partialDeepStrictEqual(result, {
    metrics: {
      "auth.response.ms": { verdict: "pass", ratio: 1 },
      "auth.response.ms.p50": { verdict: "info", ratio: 2 },
    },
    tails: { "auth.response.ms": { verdict: "pass", ratio: 1 } },
  });
  candidate.forEach((run) => {
    run.metrics["auth.response.ms"] = 120;
  });
  assert.partialDeepStrictEqual(compare(base, candidate, { metrics: {} }), {
    metrics: { "auth.response.ms": { verdict: "fail", ratio: 1.2 } },
  });
});
