import { describe, expect, it } from "vite-plus/test";

import {
  forkScheduleFromDraft,
  forkScheduleLabel,
  isoToZonedLocal,
  zonedLocalToIso,
} from "./scheduleDraft.ts";

describe("zoned wall-clock conversion", () => {
  it("adds the zone offset", () => {
    expect(zonedLocalToIso("2026-10-05T12:55", "Asia/Dubai")).toBe("2026-10-05T12:55:00+04:00");
    expect(zonedLocalToIso("2026-10-05T12:55", "UTC")).toBe("2026-10-05T12:55:00+00:00");
  });

  it("uses the offset in force on that date in DST zones", () => {
    expect(zonedLocalToIso("2026-07-01T09:00", "Europe/Berlin")).toBe("2026-07-01T09:00:00+02:00");
    expect(zonedLocalToIso("2026-12-01T09:00", "Europe/Berlin")).toBe("2026-12-01T09:00:00+01:00");
  });

  it("round-trips through the zone", () => {
    expect(isoToZonedLocal("2026-10-05T08:55:00Z", "Asia/Dubai")).toBe("2026-10-05T12:55");
  });
});

describe("fork schedule drafts", () => {
  it("builds a cron schedule and normalises spacing", () => {
    expect(
      forkScheduleFromDraft("cron", {
        cronExpression: " */2  * * * * ",
        onceLocal: "",
        timeZone: "Asia/Dubai",
      }),
    ).toEqual({ schedule: { type: "cron", expression: "*/2 * * * *", timeZone: "Asia/Dubai" } });
  });

  it("reports bad input instead of throwing", () => {
    expect(
      forkScheduleFromDraft("cron", { cronExpression: "bad", onceLocal: "", timeZone: "UTC" }),
    ).toHaveProperty("problem");
    expect(
      forkScheduleFromDraft("once", { cronExpression: "", onceLocal: "", timeZone: "UTC" }),
    ).toHaveProperty("problem");
  });

  it("labels cron and once schedules", () => {
    expect(forkScheduleLabel({ type: "cron", expression: "17 * * * *", timeZone: "UTC" })).toBe(
      "Cron 17 * * * * · UTC",
    );
    expect(
      forkScheduleLabel({ type: "once", at: "2026-10-05T08:55:00Z", timeZone: "Asia/Dubai" }),
    ).toBe("Once 2026-10-05 12:55 · Asia/Dubai");
  });
});
