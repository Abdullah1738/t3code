import { describe, expect, it } from "vite-plus/test";

import { ageView, clockLabel, formatDayLabel, formatTimeOfDay } from "./time.ts";

const NOW = Date.parse("2026-10-17T08:33:00.000Z");

describe("display times", () => {
  it("shortens ages and says how loud to show them", () => {
    expect(ageView("2026-10-17T08:32:30Z", NOW)).toEqual({ label: "now", tier: "minutes" });
    expect(ageView("2026-10-17T07:41:00Z", NOW)).toEqual({ label: "52m", tier: "minutes" });
    expect(ageView("2026-10-17T03:00:00Z", NOW)).toEqual({ label: "5h", tier: "hours" });
    expect(ageView("2026-10-15T18:30:00Z", NOW)).toEqual({ label: "1d 14h", tier: "days" });
    expect(ageView("2026-10-15T08:33:00Z", NOW)).toEqual({ label: "2d", tier: "days" });
    expect(ageView("not a time", NOW)).toBeNull();
  });

  it("formats day labels and times of day in the zone given", () => {
    expect(formatDayLabel("2026-10-01T08:00:00Z", "UTC")).toBe("Thu 1 Oct");
    expect(formatTimeOfDay("2026-10-04T15:41:48Z", "UTC")).toBe("15:41");
    expect(formatTimeOfDay("not a time", "UTC")).toBe("");
  });

  it("reads clock times in the zone it is given", () => {
    const at = "2026-10-17T05:06:00.000Z";
    expect(clockLabel(at, NOW, "UTC")).toBe("05:06");
    expect(clockLabel(at, NOW, "Asia/Dubai")).toBe("09:06");
    // 22:06 on the 16th in Los Angeles, where it is already the 17th now.
    expect(clockLabel(at, NOW, "America/Los_Angeles")).toBe("Fri 16 Oct");
    expect(clockLabel("2026-10-17T08:00:00.000Z", NOW, "America/Los_Angeles")).toBe("01:00");
    expect(clockLabel("2026-10-14T19:30:00.000Z", NOW, "UTC")).toBe("Wed 14 Oct");
  });
});
