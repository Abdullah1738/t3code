import { assert, it, vi } from "@effect/vitest";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import { Analytics } from "../../analytics/Analytics.ts";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Metric from "effect/Metric";
import * as References from "effect/References";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { KanbanError } from "@t3tools/contracts";

import * as BoardLocks from "./boardLocks.ts";
import * as SavedWrite from "./savedWrite.ts";
import * as SavedReply from "../tools/savedReply.ts";
import { McpSchema } from "effect/ai";

it.effect("#1747 an arbitrary child cannot release the owning fiber's gate", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    yield* locks.board(
      "a",
      Effect.gen(function* () {
        const child = yield* locks.outside(locks.holders, undefined, true).pipe(Effect.forkChild);
        assert.isTrue(
          (yield* Fiber.join(child)).some(
            (holder) => holder.boardId === "a" && holder.lock === "gate",
          ),
        );
      }),
    );
    assert.deepEqual(yield* locks.holders, []);
  }),
);

it.effect.each(["independent", "fresh", "background"] as const)(
  "#1747 %s work leaves the mutation's SELECT exemption behind",
  (scope) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const read = locks.board(
        "a",
        SavedWrite.read(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
      );
      const detached = scope === "background" ? SavedWrite.background(read) : locks[scope](read);
      const pending = yield* SavedWrite.maskedWrite(detached).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(2_000);
      assert.isDefined(pending.pollUnsafe());
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
      assert.deepEqual(yield* locks.holders, []);
    }),
);

it.effect("#1747 long holds retain the dependency at the threshold after it finishes", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const finishRead = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const warnings: unknown[] = [];
    const pending = yield* locks
      .board(
        "robob",
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finishRead)),
            Effect.withSpan("KanbanThreads.find"),
          );
          yield* Deferred.succeed(second, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.withSpan("KanbanService.publish"),
          );
        }),
      )
      .pipe(
        Effect.provideService(BoardLocks.operationName, "turnEnded"),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
            mergeWithExisting: false,
          }),
        ),
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(6_000);
    yield* Deferred.succeed(finishRead, undefined);
    yield* Deferred.await(second);
    yield* TestClock.adjust(1_000);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(pending);
    const row = warnings.find((message) =>
      String(message).includes('"event":"kanban board lock long hold"'),
    );
    assert.deepInclude(JSON.parse(String(row)), {
      threshold: { observedAtMs: 5_000, awaited: "KanbanThreads.find", readers: [] },
      subSteps: [
        { subStep: "KanbanThreads.find", ms: 6_000 },
        { subStep: "KanbanService.publish", ms: 1_000 },
      ],
    });
  }),
);

it.effect.each(["tick", "turnEnded"])(
  "#1747 a %s reader wait releases its gate without retrying the stalled dependency",
  (name) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reader = yield* Semaphore.make(1);
      const held = yield* Deferred.make<void>();
      const holder = yield* reader
        .withPermits(1)(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      let attempts = 0;
      const pending = yield* locks
        .run(
          Effect.gen(function* () {
            attempts++;
            yield* locks.access("a", Effect.void);
            yield* SavedWrite.read(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(reader.withPermits(1)(Effect.void)),
              ),
            );
          }),
        )
        .pipe(
          Effect.provideService(BoardLocks.operationName, `test1747.${name}`),
          Effect.exit,
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      const written = yield* Deferred.make<void>();
      const writer = yield* locks
        .board("a", locks.access("a", Deferred.succeed(written, undefined), true))
        .pipe(Effect.forkChild);
      const other = yield* SavedReply.protect(
        locks.board(
          "b",
          locks.access("b", Effect.succeed(new McpSchema.CallToolResult({ content: [] })), true),
        ),
        "card_update",
      );
      assert.isFalse((other as McpSchema.CallToolResult).isError ?? false);
      yield* TestClock.adjust(2_000);
      assert.isTrue(yield* Deferred.isDone(written));
      assert.isDefined(pending.pollUnsafe());
      assert.isUndefined(holder.pollUnsafe());
      assert.equal(attempts, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(writer);
      const result = yield* Fiber.join(pending);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.instanceOf(Cause.squash(result.cause), BoardLocks.DispatchReadBudgetExceeded);
      assert.deepEqual(yield* locks.holders, []);
    }),
);

it.effect.each(
  (["gate", "card", "migration"] as const).flatMap((lock) =>
    [4_900, 5_000, 8_195].map((heldMs) => ({ lock, heldMs })),
  ),
)("#1539 logs a $lock hold of $heldMs ms as a complete holder row", ({ lock, heldMs }) => {
  const logs: Array<{ line: string; annotations: Readonly<Record<string, unknown>> }> = [];
  const logger = Logger.make(({ fiber, message }) => {
    if (String(message).includes('"event":"kanban board lock long hold"'))
      logs.push({
        line: String(message),
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
  });
  return Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const body = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)));
    const hold =
      lock === "migration"
        ? locks.exclusive(body)
        : lock === "card"
          ? locks.run(locks.access("robob", Effect.void).pipe(Effect.andThen(body)), "card-1539")
          : locks.board("robob", body);
    const holder = yield* Effect.forkChild(
      hold.pipe(Effect.provideService(BoardLocks.operationName, "card.reviewResult")),
    );
    yield* Deferred.await(entered);
    const waiter = yield* Effect.forkChild(
      lock === "card"
        ? locks.run(locks.access("robob", Effect.void), "card-1539")
        : locks.board("robob", Effect.void),
    );
    yield* TestClock.adjust(0);
    assert.isUndefined(waiter.pollUnsafe());
    yield* TestClock.adjust(heldMs);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(waiter);
    assert.deepStrictEqual(yield* locks.holders, []);
    if (heldMs < 5_000) {
      assert.lengthOf(logs, 0);
      return;
    }
    assert.lengthOf(logs, 1);
    const fields = {
      "board.observed_at_ms": heldMs,
      "board.id": lock === "migration" ? "*" : "robob",
      "board.holder": "card.reviewResult",
      "board.card_id": lock === "card" ? "card-1539" : null,
      "board.lock": lock,
      "board.mode": "exclusive",
      "board.acquired_at_ms": 0,
      "board.held_ms": heldMs,
      "board.waiters": 1,
      ...(lock === "migration"
        ? {}
        : {
            subSteps: [{ subStep: "card.reviewResult", ms: heldMs }],
            threshold: { awaited: "card.reviewResult", readers: [], observedAtMs: 5_000 },
          }),
    };
    assert.deepStrictEqual(JSON.parse(logs[0]!.line), {
      event: "kanban board lock long hold",
      ...fields,
    });
    assert.deepInclude(logs[0]!.annotations, { ...fields, "board.lock_log": true });
    assert.notProperty(logs[0]!.annotations, "board.waiting_on");
  }).pipe(
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

it.effect("#566 a committed re-acquire timeout never advertises a safe retry", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const finishCall = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks
        .board(
          "a",
          locks.outside(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finishCall))),
          ),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    const writer = yield* Effect.forkChild(
      locks.board(
        "a",
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(held);
    yield* Deferred.succeed(finishCall, undefined);
    yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS + 1);
    const result = yield* Fiber.join(first);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      assert.instanceOf(error, KanbanError);
      assert.strictEqual((error as KanbanError).saved, null);
      const message = String(error);
      assert.include(message, "may have been applied");
      assert.notInclude(message, "Safe to retry");
    }
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writer);
  }),
);

