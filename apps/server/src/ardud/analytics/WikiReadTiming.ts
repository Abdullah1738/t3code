import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type Phase =
  | "admission"
  | "readiness"
  | "caller"
  | "board"
  | "metadata"
  | "body"
  | "section"
  | "handler"
  | "encode";

export const observer = Context.Reference<
  ((phase: Phase) => (outcome: { succeeded: boolean; resolved: boolean }) => void) | undefined
>("t3/ardud/analytics/WikiReadTiming", { defaultValue: () => undefined });

// The enclosing wiki deadline owns tracing and snapshots, including unfinished waits.
export const step = Effect.fnUntraced(function* <A, E, R>(
  phase: Phase,
  effect: Effect.Effect<A, E, R>,
) {
  const observe = yield* observer;
  if (observe === undefined) return yield* effect;
  const leave = observe(phase);
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() =>
        leave({
          succeeded: exit._tag === "Success",
          resolved: exit._tag === "Success" && exit.value !== null,
        }),
      ),
    ),
  );
});
