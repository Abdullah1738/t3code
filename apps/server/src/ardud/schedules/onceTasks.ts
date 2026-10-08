import type { ScheduledTaskSchedule, ScheduledTaskUpsertSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** True for a one-time schedule whose run time is not in the future. */
export function onceRunInPast(
  schedule: ScheduledTaskSchedule | ScheduledTaskUpsertSchedule,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "once") return false;
  const at = DateTime.make(schedule.at);
  return Option.isNone(at) || DateTime.toEpochMillis(at.value) <= DateTime.toEpochMillis(now);
}

export const ONCE_IN_PAST_MESSAGE =
  "The one-time run is in the past. Pick a future time or leave the task disabled.";
