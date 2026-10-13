import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "../baseSchemas.ts";

/**
 * Fork-only session board snapshot (ported from OpenChamber), served read-only
 * at GET /api/ardud/board for the telegram bridge. Lanes: running, waiting
 * (for review), backlog, scheduled (automated runs).
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
