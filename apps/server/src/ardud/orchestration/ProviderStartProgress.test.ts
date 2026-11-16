import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as Progress from "./ProviderStartProgress.ts";

const attempt = {
  threadId: ThreadId.make("progress-thread"),
  runId: RunId.make("progress-run"),
  attemptId: RunAttemptId.make("progress-attempt"),
};
const input = {
  ...attempt,
  provider: ProviderInstanceId.make("claude"),
  model: "opus",
  delegated: true,
  providerSessionId: ProviderSessionId.make("progress-session"),
  attemptOrdinal: 1,
};

it.effect(
  "names concurrent manager waits without regressing native evidence; interruption releases the wait",
  () =>
    Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      yield* progress.begin(input);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* progress
        .withSessionStep(
          input,
          "session_status_audience",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* progress.observe(attempt, "native_accepted", "native-123");
      yield* progress.observe(attempt, "sdk_received", "native-123");
      yield* progress.step(attempt, "start_send");
      const snapshot = progress.get(attempt.runId, attempt.attemptId)!;
      assert.equal(snapshot.step, "session_status_audience");
      assert.isNotNull(snapshot.nativeAcceptedAt);
      assert.isNotNull(snapshot.sdkReceivedAt);
      const writing = yield* Deferred.make<void>();
      const writer = yield* progress
        .withRunStep(
          attempt,
          "run_ingestion_write",
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      assert.equal(progress.get(attempt.runId, attempt.attemptId)?.step, "run_ingestion_write");
      yield* Fiber.interrupt(writer);
      assert.equal(progress.get(attempt.runId, attempt.attemptId)?.step, "session_status_audience");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waiting);
      assert.equal(progress.get(attempt.runId, attempt.attemptId)?.step, "native_accepted");
      yield* progress.release(attempt);
      assert.isNull(progress.get(attempt.runId, attempt.attemptId));
    }).pipe(Effect.provide(Progress.layer)),
);

it.effect.each(
  [true, false].flatMap((delegated) =>
    (["admission", "session_open", "thread_ensure", "turn_preparation", "start_send"] as const).map(
      (step) => ({ delegated, step }),
    ),
  ),
)(
  "emits one attributed warning before native identity is known (delegated: $delegated, step: $step)",
  ({ delegated, step }) => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      for (let i = 0; i < 20; i++) {
        const current = {
          ...input,
          delegated,
          runId: RunId.make(`run-${i}`),
          attemptId: RunAttemptId.make(`attempt-${i}`),
        };
        yield* progress.begin(current);
        yield* progress.step(current, step);
      }
      yield* TestClock.adjust(59_999);
      assert.equal(spans.filter((span) => span.name === "provider.start-waiting").length, 0);
      yield* TestClock.adjust(1);
      const warnings = spans.filter((span) => span.name === "provider.start-waiting");
      assert.equal(warnings.length, 20);
      assert.isTrue(
        warnings[0]!.events.some(([, , attributes]) => attributes?.["effect.logLevel"] === "WARN"),
      );
      for (const warning of warnings)
        assert.deepInclude(Object.fromEntries(warning.attributes), {
          provider: "claude",
          providerSessionId: input.providerSessionId,
          nativeSessionId: null,
          model: "opus",
          role: delegated ? "delegated" : "unknown",
          delegated,
          step,
          elapsedMs: 60_000,
        });
      yield* TestClock.adjust("10 minutes");
      assert.equal(spans.filter((span) => span.name === "provider.start-waiting").length, 20);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Progress.layer.pipe(
            Layer.provide(Layer.mock(KanbanStore.KanbanStore)({ threadLink: () => Effect.never })),
          ),
          Logger.layer([], { mergeWithExisting: false }),
        ),
      ),
      Effect.withTracer(tracer),
    );
  },
);

