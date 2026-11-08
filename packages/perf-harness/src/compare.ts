// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { percentiles, type Run } from "./metrics.ts";
export function compare(
  base: Run[],
  candidate: Run[],
  budgets: { metrics: Record<string, { max: number }> },
  repeats = 5,
) {
  if (base.length !== repeats || candidate.length !== repeats)
    throw new Error(`Expected ${repeats} repeats per revision`);
  const first = base[0]!;
  for (const runs of [base, candidate]) {
    for (const r of runs) {
      for (const key of [
        "fixtureHash",
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
  let fail = false,
    missing = false;
  for (const key of new Set([
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
      continue;
    }
    const av = percentiles(a)!.p95,
      bv = percentiles(b)!.p95;
    const deltaPct = av === 0 ? (bv === 0 ? 0 : null) : (bv / av - 1) * 100;
    const regression = av === 0 ? bv > 0 : bv > av * 1.1;
    const budget = budgets.metrics[key]?.max;
    const verdict = (budget !== undefined && bv > budget) || regression ? "fail" : "pass";
    fail ||= verdict === "fail";
    metrics[key] = {
      base: av,
      candidate: bv,
      deltaPct,
      regression,
      budget: budget ?? null,
      verdict,
    };
  }
  const correctness = [...base, ...candidate].every((r) => r.correctness === "pass")
    ? "pass"
    : [...base, ...candidate].some((r) => r.correctness === "fail")
      ? "fail"
      : "unmeasured";
  return {
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
