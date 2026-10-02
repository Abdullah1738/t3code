import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ScheduledTaskId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ScheduledTaskUpsertSchedule } from "../scheduledTask.ts";

export const ARDUD_SCHEDULE_IMPORT_PATH = "/api/ardud/schedules/import";

/** One external scheduled task, already mapped to t3 terms. */
export const ArdudScheduleImportItem = Schema.Struct({
  /** Stable id from the source system; re-importing the same id updates the task. */
  sourceId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  workspaceRoot: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type ArdudScheduleImportItem = typeof ArdudScheduleImportItem.Type;

export const ArdudScheduleImportRequest = Schema.Struct({
  /** Prefix for task ids, e.g. "openchamber". */
  source: TrimmedNonEmptyString,
  dryRun: Schema.Boolean,
  items: Schema.Array(ArdudScheduleImportItem),
});
export type ArdudScheduleImportRequest = typeof ArdudScheduleImportRequest.Type;

export const ArdudScheduleImportOutcome = Schema.Struct({
  sourceId: Schema.String,
  title: Schema.String,
  taskId: ScheduledTaskId,
  workspaceRoot: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  projectAction: Schema.Literals(["existing", "created", "would_create"]),
  taskAction: Schema.Literals(["created", "updated", "would_create", "would_update", "failed"]),
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  note: Schema.NullOr(Schema.String),
});
export type ArdudScheduleImportOutcome = typeof ArdudScheduleImportOutcome.Type;

export const ArdudScheduleImportResult = Schema.Struct({
  dryRun: Schema.Boolean,
  outcomes: Schema.Array(ArdudScheduleImportOutcome),
});
export type ArdudScheduleImportResult = typeof ArdudScheduleImportResult.Type;
