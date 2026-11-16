import * as CheckpointRollbackService from "../../orchestration-v2/CheckpointRollbackService.ts";
import * as RunFinalizationService from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControlService from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as RuntimeRequestService from "../../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
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
import * as Deferred from "effect/Deferred";
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
  loadReader?: () => number,
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
  const admissionBlocks = new Map<string, Effect.Effect<void>>();
  const sourceBlocks = new Map<string, Effect.Effect<void>>();
  const pendingHooks = new Map<string, Effect.Effect<void>>();
  const positions: Array<{ id: string; position: number | null }> = [];
  const reads = { settings: 0, sources: 0, descriptions: 0, active: 0 };
  const runSources = new Map<string, RestartSource>();
  let wake: RestartPacingState.RestartPacingState["Service"]["wake"] = () => Effect.succeed(true);
  let load = 0;
  let failActive = false;
  let failStatus = false;
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
          wake: (input) => Effect.suspend(() => wake(input)),
          hasSuccessor: () => Effect.succeed(false),
          pending: (input) =>
            (pendingHooks.get(input.sourceRunId) ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(
                  () => !cancelled.has(input.sourceRunId) && !cancelled.has(input.effectId ?? ""),
                ),
              ),
            ),
          sourceForRun: (_, runId) =>
            (sourceBlocks.get(runId) ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reads.sources++;
                  return runSources.get(runId);
                }),
              ),
            ),
          describe: (input) =>
            Effect.sync(() => {
              reads.descriptions++;
              return {
                priority: priorities.get(input.sourceRunId) ?? 3,
                activityAt: Number(input.sourceRunId.split(":")[1]),
              };
            }),
          active: (input, runId) =>
            failActive
              ? Effect.fail(
                  new RestartPacingState.RestartPacingStateError({
                    cause: "temporary read failure",
                  }),
                )
              : Effect.sync(() => {
                  reads.active++;
                  return running.has(runId ?? input.sourceRunId);
                }),
          status: (input, position) =>
            (position === null
              ? (admissionBlocks.get(input.sourceRunId) ?? Effect.void)
              : Effect.void
            ).pipe(
              Effect.andThen(
                failStatus
                  ? Effect.fail(
                      new RestartPacingState.RestartPacingStateError({
                        cause: "temporary write failure",
                      }),
                    )
                  : Effect.sync(() => {
                      statusHooks.get(input.effectId ?? "")?.();
                      positions.push({ id: input.sourceRunId, position });
                      return !protectedNotes.has(input.sourceRunId);
                    }),
              ),
            ),
        }),
        Layer.succeed(RestartPacing.RestartLoad, loadReader ?? (() => load)),
      ),
    ),
  );
  return {
    layer,
    wakeWith: (value: typeof wake) => {
      wake = value;
    },
    failStatus: (value: boolean) => {
      failStatus = value;
    },
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
    admissionBlocks,
    sourceBlocks,
    pendingHooks,
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
      assert.equal(h.reads.sources, 0);
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
      assert.equal(h.reads.sources, 0);
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
    assert.deepEqual(load.snapshot(), {
      cpuBusy: 0.9,
      cpuBusyThreshold: 0.85,
      eventLoopUtilization: 0.1,
      eventLoopThreshold: 0.9,
      sampleIntervalMs: 10_000,
    });
    sample = {
      at: 30_000,
      idle: 15_700,
      total: 30_000,
      loopIdle: 18_500,
      loopActive: 11_500,
      loadavg: 0,
    };
    assert.isAbove(load(), 1);
    assert.equal(load.snapshot().eventLoopUtilization, 0.95);
  }),
);

