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

test("event loop p99 budget is enforced independently of response latency", () => {
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