it.effect("#566 reconciliation still fences a migration during the external call", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks
        .board(
          "a",
          locks.outside(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            undefined,
            false,
            Effect.succeed(true),
          ),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.exclusive(Effect.void);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
  }),
);

it.effect("unrelated boards and single-card writes do not share a permit", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks.run(
        locks.access(
          "a",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        "card-a",
      ),
    );
    yield* Deferred.await(entered);
    yield* locks.board("b", Effect.void);
    yield* locks.run(locks.access("a", Effect.void, true), "card-b");
    const waiting = yield* Effect.forkChild(locks.run(locks.access("a", Effect.void), "card-a"));
    const broad = yield* Effect.forkChild(locks.board("a", Effect.void));
    yield* Effect.yieldNow;
    assert.isUndefined(waiting.pollUnsafe());
    assert.isUndefined(broad.pollUnsafe());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(waiting);
    yield* Fiber.join(broad);
  }),
);

it.effect("external I/O releases the permit and fences a stale completion even when caught", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let committed = false;
    let abandoned = false;
    let attempted = false;
    const first = yield* Effect.forkChild(
      locks
        .board(
          "a",
          Effect.gen(function* () {
            yield* locks
              .outside(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
                () =>
                  Effect.sync(() => {
                    abandoned = true;
                  }),
              )
              .pipe(Effect.catchCause(() => Effect.void));
            attempted = true;
            yield* locks.access(
              "a",
              Effect.sync(() => {
                committed = true;
              }),
              true,
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.board("a", locks.access("a", Effect.void, true));
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
    assert.isFalse(committed);
    assert.isTrue(attempted);
    assert.isTrue(abandoned);
    yield* locks.board("a", Effect.void);
  }),
);

it.effect("an expired waiter never writes later and returns its migration permit", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks.board(
        "a",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(entered);
    let written = false;
    const waiter = yield* Effect.forkChild(
      locks
        .board(
          "a",
          Effect.sync(() => {
            written = true;
          }),
        )
        .pipe(Effect.exit),
    );
    yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS + 1);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(waiter)));
    assert.isFalse(written);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* locks.exclusive(Effect.void);
    assert.isFalse(written);
  }),
);

it.effect.each([1, 2, 3])(
  "cancellation at permit transfer %i returns migration, board, and card permits",
  (transfer) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const prototype = Object.getPrototypeOf(Semaphore.makeUnsafe(1)) as Semaphore.Semaphore;
      const originalTake = prototype.take;
      const originalAvailable = prototype.takeIfAvailable;
      let victim: Fiber.Fiber<unknown, unknown> | undefined;
      let transfers = 0;
      let interrupted = false;
      const afterTransfer = (acquired: boolean) =>
        Effect.sync(() => {
          if (!acquired || interrupted || ++transfers !== transfer) return;
          interrupted = true;
          victim!.interruptUnsafe();
        });
      // Inject the interrupt after the semaphore owns the permit, before the
      // caller can record ownership. Cover both the old and current take paths.
      const take = vi.spyOn(prototype, "take").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return originalTake.call(this, permits).pipe(Effect.tap(() => afterTransfer(true)));
      });
      const available = vi.spyOn(prototype, "takeIfAvailable").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return originalAvailable.call(this, permits).pipe(Effect.tap(afterTransfer));
      });
      yield* Effect.gen(function* () {
        const cancelled = yield* Effect.forkChild(
          Effect.withFiber((fiber) => {
            victim = fiber;
            return locks.run(locks.access("a", Effect.void), "card-a");
          }),
        );
        assert.isTrue(Exit.isFailure(yield* Fiber.await(cancelled)));
        assert.isTrue(interrupted);
        assert.deepStrictEqual(yield* locks.holders, []);
        const reuse = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* locks.run(locks.access("a", Effect.void), "card-a");
            yield* locks.board("a", Effect.void);
            yield* locks.exclusive(Effect.void);
          }).pipe(Effect.timeout(BoardLocks.WRITE_WAIT_MS)),
        );
        yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS + 1);
        yield* Fiber.join(reuse);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            take.mockRestore();
            available.mockRestore();
          }),
        ),
      );
    }),
);

it.effect(
  "migration fences in-flight I/O, while a different card does not invalidate a card write",
  () =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        locks.run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void);
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            yield* locks.access("a", Effect.void, true);
          }),
          "card-a",
        ),
      );
      yield* Deferred.await(entered);
      yield* locks.run(locks.access("a", Effect.void, true), "card-b");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);

      const enteredAgain = yield* Deferred.make<void>();
      const releaseAgain = yield* Deferred.make<void>();
      let committed = false;
      const stale = yield* Effect.forkChild(
        locks
          .board(
            "a",
            Effect.gen(function* () {
              yield* locks.outside(
                Deferred.succeed(enteredAgain, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseAgain)),
                ),
              );
              yield* locks.access(
                "a",
                Effect.sync(() => {
                  committed = true;
                }),
                true,
              );
            }),
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(enteredAgain);
      yield* locks.exclusive(Effect.void);
      yield* Deferred.succeed(releaseAgain, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(stale)));
      assert.isFalse(committed);
    }),
);

it.effect(
  "a launch is cleaned up if a later association fails, but an attached launch is kept",
  () =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const cleaned: Array<string> = [];
      yield* locks
        .board(
          "a",
          Effect.gen(function* () {
            yield* locks.launched(
              "orphan",
              Effect.sync(() => {
                cleaned.push("orphan");
              }),
            );
            yield* locks.launched(
              "attached",
              Effect.sync(() => {
                cleaned.push("attached");
              }),
            );
            yield* locks.attached("attached");
            return yield* Effect.fail("association failed");
          }),
        )
        .pipe(Effect.ignore);
      assert.deepStrictEqual(cleaned, ["orphan"]);
      yield* locks.board("a", Effect.void);
    }),
);

it.effect("#638 retries an uncommitted stale snapshot with new versions", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    yield* locks.board("a", Effect.void);
    let attempts = 0;
    const result = yield* locks.run(
      Effect.gen(function* () {
        attempts++;
        yield* locks.observe(Effect.void);
        if (attempts === 1) yield* locks.exclusive(Effect.void);
        return yield* locks.access("a", Effect.succeed("saved"), true);
      }),
      undefined,
    );
    assert.strictEqual(result, "saved");
    assert.strictEqual(attempts, 2);
    attempts = 0;
    const failed = yield* Effect.exit(
      locks.run(
        Effect.gen(function* () {
          attempts++;
          yield* locks.observe(Effect.void);
          yield* locks.exclusive(Effect.void);
          yield* locks.access("a", Effect.void, true);
        }),
        undefined,
      ),
    );
    assert.isTrue(Exit.isFailure(failed));
    assert.strictEqual(attempts, 9);
  }),
);

