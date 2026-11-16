import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { McpCall } from "./McpCall.ts";

type Metrics = NonNullable<McpCall["Service"]["cardNext"]>;
type Stage = Metrics["stages"][number]["stage"];

// The enclosing service owns tracing; these bounded counters survive detached deadline cleanup.
export const stage = Effect.fnUntraced(function* <A, E, R>(
  name: Stage,
  effect: Effect.Effect<A, E, R>,
) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None" || call.value.cardNext === undefined) return yield* effect;
  const state = call.value;
  const metrics = state.cardNext!;
  const started = yield* Clock.monotonicTimeNanos;
  let row = metrics.stages.find((entry) => entry.stage === name);
  if (row === undefined) {
    row = { stage: name, durationMs: 0, readerWaitMs: 0, queryMs: 0, completed: false };
    metrics.stages.push(row);
  }
  row.completed = false;
  const target = row;
  const active = { started, index: metrics.stages.indexOf(row), durationBefore: row.durationMs };
  metrics.active = active;
  if (name === "caller") {
    state.callerStarted = started;
    state.callerResolved = false;
    state.phase = "caller";
  }
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const ended = yield* Clock.monotonicTimeNanos;
        target.durationMs += Math.max(0, Number(ended - started) / 1e6);
        if (metrics.waitingSince !== undefined) {
          target.readerWaitMs += Math.max(0, Number(ended - metrics.waitingSince) / 1e6);
          delete metrics.waitingSince;
        }
        target.completed = exit._tag === "Success";
        if (metrics.active === active) delete metrics.active;
        if (name === "caller") {
          state.callerResolveMs += target.durationMs - active.durationBefore;
          delete state.callerStarted;
          state.callerResolved = exit._tag === "Success" && exit.value !== null;
          if (state.callerResolved) state.phase = "handler";
        }
      }),
    ),
  );
});

// Observe the actual connection lane, including fallback, without inspecting SQL or arguments.
export const observe = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "None") return yield* effect;
  const state = call.value;
  const metrics: Metrics = { stages: [] };
  state.cardNext = metrics;
  state.readerLane = yield* NodeSqliteClient.ReaderLane;
  const clock = yield* Clock.Clock;
  const parentStart = yield* NodeSqliteClient.ReaderWaitStartedObserver;
  const parentWait = yield* NodeSqliteClient.ReaderWaitObserver;
  const parentStatement = yield* NodeSqliteClient.StatementTimingObserver;
  return yield* effect.pipe(
    Effect.provideService(NodeSqliteClient.ReaderWaitStartedObserver, (lane) => {
      state.readerLane = lane;
      metrics.waitingSince = clock.monotonicTimeNanosUnsafe();
      const parentFinish = parentStart?.(lane);
      return (lane, acquired) => {
        // Reader wait totals arrive through ReaderWaitObserver after the grant.
        if (acquired) delete metrics.waitingSince;
        state.readerLane = lane;
        parentFinish?.(lane, acquired);
      };
    }),
    Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms, lane) => {
      const row = metrics.active === undefined ? undefined : metrics.stages[metrics.active.index];
      if (row) row.readerWaitMs += ms;
      delete metrics.waitingSince;
      parentWait?.(ms, lane);
    }),
    Effect.provideService(NodeSqliteClient.StatementTimingObserver, (observation) => {
      const row = metrics.active === undefined ? undefined : metrics.stages[metrics.active.index];
      if (row) row.queryMs += observation.durationMs;
      state.readerLane = observation.lane ?? observation.connection;
      // In-memory databases use the writer and do not report a reader acquisition.
      delete metrics.waitingSince;
      parentStatement?.(observation);
    }),
  );
});

export function snapshot(metrics: Metrics, now: bigint) {
  const cardNextStages = metrics.stages.map((row, index) => ({
    ...row,
    ...(metrics.active?.index === index
      ? {
          durationMs:
            metrics.active.durationBefore + Math.max(0, Number(now - metrics.active.started) / 1e6),
          readerWaitMs:
            row.readerWaitMs +
            (metrics.waitingSince === undefined
              ? 0
              : Math.max(0, Number(now - metrics.waitingSince) / 1e6)),
        }
      : {}),
  }));
  return {
    cardNextStages,
    readerWaitMs: cardNextStages.reduce((sum, row) => sum + row.readerWaitMs, 0),
  };
}
