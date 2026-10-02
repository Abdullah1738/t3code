import { describe, expect, it } from "@effect/vitest";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isExpiredOnceRun,
  isMissedFixedTimeRun,
  isSameSchedule,
  nextScheduledRunAt,
} from "../../scheduledTasks/Schedule.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const next = (schedule: ScheduledTaskSchedule, from: string) => {
  const value = nextScheduledRunAt(schedule, at(from));
  return value ? DateTime.formatIso(DateTime.toUtc(value)) : null;
};

describe("cron schedules", () => {
  it("runs every two minutes in Asia/Dubai", () => {
    const schedule = { type: "cron", expression: "*/2 * * * *", timeZone: "Asia/Dubai" } as const;
    expect(next(schedule, "2026-10-03T06:01:30.000Z")).toBe("2026-10-03T06:02:00.000Z");
    expect(next(schedule, "2026-10-03T06:02:00.000Z")).toBe("2026-10-03T06:04:00.000Z");
  });

  it("uses the zone's wall clock (Asia/Dubai is UTC+4, no DST)", () => {
    const schedule = { type: "cron", expression: "0 9 * * *", timeZone: "Asia/Dubai" } as const;
    expect(next(schedule, "2026-10-03T06:00:00.000Z")).toBe("2026-10-04T05:00:00.000Z");
    expect(next(schedule, "2026-10-03T04:59:00.000Z")).toBe("2026-10-03T05:00:00.000Z");
  });

  it("handles UTC step hours", () => {
    const schedule = { type: "cron", expression: "0 */4 * * *", timeZone: "UTC" } as const;
    expect(next(schedule, "2026-10-03T05:00:00.000Z")).toBe("2026-10-03T08:00:00.000Z");
  });

  it("keeps the wall-clock hour across Europe/Berlin's autumn DST change", () => {
    const schedule = { type: "cron", expression: "0 9 * * *", timeZone: "Europe/Berlin" } as const;
    // 09:00 CEST (UTC+2) before the change, 09:00 CET (UTC+1) after it.
    expect(next(schedule, "2026-10-24T06:00:00.000Z")).toBe("2026-10-24T07:00:00.000Z");
    expect(next(schedule, "2026-10-24T08:00:00.000Z")).toBe("2026-10-25T08:00:00.000Z");
  });

  it("fires a skipped spring-forward slot once, just after the gap (America/New_York)", () => {
    const schedule = {
      type: "cron",
      expression: "30 2 * * *",
      timeZone: "America/New_York",
    } as const;
    // 02:30 does not exist on 2026-03-08; it runs at 03:30 EDT instead of being lost.
    expect(next(schedule, "2026-03-08T05:00:00.000Z")).toBe("2026-03-08T07:30:00.000Z");
    expect(next(schedule, "2026-03-08T07:30:00.000Z")).toBe("2026-03-09T06:30:00.000Z");
  });

  it("does not double-fire a repeated fall-back hour (America/New_York)", () => {
    const schedule = {
      type: "cron",
      expression: "30 1 * * *",
      timeZone: "America/New_York",
    } as const;
    expect(next(schedule, "2026-11-01T04:00:00.000Z")).toBe("2026-11-01T05:30:00.000Z");
    expect(next(schedule, "2026-11-01T05:30:00.000Z")).toBe("2026-11-02T06:30:00.000Z");
  });

  it("returns null instead of throwing for corrupt persisted rows", () => {
    expect(
      next({ type: "cron", expression: "nope", timeZone: "UTC" }, "2026-10-03T00:00:00.000Z"),
    ).toBeNull();
    expect(
      next({ type: "cron", expression: "* * * * *", timeZone: "Mars/Base" }, "2026-10-03T00:00Z"),
    ).toBeNull();
  });

  it("treats cron slots like fixed-time slots when missed", () => {
    const schedule = { type: "cron", expression: "17 * * * *", timeZone: "UTC" } as const;
    const due = at("2026-10-03T06:17:00.000Z");
    expect(isMissedFixedTimeRun(schedule, due, at("2026-10-03T06:20:00.000Z"))).toBe(false);
    expect(isMissedFixedTimeRun(schedule, due, at("2026-10-03T07:00:00.000Z"))).toBe(true);
  });

  it("compares expressions ignoring whitespace but not zone", () => {
    const a = { type: "cron", expression: "0  9 * * *", timeZone: "UTC" } as const;
    expect(isSameSchedule(a, { ...a, expression: "0 9 * * *" })).toBe(true);
    expect(isSameSchedule(a, { ...a, timeZone: "Asia/Dubai" })).toBe(false);
  });
});

describe("one-time schedules", () => {
  const once = { type: "once", at: "2026-10-05T12:55:00+04:00", timeZone: "Asia/Dubai" } as const;

  it("runs at the given instant while it is in the future", () => {
    expect(next(once, "2026-10-03T00:00:00.000Z")).toBe("2026-10-05T08:55:00.000Z");
  });

  it("has no next run once the instant has passed", () => {
    expect(next(once, "2026-10-05T08:55:00.000Z")).toBeNull();
    expect(next(once, "2026-10-06T00:00:00.000Z")).toBeNull();
  });

  it("fires a late run within an hour, but expires after that", () => {
    const due = at("2026-10-05T08:55:00.000Z");
    expect(isExpiredOnceRun(once, due, at("2026-10-05T09:50:00.000Z"))).toBe(false);
    expect(isExpiredOnceRun(once, due, at("2026-10-05T09:56:00.000Z"))).toBe(true);
    expect(isMissedFixedTimeRun(once, due, at("2026-10-05T09:56:00.000Z"))).toBe(false);
  });

  it("treats the same instant in different offsets as the same schedule", () => {
    expect(isSameSchedule(once, { type: "once", at: "2026-10-05T08:55:00Z" })).toBe(true);
    expect(isSameSchedule(once, { type: "once", at: "2026-10-05T08:56:00Z" })).toBe(false);
  });
});

describe("fixed-time schedules with a time zone", () => {
  it("uses the given zone instead of the server's", () => {
    const schedule = { type: "fixed_time", timeOfDay: "09:00", timeZone: "Asia/Dubai" } as const;
    expect(next(schedule, "2026-10-03T06:00:00.000Z")).toBe("2026-10-04T05:00:00.000Z");
    expect(next(schedule, "2026-10-03T04:00:00.000Z")).toBe("2026-10-03T05:00:00.000Z");
  });

  it("checks weekdays in the given zone", () => {
    // 2026-10-03T22:00Z is Sunday 02:00 in Dubai; Monday-only means 2026-10-05 09:00 Dubai.
    const schedule = {
      type: "fixed_time",
      timeOfDay: "09:00",
      weekdays: [1],
      timeZone: "Asia/Dubai",
    } as const;
    expect(next(schedule, "2026-10-03T22:00:00.000Z")).toBe("2026-10-05T05:00:00.000Z");
  });

  it("treats a zone change as a schedule change", () => {
    const base = { type: "fixed_time", timeOfDay: "09:00" } as const;
    expect(isSameSchedule(base, { ...base, timeZone: "UTC" })).toBe(false);
  });
});