it.effect.each(["saved", "external"] as const)(
  "#638 never retries after %s work and a stale permit",
  (kind) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      let attempts = 0;
      const result = yield* Effect.exit(
        locks.run(
          Effect.gen(function* () {
            attempts++;
            if (kind === "saved") yield* locks.access("a", Effect.void, true);
            else yield* locks.outside(Effect.void);
            // Even an incorrectly classified later defect cannot override the operation's commit state.
            return yield* Effect.die(new BoardLocks.BoardStateChanged(false));
          }),
          undefined,
        ),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(attempts, 1);
      attempts = 0;
      yield* Effect.exit(
        locks.run(
          Effect.sync(() => {
            attempts++;
          }).pipe(Effect.andThen(Effect.die(new BoardLocks.BoardStateChanged(true)))),
          undefined,
        ),
      );
      assert.strictEqual(attempts, 1);
    }),
);

it.effect(
  "busy board stress: row-scoped requests and saved answers survive unrelated writers",
  () =>
    Effect.gen(function* () {
      const measure = (scoped: boolean) =>
        Effect.gen(function* () {
          const locks = yield* BoardLocks.make();
          const release = yield* Deferred.make<void>();
          const entered = Array.from({ length: 40 }, () => Deferred.makeUnsafe<void>());
          let conflicts = 0;
          let answers = 0;
          const requests = yield* Effect.forEach(entered, (ready, index) =>
            Effect.forkChild(
              locks
                .run(
                  Effect.gen(function* () {
                    yield* locks.access(
                      "busy",
                      Effect.void,
                      index >= 20,
                      scoped ? `discussion:${index}` : undefined,
                    );
                    yield* locks.outside(
                      Deferred.succeed(ready, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      ),
                    );
                    if (index >= 20) answers += 1;
                  }),
                )
                .pipe(
                  Effect.catchCause(() =>
                    Effect.sync(() => {
                      conflicts += 1;
                    }),
                  ),
                ),
            ),
          );
          yield* Effect.forEach(entered, Deferred.await);
          yield* Effect.forEach(
            Array.from({ length: 32 }, (_, i) => i),
            (i) =>
              locks.run(
                locks.access("busy", Effect.void, true, scoped ? `card:${i}` : undefined),
                `card:${i}`,
              ),
            { concurrency: "unbounded" },
          );
          yield* Deferred.succeed(release, undefined);
          yield* Effect.forEach(requests, Fiber.join);
          return { conflicts, lostAnswers: 20 - answers };
        });
      const before = yield* measure(false);
      const after = yield* measure(true);
      assert.deepEqual(before, { conflicts: 40, lostAnswers: 20 });
      assert.deepEqual(after, { conflicts: 0, lostAnswers: 0 });
      yield* Effect.log("kanban stress (32 writers, 20 requests, 20 answers)", { before, after });
    }),
);

it.effect("row dependency still fences a same-row update during external I/O", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let overwritten = false;
    const reader = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void, false, "discussion:1");
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            yield* locks.access(
              "a",
              Effect.sync(() => {
                overwritten = true;
              }),
              true,
              "discussion:1",
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.run(locks.access("a", Effect.void, true, "discussion:1"));
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(reader)));
    assert.isFalse(overwritten);
  }),
);

it.effect("a collection read after a row read restores broad conflict tracking", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const reader = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void, false, "board");
            yield* locks.access("a", Effect.void);
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.run(locks.access("a", Effect.void, true, "card:other"), "other");
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(reader)));
  }),
);

it.effect("a stale read-only operation reruns before any write or external side effect", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let reads = 0;
    let sent = 0;
    yield* locks.run(
      Effect.gen(function* () {
        yield* locks.access("a", Effect.void);
        yield* locks.outside(
          Effect.gen(function* () {
            reads += 1;
            if (reads === 1)
              yield* Effect.forkChild(
                locks.run(locks.access("a", Effect.void, true), "other"),
              ).pipe(Effect.flatMap(Fiber.join));
          }),
          undefined,
          true,
        );
        yield* locks.outside(
          Effect.sync(() => {
            sent += 1;
          }),
        );
      }),
    );
    assert.strictEqual(reads, 2);
    assert.strictEqual(sent, 1);
  }),
);

it.effect.each(["initial", "reacquire"] as const)(
  "#1941 %s validation can read outside its gate without re-entering itself",
  (stage) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      let depth = 0;
      let validations = 0;
      let reads = 0;
      yield* locks.run(
        Effect.gen(function* () {
          yield* locks.scopeDispatch(
            "a",
            ["card:target"],
            Effect.gen(function* () {
              assert.strictEqual(++depth, 1, "validation re-entered before its read returned");
              validations++;
              if (stage === "initial" || validations > 1) {
                yield* locks.outsideRead(
                  "view:worker",
                  () => 0,
                  Effect.sync(() => {
                    reads++;
                  }),
                );
              }
              return true;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  depth--;
                }),
              ),
            ),
          );
          yield* locks.outside(Effect.void, undefined, true);
        }),
        "target",
      );
      assert.strictEqual(validations, 2);
      assert.strictEqual(reads, stage === "initial" ? 2 : 1);
      assert.deepEqual(yield* locks.holders, []);
    }),
);

it.effect.each(["none", "unrelated", "card", "slot", "migration"] as const)(
  "#1941 validation retries its snapshot after an outside read overlaps %s changes",
  (change) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let free = true;
      let depth = 0;
      let attempts = 0;
      let reads = 0;
      let sent = 0;
      const dispatch = yield* locks
        .run(
          Effect.gen(function* () {
            attempts++;
            yield* locks.scopeDispatch(
              "a",
              ["card:target"],
              Effect.gen(function* () {
                assert.strictEqual(++depth, 1, "validation re-entered before its read returned");
                const snapshot = free;
                yield* locks.outsideRead(
                  "view:worker",
                  () => 0,
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        reads++;
                      }),
                    ),
                  ),
                );
                return snapshot;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    depth--;
                  }),
                ),
              ),
            );
            yield* locks.outside(
              Effect.sync(() => {
                sent++;
              }),
            );
          }),
          "target",
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      if (change === "migration") yield* locks.exclusive(Effect.void);
      else if (change !== "none") {
        yield* locks.run(
          locks.access(
            "a",
            Effect.sync(() => {
              if (change === "slot") free = false;
            }),
            true,
            change === "card" ? "card:target" : change === "slot" ? "slots:worker" : "card:other",
          ),
        );
      }
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(dispatch);
      assert.strictEqual(Exit.isSuccess(result), change !== "slot");
      assert.strictEqual(sent, change === "slot" ? 0 : 1);
      assert.strictEqual(attempts, change === "none" ? 1 : change === "slot" ? 9 : 2);
      assert.strictEqual(reads, change === "slot" ? 1 : 2);
      assert.deepEqual(yield* locks.holders, []);
    }),
);

