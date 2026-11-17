import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";
import { McpCall } from "../ardud/analytics/McpCall.ts";

export const withDeadline = Effect.fn("BoundedReadDeadline.bound")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  snapshot: () => { readonly phase: string; readonly waitedMs: number },
) {
  const call = yield* Effect.serviceOption(McpCall);
  let timing: ReturnType<typeof snapshot> | undefined;
  const capture = () => {
    timing ??= snapshot();
    if (Option.isSome(call)) call.value.boundedRead = timing;
    return timing;
  };
  // Capture before cancellation unwinds nested phase scopes. The operation keeps
  // masked cleanup behind awaitInterruptibly inside its admission permit, so this
  // race can join cancellation and release admission before returning.
  const timer = Effect.sleep("20 seconds").pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        capture();
        if (Option.isSome(call)) call.value.readDeadlineExpired = true;
      }),
    ),
    Effect.as(Option.none()),
  );
  const result = yield* operation.pipe(
    Effect.asSome,
    Effect.raceFirst(timer),
    Effect.ensuring(Effect.sync(capture)),
  );
  if (Option.isSome(result)) return result.value;
  if (Option.isSome(call)) {
    call.value.handlerOutcome = "timeout";
    call.value.handlerErrorTag = "TimeoutError";
  }
  return new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: "Robob is busy; nothing was read. Retry the same call." }],
    structuredContent: { reason: "server_busy", ...capture() },
  });
});
