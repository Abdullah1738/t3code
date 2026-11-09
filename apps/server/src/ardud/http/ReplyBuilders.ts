import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export type Lane = "interactive" | "agent";

export class ReplyBuilders extends Context.Service<
  ReplyBuilders,
  { readonly interactive: Semaphore.Semaphore; readonly agent: Semaphore.Semaphore }
>()("t3/ardud/http/ReplyBuilders") {}

// Reserve UI capacity without letting bulk reads borrow it. Four admitted 16 MiB replies
// cap concurrent payload construction at 64 MiB, excluding object/encoding overhead.
// Each lane is shared across connections, not allocated per board or request.
export const layer = Layer.effect(
  ReplyBuilders,
  Effect.gen(function* () {
    return { interactive: yield* Semaphore.make(2), agent: yield* Semaphore.make(2) };
  }),
);

export const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, lane: Lane = "agent") =>
  Effect.flatMap(Effect.serviceOption(ReplyBuilders), (builders) =>
    builders._tag === "Some"
      ? Effect.suspend(() => {
          const started = performance.now();
          return builders.value[lane].withPermits(1)(
            Effect.suspend(() =>
              Effect.annotateCurrentSpan({
                "reply_builder.admission_wait_ms": performance.now() - started,
                "reply_builder.lane": lane,
              }).pipe(Effect.andThen(effect)),
            ),
          );
        })
      : effect,
  );

export const interactive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  bounded(effect, "interactive");
