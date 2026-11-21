import capture from "./fixtures/cadence-replay.json";
import { replaySlots, type ReplayOptions } from "./slot-replay.ts";

export const healthChecks = ["meds-nag", "gym-nudge", "nutrition-checkin", "nutrition-nudge", "forge-workouts"];

export function sustainedOptions(day: 19 | 20, heavy = false): ReplayOptions {
  const start = 12 * 3600_000, end = (day === 19 ? 20 : 24) * 3600_000;
  return {
    mix: { ...capture.mix, source: `#97's 54-watcher mix; ${day} Nov synthetic sustained pressure, dynamic runtimes; whoop and inbox are explicit stress probes replacing anonymous matching-interval entries (not identity mappings); no trigger amplification`,
      watchers: [...capture.mix.watchers.map(w => healthChecks.includes(w.watcher) ? { ...w, checkMs: 500 } : w.watcher === "watcher-030" ? { ...w, watcher: "inbox-triage-fastpath", checkMs: 6239 } : w.watcher === "watcher-085" ? { ...w, watcher: "whoop-sync" } : w), ...(heavy ? [{ watcher: "btse-cost-collect-extra", intervalMs: 300_000, checkMs: 20_000, timeout_s: 120 }] : [])] },
    hysteresis: true, fastSlots: 2, accountFrom: start, accountUntil: end,
    loads: [{ at: 0, load: .5 }, { at: start, load: 3.2 }, { at: end, load: .5 }],
    runtime: (watcher, at, run) => {
      if (at < start || at >= end) return watcher.checkMs;
      if (watcher.watcher === "btse-cost-collect-extra") return 202_100;
      if (watcher.watcher === "whoop-sync") return (day === 19 ? [3185, 11_576, 38_008] : [4294, 136_908, 782_455])[run % 3]!;
      if (healthChecks.includes(watcher.watcher)) return (day === 19 ? [8_000, 12_000, 17_000] : [60_000, 120_000, 180_000, 240_000])[run % (day === 19 ? 3 : 4)]!;
      return Math.min(300_000, watcher.checkMs * (day === 19 ? 2 : 10 + (run % 6) * 10));
    },
  };
}

export async function sustainedReplay(day: 19 | 20, strategy: "baseline" | "sticky" | "borrow", freeze = false, heavy = false) {
  return replaySlots(undefined, 6, 24, { ...sustainedOptions(day, heavy), sticky: strategy !== "baseline", borrowFast: strategy === "borrow",
    // At a host freeze, existing elapsed deadlines fire on the first resumed tick.
    existingTimeouts: true, ...(freeze ? { freeze: { at: 16 * 3600_000, ms: 420_000 } } : {}) });
}

if (import.meta.main) {
  const heavy = process.argv.includes("--heavy");
  for (const day of (heavy ? [20] : [19, 20]) as (19 | 20)[]) for (const strategy of ["baseline", "sticky", "borrow"] as const) {
    const result = await sustainedReplay(day, strategy, false, heavy);
    const { completions, ...summary } = result;
    console.log(JSON.stringify({ day, strategy, ...summary }));
  }
}
