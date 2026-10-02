import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "../baseSchemas.ts";

/**
 * Fork-only session board (ported from OpenChamber). Lanes:
 * running, waiting (for review), backlog, scheduled (automated runs).
 */
export const ArdudBoardLane = Schema.Literals(["running", "waiting", "backlog", "scheduled"]);
export type ArdudBoardLane = typeof ArdudBoardLane.Type;

export const ArdudBoardAttention = Schema.Struct({
  kind: Schema.Literals(["question", "approval"]),
  count: NonNegativeInt,
});
export type ArdudBoardAttention = typeof ArdudBoardAttention.Type;

export const ArdudBoardEntry = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  state: ArdudBoardLane,
  /** Live run state: an activity run status, `background`, `idle`, `deleted` or `unknown`. */
  status: Schema.String,
  workRevision: NonNegativeInt,
  /** Epoch milliseconds of the latest work on the card. */
  updatedAt: Schema.Number,
  attention: Schema.optional(ArdudBoardAttention),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  archived: Schema.optional(Schema.Boolean),
});
export type ArdudBoardEntry = typeof ArdudBoardEntry.Type;

export const ArdudBoardSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  activatedAt: Schema.Number,
  entries: Schema.Array(ArdudBoardEntry),
  syncError: Schema.NullOr(Schema.String),
});
export type ArdudBoardSnapshot = typeof ArdudBoardSnapshot.Type;

/** Incremental board change sent over the event stream after the initial snapshot. */
export const ArdudBoardDelta = Schema.Struct({
  revision: NonNegativeInt,
  upserts: Schema.Array(ArdudBoardEntry),
  removed: Schema.Array(ThreadId),
  syncError: Schema.NullOr(Schema.String),
});
export type ArdudBoardDelta = typeof ArdudBoardDelta.Type;

/** The card the user acted on: a review is only valid for the work they saw. */
export const ArdudBoardToken = Schema.Struct({
  threadId: ThreadId,
  workRevision: NonNegativeInt,
});
export type ArdudBoardToken = typeof ArdudBoardToken.Type;

export const ARDUD_BOARD_MAX_BATCH = 500;

export const ArdudBoardClearInput = Schema.Struct({
  lane: Schema.Literals(["waiting", "backlog", "scheduled"]),
  entries: Schema.Array(ArdudBoardToken).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ARDUD_BOARD_MAX_BATCH),
  ),
});
export type ArdudBoardClearInput = typeof ArdudBoardClearInput.Type;

export const ArdudBoardClearSkipReason = Schema.Literals([
  "stale",
  "cleared",
  "running",
  "changed",
]);

export const ArdudBoardClearResult = Schema.Struct({
  ...ArdudBoardSnapshot.fields,
  cleared: Schema.Array(ThreadId),
  skipped: Schema.Array(Schema.Struct({ threadId: ThreadId, reason: ArdudBoardClearSkipReason })),
});
export type ArdudBoardClearResult = typeof ArdudBoardClearResult.Type;

export const ArdudBoardImportInput = Schema.Struct({
  /** Defaults to ~/.config/openchamber/session-board.json. */
  path: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
});
export type ArdudBoardImportInput = typeof ArdudBoardImportInput.Type;

export const ArdudBoardImportResult = Schema.Struct({
  dryRun: Schema.Boolean,
  source: Schema.String,
  total: NonNegativeInt,
  imported: NonNegativeInt,
  unmapped: NonNegativeInt,
  children: NonNegativeInt,
  keptNewer: NonNegativeInt,
  missingThreads: NonNegativeInt,
  origins: NonNegativeInt,
  lanes: Schema.Struct({
    waiting: NonNegativeInt,
    backlog: NonNegativeInt,
    scheduled: NonNegativeInt,
    reviewed: NonNegativeInt,
  }),
});
export type ArdudBoardImportResult = typeof ArdudBoardImportResult.Type;
