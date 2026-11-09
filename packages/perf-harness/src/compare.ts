// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { percentiles, type Run } from "./metrics.ts";
export const gateVersion = "paired-bootstrap-v2";
export function median(values: readonly number[]) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0))
    throw new Error("Invalid samples");
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2;
}
const ratio = (a: number, b: number) => (a === 0 ? (b === 0 ? 1 : Infinity) : b / a);
// Resample whole matched runs, retaining A/B pairing and within-run dependence.
export function pairedBootstrap(
  a: readonly number[][],
  b: readonly number[][],
  statistic: (runs: readonly number[][]) => number = (runs) => median(runs.map((r) => r[0]!)),
  iterations = 10000,
) {
  if (
    a.length < 10 ||
    a.length !== b.length ||
    a.some((r) => !r.length) ||
    b.some((r) => !r.length)
  )
    throw new Error("Expected at least 10 complete pairs");
  a.forEach((r) => median(r));
  b.forEach((r) => median(r));
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const ids = Array.from({ length: a.length }, () => Math.floor(random() * a.length));
    draws.push(ratio(statistic(ids.map((j) => a[j]!)), statistic(ids.map((j) => b[j]!))));
  }
  draws.sort((x, y) => x - y);
  return {
    ratio: ratio(statistic(a), statistic(b)),
    ci95: [draws[Math.floor(iterations * 0.025)]!, draws[Math.ceil(iterations * 0.975) - 1]!] as [
      number,
      number,
    ],
  };
}
export function compare(
  base: Run[],
  candidate: Run[],
  budgets: { metrics: Record<string, { max: number }> },
  repeats = base.length,
) {
  if (base.length !== repeats || candidate.length !== repeats)
    throw new Error(`Expected ${repeats} repeats per revision`);
  if (repeats < 10) throw new Error("Expected at least 10 pairs");
  base = [...base].sort((a, b) => a.repeat - b.repeat);
  candidate = [...candidate].sort((a, b) => a.repeat - b.repeat);
  if (base.some((r, i) => r.repeat !== candidate[i]!.repeat)) throw new Error("Unmatched pairs");
  const first = base[0]!;
  for (const runs of [base, candidate]) {
    for (const r of runs) {
      if (r.gateVersion !== gateVersion) throw new Error("Incompatible gate version");
      if (r.workloadMode === "legacy-burst")
        throw new Error("Attribution-only workload cannot pass acceptance");
      for (const key of [
        "fixtureHash",
        "harnessHash",
        "runtimeHash",
        "hardwareHash",
        "seed",
        "agents",
        "scale",
      ] as const)
        if (r[key] !== first[key]) throw new Error(`Incomparable ${key}`);
      if (r.serverHash !== runs[0]!.serverHash) throw new Error("Mixed server artifacts");
      if (r.sha !== runs[0]!.sha) throw new Error("Mixed revisions");
    }
    if (new Set(runs.map((r) => r.repeat)).size !== repeats) throw new Error("Duplicate repeat");
  }
  const metrics: Record<string, unknown> = {};
  const requiredRequests = ["boards", "board", "discussion", "post", "move"].map(
    (name) => name + ".response.ms",
  );
  const requiredScalars = [
    ...requiredRequests,
    "eventLoop.p99.ms",
    "eventLoop.max.ms",
    "wal.writeBytesPerOp",
  ];
  let fail = false,
    missing = false,
    relativeMissing = false;
  for (const key of new Set([
    ...requiredScalars,
    ...Object.keys(budgets.metrics),
    ...base.flatMap((r) => Object.keys(r.metrics)),
    ...candidate.flatMap((r) => Object.keys(r.metrics)),
  ])) {
    const collect = (runs: Run[]) =>
      runs.map((r) => r.metrics[key]).filter((v): v is number => typeof v === "number");
    const a = collect(base),
      b = collect(candidate);
    if (a.length !== repeats || b.length !== repeats) {
      metrics[key] = { status: "unmeasured" };
      missing = true;
      relativeMissing ||= requiredScalars.includes(key);
      continue;
    }
    const av = median(a),
      bv = median(b);
    const stats = pairedBootstrap(
      a.map((v) => [v]),
      b.map((v) => [v]),
    );
    const deltaPct = av === 0 ? (bv === 0 ? 0 : null) : (bv / av - 1) * 100;
    const significant = stats.ci95[0] > 1 || stats.ci95[1] < 1;
    const regression = stats.ratio > (key === "eventLoop.p99.ms" ? 1 : 1.1) && stats.ci95[0] > 1;
    const budget = budgets.metrics[key]?.max;
    const infoOnly =
      key === "wal.bytes" || key === "operations" || key.endsWith(".p95") || key.endsWith(".p50");
    const verdict = infoOnly ? "info" : regression ? "fail" : "pass";
    fail ||= verdict === "fail";
    metrics[key] = {
      ...stats,
      significant,
      absoluteBudgetExceeded: budget !== undefined && bv > budget,
      base: av,
      candidate: bv,
      deltaPct,
      regression,
      budget: budget ?? null,
      verdict,
    };
  }
  const tails: Record<string, unknown> = {};
  for (const key of new Set([
    ...requiredRequests,
    ...[...base, ...candidate].flatMap((r) => Object.keys(r.requests ?? {})),
  ])) {
    const a = base.map((r) => r.requests?.[key] ?? []),
      b = candidate.map((r) => r.requests?.[key] ?? []);
    if ([...a, ...b].some((r) => r.length < 40)) {
      missing = true;
      relativeMissing ||= requiredRequests.includes(key);
      tails[key] = { status: "unmeasured" };
      continue;
    }
    const stats = pairedBootstrap(a, b, (runs) => percentiles(runs.flat())!.p99);
    const regression = stats.ratio > 1.25 && stats.ci95[0] > 1;
    fail ||= regression;
    tails[key] = {
      base: percentiles(a.flat()),
      candidate: percentiles(b.flat()),
      ...stats,
      verdict: regression ? "fail" : "pass",
    };
  }
  const correctness = [...base, ...candidate].every((r) => r.correctness === "pass")
    ? "pass"
    : [...base, ...candidate].some((r) => r.correctness === "fail")
      ? "fail"
      : "unmeasured";
  return {
    gateVersion,
    tails,
    performanceVerdict: fail ? "fail" : relativeMissing ? "incomplete" : "pass",
    base: first.sha,
    candidate: candidate[0]!.sha,
    fixtureHash: first.fixtureHash,
    runtimeHash: first.runtimeHash,
    hardwareHash: first.hardwareHash,
    seed: first.seed,
    agents: first.agents,
    repeats,
    correctness,
    metrics,
    budgetVerdict:
      fail || correctness === "fail"
        ? "fail"
        : missing || correctness === "unmeasured"
          ? "incomplete"
          : "pass",
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b, out] = process.argv.slice(2);
  const read = (p: string) =>
    readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s) as Run);
  const result = compare(
    read(a!),
    read(b!),
    JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8")),
  );
  writeFileSync(out!, JSON.stringify(result, null, 2) + "\n");
  if (result.budgetVerdict !== "pass") process.exitCode = 1;
}
