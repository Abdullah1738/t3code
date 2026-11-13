// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off - The restart marker crosses the process boundary before application services are available.
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const restartMarker = Effect.fn("serverRuntimeStartup.restartMarker")(function* (
  stateDir: string,
) {
  const marker = NodePath.join(stateDir, "restarting");
  yield* Effect.tryPromise(() => NodeFSP.rm(marker, { force: true })).pipe(
    Effect.ignoreCause({ log: true }),
  );
  // Provider teardown and Stop both send TERM. Offbox needs this fact before any children are stopped.
  return Effect.tryPromise(() =>
    NodeFSP.writeFile(marker, JSON.stringify({ pid: process.pid, at: Date.now() / 1000 })),
  ).pipe(Effect.ignoreCause({ log: true }));
});

export const shutdownWithinBudget = Effect.fn("serverRuntimeStartup.shutdownWithinBudget")(
  function* <E1, R1, E2, R2, E3, R3>(input: {
    readonly prepare: Effect.Effect<unknown, E1, R1>;
    readonly closeProviders: Effect.Effect<unknown, E2, R2>;
    readonly checkpoint: Effect.Effect<unknown, E3, R3>;
  }) {
    yield* input.prepare.pipe(
      Effect.interruptible,
      Effect.timeoutOption("2500 millis"),
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
  },
);