it.effect.each(["validation", "read"] as const)(
  "#1397 pending dispatch %s releases the gate within its read budget",
  (stage) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let free = true;
      let sent = 0;
      let first = true;
      const pending = SavedWrite.read(
        Effect.suspend(() =>
          first
            ? Effect.sync(() => {
                first = false;
              }).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(resume)),
              )
            : Effect.void,
        ),
      );
      const dispatch = yield* Effect.forkChild(
        locks
          .run(
            Effect.gen(function* () {
              yield* locks.scopeDispatch(
                "a",
                ["card:target"],
                Effect.sync(() => free).pipe(
                  Effect.flatMap((snapshot) =>
                    (stage === "validation" ? pending : Effect.void).pipe(Effect.as(snapshot)),
                  ),
                ),
              );
              if (stage === "read") yield* locks.access("a", pending);
              yield* locks.outside(
                Effect.sync(() => {
                  sent += 1;
                }),
              );
            }),
            "target",
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(entered);
      const admitted = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        locks
          .board(
            "a",
            locks.access(
              "a",
              Effect.sync(() => {
                free = false;
              }),
              true,
            ),
          )
          .pipe(Effect.tap(() => Deferred.succeed(admitted, undefined))),
      );
      yield* TestClock.adjust("3 seconds");
      assert.isTrue(yield* Deferred.isDone(admitted));
      yield* Fiber.join(writer);
      yield* Deferred.succeed(resume, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(dispatch)));
      assert.strictEqual(sent, 0);
    }),
);

it.effect("#1397 reads share one hold budget and a timeout does not immediately retry", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const pending = yield* Deferred.make<void>();
    let attempts = 0;
    let sent = false;
    const start = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            attempts += 1;
            yield* locks.scopeDispatch("a", ["card:target"], Effect.succeed(true));
            yield* locks.access(
              "a",
              SavedWrite.read(
                Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(resume))),
              ),
            );
            yield* locks.access(
              "a",
              SavedWrite.read(
                Deferred.succeed(second, undefined).pipe(Effect.andThen(Deferred.await(pending))),
              ),
            );
            sent = true;
          }),
          "target",
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust(1500);
    yield* Deferred.succeed(resume, undefined);
    yield* Deferred.await(second);
    const admitted = yield* Deferred.make<void>();
    const writer = yield* Effect.forkChild(locks.board("a", Deferred.succeed(admitted, undefined)));
    yield* TestClock.adjust(1000);
    assert.isTrue(yield* Deferred.isDone(admitted));
    yield* Fiber.join(writer);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(start)));
    assert.strictEqual(attempts, 1);
    assert.isFalse(sent);
  }),
);

it.effect.each(["unrelated", "card", "slot", "migration"] as const)(
  "dispatch dependencies retain only their card and slot across %s changes",
  (change) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let free = true;
      let abandoned = false;
      const dispatch = yield* Effect.forkChild(
        locks
          .board(
            "a",
            Effect.gen(function* () {
              yield* locks.scopeDispatch(
                "a",
                ["card:target"],
                Effect.sync(() => free),
              );
              // Dispatch's collection reads cannot reintroduce the board generation or epoch.
              yield* locks.access("a", Effect.void);
              yield* locks.outside(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
                () =>
                  Effect.sync(() => {
                    abandoned = true;
                  }),
              );
            }),
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(entered);
      if (change === "migration") yield* locks.exclusive(Effect.void);
      else if (change === "slot") free = false;
      else
        yield* locks.run(
          locks.access("a", Effect.void, true, change === "card" ? "card:target" : undefined),
        );
      yield* Deferred.succeed(resume, undefined);
      assert.strictEqual(Exit.isSuccess(yield* Fiber.join(dispatch)), change === "unrelated");
      assert.strictEqual(abandoned, change !== "unrelated");
    }),
);

it.effect.each([
  "refresh",
  "content",
  "links",
  "refresh-after-content",
  "refresh-after-migration",
] as const)("only dispatch ignores link metadata during %s", (change) =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const scoped = yield* Effect.forkChild(
      locks
        .board(
          "a",
          Effect.gen(function* () {
            yield* locks.scopeDispatch("a", ["card:target"], Effect.succeed(true));
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    const defaultEntered = yield* Deferred.make<void>();
    const ordinary = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void, false, "card:target");
            yield* locks.outside(
              Deferred.succeed(defaultEntered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
              ),
            );
          }),
          "target",
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(defaultEntered);
    const write = locks.run(locks.access("a", Effect.void, true, "card:target"));
    if (change === "refresh-after-content") yield* write;
    if (change === "refresh-after-migration") yield* locks.exclusive(Effect.void);
    yield* change.startsWith("refresh") ? locks.dispatchMetadata(write) : write;
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual(Exit.isSuccess(yield* Fiber.join(scoped)), change === "refresh");
    assert.isFalse(Exit.isSuccess(yield* Fiber.join(ordinary)));
  }),
);

it.effect.each([false, true])(
  "compensation releases permits even with a stale snapshot: %s",
  (stale) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      let compensated = false;
      const writer = locks.run(locks.access("board", Effect.void, true));
      const result = yield* Effect.exit(
        locks.run(
          Effect.gen(function* () {
            yield* locks.access("board", Effect.void);
            if (stale)
              yield* locks.outside(Effect.forkChild(writer).pipe(Effect.flatMap(Fiber.join)));
          }).pipe(
            Effect.ensuring(
              locks.unlock.pipe(
                Effect.andThen(
                  Effect.forkChild(
                    locks.run(
                      locks.access(
                        "board",
                        Effect.sync(() => {
                          compensated = true;
                        }),
                        true,
                      ),
                    ),
                  ).pipe(Effect.flatMap(Fiber.join)),
                ),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(compensated);
      assert.strictEqual(Exit.isFailure(result), stale);
    }),
);

/**
 * A board-wide operation that reads outside the gate, once a card write
 * lands during its first read. `fence` is what the read describes.
 */
const staleOnce = (bumpFenceDuringRead: boolean) =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let fence = 0;
    let reads = 0;
    let attempts = 0;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const read = locks.outsideRead(
      "view:thread-1",
      () => fence,
      Effect.gen(function* () {
        reads += 1;
        if (reads === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return `state-${reads}`;
      }),
    );
    const op = yield* Effect.forkChild(
      locks.board(
        "a",
        Effect.gen(function* () {
          attempts += 1;
          const seen = yield* read;
          yield* locks.access("a", Effect.void, true);
          return seen;
        }),
      ),
    );
    yield* Deferred.await(entered);
    // An outside read keeps its own budget after releasing the board gate.
    yield* TestClock.adjust(10_000);
    // Another writer on the board while the read is out: the operation is stale.
    yield* locks.run(locks.access("a", Effect.void, true), "card-b");
    if (bumpFenceDuringRead) fence += 1;
    yield* Deferred.succeed(release, undefined);
    const seen = yield* Fiber.join(op);
    return { seen, reads, attempts };
  });

it.effect("a stale rerun replays its earlier read instead of queueing for it again", () =>
  Effect.gen(function* () {
    const { seen, reads, attempts } = yield* staleOnce(false);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(reads, 1);
    assert.strictEqual(seen, "state-1");
  }),
);

it.effect("a rerun reads again when the fence moved during the earlier read", () =>
  Effect.gen(function* () {
    const { seen, reads, attempts } = yield* staleOnce(true);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(reads, 2);
    assert.strictEqual(seen, "state-2");
  }),
);

it.effect("reads within one attempt and in separate operations are never replayed", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let reads = 0;
    const read = locks.outsideRead(
      "view:thread-1",
      () => 0,
      Effect.sync(() => (reads += 1)),
    );
    const both = yield* locks.board(
      "a",
      Effect.gen(function* () {
        return [yield* read, yield* read] as const;
      }),
    );
    assert.deepStrictEqual(both, [1, 2]);
    assert.strictEqual(yield* locks.board("a", read), 3);
    // Outside any operation it is a plain read.
    assert.strictEqual(yield* read, 4);
    // One constructed operation run twice, and twice at once: each run reads for itself.
    const op = locks.board("a", read);
    assert.strictEqual(yield* op, 5);
    assert.strictEqual(yield* op, 6);
    const pair = yield* Effect.all([op, op], { concurrency: 2 });
    assert.deepStrictEqual([...pair].sort(), [7, 8]);
  }),
);

