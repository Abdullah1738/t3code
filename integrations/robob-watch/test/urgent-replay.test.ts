import { expect, test } from "bun:test";
import { urgentReplay, heldSlotsReplay } from "./urgent-replay.ts";

test("ten-hour pressure replay improves safety waits and every background watcher still drains", async () => {
  const before = await urgentReplay(false), after = await urgentReplay(true);
  for (const row of after.safety) {
    const previous = before.safety.find(previous => previous.watcher === row.watcher)!;
    expect(row.p95S).toBeLessThan(previous.p95S);
  }
  for (const row of after.nonUrgent) {
    expect(row.runs).toBeGreaterThan(0);
    expect(row.maxS).toBeLessThan(4 * 3600);
  }
  // This over-capacity fixture deliberately retains observed late releases.
  // Keep failed rollout targets visible instead of tuning the input to pass.
  expect(after.safety.some(row => row.p95S >= 300)).toBe(true);
  expect(after.nonUrgentSlowWaits.p95S).toBeGreaterThan(before.nonUrgentSlowWaits.p95S * 1.1);
}, 30_000);

test("urgent work still waits for one of two held slow slots to finish", async () => {
  const held = await heldSlotsReplay();
  expect(held.runs).toBe(1);
  expect(held.maxS).toBe(600);
});
