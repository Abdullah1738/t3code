import { describe, expect, it } from "vite-plus/test";
import { analyticsQueueCount } from "./analyticsCounts";

describe("displayed analytics collections", () => {
  it.each([
    ["desktop", "queue", false, 12],
    ["tablet", "queue", false, 12],
    ["phone", "queue", false, 0],
    ["phone", "queue", true, 12],
    ["desktop", "history", false, 0],
    ["tablet", "reference", false, 0],
    ["phone", "history", false, 0],
    ["phone", "reference", true, 12],
  ] as const)("counts the queue for %s / %s / open=%s", (layout, view, open, count) => {
    expect(analyticsQueueCount(layout, view, open, 12)).toBe(count);
  });
});
