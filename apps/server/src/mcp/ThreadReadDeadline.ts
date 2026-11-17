import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import * as McpCall from "../ardud/analytics/McpCall.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as McpDeadline from "./McpDeadline.ts";

export class ThreadReadTimeoutError extends Schema.TaggedError<ThreadReadTimeoutError>()(
  "ThreadReadTimeoutError",
  {
    phase: Schema.Literals(["lane_wait", "query", "render"]),
    acknowledgement: Schema.Literals(["not_started", "may_have_completed", "completed"]),
    phaseMs: Schema.Struct({
      lane_wait: Schema.Number,
      query: Schema.Number,
      render: Schema.Number,
    }),
  },
) {
  override get message(): string {
    const state =
      this.acknowledgement === "not_started"
        ? "Read-only, nothing changed;"
        : this.acknowledgement === "completed"
          ? "A delegated result was acknowledged; automatic completion delivery may have been cancelled. Retry this read to recover the result;"
          : "A delegated result acknowledgement may still complete and cancel automatic completion delivery. Retry this read to recover the result;";
    return `t3_thread_read timed out during ${this.phase} (lane_wait ${Math.round(this.phaseMs.lane_wait)} ms, query ${Math.round(this.phaseMs.query)} ms, render ${Math.round(this.phaseMs.render)} ms). ${state} retry with a smaller limit, or use task_status for a delegated child's state.`;
  }
}

// Keep the existing operation span stable for read-deadline trace queries.
export const withDeadline = Effect.fn("ThreadReadDeadline.bound")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  yield* ThreadReadMetrics.enterPhase("lane_wait");
  const call = yield* McpCall.McpCall;
  return yield* operation.pipe(
    Effect.timeoutOrElse({
      duration: McpDeadline.READ_TIMEOUT,
      orElse: Effect.fn("ThreadReadDeadline.expired")(
        function* () {
          const timing = ThreadReadMetrics.phaseSnapshot(
            call.threadRead!.phase!,
            yield* Clock.monotonicTimeNanos,
          );
          yield* McpCall.failedPhase(timing.phase);
          return yield* Effect.fail(
            new ThreadReadTimeoutError({
              ...timing,
              acknowledgement: call.threadRead?.acknowledgement ?? "not_started",
            }),
          );
        },
        Effect.catchTags({
          ThreadReadTimeoutError: (error) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: "text", text: error.message }],
                structuredContent: {
                  _tag: error._tag,
                  message: error.message,
                  phase: error.phase,
                  phaseMs: error.phaseMs,
                  acknowledgement: error.acknowledgement,
                  saved:
                    error.acknowledgement === "not_started"
                      ? false
                      : error.acknowledgement === "completed"
                        ? true
                        : "unknown",
                },
              }),
            ),
        }),
      ),
    }),
  );
});
