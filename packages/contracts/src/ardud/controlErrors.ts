import * as Schema from "effect/Schema";

export const ControlRejectionReason = Schema.Literals([
  "no_steerable_turn",
  "thread_archived",
  "request_resolved",
  "attempt_changed",
  "run_not_interruptible",
  "run_not_found",
  "command_id_conflict",
  "command_rejected",
  "operation_conflict",
  "startup_unavailable",
  "send_timeout",
  "reader_unavailable",
  // Existing archive-if-idle reasons remain compatible with control clients.
  "archived",
  "running",
  "queued",
  "pending-request",
  "background-work",
  "pending-wake",
  "session-changed",
  "changed",
]);
export type ControlRejectionReason = typeof ControlRejectionReason.Type;

export const ControlRejectionHolder = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  requestId: Schema.optional(Schema.String),
});
export type ControlRejectionHolder = typeof ControlRejectionHolder.Type;

export const ControlRejection = Schema.Struct({
  reason: ControlRejectionReason,
  // Safe only for the identical request with its original clientRequestId.
  retrySafe: Schema.Boolean,
  holder: Schema.NullOr(ControlRejectionHolder),
});
export type ControlRejection = typeof ControlRejection.Type;

export const ControlErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  reason: Schema.optional(ControlRejectionReason),
  retrySafe: Schema.optional(Schema.Boolean),
  holder: Schema.optional(Schema.NullOr(ControlRejectionHolder)),
});
export type ControlErrorBody = typeof ControlErrorBody.Type;
