import * as Schema from "effect/Schema";

import { ScheduledTaskId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderOptionSelection } from "../model.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

export const ScheduledTaskFallbackModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
});
export type ScheduledTaskFallbackModel = typeof ScheduledTaskFallbackModel.Type;

/**
 * Input for the `t3_scheduled_task_block_retry` MCP tool.
 *
 * A task that starts a new thread on each run can retry once on a fallback
 * model when the provider blocked the response. The blocked thread is left as
 * it is and the retry is never retried.
 */
export const ScheduledTaskBlockRetryMcpInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  fallbacks: Schema.optional(
    Schema.NullOr(
      Schema.Array(ScheduledTaskFallbackModel).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    ),
  ).annotate({
    description:
      "Fallback models tried in order until one starts, for example [{instanceId:'opencode', model:'opus/gpt-6-astra'}, {instanceId:'opencode', model:'layso/gpt-6-astra'}]. null turns the retry off; leave it out to read the current setting.",
  }),
});
export type ScheduledTaskBlockRetryMcpInput = typeof ScheduledTaskBlockRetryMcpInput.Type;

export const ScheduledTaskBlockRetryMcpResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  /** Empty when the task doesn't retry. */
  fallbacks: Schema.Array(ScheduledTaskFallbackModel),
});
export type ScheduledTaskBlockRetryMcpResult = typeof ScheduledTaskBlockRetryMcpResult.Type;
