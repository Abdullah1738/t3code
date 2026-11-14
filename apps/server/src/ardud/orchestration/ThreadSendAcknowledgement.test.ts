import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  RunId,
  type OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import * as ThreadSendAcknowledgement from "./ThreadSendAcknowledgement.ts";

it.effect("names the pending read and retry identity when a send cannot commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const entered = yield* Deferred.make<void>();
      const send = yield* ThreadSendAcknowledgement.bounded(
        () =>
          ThreadSendAcknowledgement.waitingOn(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            "target permission read for thread idle-target",
          ),
        scope,
        "blocked-reader",
      ).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(send);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "send_timeout");
        assert.include(result.failure.message, "target permission read for thread idle-target");
        assert.include(result.failure.message, "blocked-reader");
        assert.include(result.failure.message, "did not save a new message");
      }
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each(["success", "failure"] as const)(
  "restores the enclosing wait after a nested read ends with %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const entered = yield* Deferred.make<void>();
        const send = yield* ThreadSendAcknowledgement.bounded(
          () =>
            ThreadSendAcknowledgement.waitingOn(
              ThreadSendAcknowledgement.waitingOn(
                outcome === "success" ? Effect.void : Effect.fail("read failed"),
                "completed receipt read",
              ).pipe(
                Effect.ignore,
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
              ),
              "message replay dispatch",
            ),
          scope,
          "read-then-dispatch",
        ).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("15 seconds");
        const result = yield* Fiber.join(send);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(result.failure.message, "message replay dispatch");
          assert.notInclude(result.failure.message, "completed receipt read");
        }
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("fences a worker when its caller is cancelled during service-scope registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      let commits = 0;
      const id = CommandId.make("command:cancel-during-fork");
      const invocation = yield* Effect.withFiber((caller) => {
        let cancelled = false;
        const registrationScope = new Proxy(serviceScope, {
          set(target, property, value) {
            const applied = Reflect.set(target, property, value);
            if (property === "state" && !cancelled) {
              cancelled = true;
              caller.interruptUnsafe();
            }
            return applied;
          },
        });
        return ThreadSendAcknowledgement.bounded(
          () =>
            ThreadSendAcknowledgement.observe(
              Effect.uninterruptibleMask((restore) =>
                Deferred.await(release).pipe(
                  Effect.andThen(restore(ThreadSendAcknowledgement.check(id))),
                  Effect.andThen(
                    Effect.sync(() => {
                      commits += 1;
                    }),
                  ),
                  Effect.andThen(Effect.die("cancelled worker must not commit")),
                ),
              ).pipe(Effect.onExit(() => Deferred.succeed(settled, undefined))),
              {
                commandId: id,
                messageId: MessageId.make("message:cancel"),
                mode: "auto",
              },
            ),
          registrationScope,
          "cancel-during-fork",
        );
      }).pipe(Effect.forkChild);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(invocation)));
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);
      assert.equal(commits, 0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("returns send_timeout when the absolute commit fence expires before its timer runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const scope = yield* Effect.scope;
      let nanos = 0n;
      const id = CommandId.make("command:fence-before-timer");
      const result = yield* ThreadSendAcknowledgement.bounded(
        () =>
          ThreadSendAcknowledgement.waitingOn(
            ThreadSendAcknowledgement.observe(
              Effect.sync(() => {
                nanos = 15_000_000_000n;
              }).pipe(
                Effect.andThen(ThreadSendAcknowledgement.check(id)),
                Effect.andThen(Effect.die("expired fence must interrupt")),
              ),
              { commandId: id, messageId: MessageId.make("message:fence"), mode: "auto" },
            ),
            "target read at the absolute fence",
          ),
        scope,
        "fence-before-timer",
      ).pipe(
        Effect.provideService(Clock.Clock, { ...clock, monotonicTimeNanosUnsafe: () => nanos }),
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "send_timeout");
        assert.include(result.failure.message, "did not save");
        assert.include(result.failure.message, "fence-before-timer");
        assert.include(result.failure.message, "target read at the absolute fence");
      }
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("keeps a committed acknowledgement when the timer runs after the deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const scope = yield* Effect.scope;
      const release = yield* Deferred.make<void>();
      let nanos = 0n;
      const id = CommandId.make("command:commit-before-timer");
      const saved: OrchestratorMcpThreadSendResult = {
        threadId: ThreadId.make("thread:committed"),
        messageId: MessageId.make("message:committed"),
        runId: RunId.make("run:committed"),
        status: "preparing",
        delivery: "started",
      };
      const result = yield* ThreadSendAcknowledgement.bounded(
        () =>
          ThreadSendAcknowledgement.observe(
            Effect.gen(function* () {
              const observer = yield* ThreadSendAcknowledgement.command;
              observer?.accept(saved);
              nanos = 20_000_000_000n;
              yield* Deferred.await(release);
              return saved;
            }),
            { commandId: id, messageId: saved.messageId, mode: "auto" },
          ),
        scope,
        "commit-before-timer",
      ).pipe(
        Effect.provideService(Clock.Clock, { ...clock, monotonicTimeNanosUnsafe: () => nanos }),
      );
      assert.deepEqual(result, saved);
      yield* Deferred.succeed(release, undefined);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
