import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScheduledTaskSchedule, ScheduledTaskUpsertSchedule } from "../scheduledTask.ts";

const decodeRead = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeWrite = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("cron and once schedules", () => {
  it("accepts a five-field cron with an IANA zone", () => {
    const schedule = { type: "cron", expression: "*/2 * * * *", timeZone: "Asia/Dubai" };
    expect(decodeWrite(schedule)).toEqual(schedule);
  });

  it("rejects bad cron expressions and zones on write", () => {
    expect(() => decodeWrite({ type: "cron", expression: "0 0 9 * * *", timeZone: "UTC" })).toThrow(
      /five-field/,
    );
    expect(() =>
      decodeWrite({ type: "cron", expression: "61 * * * *", timeZone: "UTC" }),
    ).toThrow();
    expect(() =>
      decodeWrite({ type: "cron", expression: "* * * * *", timeZone: "Mars/Base" }),
    ).toThrow(/time zone/);
  });

  it("still reads a corrupt stored cron so it can be edited or deleted", () => {
    expect(decodeRead({ type: "cron", expression: "bad", timeZone: "UTC" }).type).toBe("cron");
  });

  it("requires an explicit offset for one-time runs", () => {
    expect(decodeWrite({ type: "once", at: "2026-10-05T12:55:00+04:00" }).type).toBe("once");
    expect(decodeWrite({ type: "once", at: "2026-10-05T08:55Z", timeZone: "UTC" }).type).toBe(
      "once",
    );
    expect(() => decodeWrite({ type: "once", at: "2026-10-05T12:55:00" })).toThrow(/offset/);
    expect(() => decodeWrite({ type: "once", at: "2026-02-31T12:55:00Z" })).toThrow();
  });

  it("validates an optional fixed-time zone", () => {
    expect(decodeWrite({ type: "fixed_time", timeOfDay: "09:00", timeZone: "UTC" }).type).toBe(
      "fixed_time",
    );
    expect(() =>
      decodeWrite({ type: "fixed_time", timeOfDay: "09:00", timeZone: "Nowhere/Land" }),
    ).toThrow(/time zone/);
  });
});
