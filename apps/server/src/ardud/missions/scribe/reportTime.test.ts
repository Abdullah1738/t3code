import { describe, expect, it } from "@effect/vitest";

import { dayWindow, reportPeriod, reportTitle, reportZone, zoneLabel } from "./reportTime.ts";

const dubai = reportZone({ reports: { dayBoundary: "Asia/Dubai" } });
const berlin = reportZone({ reports: { dayBoundary: "Europe/Berlin" } });
// Santiago skips its midnight on Sunday 6 Sep 2026: that day starts at 01:00.
const santiago = reportZone({ reports: { dayBoundary: "America/Santiago" } });

describe("report zones", () => {
  it("reads the day boundary zone and ignores a missing or unknown one", () => {
    expect(dubai).not.toBeNull();
    expect(reportZone(null)).toBeNull();
    expect(reportZone({})).toBeNull();
    expect(reportZone({ reports: {} })).toBeNull();
    expect(reportZone({ reports: { dayBoundary: "Mars/Olympus" } })).toBeNull();
  });

  it("labels a zone by its city", () => {
    expect(zoneLabel(dubai!)).toBe("Dubai");
    expect(zoneLabel(reportZone({ reports: { dayBoundary: "America/New_York" } })!)).toBe(
      "New York",
    );
  });
});

describe("day windows", () => {
  it("covers the last whole day there when no end is given", () => {
    // 14:00 in Dubai on Thursday: the last whole Dubai day is Wednesday.
    expect(dayWindow(dubai!, { nowIso: "2026-10-22T10:00:00.000Z" })).toEqual({
      from: "2026-10-20T20:00:00.000Z",
      to: "2026-10-21T20:00:00.000Z",
    });
    // 00:30 in Dubai is already the next day there.
    expect(dayWindow(dubai!, { nowIso: "2026-10-22T20:30:00.000Z" })).toEqual({
      from: "2026-10-21T20:00:00.000Z",
      to: "2026-10-22T20:00:00.000Z",
    });
  });

  it("ends at the given time and goes one wall-clock day back", () => {
    expect(
      dayWindow(dubai!, { toIso: "2026-10-22T20:00:00.000Z", nowIso: "2026-10-30T00:00:00.000Z" }),
    ).toEqual({ from: "2026-10-21T20:00:00.000Z", to: "2026-10-22T20:00:00.000Z" });
  });

  it("makes the day of a DST change 25 hours long", () => {
    // Berlin leaves summer time on Sunday 25 Oct 2026.
    expect(
      dayWindow(berlin!, { toIso: "2026-10-25T23:00:00.000Z", nowIso: "2026-10-26T12:00:00.000Z" }),
    ).toEqual({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z" });
  });

  it("starts each day at its own start when a midnight is skipped", () => {
    // Saturday ends at Sunday's 01:00 start; Saturday itself starts at midnight.
    expect(dayWindow(santiago!, { nowIso: "2026-09-06T12:00:00.000Z" })).toEqual({
      from: "2026-09-05T04:00:00.000Z",
      to: "2026-09-06T04:00:00.000Z",
    });
    // Sunday is 23 hours, from its 01:00 start to Monday's midnight.
    expect(dayWindow(santiago!, { nowIso: "2026-09-07T12:00:00.000Z" })).toEqual({
      from: "2026-09-06T04:00:00.000Z",
      to: "2026-09-07T03:00:00.000Z",
    });
  });

  it("keeps a rolling day for an end that isn't a day start", () => {
    expect(
      dayWindow(dubai!, { toIso: "2026-10-22T04:30:00.000Z", nowIso: "2026-10-30T00:00:00.000Z" }),
    ).toEqual({ from: "2026-10-21T04:30:00.000Z", to: "2026-10-22T04:30:00.000Z" });
  });
});

describe("report periods", () => {
  it("keeps the UTC labels for a mission without a zone", () => {
    expect(reportPeriod("2026-10-21T00:00:00.000Z", "2026-10-21T04:00:00.000Z")).toBe(
      "21 Oct 00:00–04:00 UTC",
    );
    expect(reportPeriod("2026-10-20T04:30:00.000Z", "2026-10-21T04:30:00.000Z")).toBe(
      "20 Oct 04:30 – 21 Oct 04:30 UTC",
    );
    expect(reportPeriod("2026-10-20T20:00:00.000Z", "2026-10-21T20:00:00.000Z")).toBe(
      "20 Oct 20:00 – 21 Oct 20:00 UTC",
    );
  });

  it("uses wall times in the mission zone", () => {
    expect(reportPeriod("2026-10-21T00:00:00.000Z", "2026-10-21T04:00:00.000Z", dubai)).toBe(
      "21 Oct 04:00–08:00 Dubai",
    );
    expect(reportPeriod("2026-10-20T18:00:00.000Z", "2026-10-20T22:00:00.000Z", dubai)).toBe(
      "20 Oct 22:00 – 21 Oct 02:00 Dubai",
    );
  });

  it("names a whole day in the mission zone, and only a whole day", () => {
    expect(reportPeriod("2026-10-20T20:00:00.000Z", "2026-10-21T20:00:00.000Z", dubai)).toBe(
      "Wed 21 Oct (Dubai day)",
    );
    expect(reportPeriod("2026-10-19T20:00:00.000Z", "2026-10-21T20:00:00.000Z", dubai)).toBe(
      "20 Oct 00:00 – 22 Oct 00:00 Dubai",
    );
    expect(reportPeriod("2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", berlin)).toBe(
      "Sun 25 Oct (Berlin day)",
    );
    expect(reportPeriod("2026-09-05T04:00:00.000Z", "2026-09-06T04:00:00.000Z", santiago)).toBe(
      "Sat 5 Sep (Santiago day)",
    );
    expect(reportPeriod("2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z", santiago)).toBe(
      "Sun 6 Sep (Santiago day)",
    );
  });

  it("returns nothing for a bound that is not a time", () => {
    expect(reportPeriod("soon", "2026-10-21T04:00:00.000Z", dubai)).toBe("");
  });
});

describe("report titles", () => {
  it("takes the first heading, else names the kind", () => {
    expect(reportTitle({ kind: "daily", head: "\n# Crpko daily, Wed 21 Oct 2026\n\nbody" })).toBe(
      "Crpko daily, Wed 21 Oct 2026",
    );
    expect(reportTitle({ kind: "daily", head: "no heading" })).toBe("Daily report");
    expect(reportTitle({ kind: "update", head: "" })).toBe("Update");
  });
});
