import { expect, test } from "bun:test";
import { replaySlots } from "./slot-replay.ts";

test("87-watcher replay with slow checks stays bounded at normal and reduced capacity", async () => {
  for (const cap of [6, 2]) {
    const result = await replaySlots(undefined, cap);
    expect(result.watchers).toBe(87);
    expect(result.minRuns).toBeGreaterThan(0);
    expect(result.fast.p95S).toBeLessThan(cap === 6 ? 300 : 1200);
    expect(result.all.maxS).toBeLessThan(cap === 6 ? 400 : 1500);
  }
}, 15_000);
