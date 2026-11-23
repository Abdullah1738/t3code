import { replaySlots, type ReplayOptions } from "./slot-replay.ts";

export const safetyIds = ["offbox-home-pool-low", "offbox-home-brake2", "crpko-ios-tester-health", "9router-claude-reauth"];
export async function urgentReplay(urgent: boolean) {
  const runtimes: Record<string, number[]> = {
    "offbox-home-pool-low": [40_000, 330_500, 402_800, 215_000],
    "offbox-home-brake2": [40_000, 60_000],
    "crpko-ios-tester-health": [16_000, 215_000, 1667_900, 110_000],
    "9router-claude-reauth": [235_700, 198_000, 9600, 28_600, 174_900],
  };
  const options: ReplayOptions = {
    urgent, sticky: true, borrowFast: true, hysteresis: true, fastSlots: 2, existingTimeouts: true,
    loads: [{ at: 0, load: 42.6 }],
    mix: {
      source: "20 Nov-like synthetic 10h load mode, 35 background slow checks plus four safety watchers, all initially due. Queue and timestamps are simulated, not an exact historical reconstruction. Safety runtimes from packet/logs; brake2 runtime unavailable (watcher removed), sensitivity assumption 40/60s. Background runtimes 40/180/215/330/403s cycle through observed range; interval 300/600/900/1800s. Preserve main's sticky/borrow lanes. Observed releases deliberately include late deadlines (#148).",
      watchers: [
        ...Array.from({ length: 35 }, (_, i) => ({ watcher: `background-${i}`, intervalMs: [300_000, 600_000, 900_000, 1800_000][i % 4]!, checkMs: [40_000, 180_000, 215_000, 330_000, 403_000][i % 5]!, timeout_s: 110 })),
        ...safetyIds.map((watcher, i) => ({ watcher, urgent: true, intervalMs: [600_000, 120_000, 300_000, 60_000][i]!, checkMs: runtimes[watcher]![0]!, timeout_s: [60, 60, 110, 60][i]! })),
      ],
    },
    observedRelease: (watcher, _at, run) => {
      const ms = runtimes[watcher.watcher]?.[run % runtimes[watcher.watcher]!.length] ?? watcher.checkMs;
      // The 20 Nov pool 402.8s sample and 21 Nov iOS 1667.9s sample
      // timed out; retaining actual release time models the separate #148 bug.
      return { ms, timedOut: watcher.watcher === "offbox-home-pool-low" ? ms === 402_800
        : watcher.watcher === "crpko-ios-tester-health" ? ms === 1667_900
        : watcher.watcher.startsWith("background-") && ms > 300_000 };
    },
  };
  const result = await replaySlots(undefined, 6, 10, options);
  const lateDeadlines = result.completions.filter(row => row.timedOut && row.at - row.started > (row.watcher === "crpko-ios-tester-health" || row.watcher.startsWith("background-") ? 300_000 : 180_000));
  return { assumptions: options.mix!.source, urgent, safety: result.byWatcher.filter(row => safetyIds.includes(row.watcher)),
    nonUrgent: result.byWatcher.filter(row => !safetyIds.includes(row.watcher)),
    // Cohort percentiles must be computed from runs, not watcher percentiles.
    nonUrgentWaits: result.nonUrgent, nonUrgentSlowWaits: result.nonUrgentSlow,
    lateDeadlines: lateDeadlines.map(row => ({ watcher: row.watcher, checkMs: row.at - row.started, timeoutMs: row.watcher === "crpko-ios-tester-health" || row.watcher.startsWith("background-") ? 300_000 : 180_000 })),
    minRuns: result.minRuns };
}

export async function heldSlotsReplay() {
  const result = await replaySlots(undefined, 2, 1, { urgent: true, mix: { source: "Both slow slots occupied by 600s checks before an urgent waiter arrives; fast borrowing disabled to isolate slow admission.", watchers: [
    { watcher: "holder-a", checkMs: 600_000, intervalMs: 7200_000 },
    { watcher: "holder-b", checkMs: 620_000, intervalMs: 7200_000 },
    { watcher: "urgent", urgent: true, checkMs: 40_000, intervalMs: 7200_000 },
  ] } });
  return result.byWatcher.find(row => row.watcher === "urgent")!;
}

if (import.meta.main) console.log(JSON.stringify({ before: await urgentReplay(false), after: await urgentReplay(true), heldSlots: await heldSlotsReplay() }, null, 2));
