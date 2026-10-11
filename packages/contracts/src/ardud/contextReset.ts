import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * Input for the `t3_context_reset` MCP tool.
 *
 * Ends the calling agent's provider session in this thread and queues `note`
 * as the first message of a fresh one. The thread itself (history, workspace,
 * model, schedules) stays the same.
 */
export const ContextResetMcpInput = Schema.Struct({
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
    description:
      "Resume note that becomes the only context of the fresh session: the goal, where the plan or notes live, what is done, what is next, and anything the next session must not forget.",
  }),
});
export type ContextResetMcpInput = typeof ContextResetMcpInput.Type;

export const ContextResetMcpResult = Schema.Struct({
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  note: Schema.String,
});
export type ContextResetMcpResult = typeof ContextResetMcpResult.Type;
