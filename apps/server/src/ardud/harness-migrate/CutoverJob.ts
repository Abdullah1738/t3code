import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Cutover from "./CutoverEngine.ts";

export class CutoverJob extends Context.Service<
  CutoverJob,
  {
    readonly start: () => Effect.Effect<Cutover.CutoverStatus, Cutover.CutoverError>;
  }
>()("t3/ardud/harness-migrate/CutoverJob") {}

export const layer = Layer.effect(
  CutoverJob,
  Effect.gen(function* () {
    const cutover = yield* Cutover.HarnessCutover;
    const scope = yield* Effect.scope;
    const active = yield* Ref.make(false);
    const lock = yield* Semaphore.make(1);
    const start = Effect.fn("CutoverJob.start")(function* () {
      if (yield* Ref.get(active)) return yield* cutover.status();
      const first = yield* cutover.run();
      if (first.completed || first.refusals.length > 0) return first;
      yield* Ref.set(active, true);
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            // Provider acceptance and owner answers arrive independently; no writer or board lock is held here.
            yield* Effect.sleep("2 seconds");
            const state = yield* cutover.run();
            if (
              state.completed ||
              state.refusals.length > 0 ||
              (state.items
                .filter((item) => item.kind !== "finalize")
                .every(
                  (item) =>
                    item.state === "briefed" ||
                    (item.state === "switched" && item.kind !== "thread") ||
                    item.attempts >= 3,
                ) &&
                state.items.some((item) => item.attempts >= 3))
            )
              return;
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Harness cutover job paused", { cause })),
          Effect.ensuring(Ref.set(active, false)),
        ),
        scope,
      );
      return first;
    }, lock.withPermits(1));
    return CutoverJob.of({ start });
  }),
);