it.effect(
  "a tick step backs off twice, releases its gate, and never retries a saved or sent action",
  () =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      let attempts = 0;
      const conflict = locks
        .step(
          Effect.gen(function* () {
            attempts += 1;
            yield* locks.access("a", Effect.void);
            yield* locks.outside(
              Effect.forkChild(locks.run(locks.access("a", Effect.void, true), "x")).pipe(
                Effect.flatMap(Fiber.join),
              ),
              undefined,
              true,
            );
          }),
          "x",
        )
        .pipe(Effect.exit);
      const fiber = yield* Effect.forkChild(conflict);
      yield* TestClock.adjust(10);
      assert.strictEqual(attempts, 2);
      yield* locks.board("a", Effect.void);
      yield* TestClock.adjust(20);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      assert.strictEqual(attempts, 3);
      for (const committed of [true, false]) {
        let calls = 0;
        const exit = yield* locks
          .step(
            Effect.gen(function* () {
              calls += 1;
              yield* locks.access("a", Effect.void, committed);
              yield* locks.outside(
                Effect.forkChild(locks.run(locks.access("a", Effect.void, true), "x")).pipe(
                  Effect.flatMap(Fiber.join),
                ),
                undefined,
                committed,
              );
            }),
            "x",
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(calls, 1);
      }
    }),
);

it.effect("#882 detached follow-ons own cleanup after their original operation returns", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const start = yield* Deferred.make<void>();
    const cleaned: string[] = [];
    const background = yield* locks.board(
      "a",
      Effect.forkChild(
        locks
          .independent(
            locks.board(
              "a",
              Effect.gen(function* () {
                yield* Deferred.await(start);
                yield* locks.launched(
                  "orphan",
                  Effect.sync(() => {
                    cleaned.push("orphan");
                  }),
                );
                return yield* Effect.fail("association failed");
              }),
            ),
          )
          .pipe(Effect.exit),
      ),
    );
    yield* Deferred.succeed(start, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(background)));
    assert.deepStrictEqual(cleaned, ["orphan"]);
    yield* locks.board("a", Effect.void);
  }),
);

it.effect("saved-reply admission expires before the reply budget and never writes later", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      locks.board(
        "a",
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(held);
    let written = false;
    const waiter = yield* Effect.forkChild(
      SavedReply.protect(
        locks
          .board(
            "a",
            locks.access(
              "a",
              Effect.sync(() => {
                written = true;
              }),
              true,
            ),
          )
          .pipe(Effect.as(new McpSchema.CallToolResult({ content: [] }))),
        "card_update",
      ).pipe(Effect.exit),
    );
    yield* TestClock.adjust(SavedReply.ADMISSION_BUDGET_MS - 1);
    assert.isUndefined(waiter.pollUnsafe());
    yield* TestClock.adjust(1);
    const result = yield* Fiber.join(waiter);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      assert.include(String(Cause.squash(result.cause)), "Board busy: not written (held");
    }
    assert.isFalse(written);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS);
    yield* locks.exclusive(Effect.void);
    assert.isFalse(written);
  }),
);

it.effect.each([
  "unrelated",
  "card",
  "stop",
  "migration",
  "refresh",
  "refresh-after-content",
] as const)("a startup reconciliation cannot forgive a dispatch dependency after %s", (change) =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let abandoned = false;
    const dispatch = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.scopeDispatch("a", ["card:target", "stops:worker"], Effect.succeed(true));
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
              () =>
                Effect.sync(() => {
                  abandoned = true;
                }),
              false,
              Effect.succeed(true),
            );
          }),
          "target",
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    const write = (resource?: string) => locks.run(locks.access("a", Effect.void, true, resource));
    if (change === "migration") yield* locks.exclusive(Effect.void);
    else if (change === "unrelated") yield* write();
    else if (change === "stop") yield* write("stops:worker");
    else {
      if (change === "refresh-after-content") yield* write("card:target");
      yield* change.startsWith("refresh")
        ? locks.dispatchMetadata(write("card:target"))
        : write("card:target");
    }
    yield* Deferred.succeed(resume, undefined);
    const valid = change === "unrelated" || change === "refresh";
    assert.strictEqual(Exit.isSuccess(yield* Fiber.join(dispatch)), valid);
    assert.strictEqual(abandoned, !valid);
  }),
);

