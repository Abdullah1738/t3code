/**
 * Fork-only schedule kinds for scheduled tasks: five-field cron expressions and
 * one-time runs, both with an explicit IANA time zone. Naming follows the
 * closed upstream proposal (pingdotgg/t3code#14618) so a future upstream
 * version stays easy to merge.
 */
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "../baseSchemas.ts";

export function isValidTimeZone(zone: string): boolean {
  return Option.isSome(DateTime.zoneMakeNamed(zone));
}

/** Returns a readable problem with a cron expression, or undefined when it is valid. */
export function cronScheduleProblem(expression: string, timeZone: string): string | undefined {
  if (expression.trim().split(/\s+/).length !== 5) {
    return "Use a five-field cron expression: minute hour day-of-month month day-of-week.";
  }
  if (!isValidTimeZone(timeZone)) return `Unknown time zone '${timeZone}'.`;
  const parsed = Cron.parse(expression, timeZone);
  return Result.isFailure(parsed) ? parsed.failure.message : undefined;
}

const ONCE_AT_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** Returns a readable problem with a one-time timestamp, or undefined when it is valid. */
export function onceScheduleProblem(at: string, timeZone: string | undefined): string | undefined {
  if (!ONCE_AT_PATTERN.test(at) || Option.isNone(DateTime.make(at))) {
    return "Use an ISO timestamp with an explicit offset, such as 2026-10-05T12:55:00+04:00.";
  }
  const year = Number(at.slice(0, 4));
  const month = Number(at.slice(5, 7));
  const day = Number(at.slice(8, 10));
  // Date rolls 2026-02-31 over into March; reject it instead.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return "The timestamp has an impossible calendar date.";
  }
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    return `Unknown time zone '${timeZone}'.`;
  }
  return undefined;
}

const TimeZone = TrimmedNonEmptyString.annotate({
  description: "IANA time zone, such as Asia/Dubai, Europe/Berlin, or UTC.",
});

export const ScheduledTaskCronSchedule = Schema.Struct({
  type: Schema.Literal("cron").annotate({ description: "Select cron scheduling." }),
  expression: TrimmedNonEmptyString.annotate({
    description: "Five-field cron expression: minute hour day-of-month month day-of-week.",
  }),
  timeZone: TimeZone,
}).annotate({
  description: "Run whenever a five-field cron expression matches in the given time zone.",
});
export type ScheduledTaskCronSchedule = typeof ScheduledTaskCronSchedule.Type;

export const ScheduledTaskOnceSchedule = Schema.Struct({
  type: Schema.Literal("once").annotate({ description: "Select a single run." }),
  at: IsoDateTime.annotate({
    description: "When to run, as an ISO timestamp with an explicit offset.",
  }),
  timeZone: Schema.optional(
    TimeZone.annotate({ description: "Time zone used to show and edit the run time." }),
  ),
}).annotate({
  description: "Run once at a specific time, then disable the task.",
});
export type ScheduledTaskOnceSchedule = typeof ScheduledTaskOnceSchedule.Type;

export const ScheduledTaskUpsertCronSchedule = ScheduledTaskCronSchedule.check(
  Schema.makeFilter(
    (schedule) => cronScheduleProblem(schedule.expression, schedule.timeZone) ?? true,
  ),
);

export const ScheduledTaskUpsertOnceSchedule = ScheduledTaskOnceSchedule.check(
  Schema.makeFilter((schedule) => onceScheduleProblem(schedule.at, schedule.timeZone) ?? true),
);

/** Optional time zone for fixed-time schedules; omitted means the server's local zone. */
export const ScheduledTaskFixedTimeZone = Schema.optional(
  TimeZone.annotate({
    description: "Optional IANA time zone for the wall-clock time. Omit to use the server's zone.",
  }),
);

export const fixedTimeZoneProblem = (timeZone: string | undefined): string | true =>
  timeZone === undefined || isValidTimeZone(timeZone) ? true : `Unknown time zone '${timeZone}'.`;
