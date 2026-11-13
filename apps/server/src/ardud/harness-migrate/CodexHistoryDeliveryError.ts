import * as Data from "effect/Data";

// This error is only emitted before thread/inject_items is invoked.
export class CodexHistoryNotSentError extends Data.TaggedError("CodexHistoryNotSentError")<{
  readonly cause: unknown;
}> {}
