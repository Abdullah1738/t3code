import { test } from "node:test";
import assert from "node:assert/strict";
import { percentiles } from "./metrics.ts";
import { compare } from "./compare.ts";
import type { Run } from "./metrics.ts";
const runs = (sha: string, value: number | null): Run[] =>
  Array.from({ length: 5 }, (_, repeat) => ({
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
  assert.equal(compare(runs("base", 100), runs("new", 90), budgets).budgetVerdict, "pass");
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