it.effect("clearing an attempt does not await an uninterruptible diagnostic role read", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<null>();
    yield* Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      yield* progress.begin(input);
      yield* Deferred.await(entered);
      yield* progress.release(attempt);
      assert.isNull(progress.get(attempt.runId, attempt.attemptId));
      assert.isFalse(yield* Deferred.isDone(finish));
    }).pipe(
      Effect.ensuring(Deferred.succeed(finish, null)),
      Effect.provide(
        Progress.layer.pipe(
          Layer.provide(
            Layer.mock(KanbanStore.KanbanStore)({
              threadLink: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.uninterruptible,
                ),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "old attempt observations cannot alter or release the replacement; terminal and ACK clear tracking",
  () =>
    Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      yield* progress.begin(input);
      const replacement = {
        ...input,
        attemptId: RunAttemptId.make("replacement"),
        attemptOrdinal: 2,
      };
      yield* progress.begin(replacement);
      yield* progress.observe(attempt, "native_accepted", "old-session");
      yield* progress.release(attempt);
      assert.isNull(progress.get(attempt.runId, attempt.attemptId));
      assert.isNull(progress.get(attempt.runId, replacement.attemptId)?.nativeAcceptedAt);
      yield* TestClock.adjust(1);
      yield* progress.handle({
        id: EventId.make("old-terminal"),
        type: "run.updated",
        threadId: attempt.threadId,
        runId: attempt.runId,
        occurredAt: yield* DateTime.now,
        payload: {
          id: attempt.runId,
          activeAttemptId: attempt.attemptId,
          status: "cancelled",
        } as OrchestrationV2Run,
      });
      assert.isNotNull(progress.get(attempt.runId, replacement.attemptId));
      for (const status of ["preparing", "queued"] as const) {
        yield* progress.handle({
          id: EventId.make(`delayed-${status}`),
          type: "run.updated",
          threadId: attempt.threadId,
          runId: attempt.runId,
          occurredAt: yield* DateTime.now,
          payload: {
            id: attempt.runId,
            activeAttemptId: replacement.attemptId,
            status,
          } as OrchestrationV2Run,
        });
        assert.isNotNull(progress.get(attempt.runId, replacement.attemptId));
      }
      yield* progress.handle({
        id: EventId.make("ack"),
        type: "provider-turn.updated",
        threadId: attempt.threadId,
        runId: attempt.runId,
        occurredAt: yield* DateTime.now,
        payload: {
          id: ProviderTurnId.make("turn"),
          providerThreadId: ProviderThreadId.make("pt"),
          nodeId: NodeId.make("progress-ack-node"),
          runAttemptId: replacement.attemptId,
          ordinal: 1,
          status: "running",
          nativeTurnRef: null,
          startedAt: null,
          completedAt: null,
          promptAcceptedAt: yield* DateTime.now,
        },
      });
      assert.isNull(progress.get(attempt.runId, replacement.attemptId));
      yield* progress.begin(replacement);
      yield* progress.handle({
        id: EventId.make("terminal"),
        type: "run.updated",
        threadId: attempt.threadId,
        runId: attempt.runId,
        occurredAt: yield* DateTime.now,
        payload: {
          id: attempt.runId,
          activeAttemptId: replacement.attemptId,
          status: "interrupted",
        } as OrchestrationV2Run,
      });
      assert.isNull(progress.get(attempt.runId, replacement.attemptId));
    }).pipe(Effect.provide(Progress.layer)),
);

it.effect(
  "local registration stays pending until persisted native ACK, even with in-memory native evidence",
  () =>
    Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      yield* progress.begin(input);
      yield* progress.observe(attempt, "native_accepted", "native-123");
      const now = yield* DateTime.now;
      const run = {
        id: attempt.runId,
        activeAttemptId: attempt.attemptId,
        status: "running",
        startedAt: now,
      } as OrchestrationV2Run;
      assert.isTrue(
        Progress.startState(run, [], progress.get(run.id, run.activeAttemptId)).startPending,
      );
      const turns = [
        {
          id: ProviderTurnId.make("turn"),
          providerThreadId: ProviderThreadId.make("pt"),
          nodeId: NodeId.make("progress-pending-node"),
          runAttemptId: attempt.attemptId,
          ordinal: 1,
          status: "running" as const,
          nativeTurnRef: null,
          startedAt: now,
          completedAt: null,
        },
      ];
      assert.isTrue(Progress.startState(run, turns, null).startPending);
      assert.isFalse(
        Progress.startState(run, [{ ...turns[0]!, promptAcceptedAt: now }], null).startPending,
      );
      assert.isTrue(
        Progress.startState(
          run,
          [{ ...turns[0]!, runAttemptId: RunAttemptId.make("old"), promptAcceptedAt: now }],
          null,
        ).startPending,
      );
      assert.isFalse(
        Progress.startState({ ...run, status: "cancelled" }, turns, null).startPending,
      );
    }).pipe(Effect.provide(Progress.layer)),
);

it.effect.each(["attempt", "terminal", "attempt-terminal"] as const)(
  "cleans replaced attempts before begin is reached, via %s",
  (change) =>
    Effect.gen(function* () {
      const progress = yield* Progress.ProviderStartProgress;
      yield* progress.begin(input);
      const oldAt = yield* DateTime.now;
      yield* TestClock.adjust(1);
      const replacement = {
        ...input,
        attemptId: RunAttemptId.make("replacement-without-begin"),
        attemptOrdinal: 2,
      };
      const now = yield* DateTime.now;
      yield* progress.handle(
        change === "attempt"
          ? {
              id: EventId.make("replace"),
              type: "run-attempt.updated",
              threadId: attempt.threadId,
              runId: attempt.runId,
              occurredAt: now,
              payload: {
                id: replacement.attemptId,
                runId: attempt.runId,
                attemptOrdinal: 2,
              } as OrchestrationV2RunAttempt,
            }
          : change === "attempt-terminal"
            ? {
                id: EventId.make("old-attempt-terminal"),
                type: "run-attempt.updated",
                threadId: attempt.threadId,
                runId: attempt.runId,
                occurredAt: now,
                payload: {
                  id: attempt.attemptId,
                  runId: attempt.runId,
                  attemptOrdinal: 1,
                  status: "cancelled",
                } as OrchestrationV2RunAttempt,
              }
            : {
                id: EventId.make("new-terminal"),
                type: "run.updated",
                threadId: attempt.threadId,
                runId: attempt.runId,
                occurredAt: now,
                payload: {
                  id: attempt.runId,
                  activeAttemptId: attempt.attemptId,
                  status: "cancelled",
                } as OrchestrationV2Run,
              },
      );
      assert.isNull(progress.get(attempt.runId, attempt.attemptId));
      yield* progress.begin(replacement);
      yield* progress.handle({
        id: EventId.make("stale"),
        type: "run.updated",
        threadId: attempt.threadId,
        runId: attempt.runId,
        occurredAt: oldAt,
        payload: {
          id: attempt.runId,
          activeAttemptId: attempt.attemptId,
          status: "cancelled",
        } as OrchestrationV2Run,
      });
      yield* progress.begin(input);
      assert.isNotNull(progress.get(attempt.runId, replacement.attemptId));
    }).pipe(Effect.provide(Progress.layer)),
);
