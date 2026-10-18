import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  checkSend,
  guardSend,
  installSendGuard,
  requireSendGuard,
  type SendGuardOutcome,
  type SendGuardRequest,
} from "./guardHook.ts";

const request: SendGuardRequest = {
  path: "thread-send",
  targetThreadId: ThreadId.make("t-target"),
  from: { _tag: "thread", threadId: ThreadId.make("t-sender"), title: "Sender" },
  text: "hello",
  requestKey: "guard-hook:1",
};

const knocked: SendGuardOutcome = {
  _tag: "knocked",
  missionId: "m-1" as never,
  knockId: "knock-1" as never,
};

// The slot is process-wide, so these run in order: the "not required" case
// must come before anything calls requireSendGuard.
describe("send guard slot", () => {
  it.effect("without missions every send passes", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* guardSend(request), { _tag: "pass" });
    }),
  );

  it.effect("one owner at a time: an overlapping install dies, a later one works", () =>
    Effect.gen(function* () {
      const first = () => Effect.succeed(knocked);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSendGuard(first);
          const overlap = yield* Effect.exit(
            Effect.scoped(installSendGuard(() => Effect.succeed({ _tag: "pass" } as const))),
          );
          assert.isTrue(Exit.hasDies(overlap));
          // The first guard is still the one deciding.
          assert.deepStrictEqual(yield* guardSend(request), knocked);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSendGuard(first);
          assert.deepStrictEqual(yield* guardSend(request), knocked);
        }),
      );
    }),
  );

  it.effect("once required, a send with no guard waits for it and then fails closed", () =>
    Effect.gen(function* () {
      requireSendGuard();
      const waiting = yield* Effect.forkChild(guardSend(request));
      yield* TestClock.adjust("11 seconds");
      const exit = yield* Fiber.await(waiting);
      assert.isTrue(Exit.isFailure(exit));

      // A guard that comes up during the wait decides the send.
      const late = yield* Effect.forkChild(guardSend(request));
      yield* TestClock.adjust("1 second");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSendGuard(() => Effect.succeed(knocked));
          yield* TestClock.adjust("1 second");
          assert.deepStrictEqual(yield* Fiber.join(late), knocked);
        }),
      );
    }),
  );
});

// --- router additions: r3 ---
describe("check-only slot", () => {
  it.effect("checkSend asks the installed check and never the acting guard", () =>
    Effect.gen(function* () {
      let acted = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSendGuard(
            () => {
              acted += 1;
              return Effect.succeed(knocked);
            },
            () => Effect.succeed({ _tag: "knock", missionId: "m-1" as never, reason: "outsider" }),
          );
          assert.deepStrictEqual(yield* checkSend(request), {
            _tag: "knock",
            missionId: "m-1" as never,
            reason: "outsider",
          });
          assert.strictEqual(acted, 0);
        }),
      );
      // A guard installed without a check refuses rather than acting.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installSendGuard(() => {
            acted += 1;
            return Effect.succeed(knocked);
          });
          const exit = yield* Effect.exit(checkSend(request));
          assert.isTrue(Exit.isFailure(exit));
          assert.strictEqual(acted, 0);
        }),
      );
    }),
  );
});
// --- end router additions ---
