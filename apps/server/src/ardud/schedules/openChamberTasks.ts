import {
  ProviderInstanceId,
  type ArdudScheduleImportItem,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The subset of an OpenChamber scheduled task this import reads. */
export const OpenChamberScheduledTask = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  schedule: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("cron"),
      cron: Schema.String,
      timezone: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("once"),
      date: Schema.String,
      time: Schema.String,
      timezone: Schema.optional(Schema.String),
    }),
  ]),
  execution: Schema.Struct({
    prompt: Schema.String,
    providerID: Schema.String,
    modelID: Schema.String,
    variant: Schema.optional(Schema.String),
  }),
});
export type OpenChamberScheduledTask = typeof OpenChamberScheduledTask.Type;

export const OpenChamberProjectFile = Schema.Struct({
  projectPath: Schema.optional(Schema.String),
  scheduledTasks: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** OpenChamber names project files `path_<base64url(workspace root)>.json`. */
export function workspaceRootFromFileName(fileName: string): string | null {
  const match = /^path_(.+)\.json$/.exec(fileName);
  if (!match?.[1]) return null;
  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return null;
  }
}

export function openChamberSchedule(
  schedule: OpenChamberScheduledTask["schedule"],
): ScheduledTaskUpsertSchedule | null {
  const timeZone = schedule.timezone?.trim() || "UTC";
  if (schedule.kind === "cron") {
    return { type: "cron", expression: schedule.cron.trim(), timeZone };
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(schedule.date);
  const time = /^(\d{1,2}):(\d{2})$/.exec(schedule.time);
  if (!date || !time) return null;
  const zoned = DateTime.makeZoned(
    {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: Number(time[1]),
      minute: Number(time[2]),
      second: 0,
      millisecond: 0,
    },
    { timeZone, adjustForTimeZone: true },
  );
  if (Option.isNone(zoned)) return null;
  return {
    type: "once",
    at: DateTime.formatIsoOffset(zoned.value).replace(".000", ""),
    timeZone,
  };
}

export function openChamberTaskToImportItem(
  task: OpenChamberScheduledTask,
  workspaceRoot: string,
): ArdudScheduleImportItem | { readonly problem: string } {
  const schedule = openChamberSchedule(task.schedule);
  if (schedule === null) return { problem: "Unreadable schedule." };
  const variant = task.execution.variant?.trim();
  return {
    sourceId: task.id,
    title: task.name.trim() || "Scheduled task",
    prompt: task.execution.prompt,
    enabled: task.enabled,
    schedule,
    workspaceRoot,
    modelSelection: {
      instanceId: ProviderInstanceId.make("opencode"),
      model: `${task.execution.providerID}/${task.execution.modelID}`,
      ...(variant ? { options: [{ id: "variant", value: variant }] } : {}),
    },
  };
}
