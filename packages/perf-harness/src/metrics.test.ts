import { test } from "node:test";
import assert from "node:assert/strict";
import { percentiles } from "./metrics.ts";
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
    metrics: { latency: value },
    gaps: [],
  }));
test("nearest rank handles small samples and rejects invalid timings", () => {
  assert.equal(percentiles([5, 1, 3, 2, 4])?.p95, 5);
  assert.equal(percentiles([]), null);
  assert.throws(() => percentiles([NaN]));
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
      ["boards", "board", "discussion", "post", "move"].map((n) => [
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
      ["boards", "board", "discussion", "post", "move"].map((n) => [
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
