import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ReplyBuilders extends Context.Service<ReplyBuilders, Semaphore.Semaphore>()(
  "t3/ardud/http/ReplyBuilders",
) {}

/** Shared across HTTP and MCP, not one permit pool per board or connection. */
export const layer = Layer.effect(ReplyBuilders, Semaphore.make(2));

export const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(ReplyBuilders), (builders) =>
    builders._tag === "Some"
      ? Effect.suspend(() => {
          const started = performance.now();
          return builders.value.withPermits(1)(
            Effect.suspend(() =>
              Effect.annotateCurrentSpan(
                "reply_builder.admission_wait_ms",
                performance.now() - started,
              ).pipe(Effect.andThen(effect)),
            ),
          );
        })
      : effect,
  );
