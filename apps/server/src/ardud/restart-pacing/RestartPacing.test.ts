import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../../serverSettings.ts";
import * as RestartPacing from "./RestartPacing.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import type { RestartSource } from "./RestartPacingState.ts";

const source = (id: number): RestartSource => ({
  threadId: ThreadId.make(`thread:${id}`),
  sourceRunId: RunId.make(`run:${id}`),
});
const harness = (options: { maxActive?: number; spacingMs?: number } = {}) => {
  const running = new Set<string>();
  const priorities = new Map<string, number>();
  const cancelled = new Set<string>();
  const positions: Array<{ id: string; position: number | null }> = [];
  let load = 0;
  let failActive = false;
  const layer = RestartPacing.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ restartPacing: options }),
        Layer.succeed(RestartPacingState.RestartPacingState, {
          pending: (input) =>
            Effect.sync(
              () => !cancelled.has(input.sourceRunId) && !cancelled.has(input.effectId ?? ""),
            ),
          sourceForRun: () => Effect.succeed(undefined),
          describe: (input) =>
            Effect.sync(() => ({
              priority: priorities.get(input.sourceRunId) ?? 3,
              activityAt: Number(input.sourceRunId.split(":")[1]),
            })),
          active: (input) =>
            failActive
              ? Effect.fail(
                  new RestartPacingState.RestartPacingStateError({
                    cause: "temporary read failure",
                  }),
                )
              : Effect.sync(() => running.has(input.sourceRunId)),
          status: (input, position) =>
            Effect.sync(() => {
              positions.push({ id: input.sourceRunId, position });
              return true;
            }),
        }),
        Layer.succeed(RestartPacing.RestartLoad, () => load),
      ),
    ),
  );
  return {
    layer,
    running,
    cancelled,
    failActive: (value: boolean) => {
      failActive = value;
    },
    priorities,
    positions,
    setLoad: (value: number) => {
      load = value;
    },
  };
};

it.effect("ten continuations retain slots after dispatch until their provider turns settle", () => {
  const h = harness({ maxActive: 3, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const queued = Array.from({ length: 10 }, (_, id) => source(id));
    for (const input of queued) yield* pacing.register(input);
    const starts: string[] = [];
    while (starts.length < queued.length) {
      for (const input of queued.toReversed()) {
        if (starts.includes(input.sourceRunId)) continue;
        if ((yield* pacing.acquire(input)) === 0) {
          h.running.add(input.sourceRunId);
          starts.push(input.sourceRunId);
          yield* pacing.dispatched(input);
          assert.isAtMost(h.running.size, 3);
        }
      }
      assert.equal(h.running.size, Math.min(3, queued.length - (starts.length - h.running.size)));
      h.running.clear();
    }
    assert.equal(starts.length, 10);
  }).pipe(Effect.provide(h.layer));
});

