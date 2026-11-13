import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const RestartMarkerJson = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Number, at: Schema.Number }),
);
const encodeRestartMarker = Schema.encodeEffect(RestartMarkerJson);

export const restartMarker = Effect.fn("serverRuntimeStartup.restartMarker")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(stateDir, "restarting");
  yield* fs.remove(marker, { force: true }).pipe(Effect.ignoreCause({ log: true }));
  // Provider teardown and Stop both send TERM. Offbox needs this fact before any children are stopped.
  const mark = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const json = yield* encodeRestartMarker({ pid: process.pid, at: now / 1000 });
    yield* fs.writeFileString(marker, json);
  }).pipe(Effect.ignoreCause({ log: true }));
  return mark;
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
