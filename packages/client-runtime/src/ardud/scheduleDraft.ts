import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  cronScheduleProblem,
  isValidTimeZone,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

export type ForkScheduleMode = "cron" | "once";

export interface ForkScheduleDraft {
  readonly cronExpression: string;
  /** Wall-clock date and time for a one-time run, in `YYYY-MM-DDTHH:MM` form. */
  readonly onceLocal: string;
  /** IANA zone used by cron, once, and optionally fixed-time schedules. */
  readonly timeZone: string;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function supportedTimeZones(): ReadonlyArray<string> {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC"];
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function wallClock(value: DateTime.DateTime): string {
  const p = DateTime.toParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Converts a wall-clock `YYYY-MM-DDTHH:MM` in a zone to an ISO timestamp with
 * that zone's offset, e.g. `2026-10-05T12:55:00+04:00`.
 */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const zoned = DateTime.makeZoned(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { timeZone, adjustForTimeZone: true },
  );
  if (Option.isNone(zoned)) return null;
  return DateTime.formatIsoOffset(zoned.value).replace(/\.000(?=[+-Z])/, "");
}

/** Converts an ISO instant to the wall-clock `YYYY-MM-DDTHH:MM` in a zone. */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const zoned = DateTime.makeZoned(iso, { timeZone });
  return Option.isSome(zoned) ? wallClock(zoned.value) : "";
}

export function defaultForkScheduleDraft(
  now: DateTime.DateTime = DateTime.nowUnsafe(),
): ForkScheduleDraft {
  const timeZone = browserTimeZone();
  // About an hour ahead, rounded up to five minutes.
  const inAnHour = Math.ceil((DateTime.toEpochMillis(now) + 60 * 60_000) / 300_000) * 300_000;
  return {
    cronExpression: "0 9 * * 1-5",
    onceLocal: isoToZonedLocal(DateTime.formatIso(DateTime.makeUnsafe(inAnHour)), timeZone),
    timeZone,
  };
}

export function forkScheduleDraftFor(schedule: ScheduledTaskSchedule): ForkScheduleDraft {
  const base = defaultForkScheduleDraft();
  if (schedule.type === "cron") {
    return { ...base, cronExpression: schedule.expression, timeZone: schedule.timeZone };
  }
  if (schedule.type === "once") {
    const timeZone = schedule.timeZone ?? base.timeZone;
    return { ...base, onceLocal: isoToZonedLocal(schedule.at, timeZone), timeZone };
  }
  if (schedule.type === "fixed_time" && schedule.timeZone) {
    return { ...base, timeZone: schedule.timeZone };
  }
  return base;
}

/** Builds a cron or once schedule from the draft, or returns a readable problem. */
export function forkScheduleFromDraft(
  mode: ForkScheduleMode,
  draft: ForkScheduleDraft,
): { readonly schedule: ScheduledTaskUpsertSchedule } | { readonly problem: string } {
  const timeZone = draft.timeZone.trim();
  if (!isValidTimeZone(timeZone)) return { problem: `Unknown time zone '${timeZone}'.` };
  if (mode === "cron") {
    const expression = draft.cronExpression.trim().split(/\s+/).join(" ");
    const problem = cronScheduleProblem(expression, timeZone);
    return problem ? { problem } : { schedule: { type: "cron", expression, timeZone } };
  }
  const at = zonedLocalToIso(draft.onceLocal, timeZone);
  if (at === null) return { problem: "Pick a date and time for the one-time run." };
  return { schedule: { type: "once", at, timeZone } };
}

/** Short label for cron and once schedules; undefined for upstream kinds. */
export function forkScheduleLabel(schedule: ScheduledTaskSchedule): string | undefined {
  if (schedule.type === "cron") return `Cron ${schedule.expression} · ${schedule.timeZone}`;
  if (schedule.type === "once") {
    const timeZone = schedule.timeZone ?? browserTimeZone();
    const local = isoToZonedLocal(schedule.at, timeZone).replace("T", " ");
    return `Once ${local || schedule.at} · ${timeZone}`;
  }
  return undefined;
}
