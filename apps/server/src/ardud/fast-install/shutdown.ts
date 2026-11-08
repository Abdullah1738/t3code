import * as Effect from "effect/Effect";

export const shutdownWithinBudget = <E1, R1, E2, R2, E3, R3>(input: {
  readonly prepare: Effect.Effect<unknown, E1, R1>;
  readonly closeProviders: Effect.Effect<unknown, E2, R2>;
  readonly checkpoint: Effect.Effect<unknown, E3, R3>;
}) =>
  Effect.gen(function* () {
    yield* input.prepare.pipe(
      Effect.interruptible,
      Effect.timeoutOption("3 seconds"),
      Effect.ignoreCause({ log: true }),
    );
    yield* input.closeProviders.pipe(
      Effect.interruptible,
      Effect.timeoutOption("5 seconds"),
      Effect.ignoreCause({ log: true }),
    );
    yield* input.checkpoint.pipe(
      Effect.interruptible,
      Effect.timeoutOption("500 millis"),
      Effect.ignoreCause({ log: true }),
    );
  });