it.effect.each(["migration", "gate", "card"] as const)(
  "#1290 %s refusal names the holder and logs all admission fields once",
  (lock) => {
    const logs: Array<{ message: unknown; annotations: Readonly<Record<string, unknown>> }> = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    });
    return Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const body = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      const hold =
        lock === "migration"
          ? locks.exclusive(body)
          : locks.run(
              locks.access("crpko", Effect.void).pipe(Effect.andThen(body)),
              lock === "card" ? "907" : undefined,
            );
      const holder = yield* Effect.forkChild(hold.pipe(Effect.withSpan("test.longHolder")));
      yield* Deferred.await(entered);
      const waiter = yield* Effect.forkChild(
        locks
          .run(
            locks.access("crpko", Effect.die("must not write"), true, "card:907"),
            lock === "gate" ? undefined : "907",
          )
          .pipe(
            Effect.withSpan("test.card_move"),
            Effect.withSpan("tools/call", { attributes: { "mcp.tool.name": "card_move" } }),
            Effect.provideService(BoardLocks.writeWaitMs, 134_000),
            Effect.exit,
          ),
      );
      yield* TestClock.adjust(134_000);
      const result = yield* Fiber.join(waiter);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        assert.instanceOf(error, KanbanError);
        assert.strictEqual((error as KanbanError).saved, false);
        assert.include(
          String(error),
          "Board busy: not written (held 134000ms by test.longHolder; waited 134000ms behind 0; most time: test.longHolder 134s). Safe to retry once.",
        );
      }
      const refusals = logs.filter((log) =>
        String(log.message).includes("kanban board write refused"),
      );
      assert.strictEqual(refusals.length, 1);
      assert.deepInclude(refusals[0]!.annotations, {
        "board.waiter": "card_move",
        "board.id": "crpko",
        "board.card_id": "907",
        "board.waiting_on": lock,
        "board.waited_ms": 134_000,
        "board.waiters": 1,
        "board.queue_ahead_at_admission": 0,
        "board.wait_by_label": [
          {
            label: "test.longHolder",
            lock: lock === "migration" ? "migration" : "gate",
            ms: 134_000,
            holds: 1,
          },
        ],
        "board.wait_accounted_ms": 134_000,
      });
      const blockers = refusals[0]!.annotations["board.blockers"] as Array<Record<string, unknown>>;
      assert.lengthOf(blockers, 1);
      assert.deepInclude(blockers[0], {
        label: "test.longHolder",
        lock,
        heldForMs: 134_000,
        acquiredAtMs: 0,
      });
      assert.isNumber(blockers[0]!.fiberId);
      assert.strictEqual((yield* locks.holders).filter((h) => h.label === "card_move").length, 0);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(holder);
      assert.deepStrictEqual(yield* locks.holders, []);
      yield* locks.exclusive(Effect.void);
    }).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  },
);

it.effect.each(["success", "failure", "interrupt"] as const)(
  "#1290 holder records are removed after %s",
  (outcome) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        locks
          .run(
            locks.access(
              "crpko",
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(finish);
                if (outcome === "failure") return yield* Effect.fail("broken");
              }),
            ),
            "907",
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(entered);
      assert.lengthOf(yield* locks.holders, 3);
      if (outcome === "interrupt") yield* Fiber.interrupt(holder);
      else {
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(holder);
      }
      assert.deepStrictEqual(yield* locks.holders, []);
      yield* locks.exclusive(Effect.void);
      const migrationEntered = yield* Deferred.make<void>();
      const migrationFinish = yield* Deferred.make<void>();
      const migration = yield* Effect.forkChild(
        locks
          .exclusive(
            Effect.gen(function* () {
              yield* Deferred.succeed(migrationEntered, undefined);
              yield* Deferred.await(migrationFinish);
              if (outcome === "failure") return yield* Effect.fail("broken");
            }),
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(migrationEntered);
      assert.lengthOf(yield* locks.holders, 1);
      if (outcome === "interrupt") yield* Fiber.interrupt(migration);
      else {
        yield* Deferred.succeed(migrationFinish, undefined);
        yield* Fiber.join(migration);
      }
      assert.deepStrictEqual(yield* locks.holders, []);
      yield* locks.board("crpko", Effect.void);
    }),
);

it.effect("#1290 long-holder warnings are rate limited per board while waiters remain", () => {
  const logs: Array<Readonly<Record<string, unknown>>> = [];
  const logger = Logger.make(({ fiber, message }) => {
    if (String(message).includes("kanban board lock held too long"))
      logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  return Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      locks.board("crpko", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
    );
    yield* Deferred.await(entered);
    const first = yield* Effect.forkChild(locks.board("crpko", Effect.void));
    const second = yield* Effect.forkChild(locks.board("crpko", Effect.void));
    yield* TestClock.adjust(59_999);
    assert.lengthOf(logs, 0);
    yield* TestClock.adjust(1);
    assert.lengthOf(logs, 1);
    yield* TestClock.adjust(30_000);
    assert.lengthOf(logs, 2);
    yield* Fiber.interrupt(first);
    yield* Fiber.interrupt(second);
    yield* Fiber.interrupt(holder);
    assert.deepStrictEqual(yield* locks.holders, []);
    yield* TestClock.adjust(60_000);
    assert.lengthOf(logs, 2);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect(
  "#1290 an exclusive gate waiter logs every shared holder in its durable JSON line",
  () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      if (String(message).includes("kanban board write refused")) messages.push(String(message));
    });
    return Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const holders = [];
      for (const id of ["first", "second"]) {
        const entered = yield* Deferred.make<void>();
        holders.push(
          yield* Effect.forkChild(
            locks
              .run(
                locks.access(
                  "crpko",
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                ),
                id,
              )
              .pipe(Effect.withSpan(`gate.${id}`)),
          ),
        );
        yield* Deferred.await(entered);
      }
      const waiter = yield* Effect.forkChild(
        locks
          .board("crpko", Effect.void)
          .pipe(Effect.provideService(BoardLocks.writeWaitMs, 25), Effect.exit),
      );
      yield* TestClock.adjust(25);
      const result = yield* Fiber.join(waiter);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.include(
          String(Cause.squash(result.cause)),
          "most time: gate.first 0s, gate.second 0s",
        );
      assert.lengthOf(messages, 1);
      assert.include(messages[0]!, '"event":"kanban board write refused"');
      assert.include(messages[0]!, '"board.waiting_on":"gate"');
      assert.include(messages[0]!, '"label":"gate.first"');
      assert.include(messages[0]!, '"label":"gate.second"');
      assert.include(messages[0]!, '"mode":"shared"');
      for (const holder of holders) yield* Fiber.interrupt(holder);
      assert.deepStrictEqual(yield* locks.holders, []);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  },
);

// McpCall.ts:49 keeps board-busy classification independent of the diagnostic suffix.
const boardBusyPrefix =
  /^(?:Missions board conflict: )?(?:Board busy: not written|Not saved \(board busy\))/;

const captureWaitLogs = () => {
  const logs: Array<Readonly<Record<string, unknown>>> = [];
  const logger = Logger.make(({ fiber, message }) => {
    if (/kanban board (write refused|lock held too long)/.test(String(message)))
      logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

it.effect("#1472 attributes a queued refusal to sequential gate holders", () => {
  const { logs, layer } = captureWaitLogs();
  return Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const holders = [];
    for (const label of [
      "KanbanService.tick",
      "KanbanService.wakeBoardNudges",
      "KanbanService.tickStep:missingThread",
    ]) {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        locks
          .board(
            "robob",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          )
          .pipe(Effect.provideService(BoardLocks.operationName, label)),
      );
      holders.push({ fiber, entered, finish });
      if (holders.length === 1) yield* Deferred.await(entered);
      else yield* TestClock.adjust(0);
    }
    const waiter = yield* Effect.forkChild(
      locks
        .board("robob", Effect.die("must not write"))
        .pipe(Effect.provideService(BoardLocks.writeWaitMs, 20_000), Effect.exit),
    );
    yield* TestClock.adjust(8_000);
    yield* Deferred.succeed(holders[0]!.finish, undefined);
    yield* Fiber.join(holders[0]!.fiber);
    yield* Deferred.await(holders[1]!.entered);
    yield* TestClock.adjust(5_000);
    yield* Deferred.succeed(holders[1]!.finish, undefined);
    yield* Fiber.join(holders[1]!.fiber);
    yield* Deferred.await(holders[2]!.entered);
    yield* TestClock.adjust(7_000);
    const result = yield* Fiber.join(waiter);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause) as KanbanError;
      assert.strictEqual(
        error.detail,
        "Board busy: not written (held 7000ms by KanbanService.tickStep:missingThread; waited 20000ms behind 2; most time: tick 8s, missingThread 7s, wakeBoardNudges 5s). Safe to retry once.",
      );
      assert.match(error.detail, boardBusyPrefix);
    }
    assert.lengthOf(logs, 1);
    assert.deepInclude(logs[0], {
      "board.queue_ahead_at_admission": 2,
      "board.waiters": 1,
      "board.wait_accounted_ms": 20_000,
      "board.wait_by_label": [
        { label: "tick", lock: "gate", ms: 8_000, holds: 1 },
        { label: "missingThread", lock: "gate", ms: 7_000, holds: 1 },
        { label: "wakeBoardNudges", lock: "gate", ms: 5_000, holds: 1 },
      ],
    });
    yield* Deferred.succeed(holders[2]!.finish, undefined);
    yield* Fiber.join(holders[2]!.fiber);
    const snapshot = (yield* Metric.snapshot).find(
      (metric) => metric.id === "kanban_board_gate_hold_ms" && metric.attributes?.label === "tick",
    );
    assert.strictEqual(snapshot?.type, "Histogram");
    if (snapshot?.type === "Histogram") {
      assert.strictEqual(snapshot.state.count, 1);
      assert.strictEqual(snapshot.state.sum, 8_000);
    }
  }).pipe(Effect.provide(layer));
});

