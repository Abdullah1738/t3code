import type {
  ScheduledTaskCronSchedule,
  ScheduledTaskOnceSchedule,
  ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

/** A one-time run found overdue by more than this is marked missed instead of fired. */
export const MISSED_ONCE_GRACE_MS = 60 * MINUTE_MS;

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
