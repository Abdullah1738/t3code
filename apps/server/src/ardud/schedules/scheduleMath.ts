import type {
  ScheduledTaskCronSchedule,
  ScheduledTaskOnceSchedule,
  ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

/** One-time tasks can catch up for at most 24 hours. */
export const MISSED_ONCE_GRACE_MS = 24 * 60 * MINUTE_MS;

export function nextCronRunAt(
  schedule: ScheduledTaskCronSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  try {
    const cron = Cron.parseUnsafe(schedule.expression, schedule.timeZone);
    return DateTime.makeUnsafe(Cron.next(cron, from));
  } catch {
    return null;
  }
}

/** The single run time, or null once it is no longer in the future. */
export function nextOnceRunAt(
  schedule: ScheduledTaskOnceSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  const at = DateTime.make(schedule.at);
  if (Option.isNone(at)) return null;
  return DateTime.toEpochMillis(at.value) > DateTime.toEpochMillis(from) ? at.value : null;
}

/** Moves `from` into the schedule's zone so wall-clock math happens there. */
export function inScheduleZone(from: DateTime.DateTime, timeZone: string | undefined) {
  if (timeZone === undefined) return from;
  const zone = DateTime.zoneMakeNamed(timeZone);
  return Option.isSome(zone) ? DateTime.setZone(from, zone.value) : from;
}

function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(" ");
}

/** Semantic equality for the fork schedule kinds. Returns undefined for upstream kinds. */
export function isSameForkSchedule(
  a: ScheduledTaskSchedule,
  b: ScheduledTaskSchedule,
): boolean | undefined {
  if (a.type === "cron") {
    return (
      b.type === "cron" &&
      normalizeCron(a.expression) === normalizeCron(b.expression) &&
      a.timeZone === b.timeZone
    );
  }
  if (a.type === "once") {
    if (b.type !== "once") return false;
    const aAt = DateTime.make(a.at);
    const bAt = DateTime.make(b.at);
    return (
      Option.isSome(aAt) &&
      Option.isSome(bAt) &&
      DateTime.toEpochMillis(aAt.value) === DateTime.toEpochMillis(bAt.value)
    );
  }
  return undefined;
}

export function describeForkSchedule(schedule: ScheduledTaskSchedule): string | undefined {
  if (schedule.type === "cron") return `Cron ${schedule.expression} (${schedule.timeZone})`;
  if (schedule.type === "once") {
    return `Once at ${schedule.at}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
  }
  return undefined;
}

/** Wall-clock schedules with multiple hours/minutes are sub-daily, even on selected weekdays. */
export function allowsLateRun(schedule: ScheduledTaskSchedule): boolean {
  if (schedule.type === "once" || schedule.type === "fixed_time") return true;
  if (schedule.type === "interval") return schedule.everyMs >= 86_400_000;
  if (schedule.type !== "cron") return false;
  try {
    const cron = Cron.parseUnsafe(schedule.expression, schedule.timeZone);
    return cron.hours.size === 1 && cron.minutes.size === 1 && cron.seconds.size === 1;
  } catch {
    return false;
  }
}

export function lateRunDeadline(schedule: ScheduledTaskSchedule, slot: DateTime.DateTime) {
  if (schedule.type === "once") return DateTime.toEpochMillis(slot) + MISSED_ONCE_GRACE_MS;
  const zone = "timeZone" in schedule ? schedule.timeZone : undefined;
  const tomorrow = DateTime.setParts(
    DateTime.add(
      zone === undefined
        ? DateTime.setZone(slot, DateTime.zoneMakeLocal())
        : inScheduleZone(slot, zone),
      { days: 1 },
    ),
    {
      hour: 6,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
  );
  return Math.min(
    DateTime.toEpochMillis(slot) + 12 * 60 * MINUTE_MS,
    DateTime.toEpochMillis(tomorrow),
  );
}

/** Normal scheduler polling has a small grace; short intervals cannot reuse older slots. */
export function missedSlotGraceMs(schedule: ScheduledTaskSchedule, due: DateTime.DateTime) {
  if (schedule.type === "interval")
    return Math.min(600_000, Math.max(60_000, schedule.everyMs) - 1);
  if (schedule.type === "cron") {
    const next = nextCronRunAt(schedule, due);
    if (next !== null)
      return Math.min(600_000, DateTime.toEpochMillis(next) - DateTime.toEpochMillis(due) - 1);
  }
  return 600_000;
}
