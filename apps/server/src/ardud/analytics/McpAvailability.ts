import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as StartupPhaseLog from "../observability/StartupPhaseLog.ts";
import * as Analytics from "./Analytics.ts";

export class McpAvailability extends Context.Service<
  McpAvailability,
  {
    readonly reject: () => { readonly bootId: string; readonly phase: string };
    readonly ready: Effect.Effect<void>;
  }
>()("t3/ardud/analytics/McpAvailability") {}

const make = Effect.gen(function* () {
  const startup = yield* StartupPhaseLog.StartupPhaseLog;
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  let count = 0;
  let phase = "boot";
  const bootId = startup.snapshot().bootId;
  const reject = () => {
    const phases = startup.snapshot().phases;
    phase =
      phases.findLast((entry) => entry.outcome === "running")?.phase ??
      phases.at(-1)?.phase ??
      "boot";
    count++;
    return { bootId, phase };
  };
  const flush = Effect.gen(function* () {
    const rejected = count;
    count = 0;
    if (rejected === 0 || Option.isNone(analytics)) return;
    yield* analytics.value.record({
      ts: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      kind: "mcp.unavailable",
      surface: "server",
      route: "mcp",
      bootId,
      props: { reason: "server_starting", phase, count: rejected, status: 503 },
    });
  });
  const worker = yield* Effect.forever(Effect.sleep("10 seconds").pipe(Effect.andThen(flush))).pipe(
    Effect.forkScoped,
  );
  const ready = Fiber.interrupt(worker).pipe(Effect.andThen(flush), Effect.asVoid);
  yield* Effect.addFinalizer(() => ready);
  return McpAvailability.of({ reject, ready });
});

export const layer = Layer.effect(McpAvailability, make);
