import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Prefix = "t3.delegate" | "t3.task";
class Operation extends Context.Service<
  Operation,
  {
    readonly prefix: Prefix;
    readonly enter: (stage: string) => Effect.Effect<void>;
    readonly leave: Effect.Effect<void>;
  }
>()("t3/ardud/observability/McpTaskTrace/Operation") {}

const isFailure = Schema.is(OrchestratorMcpFailure);

// The service span owns these timings, including reads in detached fibers.
export const withTrace = (prefix: Prefix) =>
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const span = yield* Effect.option(Effect.currentSpan);
    if (Option.isNone(span)) return yield* effect;
    const totals = new Map<string, number>();
    let active: { stage: string; since: bigint } | undefined;
    let closed = false;
    const leave = Effect.gen(function* () {
      if (closed || active === undefined) return;
      const now = yield* Clock.monotonicTimeNanos;
      const elapsed = (totals.get(active.stage) ?? 0) + Number(now - active.since) / 1_000_000;
      totals.set(active.stage, elapsed);
      span.value.attribute(`${prefix}.stage_ms.${active.stage}`, elapsed);
      active = undefined;
    });
    const operation = Operation.of({
      prefix,
      // Entering a stage annotates the existing service span.
      enter: Effect.fnUntraced(function* (stage: string) {
        if (closed) return;
        yield* leave;
        span.value.attribute(`${prefix}.stage`, stage);
        active = { stage, since: yield* Clock.monotonicTimeNanos };
      }),
      leave,
    });
    return yield* effect.pipe(
      Effect.provideService(Operation, operation),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // Snapshot a blocked read before the exporter ends the caller's span;
          // late cleanup of an uninterruptible read must not change it afterwards.
          yield* leave;
          closed = true;
          if (exit._tag === "Success") return;
          const error = Cause.findErrorOption(exit.cause);
          const code =
            Option.isSome(error) && isFailure(error.value) ? error.value.code : undefined;
          if (prefix === "t3.delegate") {
            span.value.attribute(
              `${prefix}.outcome`,
              code === "delegation_timeout"
                ? "timeout_dispatch"
                : (code ?? (Cause.hasInterrupts(exit.cause) ? "interrupted" : "defect")),
            );
          } else {
            span.value.attribute(
              `${prefix}.result`,
              code === "task_not_found"
                ? String(span.value.attributes.get("t3.task.task_id") ?? "").startsWith(
                    "node:delegated-task:",
                  )
                  ? "not_found_in_flight"
                  : "not_found"
                : (code ?? (Cause.hasInterrupts(exit.cause) ? "interrupted" : "defect")),
            );
          }
        }),
      ),
    );
  });

// Stage names are fixed at the call sites, and reuse the enclosing operation span.
export const stage = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: string,
  prefix: Prefix = "t3.delegate",
) {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || operation.value.prefix !== prefix) return yield* effect;
  yield* operation.value.enter(name);
  return yield* effect.pipe(Effect.ensuring(operation.value.leave));
});
