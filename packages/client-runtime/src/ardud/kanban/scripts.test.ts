import type { KanbanScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runDuration, runState, sortScripts, scriptTriggerLabel } from "./scripts.ts";

const script = (id: string, enabled: boolean, createdAt: string) =>
  ({ id, enabled, createdAt }) as unknown as KanbanScript;

describe("board scripts", () => {
  it("says when a script runs", () => {
    const every = (everyMs: number) =>
      scriptTriggerLabel({ _tag: "schedule", everyMs, cron: null });
    expect(every(60_000)).toBe("Every minute");
    expect(every(15 * 60_000)).toBe("Every 15 min");
    expect(every(3_600_000)).toBe("Every hour");
    expect(every(6 * 3_600_000)).toBe("Every 6 h");
    expect(every(86_400_000)).toBe("Every day");
    const cron = (line: string) =>
      scriptTriggerLabel({ _tag: "schedule", everyMs: null, cron: line });
    expect(cron("0 9 * * *")).toBe("Daily 09:00");
    expect(cron("30 18 * * 1-5")).toBe("Weekdays 18:30");
    expect(cron("*/30 * * * *")).toBe("Every 30 min");
    expect(cron("0 9 1 * *")).toBe("Cron 0 9 1 * *");
    // The zone is the server's, so it's shown even when the browser is elsewhere.
    expect(
      scriptTriggerLabel({
        _tag: "schedule",
        everyMs: null,
        cron: "0 9 * * *",
        timeZone: "Asia/Dubai",
      }),
    ).toBe("Daily 09:00 · Asia/Dubai");
    expect(scriptTriggerLabel({ _tag: "event", event: "card.moved" })).toBe("When a card moves");
    expect(scriptTriggerLabel({ _tag: "manual" })).toBe("When you run it");
  });

  it("says how a run went", () => {
    expect(runState(null).label).toBe("Not run yet");
    expect(runState({ endedAt: null, exitCode: null }).tone).toBe("running");
    expect(runState({ endedAt: "2026-10-26T06:00:00Z", exitCode: 0 }).label).toBe("Done");
    expect(runState({ endedAt: "2026-10-26T06:00:00Z", exitCode: 3 }).label).toBe(
      "Failed (exit 3)",
    );
    expect(runState({ endedAt: "2026-10-26T06:00:00Z", exitCode: null }).label).toBe(
      "Didn't finish",
    );
    const startedAt = "2026-10-26T06:00:00Z";
    expect(runDuration({ startedAt, endedAt: "2026-10-26T06:00:04Z" })).toBe("4s");
    expect(runDuration({ startedAt, endedAt: "2026-10-26T06:02:10Z" })).toBe("2m 10s");
    expect(runDuration({ startedAt, endedAt: null })).toBeNull();
  });

  it("lists scripts that are on first, newest first", () => {
    const sorted = sortScripts([
      script("old-on", true, "2026-10-01T00:00:00Z"),
      script("off", false, "2026-10-20T00:00:00Z"),
      script("new-on", true, "2026-10-10T00:00:00Z"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["new-on", "old-on", "off"]);
  });
});
