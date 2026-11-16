import * as Schema from "effect/Schema";

export const McpReasonClass = Schema.Literals([
  "missing_required",
  "bad_type",
  "bad_enum",
  "too_long",
  "too_many",
  "bad_time",
  "bad_reference",
  "not_found",
  "duplicate_title",
  "duplicate_link",
  "conflict",
  "stage_not_allowed",
  "not_allowed",
  "operation_failed",
  "board_busy",
  "reply_timeout",
  "other",
]);
export type McpReasonClass = typeof McpReasonClass.Type;

// The MCP transport additionally checks membership in the called tool's input schema.
export const McpInvalidField = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/),
);

export const McpRefusedAt = Schema.Literals(["pre_lock", "in_write", "post_write"]);
