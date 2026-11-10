// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Paired reads gate: base vs candidate, interleaved AB/BA on one worker.
 *
 * usage: node packages/perf-harness/src/readsGatePairs.ts FIXTURE BASE_ENTRY CANDIDATE_ENTRY OUTDIR PAIRS [OFF_RUNS]
 *
 * Every attempt is kept (OUTDIR/runs/*.json, OUTDIR/attempts.jsonl); a failed
 * run makes the comparison ineligible rather than being dropped. OFF_RUNS
 * extra candidate runs boot with the lanes off (the rollback layout).
 *
 * Preregistered verdict (fixed before the first paired run):
 * - isolation: each foreground probe whose base loaded p95 is at least 200 ms
 *   has a median (over pairs) candidate/base loaded-p95 ratio of at most 0.5;
 * - reserved lanes (auth, identity): median loaded-p95 ratio at most 1.25;
 * - background holder (full control thread listing): median ratio at most 1.25;
 * - idle foreground: median idle-p95 ratio at most 1.25 per probe;
 * - no probe failures and no holder failures on either side.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BACKGROUND_PROBES,
  FOREGROUND_PROBES,
  RESERVED_PROBES,
  readsGate,
  type ReadsGateRun,
} from "./readsGate.ts";

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

// Deterministic resampling so the interval is reproducible from the retained runs.
function bootstrapMedian(values: ReadonlyArray<number>, resamples = 10_000, seed = 7) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const medians: Array<number> = [];
  for (let r = 0; r < resamples; r++) {
    const draw = Array.from({ length: values.length }, () => values[Math.floor(next() * values.length)]!);
    medians.push(median(draw));
  }
  medians.sort((a, b) => a - b);
  return { lo: medians[Math.floor(0.025 * resamples)]!, hi: medians[Math.floor(0.975 * resamples)]! };
}

const p95 = (run: ReadsGateRun, phase: string, probe: string) => run.summary[phase]?.[probe]?.p95 ?? Number.NaN;

const resourceAt = (run: ReadsGateRun, at: string) => run.resources.find((r) => r.at === at);

export function compare(pairs: ReadonlyArray<{ base: ReadsGateRun; candidate: ReadsGateRun }>, off: ReadonlyArray<ReadsGateRun>) {
  const probes = [...FOREGROUND_PROBES, ...RESERVED_PROBES, ...BACKGROUND_PROBES];
  const table: Record<string, unknown> = {};
  const verdicts: Array<{ check: string; pass: boolean; detail: string }> = [];
  for (const phase of ["idle", "loaded", "afterAbort"]) {
    for (const probe of probes) {
      const base = pairs.map((p) => p95(p.base, phase, probe));
      const cand = pairs.map((p) => p95(p.candidate, phase, probe));
      const ratios = pairs.map((_, i) => cand[i]! / Math.max(base[i]!, 1));
      const offP95 = off.map((r) => p95(r, phase, probe));
      table[`${phase}.${probe}`] = {
        baseMedianP95: median(base),
        candidateMedianP95: median(cand),
        offMedianP95: offP95.length ? median(offP95) : null,
        medianRatio: median(ratios),
        ci95: bootstrapMedian(ratios),
      };
    }
  }
  const row = (key: string) => table[key] as { baseMedianP95: number; medianRatio: number };
  for (const probe of FOREGROUND_PROBES) {
    const loaded = row(`loaded.${probe}`);
    if (loaded.baseMedianP95 >= 200)
      verdicts.push({
        check: `isolation.${probe}`,
        pass: loaded.medianRatio <= 0.5,
        detail: `base p95 ${Math.round(loaded.baseMedianP95)} ms, ratio ${loaded.medianRatio.toFixed(3)}`,
      });
    else
      verdicts.push({
        check: `isolation.${probe}`,
        pass: true,
        detail: `not applicable: base loaded p95 ${Math.round(loaded.baseMedianP95)} ms < 200 ms`,
      });
    const idle = row(`idle.${probe}`);
    verdicts.push({ check: `idle.${probe}`, pass: idle.medianRatio <= 1.25, detail: `ratio ${idle.medianRatio.toFixed(3)}` });
  }
  for (const probe of RESERVED_PROBES) {
    const loaded = row(`loaded.${probe}`);
    verdicts.push({ check: `reserved.${probe}`, pass: loaded.medianRatio <= 1.25, detail: `ratio ${loaded.medianRatio.toFixed(3)}` });
  }
  const holderRatios = pairs.map((p) => median(p.candidate.holders.loadedMs) / Math.max(median(p.base.holders.loadedMs), 1));
  table.holders = {
    baseMedianMs: median(pairs.map((p) => median(p.base.holders.loadedMs))),
    candidateMedianMs: median(pairs.map((p) => median(p.candidate.holders.loadedMs))),
    offMedianMs: off.length ? median(off.map((r) => median(r.holders.loadedMs))) : null,
    baseIdleMs: median(pairs.map((p) => p.base.holders.idleMs)),
    candidateIdleMs: median(pairs.map((p) => p.candidate.holders.idleMs)),
    medianRatio: median(holderRatios),
    ci95: bootstrapMedian(holderRatios),
  };
  verdicts.push({ check: "background.holder", pass: median(holderRatios) <= 1.25, detail: `ratio ${median(holderRatios).toFixed(3)}` });
  const failures = pairs.flatMap((p) => [p.base, p.candidate]).reduce(
    (n, r) => n + Object.values(r.failures).reduce((m, f) => m + f.length, 0) + r.holders.failures,
    0,
  );
  verdicts.push({ check: "failures", pass: failures === 0, detail: `${failures} probe/holder failures` });
  const resources = (side: "base" | "candidate") => {
    const pick = (at: string, key: "rssBytes" | "hwmBytes" | "threads") =>
      median(pairs.map((p) => resourceAt(p[side], at)?.[key] ?? Number.NaN));
    const io = (key: "readBytes" | "writeBytes") =>
      median(
        pairs.map((p) => (resourceAt(p[side], "loaded-end")?.[key] ?? Number.NaN) - (resourceAt(p[side], "idle-end")?.[key] ?? Number.NaN)),
      );
    return {
      idleRssBytes: pick("idle-end", "rssBytes"),
      loadedRssBytes: pick("loaded-end", "rssBytes"),
      hwmBytes: pick("end", "hwmBytes"),
      threads: pick("idle-end", "threads"),
      loadedReadBytes: io("readBytes"),
      loadedWriteBytes: io("writeBytes"),
    };
  };
  table.resources = { base: resources("base"), candidate: resources("candidate") };
  return { table, verdicts, pass: verdicts.every((v) => v.pass), pairs: pairs.length, offRuns: off.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [fixture, baseEntry, candidateEntry, outDir, pairsArg, offArg] = process.argv.slice(2);
  if (!fixture || !baseEntry || !candidateEntry || !outDir || !pairsArg) {
    console.error("usage: readsGatePairs.ts FIXTURE BASE_ENTRY CANDIDATE_ENTRY OUTDIR PAIRS [OFF_RUNS]");
    process.exit(2);
  }
  const out = resolve(outDir);
  if (existsSync(resolve(out, "comparison.json"))) throw new Error("Use a fresh output directory");
  mkdirSync(resolve(out, "runs"), { recursive: true });
  const attempt = (entry: unknown) => appendFileSync(resolve(out, "attempts.jsonl"), JSON.stringify(entry) + "\n");
  const runOne = async (side: string, entry: string, index: number, lanes: "default" | "off") => {
    const label = `${side}-${index}`;
    attempt({ label, status: "started", at: new Date().toISOString() });
    try {
      const run = await readsGate(fixture, label, entry, lanes);
      writeFileSync(resolve(out, "runs", `${label}.json`), JSON.stringify(run));
      attempt({ label, status: "completed", at: new Date().toISOString() });
      console.log(`[${label}] loaded shell p95=${Math.round(run.summary.loaded?.shell?.p95 ?? -1)} holder=${Math.round(run.holders.idleMs)}`);
      return run;
    } catch (error) {
      attempt({ label, status: "failed", error: String(error), at: new Date().toISOString() });
      throw error;
    }
  };
  const pairs: Array<{ base: ReadsGateRun; candidate: ReadsGateRun }> = [];
  for (let i = 0; i < Number(pairsArg); i++) {
    if (i % 2 === 0) {
      const base = await runOne("base", baseEntry, i, "default");
      const candidate = await runOne("candidate", candidateEntry, i, "default");
      pairs.push({ base, candidate });
    } else {
      const candidate = await runOne("candidate", candidateEntry, i, "default");
      const base = await runOne("base", baseEntry, i, "default");
      pairs.push({ base, candidate });
    }
  }
  const off: Array<ReadsGateRun> = [];
  for (let i = 0; i < Number(offArg ?? 0); i++) off.push(await runOne("candidate-off", candidateEntry, i, "off"));
  const result = compare(pairs, off);
  writeFileSync(resolve(out, "comparison.json"), JSON.stringify(result, null, 1));
  for (const v of result.verdicts) console.log(`${v.pass ? "PASS" : "FAIL"} ${v.check}: ${v.detail}`);
  console.log(result.pass ? "READS GATE PASS" : "READS GATE FAIL");
  void readFileSync;
}
