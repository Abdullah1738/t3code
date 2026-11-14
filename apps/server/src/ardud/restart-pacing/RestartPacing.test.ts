import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, RunId, ThreadId, type ServerSettingsError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Logger from "effect/Logger";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../../serverSettings.ts";
import * as RestartPacing from "./RestartPacing.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import type { RestartSource } from "./RestartPacingState.ts";
import { makeRestartLoad } from "./RestartLoad.ts";

const source = (id: number): RestartSource => ({
  threadId: ThreadId.make(`thread:${id}`),
  sourceRunId: RunId.make(`run:${id}`),
});
const harness = <E = never>(
  options: { maxActive?: number; spacingMs?: number } = {},
  settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService, E>,
) => {
  const resolvedSettings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    E | ServerSettingsError
  > = settingsLayer ?? ServerSettings.layerTest({ restartPacing: options });
  const running = new Set<string>();
  const priorities = new Map<string, number>();
  const cancelled = new Set<string>();
  const protectedNotes = new Set<string>();
  const statusHooks = new Map<string, () => void>();
  const positions: Array<{ id: string; position: number | null }> = [];
  const reads = { settings: 0, sources: 0, descriptions: 0, active: 0 };
  const runSources = new Map<string, RestartSource>();
  let load = 0;
  let failActive = false;
  const layer = RestartPacing.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            const settings = yield* ServerSettings.ServerSettingsService;
            return {
              ...settings,
              getSettings: Effect.suspend(() => {
                reads.settings++;
                return settings.getSettings;
              }),
            };
          }),
        ).pipe(Layer.provide(resolvedSettings)),
        Layer.succeed(RestartPacingState.RestartPacingState, {
          pending: (input) =>
            Effect.sync(
              () => !cancelled.has(input.sourceRunId) && !cancelled.has(input.effectId ?? ""),
            ),
          sourceForRun: (_, runId) =>
            Effect.sync(() => {
              reads.sources++;
              return runSources.get(runId);
            }),
          describe: (input) =>
            Effect.sync(() => {
              reads.descriptions++;
              return {
                priority: priorities.get(input.sourceRunId) ?? 3,
                activityAt: Number(input.sourceRunId.split(":")[1]),
              };
            }),
          active: (input) =>
            failActive
              ? Effect.fail(
                  new RestartPacingState.RestartPacingStateError({
                    cause: "temporary read failure",
                  }),
                )
              : Effect.sync(() => {
                  reads.active++;
                  return running.has(input.sourceRunId);
                }),
          status: (input, position) =>
            Effect.sync(() => {
              statusHooks.get(input.effectId ?? "")?.();
              positions.push({ id: input.sourceRunId, position });
              return !protectedNotes.has(input.sourceRunId);
            }),
        }),
        Layer.succeed(RestartPacing.RestartLoad, () => load),
      ),
    ),
  );
  return {
    layer,
    running,
    reads,
    runSources,
    cancelled,
    failActive: (value: boolean) => {
      failActive = value;
    },
    priorities,
    positions,
    protectedNotes,
    statusHooks,
    setLoad: (value: number) => {
      load = value;
    },
  };
};

