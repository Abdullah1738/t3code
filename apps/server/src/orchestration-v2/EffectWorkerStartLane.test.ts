import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const runId = RunId.make("run:start-lane");
const start = (id: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  request: { type: "provider-turn.start", runId },
});
const slow = (id: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
  ...start(id),
  request: {
    type: "provider-thread.rollback",
    providerThreadId: ProviderThreadId.make("provider-thread:start-lane"),
    checkpointId: CheckpointId.make("checkpoint:start-lane"),
    scopeId: CheckpointScopeId.make("scope:start-lane"),
  },
});
const workerLayer = (
  outbox: EffectOutbox.EffectOutboxV2Shape,
  execute: EffectWorker.OrchestrationEffectExecutorV2Shape["execute"],
) =>
  EffectWorker.layerWithOptions({ workerId: "start-lane-test" }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
        Layer.succeed(
          EffectWorker.OrchestrationEffectExecutorV2,
          EffectWorker.OrchestrationEffectExecutorV2.of({ execute }),
        ),
      ),
    ),
  );

it.effect.each(["general", "control", "start"] as const)(
  "records the %s lane on a completed claim before execution settles",
  (lane) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const pending =
        lane === "control"
          ? {
              ...start("trace-control"),
              request: {
                type: "checkpoint.capture" as const,
                runId,
                scopeId: CheckpointScopeId.make("scope:trace-control"),
              },
            }
          : start(`trace-${lane}`);
      const ended: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            ended.push(span);
            end(...args);
          };
          return span;
        },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* outbox.enqueue([pending]);
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const run =
          lane === "start"
            ? worker.runStartOnce
            : lane === "control"
              ? worker.runControlOnce
              : worker.runOnce;
        const fiber = yield* run.pipe(Effect.withTracer(tracer), Effect.forkScoped);
        yield* Deferred.await(entered);
        const claim = ended.find((span) => span.name === "EffectWorker.claim");
        assert.isDefined(claim);
        assert.equal(claim?.attributes.get("lane"), lane);
        assert.equal(claim?.attributes.get("worker.id"), "start-lane-test");
        assert.equal(claim?.attributes.get("effect.id"), pending.id);
        assert.equal(claim?.attributes.get("effect.type"), pending.request.type);
        assert.equal(claim?.attributes.get("thread.id"), pending.threadId);
        assert.equal(claim?.attributes.get("result"), "claimed");
        assert.equal(Option.getOrThrow(yield* outbox.get(pending.id)).status, "running");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        assert.equal(yield* worker.drain(), 0);
      }).pipe(
        Effect.provide(
          workerLayer(outbox, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(layerOutbox)),
);

it.effect("claims a committed start while all four general workers are occupied", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const occupied = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const claims = new Map<string, string>();
    const observed: EffectOutbox.EffectOutboxV2Shape = {
      ...outbox,
      claimNext: (input) =>
        outbox.claimNext(input).pipe(
          Effect.tap((claimed) =>
            Effect.sync(() => {
              if (Option.isSome(claimed))
                claims.set(
                  claimed.value.id,
                  input.onlyEffectTypes?.includes("provider-turn.start") ? "start" : "general",
                );
            }),
          ),
        ),
    };
    yield* outbox.enqueue(Array.from({ length: 4 }, (_, i) => slow(`busy-${i}`)));
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* EffectWorker.runDaemonWithOptions().pipe(Effect.forkScoped);
      for (let i = 0; i < 4; i++) yield* Queue.take(occupied);
      yield* outbox.enqueue([start("new-start")]);
      yield* outbox.notifyAvailable();
      yield* TestClock.adjust("0 millis");
      assert.isTrue(yield* Deferred.isDone(started));
      yield* outbox.awaitSettled("new-start");
      assert.equal(claims.get("new-start"), "start");
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain();
    }).pipe(
      Effect.provide(
        workerLayer(observed, (effect) =>
          effect.request.type === "provider-turn.start"
            ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
            : Queue.offer(occupied, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect.each(["provider-turn.steer", "checkpoint.capture"] as const)(
  "start lane waits behind a pending and running %s of the same thread",
  (predecessor) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const next = start("ordered-start");
      const prior: EffectOutbox.PendingOrchestrationEffectV2 = {
        ...start("prior"),
        threadId: next.threadId,
        availableAt: DateTime.add(yield* DateTime.now, { seconds: 5 }),
        request:
          predecessor === "checkpoint.capture"
            ? { type: predecessor, runId, scopeId: CheckpointScopeId.make("scope:prior") }
            : {
                type: predecessor,
                providerSessionId: ProviderSessionId.make("session:prior"),
                providerThreadId: ProviderThreadId.make("thread:prior"),
                providerTurnId: ProviderTurnId.make("turn:prior"),
                messageId: MessageId.make("message:prior"),
              },
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* outbox.enqueue([prior, next]);
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.isFalse(yield* worker.runStartOnce);
        assert.isTrue(Option.isNone(yield* worker.nextStartClaimableAt));
        yield* TestClock.adjust("5 seconds");
        const priorFiber = yield* worker.runControlOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        assert.isFalse(yield* worker.runStartOnce);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(priorFiber);
        assert.isTrue(yield* worker.runStartOnce);
        assert.deepEqual(yield* Ref.get(executions), [prior.id, next.id]);
        assert.equal(yield* worker.drain(), 0);
      }).pipe(
        Effect.provide(
          workerLayer(outbox, (effect) =>
            Ref.update(executions, (ids) => [...ids, effect.id]).pipe(
              Effect.andThen(
                effect.id === prior.id
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("two starts on one thread cannot overlap across start and general claims", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const first = start("first");
    const second = { ...start("second"), threadId: first.threadId };
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* outbox.enqueue([first, second]);
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const firstFiber = yield* worker.runStartOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.isFalse(yield* worker.runStartOnce);
      assert.isFalse(yield* worker.runOnce);
      assert.isTrue(Option.isNone(yield* worker.nextStartClaimableAt));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(firstFiber);
      assert.isTrue(yield* worker.runStartOnce);
      assert.equal(yield* worker.drain(), 0);
      for (const { id } of [first, second]) {
        const row = Option.getOrThrow(yield* outbox.get(id));
        assert.equal(row.status, "succeeded");
        assert.equal(row.attemptCount, 1);
      }
    }).pipe(
      Effect.provide(
        workerLayer(outbox, (effect) =>
          effect.id === first.id
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect.each([undefined, 2] as const)(
  "bounds only the start lane at N (%s) and lets a free general worker claim start N+1",
  (startLaneConcurrency) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const occupied = yield* Queue.unbounded<string>();
      const releaseGeneral = yield* Queue.unbounded<void>();
      const started = yield* Queue.unbounded<string>();
      const releaseStarts = yield* Deferred.make<void>();
      const lanes = new Map<string, string>();
      const observed: EffectOutbox.EffectOutboxV2Shape = {
        ...outbox,
        claimNext: (input) =>
          outbox.claimNext(input).pipe(
            Effect.tap((claim) =>
              Effect.sync(() => {
                if (Option.isSome(claim))
                  lanes.set(
                    claim.value.id,
                    input.onlyEffectTypes === undefined ? "general" : "start",
                  );
              }),
            ),
          ),
      };
      const busy = Array.from({ length: 4 }, (_, i) => slow(`busy-${i}`));
      const n = startLaneConcurrency ?? 10;
      const starts = Array.from({ length: n + 1 }, (_, i) => start(`start-${i}`));
      yield* outbox.enqueue(busy);
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* EffectWorker.runDaemonWithOptions({
          ...(startLaneConcurrency === undefined ? {} : { startLaneConcurrency }),
          controlLaneConcurrency: 0,
        }).pipe(Effect.forkScoped);
        for (const _ of busy) yield* Queue.take(occupied);
        yield* outbox.enqueue(starts);
        yield* outbox.notifyAvailable(starts.length);
        const claimedInLane = yield* Effect.forEach(Array.from({ length: n }), () =>
          Queue.take(started),
        );
        yield* TestClock.adjust("0 millis");
        assert.equal(yield* Queue.size(started), 0);
        for (const id of claimedInLane) assert.equal(lanes.get(id), "start");
        const extra = starts.find(({ id }) => !claimedInLane.includes(id))!;
        assert.equal(Option.getOrThrow(yield* outbox.get(extra.id)).status, "pending");
        yield* Queue.offer(releaseGeneral, undefined);
        assert.equal(yield* Queue.take(started), extra.id);
        assert.equal(lanes.get(extra.id), "general");
        yield* Deferred.succeed(releaseStarts, undefined);
        yield* Queue.offerAll(releaseGeneral, [undefined, undefined, undefined]);
        for (const { id } of [...busy, ...starts]) yield* outbox.awaitSettled(id);
        assert.equal(yield* worker.drain(), 0);
      }).pipe(
        Effect.provide(
          workerLayer(observed, (effect) =>
            effect.request.type === "provider-turn.start"
              ? Queue.offer(started, effect.id).pipe(Effect.andThen(Deferred.await(releaseStarts)))
              : Queue.offer(occupied, effect.id).pipe(Effect.andThen(Queue.take(releaseGeneral))),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("zero start-lane concurrency retains general-only start execution", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const occupied = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const laneClaims = yield* Ref.make(0);
    const observed: EffectOutbox.EffectOutboxV2Shape = {
      ...outbox,
      claimNext: (input) =>
        (input.onlyEffectTypes?.includes("provider-turn.start")
          ? Ref.update(laneClaims, (n) => n + 1)
          : Effect.void
        ).pipe(Effect.andThen(outbox.claimNext(input))),
    };
    yield* outbox.enqueue([slow("busy"), start("pending")]);
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* EffectWorker.runDaemonWithOptions({
        concurrency: 1,
        controlLaneConcurrency: 0,
        startLaneConcurrency: 0,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(occupied);
      yield* TestClock.adjust("29 seconds");
      assert.equal(Option.getOrThrow(yield* outbox.get("pending")).status, "pending");
      assert.equal(yield* Ref.get(laneClaims), 0);
      yield* Deferred.succeed(release, undefined);
      yield* outbox.awaitSettled("pending");
      assert.equal(yield* worker.drain(), 0);
    }).pipe(
      Effect.provide(
        workerLayer(observed, (effect) =>
          effect.id === "busy"
            ? Deferred.succeed(occupied, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
      Effect.scoped,
    );
    const enabledOccupied = yield* Deferred.make<void>();
    const enabledRelease = yield* Deferred.make<void>();
    yield* outbox.enqueue([slow("enabled-busy"), start("enabled-start")]);
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({
        concurrency: 1,
        controlLaneConcurrency: 0,
        startLaneConcurrency: 1,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(enabledOccupied);
      yield* TestClock.adjust("0 millis");
      assert.equal(Option.getOrThrow(yield* outbox.get("enabled-start")).status, "succeeded");
      assert.isAbove(yield* Ref.get(laneClaims), 0);
      yield* Deferred.succeed(enabledRelease, undefined);
      yield* outbox.awaitSettled("enabled-busy");
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.equal(yield* worker.drain(), 0);
    }).pipe(
      Effect.provide(
        workerLayer(observed, (effect) =>
          effect.id === "enabled-busy"
            ? Deferred.succeed(enabledOccupied, undefined).pipe(
                Effect.andThen(Deferred.await(enabledRelease)),
              )
            : Effect.void,
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect(
  "post-commit notification wakes an idle start lane without advancing the liveness clock",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const occupied = yield* Queue.unbounded<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();
      const observed: EffectOutbox.EffectOutboxV2Shape = {
        ...outbox,
        awaitStartAvailable: Deferred.succeed(waiting, undefined).pipe(
          Effect.andThen(outbox.awaitStartAvailable),
        ),
      };
      yield* outbox.enqueue(Array.from({ length: 4 }, (_, i) => slow(`busy-${i}`)));
      yield* Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ startLaneConcurrency: 1 }).pipe(
          Effect.forkScoped,
        );
        for (let i = 0; i < 4; i++) yield* Queue.take(occupied);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("0 millis");
        const before = yield* DateTime.now;
        yield* outbox.enqueue([start("wake")]);
        yield* outbox.notifyAvailable();
        yield* TestClock.adjust("0 millis");
        assert.isTrue(yield* Deferred.isDone(ran));
        yield* outbox.awaitSettled("wake");
        assert.equal(DateTime.toEpochMillis(yield* DateTime.now), DateTime.toEpochMillis(before));
      }).pipe(
        Effect.provide(
          workerLayer(observed, (effect) =>
            effect.request.type === "provider-turn.start"
              ? Deferred.succeed(ran, undefined).pipe(Effect.asVoid)
              : Queue.offer(occupied, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("start-only deadlines ignore other due types and retain future start retries", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const future = DateTime.add(now, { seconds: 5 });
    yield* outbox.enqueue([slow("other"), { ...start("future"), availableAt: future }]);
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.isFalse(yield* worker.runStartOnce);
      assert.equal(
        DateTime.toEpochMillis(Option.getOrThrow(yield* worker.nextStartClaimableAt)),
        DateTime.toEpochMillis(future),
      );
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(yield* worker.runStartOnce);
      assert.isFalse(yield* worker.runStartOnce);
      assert.equal(Option.getOrThrow(yield* outbox.get("other")).status, "pending");
      assert.equal(yield* worker.drain(), 1);
    }).pipe(Effect.provide(workerLayer(outbox, () => Effect.void)));
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect(
  "idle start notifications and liveness probes skip write claims until a start is due",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const occupied = yield* Queue.unbounded<void>();
      const release = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();
      const startClaims = yield* Ref.make(0);
      const observed: EffectOutbox.EffectOutboxV2Shape = {
        ...outbox,
        claimNext: (input) =>
          (input.onlyEffectTypes?.includes("provider-turn.start")
            ? Ref.update(startClaims, (n) => n + 1)
            : Effect.void
          ).pipe(Effect.andThen(outbox.claimNext(input))),
      };
      const busy = Array.from({ length: 4 }, (_, i) => slow(`idle-busy-${i}`));
      yield* outbox.enqueue(busy);
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* EffectWorker.runDaemonWithOptions({ livenessPollIntervalMs: 100 }).pipe(
          Effect.forkScoped,
        );
        for (const _ of busy) yield* Queue.take(occupied);
        yield* TestClock.adjust("0 millis");
        assert.equal(yield* Ref.get(startClaims), 0);
        yield* outbox.enqueue([
          {
            ...start("not-yet-due"),
            availableAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
          },
        ]);
        yield* outbox.notifyAvailable(64);
        yield* TestClock.adjust("500 millis");
        assert.equal(yield* Ref.get(startClaims), 0);
        assert.isFalse(yield* Deferred.isDone(ran));
        yield* TestClock.adjust("500 millis");
        yield* Deferred.await(ran);
        yield* outbox.awaitSettled("not-yet-due");
        assert.equal(Option.getOrThrow(yield* outbox.get("not-yet-due")).attemptCount, 1);
        yield* Deferred.succeed(release, undefined);
        for (const { id } of busy) yield* outbox.awaitSettled(id);
        assert.equal(yield* worker.drain(), 0);
      }).pipe(
        Effect.provide(
          workerLayer(observed, (effect) =>
            effect.request.type === "provider-turn.start"
              ? Deferred.succeed(ran, undefined).pipe(Effect.asVoid)
              : Queue.offer(occupied, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);
