import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { McpCall } from "../ardud/analytics/McpCall.ts";
import * as WikiReadTiming from "../ardud/analytics/WikiReadTiming.ts";
import * as BoundedReadDeadline from "./BoundedReadDeadline.ts";

export const withDeadline = Effect.fn("WikiReadDeadline.bound")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  const clock = yield* Clock.Clock;
  const call = yield* Effect.serviceOption(McpCall);
  const state = call._tag === "Some" ? call.value : undefined;
  const started = clock.monotonicTimeNanosUnsafe();
  const elapsed = () => Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6;
  const totals = new Map<string, number>();
  let phase: WikiReadTiming.Phase = "admission";
  let since = 0;
  let closed = false;
  let callerStarted: number | undefined;
  let readerStarted: number | undefined;
  const account = () => {
    const now = elapsed();
    totals.set(phase, (totals.get(phase) ?? 0) + now - since);
    since = now;
  };
  const freeze = () => {
    if (closed) return;
    account();
    if (readerStarted !== undefined)
      totals.set("reader_wait", (totals.get("reader_wait") ?? 0) + elapsed() - readerStarted);
    if (state !== undefined) {
      state.replyStage = phase;
      state.replySubSteps = [...totals]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, ms]) => ({ subStep: `wiki.${name}`, ms }));
      if (callerStarted !== undefined) state.callerResolveMs += elapsed() - callerStarted;
    }
    closed = true;
  };
  const parentStart = yield* NodeSqliteClient.ReaderWaitStartedObserver;
  const parentWait = yield* NodeSqliteClient.ReaderWaitObserver;
  const parentStatement = yield* NodeSqliteClient.StatementTimingObserver;
  const observeLane = (lane: string | undefined) => {
    if (closed || state === undefined || lane === undefined) return;
    state.readerLane = lane;
    if (phase === "caller") state.callerReaderLane = lane;
  };
  const work = operation.pipe(
    NodeSqliteClient.foregroundReads,
    Effect.provideService(WikiReadTiming.observer, (next) => {
      if (closed) return () => {};
      account();
      const previous = phase;
      phase = next;
      if (next === "caller") callerStarted = elapsed();
      return ({ succeeded, resolved }) => {
        if (closed) return;
        // An interrupted step must retain its phase before outer scopes unwind.
        if (!succeeded) {
          freeze();
          return;
        }
        account();
        if (next === "caller" && state !== undefined && callerStarted !== undefined) {
          state.callerResolveMs += elapsed() - callerStarted;
          state.callerResolved = resolved;
          callerStarted = undefined;
        }
        phase = previous;
      };
    }),
    Effect.provideService(NodeSqliteClient.ReaderWaitStartedObserver, (lane) => {
      if (!closed) {
        readerStarted = elapsed();
        observeLane(lane);
      }
      const finish = parentStart?.(lane);
      return (lane, acquired) => {
        observeLane(lane);
        if (!closed && acquired && lane === "writer" && readerStarted !== undefined) {
          totals.set("reader_wait", (totals.get("reader_wait") ?? 0) + elapsed() - readerStarted);
          readerStarted = undefined;
        }
        finish?.(lane, acquired);
      };
    }),
    Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms, lane) => {
      if (!closed) {
        totals.set("reader_wait", (totals.get("reader_wait") ?? 0) + ms);
        readerStarted = undefined;
        observeLane(lane);
      }
      parentWait?.(ms, lane);
    }),
    Effect.provideService(NodeSqliteClient.StatementTimingObserver, (sample) => {
      if (!closed) {
        totals.set("query", (totals.get("query") ?? 0) + sample.durationMs);
        observeLane(sample.lane ?? sample.connection);
      }
      parentStatement?.(sample);
    }),
  );
  return yield* BoundedReadDeadline.withDeadline(work, () => {
    freeze();
    return { phase, waitedMs: elapsed() };
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => {
        freeze();
        return Effect.annotateCurrentSpan(
          Object.fromEntries([...totals].map(([name, ms]) => [`wiki.phase_ms.${name}`, ms])),
        );
      }),
    ),
  );
});
