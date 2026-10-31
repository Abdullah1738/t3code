/// <reference types="node" />
// @effect-diagnostics nodeBuiltinImport:off - the TZ subprocess check spawns Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { ageView, clockLabel, formatDayLabel, formatTimeOfDay } from "./time.ts";

const NOW = Date.parse("2026-10-17T08:33:00.000Z");
const TIME_MODULE = NodeURL.fileURLToPath(new URL("./time.ts", import.meta.url));

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

  it("calendar comparisons reuse explicit formatters and preserve local day boundaries", () => {
    // The old algorithm built a calendar formatter on every call; expected labels come from it.
    const oldCalendarDay = (atMs: number, timeZone?: string) =>
      new Intl.DateTimeFormat("en-GB", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        ...(timeZone ? { timeZone } : {}),
      }).format(atMs);
    const oldClockLabel = (atIso: string, nowMs: number, timeZone?: string) => {
      const atMs = Date.parse(atIso);
      if (!Number.isFinite(atMs)) return "";
      return oldCalendarDay(atMs, timeZone) === oldCalendarDay(nowMs, timeZone)
        ? formatTimeOfDay(atIso, timeZone)
        : formatDayLabel(atIso, timeZone);
    };

    const zones: Array<string | undefined> = [
      undefined,
      "",
      "UTC",
      "Asia/Dubai",
      "America/New_York",
      "America/Los_Angeles",
    ];
    const nows = [
      "2026-10-30T00:10:00.000Z",
      "2026-03-08T07:01:00.000Z",
      "2026-11-01T06:01:00.000Z",
    ];
    const ats = [
      "2026-10-30T00:01:00Z",
      "2026-10-29T23:59:00Z",
      "2026-03-08T06:59:00Z",
      "2026-03-08T07:01:00Z",
      "2026-11-01T05:59:00Z",
      "2026-11-01T06:01:00Z",
      "bad",
    ];
    let checked = 0;
    for (const zone of zones)
      for (const now of nows)
        for (const at of ats) {
          expect(clockLabel(at, Date.parse(now), zone)).toBe(
            oldClockLabel(at, Date.parse(now), zone),
          );
          checked++;
        }
    expect(checked).toBe(126);

    // Invalid input behaviour is unchanged.
    expect(clockLabel("not a time", NOW)).toBe("");
    expect(clockLabel("not a time", NOW, "UTC")).toBe("");
    expect(() => clockLabel("2026-10-17T05:06:00Z", Number.NaN)).toThrow(RangeError);
    expect(() => clockLabel("2026-10-17T05:06:00Z", Number.NaN, "UTC")).toThrow(RangeError);
    expect(() => clockLabel("2026-10-17T05:06:00Z", NOW, "Not/AZone")).toThrow(RangeError);

    // Warm the display formatters, then count calendar formatters only (year+month+day options).
    clockLabel("2026-10-17T05:06:00.000Z", NOW);
    clockLabel("2026-10-17T05:06:00.000Z", NOW, "America/New_York");
    clockLabel("2026-10-17T05:06:00.000Z", NOW, "Pacific/Auckland");

    const local = recordCalendarFormatters(() => {
      for (let i = 0; i < 320; i++) {
        clockLabel("2026-10-17T05:06:00.000Z", NOW + i * 60_000);
      }
    });
    expect(local).toHaveLength(0);

    const explicit = recordCalendarFormatters(() => {
      for (let i = 0; i < 50; i++) {
        clockLabel("2026-10-17T05:06:00.000Z", NOW, "America/New_York");
        clockLabel("2026-10-14T19:30:00.000Z", NOW, "Pacific/Auckland");
      }
    });
    expect(explicit.filter((o) => o.timeZone === "America/New_York").length).toBeLessThanOrEqual(1);
    expect(explicit.filter((o) => o.timeZone === "Pacific/Auckland").length).toBeLessThanOrEqual(1);
  });

  for (const [tz, expected] of [
    ["UTC", "Fri 30 Oct"],
    ["Asia/Dubai", "00:10"],
    ["America/New_York", "Fri 30 Oct"],
  ] as const) {
    it(`local day comparison matches the old algorithm under TZ=${tz}`, () => {
      const output = NodeChildProcess.execFileSync(
        process.execPath,
        ["--input-type=module", "-e", LOCAL_SCRIPT],
        {
          env: { ...process.env, TZ: tz },
          encoding: "utf8",
        },
      );
      const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
        checked: number;
        mismatches: unknown[];
        boundary: string;
      };
      expect(result.checked).toBe(21);
      expect(result.mismatches).toEqual([]);
      // 2026-10-30 20:10Z is 00:10 on the 31st in Dubai, the same day as "now"; elsewhere it is still the 30th.
      expect(result.boundary).toBe(expected);
    });
  }
});

function recordCalendarFormatters(run: () => void): Intl.DateTimeFormatOptions[] {
  const original = Intl.DateTimeFormat;
  const created: Intl.DateTimeFormatOptions[] = [];
  const spy = function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    if (options && "year" in options && "month" in options && "day" in options) {
      created.push(options);
    }
    return new original(locale, options);
  };
  Intl.DateTimeFormat = spy as unknown as typeof Intl.DateTimeFormat;
  try {
    run();
  } finally {
    Intl.DateTimeFormat = original;
  }
  return created;
}

// Runs in a child process so TZ applies from startup without mutating this test process.
const LOCAL_SCRIPT = `
const { clockLabel, formatDayLabel, formatTimeOfDay } = await import(${JSON.stringify(TIME_MODULE)});
const cal = (ms) => new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric" }).format(ms);
const old = (at, now) => {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  return cal(ms) === cal(now) ? formatTimeOfDay(at) : formatDayLabel(at);
};
const nows = ["2026-10-30T00:10:00.000Z", "2026-03-08T07:01:00.000Z", "2026-11-01T06:01:00.000Z"];
const ats = ["2026-10-30T00:01:00Z", "2026-10-29T23:59:00Z", "2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:01:00Z", "bad"];
let checked = 0;
const mismatches = [];
for (const now of nows) for (const at of ats) {
  checked++;
  const got = clockLabel(at, Date.parse(now));
  const want = old(at, Date.parse(now));
  if (got !== want) mismatches.push({ at, now, got, want });
}
const boundary = clockLabel("2026-10-30T20:10:00Z", Date.parse("2026-10-31T05:00:00Z"));
console.log(JSON.stringify({ checked, mismatches, boundary }));
`;
