import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import * as McpDeadline from "./McpDeadline.ts";

class ThreadReadTimeoutError extends Schema.TaggedError<ThreadReadTimeoutError>()(
  "ThreadReadTimeoutError",
  {},
) {
  override get message(): string {
    return "Thread read timed out after 55 seconds. No thread content was changed. Retry with a smaller limit or runLimit.";
  }
}

// Cover admission as well as the handler. Masked SQLite cleanup must not hold the reply.
export const bound = Effect.fn("ThreadReadDeadline.bound")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  return yield* operation.pipe(
    McpDeadline.awaitInterruptibly,
    Effect.timeoutOrElse({
      duration: "55 seconds",
      orElse: () => {
        const error = new ThreadReadTimeoutError();
        const content = { _tag: error._tag, message: error.message };
        return Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            structuredContent: content,
            content: [{ type: "text", text: JSON.stringify(content) }],
          }),
        );
      },
    }),
  );
});