it.effect.each(["gate", "migration"] as const)(
  "#1472 clips a %s holder to the wait interval",
  (lock) => {
    const { logs, layer } = captureWaitLogs();
    return Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const holder = yield* Effect.forkChild(
        (lock === "migration" ? locks.exclusive(hold) : locks.board("robob", hold)).pipe(
          Effect.provideService(BoardLocks.operationName, "KanbanService.tickStep:beforeWait"),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(10_000);
      const waiter = yield* Effect.forkChild(
        locks
          .board("robob", Effect.void)
          .pipe(Effect.provideService(BoardLocks.writeWaitMs, 20_000), Effect.exit),
      );
      yield* TestClock.adjust(20_000);
      yield* Fiber.join(waiter);
      assert.deepInclude(logs[0], {
        "board.wait_accounted_ms": 20_000,
        "board.wait_by_label": [{ label: "beforeWait", lock, ms: 20_000, holds: 1 }],
      });
      yield* Fiber.interrupt(holder);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("#1472 the 257th gate release evicts the oldest, only on its own board", () => {
  const { logs, layer } = captureWaitLogs();
  return Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      locks
        .run(
          locks
            .access("robob", Effect.void)
            .pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
            ),
          "blocked",
        )
        .pipe(Effect.provideService(BoardLocks.operationName, "KanbanService.blocker")),
    );
    yield* Deferred.await(entered);
    const waiter = yield* Effect.forkChild(
      locks.run(locks.access("robob", Effect.void), "blocked"),
    );
    yield* TestClock.adjust(0);
    for (let i = 0; i < 256; i++) {
      yield* locks
        .run(locks.access("robob", TestClock.adjust(1)), "other")
        .pipe(
          Effect.provideService(
            BoardLocks.operationName,
            i === 0 ? "KanbanService.oldest" : "KanbanService.repeated",
          ),
        );
    }
    // Other boards' releases must not evict this board's history.
    for (let i = 0; i < 257; i++) yield* locks.board("elsewhere", Effect.void);
    yield* TestClock.adjust(60_000 - 256);
    assert.deepInclude(logs[0], {
      "board.queue_ahead_at_admission": 0,
      "board.wait_accounted_ms": 60_256,
      "board.wait_by_label": [
        { label: "blocker", lock: "gate", ms: 60_000, holds: 1 },
        { label: "repeated", lock: "gate", ms: 255, holds: 255 },
        { label: "oldest", lock: "gate", ms: 1, holds: 1 },
      ],
    });
    yield* locks
      .run(locks.access("robob", TestClock.adjust(1)), "other")
      .pipe(Effect.provideService(BoardLocks.operationName, "KanbanService.repeated"));
    yield* TestClock.adjust(29_999);
    assert.deepInclude(logs[1], {
      "board.wait_accounted_ms": 90_256,
      "board.wait_by_label": [
        { label: "blocker", lock: "gate", ms: 90_000, holds: 1 },
        { label: "repeated", lock: "gate", ms: 256, holds: 256 },
      ],
    });
    yield* Fiber.interrupt(waiter);
    yield* Fiber.interrupt(holder);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "#1472 limits attribution to eight labels while accounting for all overlapping gate holds",
  () => {
    const { logs, layer } = captureWaitLogs();
    return Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const holders = [];
      for (let i = 0; i < 10; i++) {
        const entered = yield* Deferred.make<void>();
        holders.push(
          yield* Effect.forkChild(
            locks
              .run(
                locks
                  .access("robob", Effect.void)
                  .pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Effect.never),
                  ),
                `card-${i}`,
              )
              .pipe(Effect.provideService(BoardLocks.operationName, `KanbanService.label${i}`)),
          ),
        );
        yield* Deferred.await(entered);
      }
      const waiter = yield* Effect.forkChild(
        locks
          .board("robob", Effect.void)
          .pipe(Effect.provideService(BoardLocks.writeWaitMs, 20_000), Effect.exit),
      );
      yield* TestClock.adjust(20_000);
      const result = yield* Fiber.join(waiter);
      if (Exit.isFailure(result))
        assert.include(
          String(Cause.squash(result.cause)),
          "most time: label0 20s, label1 20s, label2 20s",
        );
      assert.deepInclude(logs[0], { "board.wait_accounted_ms": 200_000 });
      assert.deepStrictEqual(
        logs[0]!["board.wait_by_label"],
        Array.from({ length: 8 }, (_, i) => ({
          label: `label${i}`,
          lock: "gate",
          ms: 20_000,
          holds: 1,
        })),
      );
      for (const holder of holders) yield* Fiber.interrupt(holder);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("#1472 retains the holder fallback when the wait has no positive overlap", () => {
  const { logs, layer } = captureWaitLogs();
  return Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      locks
        .board("robob", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.provideService(BoardLocks.operationName, "KanbanService.tick")),
    );
    yield* Deferred.await(entered);
    const waiter = yield* Effect.forkChild(
      locks
        .board("robob", Effect.void)
        .pipe(Effect.provideService(BoardLocks.writeWaitMs, 0), Effect.exit),
    );
    yield* TestClock.adjust(0);
    const result = yield* Fiber.join(waiter);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause) as KanbanError;
      assert.strictEqual(
        error.detail,
        "Board busy: not written (held 0ms by KanbanService.tick; waited 0ms). Safe to retry once.",
      );
      assert.match(error.detail, boardBusyPrefix);
    }
    assert.deepInclude(logs[0], { "board.wait_accounted_ms": 0, "board.wait_by_label": [] });
    yield* Fiber.interrupt(holder);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["card_update", "discussion_post", "report_bug"] as const)(
  "#1412 %s outer reply deadline names the active holder and actual admission wait",
  (tool) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const beforeAdmission = yield* Deferred.make<void>();
      const admit = yield* Deferred.make<void>();
      const holder = yield* locks
        .board("a", Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.provideService(BoardLocks.operationName, "slow-holder"), Effect.forkChild);
      yield* Deferred.await(held);
      let written = false;
      const waiter = yield* SavedReply.protect(
        Effect.gen(function* () {
          yield* Deferred.succeed(beforeAdmission, undefined);
          yield* Deferred.await(admit);
          yield* locks.board(
            "a",
            locks.access(
              "a",
              Effect.sync(() => {
                written = true;
              }),
              true,
            ),
          );
          return new McpSchema.CallToolResult({ content: [] });
        }),
        tool,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(beforeAdmission);
      yield* TestClock.adjust(10_000);
      yield* Deferred.succeed(admit, undefined);
      yield* TestClock.adjust(15_000);
      const result = yield* Fiber.join(waiter);
      assert.instanceOf(result, McpSchema.CallToolResult);
      const text = JSON.stringify(result);
      assert.include(text, "held 25000ms by slow-holder");
      assert.include(text, "waited 15000ms");
      assert.notInclude(text, "Not saved (board busy)");
      assert.isFalse(written);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* locks.board("a", Effect.void);
      assert.isFalse(written);
    }),
);

