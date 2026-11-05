import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
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

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const sessionId = ProviderSessionId.make("provider-session:control-lane");
const providerThreadId = ProviderThreadId.make("provider-thread:control-lane");
const providerTurnId = ProviderTurnId.make("provider-turn:control-lane");
const runId = RunId.make("run:control-lane");
const control = { providerSessionId: sessionId, providerThreadId, providerTurnId };

const start = (id: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  request: { type: "provider-turn.start", runId },
});

const interrupt = (id: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  request: { type: "provider-turn.interrupt", ...control },
});

const workerLayer = (
  outbox: EffectOutbox.EffectOutboxV2Shape,
  execute: EffectWorker.OrchestrationEffectExecutorV2Shape["execute"],
) =>
  EffectWorker.layerWithOptions({ workerId: "control-lane-test" }).pipe(
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

it.effect("wakes an idle general worker when a control waiter is first", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const releaseGeneral = yield* Deferred.make<void>();
    const laneWaiting = yield* Deferred.make<void>();
    const allWaiting = yield* Deferred.make<void>();
    const waits = yield* Ref.make(0);
    const ran = yield* Deferred.make<void>();
    const observed: EffectOutbox.EffectOutboxV2Shape = {
      ...outbox,
      claimNext: (input) =>
        (input.onlyEffectTypes === undefined ? Deferred.await(releaseGeneral) : Effect.void).pipe(
          Effect.andThen(outbox.claimNext(input)),
        ),
      awaitControlAvailable: Effect.gen(function* () {
        yield* Deferred.succeed(laneWaiting, undefined);
        yield* outbox.awaitControlAvailable;
      }),
      awaitAvailable: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(waits, (n) => n + 1);
        if (count === 4) yield* Deferred.succeed(allWaiting, undefined);
        yield* outbox.awaitAvailable;
      }),
    };
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions().pipe(Effect.forkScoped);
      yield* Deferred.await(laneWaiting);
      yield* TestClock.adjust("0 millis");
      yield* Deferred.succeed(releaseGeneral, undefined);
      yield* Deferred.await(allWaiting);
      yield* TestClock.adjust("0 millis");
      yield* outbox.enqueue([start("single-notification")]);
      yield* outbox.notifyAvailable();
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* Deferred.isDone(ran));
    }).pipe(
      Effect.provide(workerLayer(observed, () => Deferred.succeed(ran, undefined).pipe(Effect.asVoid))),
      Effect.scoped,
    );
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("wakes a control worker even if general workers consume a notification first", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const generalBlocked = yield* Queue.unbounded<void>();
    const releaseGeneral = yield* Deferred.make<void>();
    const allWaiting = yield* Deferred.make<void>();
    const laneWaiting = yield* Deferred.make<void>();
    const waits = yield* Ref.make(0);
    const generalWake = yield* Deferred.make<void>();
    const holdGeneral = yield* Deferred.make<void>();
    const executed = yield* Deferred.make<void>();
    const observed: EffectOutbox.EffectOutboxV2Shape = {
      ...outbox,
      claimNext: (input) =>
        (input.onlyEffectTypes === undefined
          ? Queue.offer(generalBlocked, undefined).pipe(Effect.andThen(Deferred.await(releaseGeneral)))
          : Effect.void
        ).pipe(Effect.andThen(outbox.claimNext(input))),
      awaitAvailable: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(waits, (n) => n + 1);
        if (count === 4) yield* Deferred.succeed(allWaiting, undefined);
        yield* outbox.awaitAvailable;
        yield* Deferred.succeed(generalWake, undefined);
        yield* Deferred.await(holdGeneral);
      }),
      awaitControlAvailable: Deferred.await(laneWaiting).pipe(
        Effect.andThen(outbox.awaitControlAvailable),
      ),
    };
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions().pipe(Effect.forkScoped);
      yield* Effect.forEach([0, 1, 2, 3], () => Queue.take(generalBlocked));
      yield* Deferred.succeed(releaseGeneral, undefined);
      yield* Deferred.await(allWaiting);
      yield* TestClock.adjust("0 millis");
      yield* outbox.enqueue([interrupt("single-control-notification")]);
      yield* outbox.notifyAvailable();
      yield* Deferred.await(generalWake);
      yield* Deferred.succeed(laneWaiting, undefined);
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* Deferred.isDone(executed));
      assert.equal(Option.getOrThrow(yield* outbox.get("single-control-notification")).attemptCount, 1);
    }).pipe(
      Effect.provide(workerLayer(observed, () => Deferred.succeed(executed, undefined).pipe(Effect.asVoid))),
      Effect.scoped,
    );
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("runs an interrupt while all four general workers are blocked by starts", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const started = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const initial = Array.from({ length: 4 }, (_, index) => start(`initial-${index}`));
    const pending = Array.from({ length: 3 }, (_, index) => start(`pending-${index}`));
    const stop = interrupt("stop-other-thread");
    yield* outbox.enqueue(initial);

    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions().pipe(Effect.forkScoped);
      yield* Effect.forEach(initial, () => Queue.take(started));
      yield* outbox.enqueue([...pending, stop]);
      yield* outbox.notifyAvailable(4);
      yield* Deferred.await(stopped).pipe(Effect.timeout("5 seconds"));
      yield* outbox.awaitSettled(stop.id);
      for (const effect of initial) {
        assert.equal(Option.getOrThrow(yield* outbox.get(effect.id)).status, "running");
      }
      for (const effect of pending) {
        const row = Option.getOrThrow(yield* outbox.get(effect.id));
        assert.equal(row.status, "pending");
        assert.equal(row.attemptCount, 0);
      }
    }).pipe(
      Effect.provide(
        workerLayer(outbox, (effect) =>
          effect.request.type === "provider-turn.start"
            ? Queue.offer(started, effect.id).pipe(Effect.andThen(Deferred.await(release)))
            : Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect("keeps a steer behind a pending and then running start on the same thread", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const first = start("ordered-start");
    const steer: EffectOutbox.PendingOrchestrationEffectV2 = {
      id: "ordered-steer",
      commandId: CommandId.make("command:ordered-steer"),
      threadId: first.threadId,
      request: { type: "provider-turn.steer", ...control, messageId: MessageId.make("message:steer") },
    };
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const executions = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* outbox.enqueue([first, steer]);
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.isFalse(yield* worker.runControlOnce);
      const startFiber = yield* worker.runOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      assert.isFalse(yield* worker.runControlOnce);
      const row = Option.getOrThrow(yield* outbox.get(steer.id));
      assert.equal(row.status, "pending");
      assert.equal(row.attemptCount, 0);
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Fiber.join(startFiber));
      assert.isTrue(yield* worker.runControlOnce);
      assert.deepEqual(yield* Ref.get(executions), [first.id, steer.id]);
    }).pipe(
      Effect.provide(
        workerLayer(outbox, (effect) =>
          Ref.update(executions, (current) => [...current, effect.id]).pipe(
            Effect.andThen(
              effect.id === first.id
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          ),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect("claims every allowed control type and no start, restart, continuation, title or rollback", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const disallowed: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2> = [
      { type: "provider-turn.start", runId },
      { type: "provider-turn.restart", ...control, interruptedAttemptId: RunAttemptId.make("attempt:test"), runId },
      { type: "provider-runtime.continue", sourceRunId: runId },
      { type: "thread-title.generate", kind: { type: "regenerate" } },
      { type: "provider-thread.rollback", providerThreadId, checkpointId: CheckpointId.make("checkpoint:test"), scopeId: CheckpointScopeId.make("scope:test") },
    ];
    const allowed: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2> = [
      { type: "provider-turn.interrupt", ...control },
      { type: "provider-turn.steer", ...control, messageId: MessageId.make("message:test") },
      { type: "runtime-request.respond", providerSessionId: sessionId, requestId: RuntimeRequestId.make("request:test") },
      { type: "delegated-tasks.stop" },
      { type: "provider-session.detach", providerSessionId: sessionId },
      { type: "mcp-credential.revoke-thread" },
      { type: "checkpoint.capture", runId, scopeId: CheckpointScopeId.make("scope:test") },
      { type: "scheduled-tasks.cleanup" },
      { type: "terminal.cleanup" },
      { type: "preview.cleanup" },
      { type: "attachment.cleanup", attachmentIds: [] },
    ];
    const makeRows = (requests: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2>) =>
      requests.map((request) => ({ ...start(request.type), request }));
    const excludedRows = makeRows(disallowed);
    const allowedRows = makeRows(allowed);
    const executions = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* outbox.enqueue(excludedRows);
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.isFalse(yield* worker.runControlOnce);
      yield* outbox.enqueue(allowedRows);
      for (const _ of allowedRows) assert.isTrue(yield* worker.runControlOnce);
      assert.isFalse(yield* worker.runControlOnce);
      assert.sameMembers([...(yield* Ref.get(executions))], allowedRows.map(({ id }) => id));
      for (const { id } of excludedRows) {
        const row = Option.getOrThrow(yield* outbox.get(id));
        assert.equal(row.status, "pending");
        assert.equal(row.attemptCount, 0);
      }
    }).pipe(
      Effect.provide(workerLayer(outbox, (effect) => Ref.update(executions, (ids) => [...ids, effect.id]))),
    );
  }).pipe(Effect.provide(layerOutbox)),
);

it.effect("does not spin on due starts and wakes at the next control deadline", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const attempts = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const controlRan = yield* Deferred.make<void>();
    const instrumented: EffectOutbox.EffectOutboxV2Shape = {
      ...outbox,
      claimNext: (input) =>
        (input.onlyEffectTypes === undefined ? Effect.void : Ref.update(attempts, (n) => n + 1)).pipe(
          Effect.andThen(outbox.claimNext(input)),
        ),
    };
    const now = yield* DateTime.now;
    const later = { ...interrupt("future-interrupt"), availableAt: DateTime.add(now, { seconds: 5 }) };
    yield* outbox.enqueue([start("block"), start("due-1"), start("due-2"), later]);
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 1, livenessPollIntervalMs: 30_000 }).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      const firstCount = yield* Ref.get(attempts);
      assert.isAtLeast(firstCount, 1);
      assert.isAtMost(firstCount, 2);
      assert.isFalse(yield* Deferred.isDone(controlRan));
      yield* TestClock.adjust("4 seconds");
      yield* Deferred.await(controlRan);
      // The completion notification and the worker's next idle probe can both
      // cause another claim after the control has run.
      assert.isAtMost(yield* Ref.get(attempts), 5);
    }).pipe(
      Effect.provide(
        workerLayer(instrumented, (effect) =>
          effect.request.type === "provider-turn.start"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Deferred.succeed(controlRan, undefined).pipe(Effect.asVoid),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(Layer.merge(layerOutbox, TestClock.layer()))),
);

it.effect("completes five controls and five starts exactly once with four general workers and one control worker", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const starts = Array.from({ length: 5 }, (_, index) => start(`batch-start-${index}`));
    const controls = Array.from({ length: 5 }, (_, index) => interrupt(`batch-control-${index}`));
    const started = yield* Queue.unbounded<string>();
    const completedControls = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    const executions = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* outbox.enqueue(starts);
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 4, controlLaneConcurrency: 1 }).pipe(
        Effect.forkScoped,
      );
      yield* Effect.forEach(starts.slice(0, 4), () => Queue.take(started));
      yield* outbox.enqueue(controls);
      yield* outbox.notifyAvailable(controls.length);
      yield* Effect.forEach(controls, () => Queue.take(completedControls)).pipe(Effect.timeout("5 seconds"));
      assert.equal((yield* Ref.get(executions)).filter((id) => id.startsWith("batch-start")).length, 4);
      yield* Deferred.succeed(release, undefined);
      for (const { id } of [...starts, ...controls]) yield* outbox.awaitSettled(id);
      assert.sameMembers([...(yield* Ref.get(executions))], [...starts, ...controls].map(({ id }) => id));
      assert.equal((yield* Ref.get(executions)).length, 10);
      for (const { id } of [...starts, ...controls]) {
        const row = Option.getOrThrow(yield* outbox.get(id));
        assert.equal(row.status, "succeeded");
        assert.equal(row.attemptCount, 1);
      }
    }).pipe(
      Effect.provide(
        workerLayer(outbox, (effect) =>
          Ref.update(executions, (ids) => [...ids, effect.id]).pipe(
            Effect.andThen(
              effect.request.type === "provider-turn.start"
                ? Queue.offer(started, effect.id).pipe(Effect.andThen(Deferred.await(release)))
                : Queue.offer(completedControls, effect.id).pipe(Effect.asVoid),
            ),
          ),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(layerOutbox)),
);
