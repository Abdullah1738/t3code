import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const ThreadRedactionInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  needleFile: Schema.optional(TrimmedNonEmptyString),
  compact: Schema.optional(Schema.Boolean),
});
export type ThreadRedactionInput = typeof ThreadRedactionInput.Type;

export const ThreadRedactionCount = Schema.Struct({
  store: Schema.String,
  matchedBefore: Schema.Number,
  replaced: Schema.Number,
  remainingAfter: Schema.Number,
});
export type ThreadRedactionCount = typeof ThreadRedactionCount.Type;
export const ThreadRedactionResult = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.String,
  stores: Schema.Array(ThreadRedactionCount),
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      status: Schema.Literals(["rewritten", "unsupported", "missing"]),
    }),
  ),
  checkpointed: Schema.Boolean,
  compacted: Schema.Boolean,
  verify: Schema.Boolean,
});
export type ThreadRedactionResult = typeof ThreadRedactionResult.Type;

export const ThreadItemRedacted = Schema.Struct({
  itemId: Schema.String,
  reason: Schema.String,
  at: Schema.String,
});