it.effect("#1412 a bounded read releases its lock without immediately retrying", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    let reads = 0;
    const read = yield* locks
      .step(
        locks.boundedReads(
          locks.access(
            "a",
            SavedWrite.read(
              Effect.gen(function* () {
                reads += 1;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(yield* Deferred.make<void>());
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(2_000);
    const result = yield* Fiber.join(read);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result))
      assert.instanceOf(Cause.squash(result.cause), BoardLocks.BoardReadBudgetExceeded);
    yield* locks.board("a", Effect.void);
    assert.strictEqual(reads, 1);
    assert.deepStrictEqual(yield* locks.holders, []);
  }),
);

it.effect("#1412 lock holds retain board and step attribution in metrics and analytics", () =>
  Effect.gen(function* () {
    const rows: AnalyticsEvent[] = [];
    yield* Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const hold = yield* locks
        .step(
          locks.access(
            "offbox",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          ),
          undefined,
          "KanbanService.tickStep:wakeDiscussionNudges",
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1_500);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(hold);
      assert.deepInclude(rows[0], {
        kind: "kanban.lock_hold",
        boardId: "offbox",
        durationMs: 1_500,
        props: { phase: "wakeDiscussionNudges" },
      });
      const histogram = (yield* Metric.snapshot).find(
        (row) =>
          row.id === "kanban_board_lock_hold_duration" &&
          row.attributes?.boardId === "offbox" &&
          row.attributes?.name === "KanbanService.tickStep:wakeDiscussionNudges",
      );
      assert.isDefined(histogram);
    }).pipe(
      Effect.provide(
        Layer.mock(Analytics)({
          record: (event) =>
            Effect.sync(() => {
              rows.push(event);
            }),
        }),
      ),
    );
  }),
);

it.effect.each(["read.card", "syncPrs.fetch", "syncPrs.write", "apply"] as const)(
  "long holds and active holder warnings name the %s sub-step",
  (phase) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const lines: Array<Record<string, unknown>> = [];
      const clock = yield* Clock.Clock;
      let observing = 0;
      const logger = Logger.make(({ message }) => {
        const line = String(message);
        if (line.startsWith('{"event":"kanban board lock')) lines.push(JSON.parse(line));
      });
      yield* Effect.gen(function* () {
        const holder = yield* Effect.forkChild(
          SavedWrite.subSteps(
            "tickStep:landing",
            locks.board(
              "a",
              Effect.gen(function* () {
                const observe = yield* NodeSqliteClient.ReaderSnapshotObserver;
                const stop = observe?.(() => ({
                  db: "boards",
                  connection: "reader",
                  lane: "background",
                  slot: 0,
                  stage: "slot",
                  queueDepth: 2,
                  oldestInFlightAgeMs: clock.currentTimeMillisUnsafe(),
                  holder: "KanbanAskFeed.read",
                }));
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release).pipe(Effect.ensuring(Effect.sync(() => stop?.())));
              }).pipe(
                Effect.withSpan("KanbanStore.read", {
                  attributes: { "kanban.operation": "read card" },
                }),
                Effect.withSpan(phase),
              ),
            ),
          ),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(60_000);
        const active = yield* locks.holders;
        assert.deepEqual(active.find((holder) => holder.lock === "gate")?.subSteps, [
          { subStep: phase, ms: 60_000 },
        ]);
        assert.deepEqual(
          (yield* locks.holders).find((holder) => holder.lock === "gate")?.subSteps,
          [{ subStep: phase, ms: 60_000 }],
        );
        assert.strictEqual(observing, 1);
        const waiter = yield* Effect.forkChild(locks.board("a", Effect.void));
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(waiter);
        const hold = lines.find((line) => line.event === "kanban board lock long hold");
        assert.deepEqual(hold?.subSteps, [{ subStep: phase, ms: 60_000 }]);
        assert.deepEqual(hold?.threshold, {
          observedAtMs: 5_000,
          awaited: "KanbanStore.read.card",
          readers: [
            {
              db: "boards",
              connection: "reader",
              lane: "background",
              slot: 0,
              stage: "slot",
              queueDepth: 2,
              oldestInFlightAgeMs: 5_000,
              holder: "KanbanAskFeed.read",
            },
          ],
        });
        const warning = lines.find((line) => line.event === "kanban board lock held too long");
        const blockers = warning?.["board.blockers"] as Array<{ subSteps?: unknown }> | undefined;
        assert.deepEqual(blockers?.[0]?.subSteps, [{ subStep: phase, ms: 60_000 }]);
        assert.strictEqual(observing, 0);
        assert.deepEqual(yield* locks.holders, []);
      }).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(NodeSqliteClient.ReaderSnapshotObserver, () => {
          observing += 1;
          return () => {
            observing -= 1;
          };
        }),
      );
    }),
);
