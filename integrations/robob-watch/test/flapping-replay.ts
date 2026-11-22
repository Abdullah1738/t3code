import capture from "./fixtures/flapping-cadence.json";
import { replaySlots, type ReplayOptions } from "./slot-replay.ts";
import { healthChecks, sustainedOptions } from "./sustained-replay.ts";
import { DeadlineSlots } from "./deadline-slots.ts";

export type RuntimeMix = "raw" | "precap";
export type Release = "deadline" | "observed";
export type Strategy = "live" | "baseline" | "sticky" | "borrow" | "edf";

export function flappingOptions(mix: RuntimeMix, release: Release, strategy: Strategy): ReplayOptions {
  const records = new Map(capture.watchers.map(watcher => [watcher.watcher, {
    hours: new Map(Object.entries(watcher.hours).map(([hour, values]) => [Number(hour),
      values.map(([ms, timedOut]) => ({ ms: Number(ms), timedOut: timedOut === true })),
    ])),
    precap: watcher.precap.map(([ms, timedOut]) => ({ ms: Number(ms), timedOut: timedOut === true })),
  }]));
  const runtimeSample = (watcher: { watcher: string }, at: number, run: number) => {
    const record = records.get(watcher.watcher)!;
    const hour = Math.floor(at / 3600_000);
    const key = [...record.hours.keys()].filter(h => h <= hour).sort((a, b) => b - a)[0]
      ?? Math.min(...record.hours.keys());
    // Post-cap missing hours carry the last observed sample; the pre-cap run exposes that pessimism.
    return (mix === "precap" ? record.precap : record.hours.get(key)!)[run % 5]!;
  };
  return {
    mix: { source: capture.source, watchers: capture.watchers }, loads: capture.loads,
    hysteresis: true, fastSlots: 2, existingTimeouts: true, freeze: capture.runnerDown,
    sticky: strategy === "sticky" || strategy === "borrow" || strategy === "edf", borrowFast: strategy === "borrow" || strategy === "edf",
    // Live lacked main's probe recovery; keep it separate from the fix's baseline.
    failureProbes: strategy !== "live",
    runtime: (watcher, at, run) => runtimeSample(watcher, at, run).ms,
    ...(release === "observed" ? { observedRelease: runtimeSample } : {}),
  };
}

export function flappingReplay(mix: RuntimeMix, release: Release, strategy: Strategy) {
  return replaySlots(strategy === "edf" ? DeadlineSlots : undefined, 6, 24, flappingOptions(mix, release, strategy));
}

export function cadenceSummary(result: Awaited<ReturnType<typeof replaySlots>>) {
  const { completions, ...summary } = result;
  const target = healthChecks.map(watcher => {
    const rows = completions.filter(row => row.watcher === watcher && !row.timedOut && row.at < result.hours * 3600_000);
    const gaps = rows.slice(1).map((row, i) => ({ start: rows[i]!.at / 1000, end: row.at / 1000, seconds: (row.at - rows[i]!.at) / 1000 }));
    return { watcher, completed: rows.length, completedMaxGapS: Math.max(0, ...gaps.map(row => row.seconds)),
      lateWindowCompleted: rows.filter(row => row.at >= (20 * 3600 + 34 * 60) * 1000 && row.at <= (23 * 3600 + 12 * 60) * 1000).length,
      worstGaps: gaps.sort((a, b) => b.seconds - a.seconds).slice(0, 3) };
  });
  return { ...summary, target };
}

export function borrowedStallOptions(releaseDelayMs: number): ReplayOptions {
  return {
    fastSlots: 2, borrowFast: true, existingTimeouts: true, releaseDelayMs,
    loads: [{ at: 0, load: 9 }], freeze: { at: 5000, ms: 420_000 },
    mix: { source: "two slow holders, one hung borrower, four native fast checks; measured timeout-release delay", watchers: [
      ...["slow-a", "slow-b"].map(watcher => ({ watcher, intervalMs: 3600_000, checkMs: 300_000 })),
      { watcher: "borrowed", intervalMs: 300_000, checkMs: 60_000 },
      ...healthChecks.slice(0, 4).map(watcher => ({ watcher, intervalMs: 300_000, checkMs: 500 })),
    ] }, runtime: watcher => watcher.watcher === "borrowed" ? 600_000 : watcher.checkMs,
  };
}

if (import.meta.main) {
  for (const mix of ["raw", "precap"] as const) for (const release of ["deadline", "observed"] as const) {
    for (const strategy of ["live", "baseline", "sticky", "borrow"] as const) {
      console.log(JSON.stringify({ label: `${mix}:${release}:${strategy}`, day: 21, ...cadenceSummary(await flappingReplay(mix, release, strategy)) }));
    }
  }
  console.log(JSON.stringify({ label: "raw:deadline:edf", day: 21, ...cadenceSummary(await flappingReplay("raw", "deadline", "edf")) }));
  for (const delay of [0, 324200, 1482100, 2302500]) {
    const result = await replaySlots(undefined, 6, 24, {
      ...sustainedOptions(19), sticky: true, borrowFast: true, existingTimeouts: true,
      freeze: { at: 16 * 3600_000, ms: 420_000 }, releaseDelayMs: delay,
    });
    console.log(JSON.stringify({ label: `seven-minute-stall:timeout-release-delay-${delay}`, day: 19, ...cadenceSummary(result) }));
    console.log(JSON.stringify({ label: `borrowed-stall:timeout-release-delay-${delay}`,
      ...await replaySlots(undefined, 2, 1, borrowedStallOptions(delay)) }));
  }
}
