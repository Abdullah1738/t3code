import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Analytics from "./Analytics.ts";

export class McpCallLedger extends Context.Service<
  McpCallLedger,
  {
    readonly begin: (
      interrupted: () => Effect.Effect<AnalyticsEvent>,
    ) => Effect.Effect<
      Option.Option<(event: Effect.Effect<AnalyticsEvent>) => Effect.Effect<void>>
    >;
    readonly shutdown: Effect.Effect<void>;
  }
>()("t3/ardud/analytics/McpCallLedger") {}

const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const pending = new Map<symbol, () => Effect.Effect<AnalyticsEvent>>();
  let closing = false;
  // The request already has a span. Tracking only changes bounded call metadata in memory.
  const begin = Effect.fnUntraced(function* (interrupted: () => Effect.Effect<AnalyticsEvent>) {
    return yield* Effect.sync(() => {
      if (closing) return Option.none();
      const id = Symbol();
      pending.set(id, interrupted);
      return Option.some((event: Effect.Effect<AnalyticsEvent>) =>
        Effect.suspend(() => {
          if (!pending.delete(id) || Option.isNone(analytics)) return Effect.void;
          const writer = analytics.value;
          return event.pipe(
            Effect.flatMap((row) => {
              const write = Effect.suspend(() => writer.record(row)).pipe(
                Effect.interruptible,
                Effect.timeout("1 second"),
                Effect.ignoreCause,
              );
              return row.outcome === "interrupted"
                ? write
                : write.pipe(Effect.forkDetach, Effect.asVoid);
            }),
          );
        }),
      );
    });
  });
  const shutdown = Effect.gen(function* () {
    if (closing) return;
    closing = true;
    const calls = [...pending.values()];
    pending.clear();
    if (Option.isNone(analytics)) return;
    const writer = analytics.value;
    // One deadline covers every receipt lookup and the disk drain, rather than one per call.
    yield* Effect.gen(function* () {
      yield* Effect.forEach(calls, (row) => row().pipe(Effect.flatMap(writer.record)), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* writer.flush;
    }).pipe(Effect.interruptible, Effect.timeout("1 second"), Effect.ignoreCause);
  });
  yield* Effect.addFinalizer(() => shutdown);
  return McpCallLedger.of({ begin, shutdown });
});

export const layer = Layer.effect(McpCallLedger, make);