it.effect("an owner thread registered last starts before evaluators and board workers", () => {
  const h = harness({ spacingMs: 0 });
  const owner = source(0);
  h.priorities.set(owner.sourceRunId, 0);
  h.priorities.set(source(1).sourceRunId, 1);
  h.priorities.set(source(2).sourceRunId, 2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    for (const input of [source(3), source(2), source(1), owner]) yield* pacing.register(input);
    assert.isAbove(yield* pacing.acquire(source(3)), 0);
    assert.equal(yield* pacing.acquire(owner), 0);
    h.running.add(owner.sourceRunId);
    assert.equal(yield* pacing.acquire(source(1)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([false, true])(
  "a replacement start restores its waiting position when the old effect settled: %s",
  (settled) => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const blocker = source(0);
      assert.equal(yield* pacing.acquire(blocker), 0);
      h.running.add(blocker.sourceRunId);
      yield* pacing.dispatched(blocker);
      const original = { ...source(1), effectId: "start:old" };
      assert.equal(yield* pacing.acquire(original), 15_000);
      if (settled) h.cancelled.add(original.effectId);
      h.positions.length = 0;
      const replacement = { ...original, effectId: "start:replacement" };
      assert.equal(yield* pacing.acquire(replacement), 15_000);
      assert.deepEqual(h.positions, [{ id: original.sourceRunId, position: 1 }]);
      h.running.clear();
      h.setLoad(2);
      assert.equal(yield* pacing.acquire(replacement), 15_000);
      yield* TestClock.adjust("20 minutes");
      assert.equal(yield* pacing.acquire(replacement), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("load holds until the next check after load drops", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 15_000);
    yield* TestClock.adjust("15 seconds");
    assert.equal(yield* pacing.acquire(source(1)), 15_000);
    h.setLoad(0);
    yield* TestClock.adjust("15 seconds");
    assert.equal(yield* pacing.acquire(source(1)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("pruning an old effect preserves the run's cumulative load hold", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  h.priorities.set(source(0).sourceRunId, 0);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const original = { ...source(0), effectId: "start:before-requeue" };
    assert.equal(yield* pacing.acquire(original), 15_000);
    yield* TestClock.adjust("19 minutes");
    assert.equal(yield* pacing.acquire(original), 15_000);
    h.cancelled.add(original.effectId);
    assert.equal(yield* pacing.acquire(source(1)), 15_000);
    yield* TestClock.adjust("1 minute");
    assert.equal(yield* pacing.acquire({ ...original, effectId: "start:after-requeue" }), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a sustained load hold is capped at twenty minutes per run", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    yield* TestClock.adjust("19 minutes");
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    yield* TestClock.adjust("1 minute");
    assert.equal(yield* pacing.acquire(source(1)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("spacing admits another start after twenty seconds, never over the active limit", () => {
  const h = harness({ maxActive: 2 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    h.running.add(source(1).sourceRunId);
    yield* pacing.dispatched(source(1));
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust("20 seconds");
    assert.equal(yield* pacing.acquire(source(2)), 0);
    h.running.add(source(2).sourceRunId);
    yield* pacing.dispatched(source(2));
    yield* TestClock.adjust("20 minutes");
    assert.isAbove(yield* pacing.acquire(source(3)), 0);
    h.running.delete(source(1).sourceRunId);
    assert.equal(yield* pacing.acquire(source(3)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a single default continuation adds no delay or waiting notification", () => {
  const h = harness();
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    assert.deepEqual(h.positions, [{ id: source(1).sourceRunId, position: null }]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a declined continuation returns its reservation immediately", () => {
  const h = harness({ maxActive: 1 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    yield* pacing.dispatched(source(1));
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("fresh user turns bypass a full gate and high host load", () => {
  const h = harness({ maxActive: 1 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    h.running.add(source(1).sourceRunId);
    h.setLoad(2);
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    assert.equal(yield* pacing.acquireRun(source(3).threadId, source(3).sourceRunId), 0);
    assert.equal(yield* pacing.acquireRun(source(1).threadId, RunId.make("fresh-user-run")), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "draining durable claims never admits more than K turns; deferred claims keep retry attempts",
  () => {
    const h = harness({ maxActive: 3, spacingMs: 0 });
    const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const executorLayer = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const pacing = yield* RestartPacing.RestartPacing;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Effect.gen(function* () {
              if (effect.request.type !== "provider-runtime.continue") return;
              const input = { threadId: effect.threadId, sourceRunId: effect.request.sourceRunId };
              const delay = yield* pacing.acquire(input);
              if (delay > 0)
                return yield* new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  deferMs: delay,
                });
              h.running.add(input.sourceRunId);
              assert.isAtMost(h.running.size, 3);
              yield* pacing.dispatched(input);
            }).pipe(
              Effect.mapError((cause) =>
                EffectWorker.isOrchestrationEffectExecutionError(cause)
                  ? cause
                  : new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provideMerge(h.layer));
    return Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const pacing = yield* RestartPacing.RestartPacing;
      for (let id = 9; id >= 0; id--) {
        const input = source(id);
        yield* pacing.register(input);
        yield* outbox.enqueue([
          {
            id: `effect:${9 - id}`,
            commandId: CommandId.make(`command:${id}`),
            threadId: input.threadId,
            request: { type: "provider-runtime.continue", sourceRunId: input.sourceRunId },
          },
        ]);
      }
      yield* worker.drain();
      assert.equal(h.running.size, 3);
      const held = Option.getOrThrow(yield* outbox.get("effect:9"));
      assert.equal(held.status, "pending");
      assert.equal(held.attemptCount, 0);
      let admitted = 3;
      while (admitted < 10) {
        h.running.clear();
        yield* TestClock.adjust("15 seconds");
        yield* worker.drain();
        admitted += h.running.size;
        assert.isAtMost(h.running.size, 3);
      }
      assert.equal(admitted, 10);
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(Layer.provideMerge(Layer.mergeAll(outboxLayer, executorLayer))),
      ),
    );
  },
);

it.effect("a fresh user start on the same thread passes a deferred restart claim", () => {
  const h = harness();
  h.setLoad(2);
  let freshStarted = false;
  const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const executorLayer = Layer.effect(
    EffectWorker.OrchestrationEffectExecutorV2,
    Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      return EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          Effect.gen(function* () {
            const delay =
              effect.request.type === "provider-runtime.continue"
                ? yield* pacing.acquire({
                    threadId: effect.threadId,
                    sourceRunId: effect.request.sourceRunId,
                  })
                : effect.request.type === "provider-turn.start"
                  ? yield* pacing.acquireRun(effect.threadId, effect.request.runId)
                  : 0;
            if (delay > 0)
              return yield* new EffectWorker.OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                deferMs: delay,
              });
            freshStarted = true;
          }).pipe(
            Effect.mapError((cause) =>
              EffectWorker.isOrchestrationEffectExecutionError(cause)
                ? cause
                : new EffectWorker.OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(h.layer));
  return Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([
      {
        id: "effect:old",
        commandId: CommandId.make("command:old"),
        threadId: source(1).threadId,
        request: { type: "provider-runtime.continue", sourceRunId: source(1).sourceRunId },
      },
    ]);
    yield* worker.drain();
    assert.isFalse(freshStarted);
    yield* outbox.enqueue([
      {
        id: "effect:fresh",
        commandId: CommandId.make("command:fresh"),
        threadId: source(1).threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:fresh") },
      },
    ]);
    yield* worker.drain();
    assert.isTrue(freshStarted);
    assert.equal(Option.getOrThrow(yield* outbox.get("effect:old")).status, "pending");
  }).pipe(
    Effect.provide(
      EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(outboxLayer, executorLayer))),
    ),
  );
});

it.effect("a cancelled priority head cannot strand the remaining queue", () => {
  const h = harness({ spacingMs: 0 });
  h.priorities.set(source(1).sourceRunId, 0);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.register(source(1));
    yield* pacing.register(source(2));
    h.cancelled.add(source(1).sourceRunId);
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("holds the reservation while dispatch has not persisted its continuation yet", () => {
  const h = harness({ maxActive: 1, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    // The old run is cancelled and the replacement transaction has not committed.
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    h.running.add(source(1).sourceRunId);
    yield* pacing.dispatched(source(1));
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    h.running.delete(source(1).sourceRunId);
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("recovers a transient deferral write failure and refunds the claim attempt", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    let writes = 0;
    const observed = EffectOutbox.EffectOutboxV2.of({
      ...outbox,
      retry: (input) =>
        ++writes === 1
          ? Effect.fail(
              new EffectOutbox.EffectOutboxError({ operation: "retry", effectId: input.effectId }),
            )
          : outbox.retry(input),
    });
    yield* outbox.enqueue([
      {
        id: "effect:failed-defer",
        commandId: CommandId.make("command:failed-defer"),
        threadId: source(1).threadId,
        request: { type: "provider-runtime.continue", sourceRunId: source(1).sourceRunId },
      },
    ]);
    const workerLayer = EffectWorker.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(EffectOutbox.EffectOutboxV2, observed),
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
            execute: (effect) =>
              Effect.fail(
                new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  deferMs: 15_000,
                }),
              ),
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      return yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).runOnce;
    }).pipe(Effect.exit, Effect.provide(workerLayer));
    assert.equal(result._tag, "Failure");
    const recovered = Option.getOrThrow(yield* outbox.get("effect:failed-defer"));
    assert.equal(writes, 2);
    assert.equal(recovered.status, "pending");
    assert.equal(recovered.attemptCount, 0);
    assert.equal(recovered.lastError, "Resuming after restart");
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect.each([
  [null, false],
  ["", false],
  ["A real startup error", false],
  ["Resuming after restart", true],
] as const)("only a paced pending provider start lets later work pass (%s)", (reason) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = source(10).threadId;
    const now = yield* DateTime.now;
    yield* outbox.enqueue([
      {
        id: "effect:barrier",
        commandId: CommandId.make("command:barrier"),
        threadId,
        request: { type: "provider-turn.start", runId: source(10).sourceRunId },
        availableAt: reason[0] === null ? DateTime.add(now, { seconds: 15 }) : now,
      },
    ]);
    if (reason[0] !== null) {
      const held = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "barrier", leaseDurationMs: 30_000 }),
      );
      yield* outbox.retry({
        effectId: held.id,
        workerId: "barrier",
        error: reason[0],
        delayMs: 15_000,
      });
    }
    yield* outbox.enqueue([
      {
        id: "effect:after-barrier",
        commandId: CommandId.make("command:after-barrier"),
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:after-barrier") },
      },
    ]);
    const next = yield* outbox.claimNext({ workerId: "later", leaseDurationMs: 30_000 });
    assert.equal(Option.isSome(next), reason[1]);
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("a failed post-dispatch read cannot leave an in-flight reservation forever", () => {
  const h = harness({ maxActive: 1, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    h.failActive(true);
    assert.equal((yield* pacing.dispatched(source(1)).pipe(Effect.exit))._tag, "Failure");
    h.failActive(false);
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});