it.effect(
  "50 waiters share one settings materialization per pass and no projection reads while held",
  () => {
    const secretReads = new Map<string, number>();
    const config = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providerInstances: {
              codex_fixture: {
                driver: "codex",
                environment: [
                  { name: "FIXTURE_SECRET", value: "", sensitive: true, valueRedacted: true },
                ],
                config: {},
              },
            },
          }),
        );
        return config;
      }),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "restart-pacing-settings-" })),
    );
    const realSettings = ServerSettings.layer.pipe(
      Layer.provide(
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (name) =>
            Effect.sync(() => {
              secretReads.set(name, (secretReads.get(name) ?? 0) + 1);
              return Option.none();
            }),
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
        }),
      ),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(config),
      Layer.provide(NodeServices.layer),
    );
    const h = harness({}, realSettings);
    h.setLoad(2);
    const queued = Array.from({ length: 50 }, (_, id) => source(id));
    for (const input of queued) h.runSources.set(input.sourceRunId, input);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      for (const input of queued) yield* pacing.register(input);
      const check = Effect.forEach(queued, (input) =>
        pacing.acquireRun(input.threadId, input.sourceRunId),
      );
      assert.deepEqual(yield* check, Array(50).fill(15_000));
      assert.equal(h.reads.settings, 1);
      assert.equal(secretReads.size, 1);
      assert.isTrue([...secretReads.values()].every((count) => count === 1));
      assert.equal(h.reads.sources, 50);
      assert.equal(h.reads.descriptions, 50);
      assert.equal(h.positions.length, 50);
      yield* TestClock.adjust("15 seconds");
      assert.deepEqual(yield* check, Array(50).fill(30_000));
      assert.equal(h.reads.settings, 2);
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(yield* check, Array(50).fill(60_000));
      assert.equal(h.reads.settings, 3);
      yield* TestClock.adjust("60 seconds");
      assert.deepEqual(yield* check, Array(50).fill(60_000));
      assert.equal(h.reads.settings, 4);
      assert.isTrue([...secretReads.values()].every((count) => count === 4));
      assert.equal(h.reads.sources, 50);
      assert.equal(h.reads.descriptions, 50);
      assert.equal(h.reads.active, 0);
      assert.equal(h.positions.length, 50);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "an outbox waiter resumes after the twenty minute hold and revalidates its run only at admission",
  () => {
    const h = harness();
    h.setLoad(2);
    const input = source(1);
    h.runSources.set(input.sourceRunId, input);
    let starts = 0;
    const executor = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const pacing = yield* RestartPacing.RestartPacing;
        return {
          execute: (effect) =>
            Effect.gen(function* () {
              if (effect.request.type !== "provider-turn.start") return;
              const deferMs = yield* pacing.acquireRun(
                effect.threadId,
                effect.request.runId,
                effect.id,
              );
              if (deferMs > 0)
                return yield* new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  deferMs,
                });
              starts++;
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
        };
      }),
    ).pipe(Layer.provide(h.layer));
    return Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([
        {
          id: "effect:held",
          commandId: CommandId.make("command:held"),
          threadId: input.threadId,
          request: { type: "provider-turn.start", runId: input.sourceRunId },
        },
      ]);
      yield* worker.drain();
      for (;;) {
        const held = Option.getOrThrow(yield* outbox.get("effect:held"));
        if (held.status === "succeeded") break;
        assert.equal(h.reads.sources, 1);
        const now = yield* Clock.currentTimeMillis;
        const next = Date.parse(held.availableAt);
        assert.isAtMost(next, 20 * 60_000);
        yield* TestClock.adjust(next - now);
        yield* worker.drain();
      }
      assert.equal(yield* Clock.currentTimeMillis, 20 * 60_000);
      assert.equal(starts, 1);
      assert.equal(h.reads.sources, 2);
      assert.equal(Option.getOrThrow(yield* outbox.get("effect:held")).status, "succeeded");
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              executor,
            ),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "a cancelled provider start is rechecked at admission and cannot strand the next waiter",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.setLoad(2);
    const first = source(1);
    h.runSources.set(first.sourceRunId, first);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId), 15_000);
      h.runSources.delete(first.sourceRunId);
      h.setLoad(0);
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId), 0);
      assert.equal(yield* pacing.acquire(source(2)), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("system CPU and event-loop interval counters ignore a busy load average", () =>
  Effect.sync(() => {
    let sample = { at: 0, idle: 0, total: 0, loopIdle: 0, loopActive: 0, loadavg: 30 };
    const load = makeRestartLoad(() => sample);
    sample = {
      at: 10_000,
      idle: 5_700,
      total: 10_000,
      loopIdle: 9_000,
      loopActive: 1_000,
      loadavg: 30,
    };
    assert.isBelow(load(), 1);
    sample = {
      at: 20_000,
      idle: 6_700,
      total: 20_000,
      loopIdle: 18_000,
      loopActive: 2_000,
      loadavg: 0,
    };
    assert.isAbove(load(), 1);
    sample = {
      at: 30_000,
      idle: 15_700,
      total: 30_000,
      loopIdle: 18_500,
      loopActive: 11_500,
      loadavg: 0,
    };
    assert.isAbove(load(), 1);
  }),
);

it.effect("ten continuations cap concurrent provider starts until confirmation", () => {
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
      yield* TestClock.adjust("1 minute");
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

it.effect("holder checks grow linearly across dispatch and native reservation transfer", () => {
  const h = harness({ maxActive: 1000, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    for (let id = 0; id < 150; id++) {
      const input = { ...source(id), effectId: `continue:${id}` };
      h.runSources.set(input.sourceRunId, input);
      assert.equal(yield* pacing.acquire(input), 0);
      h.running.add(input.sourceRunId);
      yield* pacing.dispatched(input);
      assert.equal(yield* pacing.acquireRun(input.threadId, input.sourceRunId, `start:${id}`), 0);
    }
    assert.equal(h.reads.active, 150);
    h.running.delete(source(0).sourceRunId);
    yield* TestClock.adjust("10 seconds");
    assert.equal(yield* pacing.acquire(source(150)), 0);
    assert.equal(h.reads.active, 300, "periodic scans still check every retained holder");
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["provider-runtime.continue", "provider-turn.start"] as const)(
  "%s drains out-of-order claims in priority order without a resource backoff",
  (type) => {
    const h = harness({ maxActive: 1000, spacingMs: 0 });
    h.priorities.set(source(0).sourceRunId, 0);
    const starts: string[] = [];
    const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const executorLayer = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const pacing = yield* RestartPacing.RestartPacing;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Effect.gen(function* () {
              const input = source(Number(effect.id.split(":")[1]));
              const delay = yield* type === "provider-runtime.continue"
                ? pacing.acquire({ ...input, effectId: effect.id })
                : pacing.acquireRun(input.threadId, input.sourceRunId, effect.id);
              if (delay > 0)
                return yield* new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: type,
                  deferMs: delay,
                });
              starts.push(input.sourceRunId);
              h.running.add(input.sourceRunId);
            }).pipe(
              Effect.mapError((cause) =>
                EffectWorker.isOrchestrationEffectExecutionError(cause)
                  ? cause
                  : new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: type,
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
      for (let id = 0; id < 5; id++) {
        const input = source(id);
        h.runSources.set(input.sourceRunId, input);
        yield* pacing.register({ ...input, effectId: `effect:${id}` });
        yield* outbox.enqueue([
          {
            id: `effect:${id}`,
            commandId: CommandId.make(`command:${id}`),
            threadId: input.threadId,
            request:
              type === "provider-runtime.continue"
                ? { type, sourceRunId: input.sourceRunId }
                : { type, runId: input.sourceRunId },
          },
        ]);
      }
      yield* worker.drain();
      for (let pass = 0; pass < 4; pass++) {
        yield* TestClock.adjust(1);
        yield* worker.drain();
      }
      assert.deepEqual(
        starts,
        [0, 4, 3, 2, 1].map((id) => source(id).sourceRunId),
      );
      for (let id = 0; id < 5; id++) {
        const effect = Option.getOrThrow(yield* outbox.get(`effect:${id}`));
        assert.equal(effect.status, "succeeded");
        assert.equal(effect.attemptCount, 1);
      }
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(outboxLayer, executorLayer))),
      ),
    );
  },
);

it.effect("backs off an unchanged priority head and resets when that head advances", () => {
  const h = harness({ maxActive: 1000, spacingMs: 0 });
  h.priorities.set(source(0).sourceRunId, 0);
  h.priorities.set(source(2).sourceRunId, 1);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    for (const id of [0, 1, 2]) yield* pacing.register(source(id));
    const retries = yield* Effect.forEach(Array.from({ length: 20 }), () =>
      pacing.acquire(source(1)),
    );
    assert.equal(retries[0], 1);
    assert.equal(retries.at(-1), 100);
    assert.isFalse(h.positions.some(({ position }) => position !== null));
    h.cancelled.add(source(0).sourceRunId);
    assert.equal(yield* pacing.acquire(source(1)), 1);
    h.cancelled.add(source(2).sourceRunId);
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
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* pacing.acquire(replacement), 30_000);
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
    assert.equal(yield* pacing.acquire(source(1)), 30_000);
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
    assert.equal(yield* pacing.acquire(original), 30_000);
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
    yield* TestClock.adjust("20 seconds");
    assert.isAbove(yield* pacing.acquire(source(3)), 0);
    h.running.delete(source(1).sourceRunId);
    yield* TestClock.adjust("1 minute");
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
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust("20 seconds");
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
    yield* TestClock.adjust("1 minute");
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

it.effect.each(["active capacity", "load"])(
  "bounds a restart admission blocked by %s",
  (holder) => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    const first = source(1);
    const waiter = source(2);
    h.runSources.set(first.sourceRunId, first);
    h.runSources.set(waiter.sourceRunId, waiter);
    h.running.add(first.sourceRunId);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId), 0);
      if (holder === "load") {
        h.running.clear();
        h.setLoad(2);
        yield* TestClock.adjust("10 seconds");
      }
      assert.isAbove(yield* pacing.acquireRun(waiter.threadId, waiter.sourceRunId), 0);
      yield* TestClock.adjust(`${RestartPacing.RESTART_ADMISSION_TIMEOUT_MS} millis`);
      const failure = yield* pacing
        .acquireRun(waiter.threadId, waiter.sourceRunId)
        .pipe(Effect.flip);
      assert.instanceOf(failure, RestartPacing.RestartAdmissionTimeoutError);
      assert.equal(h.positions.at(-1)?.position, null);
      // A caller-requested fresh resume without a restart marker cannot inherit the retired registration.
      h.runSources.delete(waiter.sourceRunId);
      assert.equal(yield* pacing.acquireRun(waiter.threadId, waiter.sourceRunId), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "an expiry commit retry keeps its deadline but a new resume gets a fresh allowance",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    const first = source(1);
    const waiter = source(2);
    h.running.add(first.sourceRunId);
    h.runSources.set(first.sourceRunId, first);
    h.runSources.set(waiter.sourceRunId, waiter);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      yield* pacing.acquireRun(first.threadId, first.sourceRunId, "effect:first");
      assert.isAbove(
        yield* pacing.acquireRun(waiter.threadId, waiter.sourceRunId, "effect:waiter"),
        0,
      );
      yield* TestClock.adjust(`${RestartPacing.RESTART_ADMISSION_TIMEOUT_MS} millis`);
      // Main may recover the old slot; keep load admission closed for the fresh allowance.
      h.setLoad(2);
      assert.instanceOf(
        yield* pacing
          .acquireRun(waiter.threadId, waiter.sourceRunId, "effect:waiter")
          .pipe(Effect.flip),
        RestartPacing.RestartAdmissionTimeoutError,
      );
      assert.instanceOf(
        yield* pacing
          .acquireRun(waiter.threadId, waiter.sourceRunId, "effect:waiter")
          .pipe(Effect.flip),
        RestartPacing.RestartAdmissionTimeoutError,
      );
      assert.isAbove(
        yield* pacing.acquireRun(waiter.threadId, waiter.sourceRunId, "effect:new-resume"),
        0,
      );
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("reclaims a lost dispatch settlement after the two minute grace", () => {
  const h = harness({ maxActive: 1, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    yield* TestClock.adjust("119 seconds");
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust("11 seconds");
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a confirmed provider start releases its slot while the turn continues", () => {
  const h = harness({ maxActive: 1 });
  const first = source(1);
  h.runSources.set(first.sourceRunId, first);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId, "start:1"), 0);
    h.running.add(first.sourceRunId);
    yield* TestClock.adjust("20 seconds");
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:1");
    assert.equal(yield* pacing.acquire(source(2)), 0);
    assert.isTrue(h.running.has(first.sourceRunId));
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a saturated gate warns with holders and recovers after ten minutes without progress",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.running.add(source(1).sourceRunId);
    const warnings: unknown[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquire(source(1)), 0);
      yield* TestClock.adjust("9 minutes");
      assert.isAbove(yield* pacing.acquire(source(2)), 0);
      assert.equal(warnings.length, 0);
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* pacing.acquire(source(2)), 0);
      assert.equal(warnings.length, 1);
      const warning = JSON.stringify(warnings[0]);
      assert.include(warning, "restart-pacing.stuck");
      assert.include(warning, "run:1");
      assert.include(warning, "dispatching");
      assert.include(warning, "600000");
    }).pipe(
      Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect("a fresh load-held priority head cannot starve an eligible older resume", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  h.priorities.set(source(2).sourceRunId, 0);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    yield* TestClock.adjust("20 minutes");
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    assert.equal(yield* pacing.acquire(source(1)), 0);
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a stale head whose note belongs to a replacement does not block another resume", () => {
  const h = harness({ spacingMs: 0 });
  h.priorities.set(source(1).sourceRunId, 0);
  h.cancelled.add(source(1).sourceRunId);
  h.protectedNotes.add(source(1).sourceRunId);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.register(source(1));
    assert.equal(yield* pacing.acquire(source(2)), 0);
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    assert.isFalse(h.positions.some((position) => position.position === 0));
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a stale dispatch finalizer cannot release a provider start's transferred reservation",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    const first = source(1);
    h.runSources.set(first.sourceRunId, first);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquire({ ...first, effectId: "continue:1" }), 0);
      assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId, "start:1"), 0);
      h.running.add(first.sourceRunId);
      yield* pacing.release({ ...first, effectId: "continue:1" });
      yield* pacing.dispatched({ ...first, effectId: "continue:1" });
      assert.isAbove(yield* pacing.acquire(source(2)), 0);
      yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:old");
      assert.isAbove(yield* pacing.acquire(source(2)), 0);
      yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:1");
      assert.equal(yield* pacing.acquire(source(2)), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("provider completion clears its cache even when refresh already freed the slot", () => {
  const h = harness({ maxActive: 1, spacingMs: 0 });
  const first = source(1);
  h.runSources.set(first.sourceRunId, first);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId, "start:1"), 0);
    yield* TestClock.adjust("10 seconds");
    assert.equal(yield* pacing.acquire(source(2)), 0);
    yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:1");
    h.runSources.delete(first.sourceRunId);
    const reads = h.reads.sources;
    assert.equal(yield* pacing.acquireRun(first.threadId, first.sourceRunId, "start:stale"), 0);
    assert.equal(h.reads.sources, reads + 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a failed reservation read cannot block an unrelated start while capacity remains",
  () => {
    const h = harness({ maxActive: 2, spacingMs: 0 });
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquire(source(1)), 0);
      h.failActive(true);
      yield* TestClock.adjust("2 minutes");
      assert.equal(yield* pacing.acquire(source(2)), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a load-ready waiter retries at the startup spacing deadline on a loaded host", () => {
  const h = harness();
  h.setLoad(2);
  h.priorities.set(source(1).sourceRunId, 0);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust("20 minutes");
    assert.equal(yield* pacing.acquire(source(1)), 0);
    assert.equal(yield* pacing.acquire(source(2)), 20_000);
    yield* TestClock.adjust("20 seconds");
    assert.equal(yield* pacing.acquire(source(2)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a stale reservation expires even while other slots keep making progress", () => {
  const h = harness({ maxActive: 2, spacingMs: 0 });
  h.running.add(source(1).sourceRunId);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.equal(yield* pacing.acquire(source(1)), 0);
    yield* TestClock.adjust("9 minutes");
    assert.equal(yield* pacing.acquire(source(2)), 0);
    yield* pacing.release(source(2));
    yield* TestClock.adjust("1 minute");
    assert.equal(yield* pacing.acquire(source(3)), 0);
    assert.equal(yield* pacing.acquire(source(4)), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["continuation", "provider-start", "reclaimed", "expired"] as const)(
  "a %s retry keeps the load budget already spent by its run",
  (exit) => {
    const h = harness({ maxActive: 1 });
    h.setLoad(2);
    const first = source(1);
    h.runSources.set(first.sourceRunId, first);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const acquire =
        exit === "provider-start"
          ? pacing.acquireRun(first.threadId, first.sourceRunId, "start:retry")
          : pacing.acquire(first);
      assert.isAbove(yield* acquire, 0);
      yield* TestClock.adjust("20 minutes");
      assert.equal(yield* acquire, 0);
      if (exit === "continuation") yield* pacing.release(first);
      else if (exit === "provider-start")
        yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:retry", true);
      else {
        yield* TestClock.adjust(exit === "reclaimed" ? "2 minutes" : "10 minutes");
        assert.isAbove(yield* pacing.acquire(source(2)), 0);
      }
      yield* TestClock.adjust("20 seconds");
      assert.equal(yield* acquire, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["new-admission", "transfer"] as const)(
  "a %s cancellation during admission releases the slot before provider start",
  (boundary) => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    const first = source(1);
    h.runSources.set(first.sourceRunId, first);
    let armed = false;
    let enteredProvider = false;
    const logger = Logger.make(({ message, fiber }) => {
      if (
        armed &&
        boundary === "new-admission" &&
        JSON.stringify(message).includes("restart-pacing.admitted")
      ) {
        armed = false;
        fiber.interruptUnsafe();
      }
    });
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      if (boundary === "transfer") {
        assert.equal(yield* pacing.acquire({ ...first, effectId: "continue:1" }), 0);
        h.statusHooks.set("start:1", () => Fiber.getCurrent()?.interruptUnsafe());
      }
      armed = true;
      const fiber = yield* pacing.acquireRun(first.threadId, first.sourceRunId, "start:1").pipe(
        Effect.andThen(
          Effect.sync(() => {
            enteredProvider = true;
          }),
        ),
        Effect.onExit((exit) =>
          pacing.releaseRun(first.threadId, first.sourceRunId, "start:1", Exit.isFailure(exit)),
        ),
        Effect.forkChild,
      );
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.isFalse(enteredProvider);
      assert.equal(yield* pacing.acquire(source(2)), 0);
    }).pipe(
      Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect.each([
  "continuation",
  "provider-start",
  "refreshed-before-finalizer",
  "expired-reservation",
] as const)("admitted preparation does not spend the next admission deadline: %s", (exit) => {
  const h = harness({ maxActive: 1, spacingMs: 0 });
  h.setLoad(2);
  const first = source(1);
  h.runSources.set(first.sourceRunId, first);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const providerStart = exit === "provider-start" || exit === "refreshed-before-finalizer";
    const acquire = providerStart
      ? pacing.acquireRun(first.threadId, first.sourceRunId, "start:retry")
      : pacing.acquire(first);
    assert.isAbove(yield* acquire, 0);
    yield* TestClock.adjust("20 minutes");
    assert.equal(yield* acquire, 0);
    // Workspace/preparation and the retry backoff are outside the waiting budget.
    yield* TestClock.adjust("31 minutes");
    if (exit === "refreshed-before-finalizer" || exit === "expired-reservation") {
      assert.isAbove(yield* pacing.acquire(source(2)), 0);
      h.cancelled.add(source(2).sourceRunId);
    }
    if (providerStart)
      yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:retry", true);
    else if (exit === "continuation") yield* pacing.release(first);
    yield* TestClock.adjust("31 minutes");
    const retried = yield* acquire.pipe(Effect.result);
    assert.equal(retried._tag, "Success", "admitted time must not expire the new admission wait");
    if (retried._tag === "Success")
      assert.equal(retried.success, 0, "the retry keeps its spent load credit");
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["deferred", "pruned"] as const)(
  "a continuously waiting %s retry retains its admission deadline",
  (exit) => {
    const h = harness({ spacingMs: 0 });
    h.setLoad(2);
    const first = source(1);
    h.runSources.set(first.sourceRunId, first);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const acquire = pacing.acquireRun(first.threadId, first.sourceRunId, "start:waiting");
      assert.isAbove(yield* acquire, 0);
      yield* TestClock.adjust("15 minutes");
      if (exit === "pruned") {
        h.cancelled.add("start:waiting");
        assert.isAbove(yield* pacing.acquire(source(2)), 0);
        h.cancelled.delete("start:waiting");
      } else yield* pacing.releaseRun(first.threadId, first.sourceRunId, "start:waiting", true);
      yield* TestClock.adjust("16 minutes");
      assert.instanceOf(
        yield* acquire.pipe(Effect.flip),
        RestartPacing.RestartAdmissionTimeoutError,
      );
    }).pipe(Effect.provide(h.layer));
  },
);