it.effect("a load-held waiting row records the raw interval inputs and thresholds", () => {
  let sample = { at: 0, idle: 0, total: 0, loopIdle: 0, loopActive: 0 };
  const load = makeRestartLoad(() => sample);
  const h = harness({ spacingMs: 0 }, undefined, load);
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    sample = { at: 10_000, idle: 1_000, total: 10_000, loopIdle: 500, loopActive: 9_500 };
    yield* TestClock.adjust(10_000);
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    const waiting = messages.findLast((row) => row.includes("restart-pacing.waiting"))!;
    for (const field of [
      '"loaded":true',
      '"cpuBusy":0.9',
      '"cpuBusyThreshold":0.85',
      '"eventLoopUtilization":0.95',
      '"eventLoopThreshold":0.9',
      '"sampleIntervalMs":10000',
      '"queuedAtMs":10000',
      '"waitedMs":0',
      '"lastAdmissionAgoMs":null',
    ])
      assert.include(waiting, field);
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("ten continuations cap concurrent provider starts until confirmation", () => {
  const h = harness({ maxActive: 3, spacingMs: 0 });
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const queued = Array.from({ length: 10 }, (_, id) => source(id));
    for (const input of queued) yield* pacing.register(input);
    const starts: string[] = [];
    while (starts.length < queued.length) {
      for (const input of queued) {
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
        [0, 1, 2, 3, 4].map((id) => source(id).sourceRunId),
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

it.effect("a retired paced start completes its note when its replacement is cancelled", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const original = { ...source(1), effectId: "start:retired" };
    const other = source(2);
    assert.isAbove(yield* pacing.acquire(original), 0);
    h.cancelled.add(original.effectId);
    h.protectedNotes.add(original.sourceRunId);
    assert.isAbove(yield* pacing.acquire(other), 0);
    assert.deepEqual(h.positions.at(-1), { id: other.sourceRunId, position: 1 });

    h.positions.length = 0;
    h.protectedNotes.delete(original.sourceRunId);
    assert.isAbove(yield* pacing.acquire(other), 0);
    assert.deepEqual(h.positions, [{ id: original.sourceRunId, position: null }]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("retired note cleanup continues after the admission queue empties", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const original = { ...source(1), effectId: "start:retired" };
    const replacement = { ...source(2), threadId: original.threadId, effectId: "start:new" };
    assert.isAbove(yield* pacing.acquire(original), 0);
    h.protectedNotes.add(original.sourceRunId);
    assert.isAbove(yield* pacing.acquire(replacement), 0);
    h.setLoad(0);
    yield* TestClock.adjust("15 seconds");
    assert.equal(yield* pacing.acquire(replacement), 0);

    h.positions.length = 0;
    h.protectedNotes.delete(original.sourceRunId);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(h.positions, [{ id: original.sourceRunId, position: null }]);
  }).pipe(Effect.provide(h.layer));
});

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

it.effect.each(["pending", "status"] as const)(
  "pruning blocked in %s cannot backdate position progress across an expired window",
  (persistence) => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const stale = source(1);
      const waiter = source(2);
      const newcomer = source(3);
      yield* pacing.register(stale);
      yield* pacing.register(waiter);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      yield* TestClock.adjust("25 minutes");
      h.priorities.set(newcomer.sourceRunId, 0);
      h.setLoad(0);
      assert.equal(yield* pacing.acquire(newcomer), 0);
      h.running.add(newcomer.sourceRunId);
      yield* pacing.dispatched(newcomer);
      yield* TestClock.adjust(299_000);
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const blocks = persistence === "pending" ? h.pendingHooks : h.admissionBlocks;
      blocks.set(
        stale.sourceRunId,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      );
      h.cancelled.add(stale.sourceRunId);
      const acquiring = yield* pacing.acquire(waiter).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(25_000);
      yield* Deferred.succeed(proceed, undefined);
      const failure = yield* Fiber.join(acquiring);
      assert.instanceOf(failure, RestartPacing.RestartAdmissionTimeoutError);
      assert.equal(DateTime.toEpochMillis(failure.deadline), 30 * 60_000);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["no improvement", "later real improvement"] as const)(
  "replacement preserves the waiter's completed queue position: %s",
  (progress) => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const first = { ...source(1), sourceRunId: RunId.make("run:first:ordinal:1") };
      const successor = { ...first, sourceRunId: RunId.make("run:first:ordinal:2") };
      const waiter = source(2);
      const newcomer = source(3);
      yield* pacing.register(first);
      yield* pacing.register(waiter);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      yield* TestClock.adjust("25 minutes");
      h.priorities.set(newcomer.sourceRunId, 0);
      h.setLoad(0);
      assert.equal(yield* pacing.acquire(newcomer), 0);
      h.running.add(newcomer.sourceRunId);
      yield* pacing.dispatched(newcomer);
      yield* TestClock.adjust("4 minutes");
      yield* pacing.register(successor);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      assert.equal(h.positions.at(-1)?.position, 2);
      if (progress === "no improvement") {
        yield* TestClock.adjust("1 minute");
        const failure = yield* pacing.acquire(waiter).pipe(Effect.flip);
        assert.instanceOf(failure, RestartPacing.RestartAdmissionTimeoutError);
        assert.equal(DateTime.toEpochMillis(failure.deadline), 30 * 60_000);
        return;
      }
      yield* TestClock.adjust(30_000);
      yield* pacing.release(newcomer);
      assert.equal(yield* pacing.acquire(successor), 0);
      yield* pacing.dispatched(successor);
      yield* TestClock.adjust(25.5 * 60_000);
      const later = source(4);
      h.priorities.set(later.sourceRunId, 0);
      assert.equal(yield* pacing.acquire(later), 0);
      h.running.add(later.sourceRunId);
      yield* pacing.dispatched(later);
      yield* TestClock.adjust(4.25 * 60_000);
      assert.equal(yield* Clock.currentTimeMillis, 59.25 * 60_000);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      yield* pacing.release(later);
      assert.equal(yield* pacing.acquire(waiter), 0);
    }).pipe(Effect.provide(h.layer));
  },
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

it.effect("a deep load-held queue keeps a progressing source alive beyond 30 minutes", () => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const messages: Array<{ at: number; row: string }> = [];
  let at = 0;
  const logger = Logger.make(({ message }) => messages.push({ at, row: JSON.stringify(message) }));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const queued = Array.from({ length: 40 }, (_, id) => source(id + 1));
    const waiter = queued[33]!;
    const advanceTo = (at: number) =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => TestClock.adjust(at - now)));
    for (const entry of queued) yield* pacing.register(entry);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    assert.equal(h.positions.at(-1)?.position, 34);
    for (let index = 0; index < 33; index++) {
      yield* advanceTo((index + 1) * 90_000);
      h.setLoad(0);
      at = yield* Clock.currentTimeMillis;
      assert.equal(yield* pacing.acquire(queued[index]!), 0);
      yield* pacing.dispatched(queued[index]!);
      if (index === 32) {
        assert.equal(yield* pacing.acquire(waiter), 0);
        break;
      }
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      if (index === 29) {
        assert.equal(yield* Clock.currentTimeMillis, 45 * 60_000);
      }
      h.setLoad(2);
      yield* TestClock.adjust(10_000);
      at = yield* Clock.currentTimeMillis;
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      if (index === 19) {
        yield* advanceTo(31 * 60_000);
        at = yield* Clock.currentTimeMillis;
        assert.isAbove(yield* pacing.acquire(waiter), 0);
      }
    }
    assert.equal(h.positions.at(-1)?.position, null);
    assert.equal(yield* Clock.currentTimeMillis, 49.5 * 60_000);
    const deferred = messages.filter(
      ({ row }) =>
        row.includes("restart-pacing.bound_deferred") &&
        row.includes(`"sourceRunId":"${waiter.sourceRunId}"`),
    );
    assert.lengthOf(deferred, 2);
    for (let index = 1; index < deferred.length; index++)
      assert.isAtLeast(deferred[index]!.at - deferred[index - 1]!.at, 10 * 60_000);
    assert.isFalse(messages.some(({ row }) => row.includes("restart-pacing.bound_failed")));
    const waiting = messages.find(({ row }) => row.includes("restart-pacing.waiting"))!.row;
    assert.include(waiting, '"lastAdmissionAgoMs":null');
    assert.include(waiting, '"loadScore":2');
    assert.include(waiting, '"loadThreshold":1');
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("the absolute backstop expires a source even while both progress clocks advance", () => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const queued = Array.from({ length: 100 }, (_, id) => source(id + 1));
    const waiter = queued[99]!;
    for (const entry of queued) yield* pacing.register(entry);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    for (let index = 0; index < 79; index++) {
      yield* TestClock.adjust(90_000);
      h.setLoad(0);
      assert.equal(yield* pacing.acquire(queued[index]!), 0);
      yield* pacing.dispatched(queued[index]!);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
    }
    yield* TestClock.adjust(90_000);
    assert.instanceOf(
      yield* pacing.acquire(waiter).pipe(Effect.flip),
      RestartPacing.RestartAdmissionTimeoutError,
    );
    const failed = messages.findLast((row) => row.includes("restart-pacing.bound_failed"));
    assert.include(failed!, '"rule":"absolute_backstop"');
    assert.include(failed!, '"waitedMs":7200000');
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("admissions elsewhere do not extend a source whose position never improves", () => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const waiter = source(100);
    yield* pacing.register(waiter);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    h.setLoad(0);
    for (let index = 0; index < 19; index++) {
      yield* TestClock.adjust(90_000);
      const newcomer = source(index);
      h.priorities.set(newcomer.sourceRunId, 0);
      assert.equal(yield* pacing.acquire(newcomer), 0);
      yield* pacing.dispatched(newcomer);
    }
    yield* TestClock.adjust(90_000);
    assert.instanceOf(
      yield* pacing.acquire(waiter).pipe(Effect.flip),
      RestartPacing.RestartAdmissionTimeoutError,
    );
    assert.include(
      messages.findLast((row) => row.includes("bound_failed"))!,
      '"rule":"no_progress"',
    );
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("position changes and a late admission cannot revive a window with no admissions", () => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const queued = Array.from({ length: 40 }, (_, id) => source(id + 1));
    const waiter = queued[39]!;
    for (const entry of queued) yield* pacing.register(entry);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    for (let index = 0; index < 29; index++) {
      yield* TestClock.adjust(60_000);
      h.cancelled.add(queued[index]!.sourceRunId);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
    }
    yield* TestClock.adjust(60_000);
    h.setLoad(0);
    // A newly registered source can be admitted, but the old window has expired.
    const newcomer = source(100);
    h.priorities.set(newcomer.sourceRunId, 0);
    assert.equal(yield* pacing.acquire(newcomer), 0);
    yield* pacing.dispatched(newcomer);
    assert.instanceOf(
      yield* pacing.acquire(waiter).pipe(Effect.flip),
      RestartPacing.RestartAdmissionTimeoutError,
    );
    assert.include(
      messages.findLast((row) => row.includes("bound_failed"))!,
      '"rule":"no_progress"',
    );
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("a pruned waiter retains admissions made before its replacement registers", () => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const first = source(1);
  const waiter = { ...source(2), effectId: "start:replacement-race" };
  const later = source(3);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.register(first);
    yield* pacing.register(waiter);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    yield* TestClock.adjust("15 minutes");
    h.cancelled.add(first.sourceRunId);
    assert.isAbove(yield* pacing.acquire(waiter), 0);
    h.cancelled.add(waiter.effectId);
    assert.isAbove(yield* pacing.acquire(later), 0);
    h.cancelled.delete(waiter.effectId);
    yield* TestClock.adjust("5 minutes");
    h.setLoad(0);
    assert.equal(yield* pacing.acquire(later), 0);
    yield* pacing.dispatched(later);
    yield* TestClock.adjust("11 minutes");
    assert.equal(yield* pacing.acquire(waiter), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "background pruning credits a sleeping waiter's position before its window expires",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const stale = source(1);
      const waiter = source(2);
      const newcomer = source(3);
      yield* pacing.register(stale);
      yield* pacing.register(waiter);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      yield* TestClock.adjust("25 minutes");
      h.priorities.set(newcomer.sourceRunId, 0);
      h.setLoad(0);
      assert.equal(yield* pacing.acquire(newcomer), 0);
      h.running.add(newcomer.sourceRunId);
      yield* pacing.dispatched(newcomer);
      yield* TestClock.adjust(280_000);
      const pruned = yield* Deferred.make<void>();
      h.pendingHooks.set(
        waiter.sourceRunId,
        Deferred.succeed(pruned, undefined).pipe(Effect.asVoid),
      );
      h.cancelled.add(stale.sourceRunId);
      yield* TestClock.adjust(10_000);
      yield* Deferred.await(pruned);
      yield* TestClock.adjust(70_000);
      assert.equal(yield* Clock.currentTimeMillis, 31 * 60_000);
      assert.isAbove(yield* pacing.acquire(waiter), 0);
      yield* pacing.release(newcomer);
      assert.equal(yield* pacing.acquire(waiter), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each([
  ["no_progress", "status"],
  ["no_progress", "sourceForRun"],
  ["absolute_backstop", "status"],
  ["absolute_backstop", "sourceForRun"],
] as const)("a %s deadline crossed during %s cannot admit the source", ([rule, persistence]) => {
  const h = harness({ maxActive: 4, spacingMs: 0 });
  h.setLoad(2);
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const count = rule === "absolute_backstop" ? 80 : 1;
    const queued = Array.from({ length: count }, (_, id) => source(id + 1));
    const waiter = queued.at(-1)!;
    h.runSources.set(waiter.sourceRunId, waiter);
    for (const entry of queued) yield* pacing.register(entry);
    assert.isAbove(yield* pacing.acquireRun(waiter.threadId, waiter.sourceRunId), 0);
    for (const entry of queued.slice(0, -1)) {
      yield* TestClock.adjust(90_000);
      h.setLoad(0);
      assert.equal(yield* pacing.acquire(entry), 0);
      yield* pacing.dispatched(entry);
    }
    const deadline = (rule === "absolute_backstop" ? 120 : 30) * 60_000;
    yield* TestClock.adjust(deadline - 1000 - (yield* Clock.currentTimeMillis));
    h.setLoad(0);
    const entered = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    const blocks = persistence === "status" ? h.admissionBlocks : h.sourceBlocks;
    blocks.set(
      waiter.sourceRunId,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    );
    const admitting = yield* pacing
      .acquireRun(waiter.threadId, waiter.sourceRunId)
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(25_000);
    yield* Deferred.succeed(proceed, undefined);
    const failure = yield* Fiber.join(admitting);
    assert.instanceOf(failure, RestartPacing.RestartAdmissionTimeoutError);
    assert.equal(DateTime.toEpochMillis(failure.deadline), deadline);
    const failed = messages.findLast((row) => row.includes("restart-pacing.bound_failed"));
    assert.include(failed!, `"rule":"${rule}"`);
    assert.include(failed!, `"waitedMs":${deadline + 24_000}`);
    assert.isFalse(
      messages.some(
        (row) =>
          row.includes(`"sourceRunId":"${waiter.sourceRunId}"`) &&
          row.includes("restart-pacing.admitted"),
      ),
    );
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
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
    assert.instanceOf(
      yield* pacing.acquire(source(1)).pipe(Effect.flip),
      RestartPacing.RestartAdmissionSupersededError,
    );
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

it.effect.each([false, true])(
  "a settled continuation preserves only wakes racing its retirement (queued=%s)",
  (queued) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const startupAt = yield* DateTime.now;
      const threadId = source(100).threadId;
      yield* outbox.enqueue([
        {
          id: "effect:race-boundary",
          commandId: CommandId.make("command:race-boundary"),
          threadId,
          request: {
            type: "provider-runtime.continue",
            sourceRunId: source(100).sourceRunId,
            queued,
          },
        },
      ]);
      const input = { threadId, requestedAt: startupAt, startupAt };
      assert.equal(yield* outbox.hasRunContinuationAt(input), !queued);
      yield* outbox.claimNext({ workerId: "retire", leaseDurationMs: 30000 });
      yield* TestClock.adjust("10 seconds");
      yield* outbox.succeed({ effectId: "effect:race-boundary", workerId: "retire" });
      assert.isFalse(yield* outbox.hasPendingRunContinuation(threadId));
      assert.equal(yield* outbox.hasRunContinuationAt(input), !queued);
      yield* TestClock.adjust("1 second");
      assert.isFalse(
        yield* outbox.hasRunContinuationAt({ ...input, requestedAt: yield* DateTime.now }),
      );
      assert.isFalse(
        yield* outbox.hasRunContinuationAt({ ...input, startupAt: yield* DateTime.now }),
      );
    }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("continuation preflight and admission share one settings snapshot across retries", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    for (let i = 0; i < 50; i++) {
      yield* pacing.settingsSnapshot;
      assert.isAbove(yield* pacing.acquire(source(i)), 0);
    }
    assert.equal(h.reads.settings, 1);
    yield* TestClock.adjust("10 seconds");
    yield* pacing.settingsSnapshot;
    yield* pacing.acquire(source(0));
    assert.equal(h.reads.settings, 2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("declining a waiting continuation closes its note without another acquisition", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    yield* pacing.dispatched(source(1), true);
    assert.deepEqual(
      h.positions.map((entry) => entry.position),
      [1, null],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a declined old claim cannot clear a replacement continuation's wait", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const original = { ...source(1), effectId: "old" };
    const replacement = { ...source(1), effectId: "replacement" };
    assert.isAbove(yield* pacing.acquire(original), 0);
    assert.isAbove(yield* pacing.acquire(replacement), 0);
    yield* pacing.dispatched(original, true);
    assert.isTrue(h.positions.every((entry) => entry.position !== null));
    yield* pacing.dispatched(replacement, true);
    assert.equal(h.positions.at(-1)?.position, null);
  }).pipe(Effect.provide(h.layer));
});

it.effect("failed decline cleanup retains ownership until its note can be closed", () => {
  const h = harness();
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    assert.isAbove(yield* pacing.acquire(source(1)), 0);
    h.failStatus(true);
    assert.equal((yield* pacing.dispatched(source(1), true).pipe(Effect.exit))._tag, "Failure");
    h.failStatus(false);
    yield* pacing.dispatched(source(1), true);
    assert.deepEqual(
      h.positions.map((entry) => entry.position),
      [1, null],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "runtime recovery reaches provider start two minutes after death despite a routine restart backlog",
  () => {
    const h = harness({ maxActive: 4, spacingMs: 20000 });
    const recovery = source(0);
    h.runSources.set(recovery.sourceRunId, recovery);
    h.priorities.set(recovery.sourceRunId, 0.5);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const death = yield* Clock.currentTimeMillis;
      for (let id = 1; id <= 50; id++) {
        h.priorities.set(source(id).sourceRunId, 2);
        yield* pacing.register(source(id));
      }
      yield* TestClock.adjust("2 minutes");
      const started = yield* Deferred.make<number>();
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
        Effect.provide(
          EffectWorker.layerExecutor.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(RunFinalizationService.RunFinalizationService)({}),
                Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
                Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
                Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(McpSessionRegistry.McpSessionRegistry)({}),
                Layer.mock(EventSink.EventSinkV2)({}),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
                ServerSettings.layerTest(),
                Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({
                  start: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((at) => Deferred.succeed(started, at)),
                      Effect.asVoid,
                    ),
                }),
              ),
            ),
          ),
        ),
      );
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* executor.execute({
        id: "runtime-resume",
        commandId: CommandId.make("command:runtime-resume"),
        threadId: recovery.threadId,
        request: { type: "provider-turn.start", runId: recovery.sourceRunId },
        status: "running",
        attemptCount: 1,
        availableAt: at,
        leaseOwner: "test-worker",
        leaseExpiresAt: at,
        createdAt: at,
        updatedAt: at,
        completedAt: null,
        lastError: null,
      });
      const providerStartedAt = yield* Deferred.await(started);
      assert.equal(providerStartedAt - death, 120000);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "ten durable waiters drain at twenty second spacing, including sleeping successors",
  () => {
    const h = harness({ maxActive: 4, spacingMs: 20_000 });
    const starts: number[] = [];
    const executor = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const pacing = yield* RestartPacing.RestartPacing;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Effect.gen(function* () {
              if (effect.request.type !== "provider-turn.start") return;
              const delay = yield* pacing.acquireRun(
                effect.threadId,
                effect.request.runId,
                effect.id,
              );
              if (delay > 0)
                return yield* new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  deferMs: delay,
                });
              starts.push(yield* Clock.currentTimeMillis);
              yield* pacing.releaseRun(effect.threadId, effect.request.runId, effect.id);
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
      h.wakeWith((input) =>
        outbox
          .wakeRestartEffect(input.effectId!)
          .pipe(
            Effect.mapError((cause) => new RestartPacingState.RestartPacingStateError({ cause })),
          ),
      );
      const began = yield* Clock.currentTimeMillis;
      for (let id = 0; id < 10; id++) {
        const input = source(id);
        h.runSources.set(input.sourceRunId, input);
        yield* pacing.register({ ...input, effectId: `drain:${id}` });
        yield* outbox.enqueue([
          {
            id: `drain:${id}`,
            threadId: input.threadId,
            commandId: CommandId.make(`drain:${id}`),
            request: { type: "provider-turn.start", runId: input.sourceRunId },
          },
        ]);
      }
      yield* worker.drain();
      for (let count = 1; count < 10; count++) {
        yield* TestClock.adjust(20_000);
        yield* worker.drain();
        assert.equal(starts.length, count + 1);
      }
      assert.deepEqual(
        starts.map((at) => at - began),
        Array.from({ length: 10 }, (_, i) => i * 20_000),
      );
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(
          Layer.provideMerge(
            Layer.merge(
              executor,
              EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect("a successor replaces its thread's source in place and retires old retries", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const before = source(1);
    const first = source(2);
    const after = source(3);
    const newer = { ...source(4), threadId: first.threadId };
    for (const input of [before, first, after]) yield* pacing.register(input);
    yield* pacing.acquire(first);
    assert.equal(h.positions.at(-1)?.position, 2);
    yield* pacing.acquire(newer);
    assert.equal(h.positions.at(-1)?.position, 2);
    assert.instanceOf(
      yield* pacing.acquire(first).pipe(Effect.flip),
      RestartPacing.RestartAdmissionSupersededError,
    );
    yield* pacing.acquire(after);
    assert.equal(h.positions.at(-1)?.position, 3);
    assert.isTrue(
      h.positions.some((entry) => entry.id === first.sourceRunId && entry.position === null),
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("wait and admission logs carry queue age and eligible head idle time", () => {
  const h = harness({ spacingMs: 20_000 });
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.acquire(source(1));
    yield* pacing.dispatched(source(1));
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust(20_000);
    assert.equal(yield* pacing.acquire(source(2)), 0);
    for (const name of ["waiting", "admitted"]) {
      const logged = messages.findLast((message) => message.includes(`restart-pacing.${name}`));
      assert.isDefined(logged);
      assert.include(logged!, '"queuedAtMs":0');
      assert.include(logged!, name === "admitted" ? '"waitedMs":20000' : '"waitedMs":0');
      if (name === "admitted") assert.include(logged!, '"headIdleMs":0');
    }
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect.each([3, 12])("a late ordinal 2 source cannot replace queued ordinal %s", (ordinal) => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    const newer = {
      threadId: source(2).threadId,
      sourceRunId: RunId.make(`run:thread:two:ordinal:${ordinal}`),
    };
    const older = { ...newer, sourceRunId: RunId.make("run:thread:two:ordinal:2") };
    yield* pacing.register(source(1));
    yield* pacing.register(newer);
    assert.instanceOf(
      yield* pacing.acquire(older).pipe(Effect.flip),
      RestartPacing.RestartAdmissionSupersededError,
    );
    assert.isAbove(yield* pacing.acquire(newer), 0);
    assert.equal(h.positions.at(-1)?.position, 2);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["before admission", "after admission"])(
  "a resumed recovery keeps its entry despite an older marker: %s",
  (when) => {
    const h = harness({ spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = source(1);
      const newer = { ...source(2), threadId: old.threadId };
      yield* pacing.acquire(old);
      yield* pacing.acquire(newer);
      h.runSources.set(newer.sourceRunId, old);
      if (when === "before admission") {
        assert.isAbove(
          yield* pacing.acquireRun(newer.threadId, newer.sourceRunId, "resumed:start"),
          0,
        );
        assert.equal(h.positions.at(-1)?.position, 1);
      }
      h.setLoad(0);
      yield* TestClock.adjust(10_000);
      if (when === "before admission")
        assert.instanceOf(
          yield* pacing.acquire(newer).pipe(Effect.flip),
          RestartPacing.RestartAdmissionSupersededError,
        );
      else assert.equal(yield* pacing.acquire(newer), 0);
      const effectId = when === "before admission" ? "resumed:start" : "recovered:start";
      assert.equal(yield* pacing.acquireRun(newer.threadId, newer.sourceRunId, effectId), 0);
      assert.equal(h.reads.sources, when === "before admission" ? 1 : 0);
      yield* pacing.releaseRun(newer.threadId, newer.sourceRunId, effectId);
      assert.equal(yield* pacing.acquire(source(3)), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("head idle and wait age include time spent committing admission", () => {
  const h = harness({ spacingMs: 20_000 });
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.acquire(source(1));
    yield* pacing.dispatched(source(1));
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    yield* TestClock.adjust(20_000);
    const entered = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    h.admissionBlocks.set(
      source(2).sourceRunId,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    );
    const admitting = yield* pacing.acquire(source(2)).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(25_000);
    yield* Deferred.succeed(proceed, undefined);
    assert.equal(yield* Fiber.join(admitting), 0);
    const logged = messages.findLast((message) => message.includes("restart-pacing.admitted"));
    assert.include(logged!, '"waitedMs":45000');
    assert.include(logged!, '"headIdleMs":25000');
  }).pipe(
    Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
  );
});

it.effect("pruning a settled effect retains its replacement's earlier queue position", () => {
  const h = harness({ spacingMs: 0 });
  h.setLoad(2);
  const first = source(1);
  h.runSources.set(first.sourceRunId, first);
  return Effect.gen(function* () {
    const pacing = yield* RestartPacing.RestartPacing;
    yield* pacing.acquireRun(first.threadId, first.sourceRunId, "old:effect");
    yield* pacing.register(source(2));
    yield* pacing.register(source(3));
    h.cancelled.add("old:effect");
    assert.isAbove(yield* pacing.acquire(source(2)), 0);
    h.cancelled.delete("old:effect");
    assert.isAbove(yield* pacing.acquireRun(first.threadId, first.sourceRunId, "new:effect"), 0);
    assert.equal(h.positions.at(-1)?.position, 1);
    assert.isAbove(yield* pacing.acquire(source(3)), 0);
    assert.equal(h.positions.at(-1)?.position, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each(["replacement pending", "replacement settled", "older queued input"] as const)(
  "a promoted input revalidates admission after its marker was superseded: %s",
  (kind) => {
    const h = harness({ spacingMs: 20_000 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = source(1);
      const newer = { ...source(2), threadId: old.threadId };
      yield* pacing.acquire(old);
      yield* pacing.acquire(newer);
      if (kind !== "replacement pending") {
        h.setLoad(0);
        yield* TestClock.adjust(10_000);
        assert.equal(yield* pacing.acquire(newer), 0);
        yield* pacing.dispatched(newer, true);
        h.setLoad(2);
        yield* TestClock.adjust(10_000);
      }
      const actualId = kind === "older queued input" ? old.sourceRunId : RunId.make("run:promoted");
      h.runSources.set(actualId, old);
      assert.isAbove(yield* pacing.acquireRun(old.threadId, actualId, "promoted:start"), 0);
      assert.equal(h.positions.at(-1)?.position, 1);
      h.setLoad(0);
      yield* TestClock.adjust(20_000);
      assert.equal(yield* pacing.acquireRun(old.threadId, actualId, "promoted:start"), 0);
      yield* pacing.releaseRun(old.threadId, actualId, "promoted:start");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "holder refresh tracks the actual start while its replacement source stays queued",
  () => {
    const h = harness({ maxActive: 1, spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = source(1);
      const queued = { ...source(2), threadId: old.threadId };
      const actual = RunId.make("run:actual-start");
      yield* pacing.acquire(old);
      yield* pacing.acquire(queued);
      h.runSources.set(actual, old);
      assert.isAbove(yield* pacing.acquireRun(old.threadId, actual, "actual:effect"), 0);
      h.setLoad(0);
      yield* TestClock.adjust(10_000);
      assert.equal(yield* pacing.acquireRun(old.threadId, actual, "actual:effect"), 0);
      h.running.add(actual);
      yield* TestClock.adjust("3 minutes");
      assert.isAbove(yield* pacing.acquire(source(3)), 0);
      yield* pacing.releaseRun(old.threadId, actual, "stale:effect");
      assert.isAbove(yield* pacing.acquire(source(3)), 0);
      yield* pacing.releaseRun(old.threadId, actual, "actual:effect");
      assert.equal(yield* pacing.acquire(source(3)), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["provider failure", "holder reclaimed"])(
  "a borrowed source retains spent load credit after %s",
  (edge) => {
    const h = harness({ maxActive: 1, spacingMs: 20_000 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = source(1);
      const queued = { ...source(2), threadId: old.threadId };
      const actual = RunId.make("run:borrowed-start");
      yield* pacing.acquire(old);
      yield* pacing.acquire(queued);
      h.runSources.set(actual, old);
      assert.isAbove(yield* pacing.acquireRun(old.threadId, actual, "borrowed:start"), 0);
      yield* TestClock.adjust("20 minutes");
      assert.equal(yield* pacing.acquireRun(old.threadId, actual, "borrowed:start"), 0);
      if (edge === "holder reclaimed") {
        yield* TestClock.adjust("2 minutes");
        assert.isAbove(yield* pacing.acquire(source(3)), 0);
      }
      yield* pacing.releaseRun(old.threadId, actual, "borrowed:start", true);
      yield* TestClock.adjust("20 seconds");
      assert.equal(yield* pacing.acquireRun(old.threadId, actual, "borrowed:retry"), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["same recovery source", "newer recovery source"])(
  "a waiting actual start keeps ownership against a %s wake",
  (edge) => {
    const h = harness({ spacingMs: 20_000 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = { ...source(1), effectId: "old:wake" };
      const queued = { ...source(2), threadId: old.threadId, effectId: "queued:wake" };
      const actual = RunId.make("run:actual-owned-start");
      yield* pacing.acquire(old);
      yield* pacing.acquire(queued);
      yield* pacing.register(source(3));
      h.runSources.set(actual, old);
      assert.isAbove(yield* pacing.acquireRun(old.threadId, actual, "actual:start"), 0);
      const wake =
        edge === "same recovery source"
          ? queued
          : {
              ...source(4),
              threadId: old.threadId,
              effectId: "newer:wake",
            };
      yield* pacing.register(wake);
      assert.instanceOf(
        yield* pacing.acquire(wake).pipe(Effect.flip),
        RestartPacing.RestartAdmissionSupersededError,
      );
      yield* pacing.acquire(source(3));
      assert.equal(h.positions.at(-1)?.position, 2);
      yield* TestClock.adjust("20 minutes");
      assert.instanceOf(
        yield* pacing.acquire(wake).pipe(Effect.flip),
        RestartPacing.RestartAdmissionSupersededError,
      );
      assert.equal(yield* pacing.acquireRun(old.threadId, actual, "actual:start"), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a protected old note cannot block replacement and closes after its owner settles",
  () => {
    const h = harness({ spacingMs: 0 });
    h.setLoad(2);
    return Effect.gen(function* () {
      const pacing = yield* RestartPacing.RestartPacing;
      const old = { ...source(1), effectId: "old:effect" };
      const newer = { ...source(2), threadId: old.threadId, effectId: "new:effect" };
      h.protectedNotes.add(old.sourceRunId);
      let closed = false;
      h.statusHooks.set(old.effectId, () => {
        if (!h.protectedNotes.has(old.sourceRunId)) closed = true;
      });
      yield* pacing.acquire(old);
      assert.isAbove(yield* pacing.acquire(newer), 0);
      assert.deepEqual(h.positions.at(-1), { id: newer.sourceRunId, position: 1 });
      assert.isFalse(closed);
      yield* pacing.acquire(source(3));
      assert.equal(h.positions.at(-1)?.position, 2);
      h.protectedNotes.delete(old.sourceRunId);
      yield* TestClock.adjust(10_000);
      assert.isTrue(closed);
      assert.isAbove(yield* pacing.acquire(newer), 0);
      assert.deepEqual(h.positions.at(-1), { id: newer.sourceRunId, position: 1 });
    }).pipe(Effect.provide(h.layer));
  },
);
