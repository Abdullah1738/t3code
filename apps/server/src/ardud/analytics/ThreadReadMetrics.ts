import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { McpCall } from "./McpCall.ts";

type Stage = NonNullable<McpCall["Service"]["threadRead"]>["threadReadStages"][number]["stage"];

// The service operation already owns a span. Keep stage accounting through interruption,
// independently of trace sampling, without holding a reader during result assembly.
export const read = Effect.fnUntraced(function* <A, E, R>(
  stage: Stage,
  effect: Effect.Effect<A, E, R>,
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (Option.isNone(call) || call.value.threadRead === undefined) return yield* effect;
  const metrics = call.value.threadRead;
  const row = { stage, durationMs: 0, readerWaitMs: 0, queryMs: 0, completed: false };
  const existing = metrics.threadReadStages.find((row) => row.stage === stage);
  if (existing === undefined) metrics.threadReadStages.push(row);
  const target = existing ?? row;
  const parent = yield* NodeSqliteClient.ReaderWaitObserver;
  const parentStatements = yield* NodeSqliteClient.StatementObserver;
  const started = yield* Clock.monotonicTimeNanos;
  const activeStage = { row: target, started, durationBefore: target.durationMs };
  metrics.activeStage = activeStage;
  target.completed = false;
  return yield* effect.pipe(
    Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms) => {
      target.readerWaitMs += ms;
      metrics.readerWaitMs += ms;
      parent?.(ms);
    }),
    Effect.provideService(NodeSqliteClient.StatementObserver, {
      slowThresholdMs: 0,
      record: (observation) => {
        // Statement observers start on an acquired connection; waitMs is
        // separate acquisition metadata and must not be subtracted again.
        target.queryMs += observation.durationMs;
        metrics.queryMs += observation.durationMs;
        return parentStatements !== undefined &&
          observation.durationMs >= parentStatements.slowThresholdMs
          ? parentStatements.record(observation)
          : Effect.void;
      },
    }),
    Effect.ensuring(
      Effect.gen(function* () {
        const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
        target.durationMs += elapsed;
        target.completed = true;
        if (metrics.activeStage === activeStage) delete metrics.activeStage;
      }),
    ),
  );
});

export const render = Effect.fnUntraced(function* <A>(build: () => A) {
  const call = yield* Effect.serviceOption(McpCall);
  const started = yield* Clock.monotonicTimeNanos;
  return yield* Effect.sync(build).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (Option.isSome(call) && call.value.threadRead !== undefined)
          call.value.threadRead.renderMs +=
            Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
      }),
    ),
  );
});

// Shutdown records the ledger before interrupting request fibers. Copy the active
// duration now, without waiting for a database stage's finalizer to run.
export function snapshot(metrics: NonNullable<McpCall["Service"]["threadRead"]>, now: bigint) {
  return {
    readerWaitMs: metrics.readerWaitMs,
    queryMs: metrics.queryMs,
    renderMs: metrics.renderMs,
    threadReadStages: metrics.threadReadStages.map((row) => ({
      ...row,
      durationMs:
        metrics.activeStage?.row === row
          ? metrics.activeStage.durationBefore +
            Math.max(0, Number(now - metrics.activeStage.started) / 1e6)
          : row.durationMs,
    })),
  };
}
