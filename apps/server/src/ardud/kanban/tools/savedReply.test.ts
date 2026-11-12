import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
import * as SavedReply from "./savedReply.ts";

const reply = new McpSchema.CallToolResult({ content: [] });
const callResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const replyData = Schema.decodeUnknownSync(
  Schema.Struct({
    saved: Schema.NullOr(Schema.Boolean),
    message: Schema.String,
    threadId: Schema.optional(Schema.String),
  }),
);

it.effect.each([...SavedReply.TOOLS])("%s interrupted before commit is not saved", (tool) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finalizing = yield* Deferred.make<void>();
    const finishCleanup = yield* Deferred.make<void>();
    let interrupted = false;
    let written = false;
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(SavedWrite.committing),
          Effect.andThen(
            Effect.sync(() => {
              written = true;
            }),
          ),
          Effect.as(reply),
          Effect.onInterrupt(() =>
            Deferred.succeed(finalizing, undefined).pipe(
              Effect.andThen(Deferred.await(finishCleanup)),
              Effect.andThen(
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
          ),
        ),
        tool,
      ),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    yield* Deferred.await(finalizing);
    // The fallback cannot inspect commit state until cancellation cleanup finishes.
    assert.isUndefined(call.pollUnsafe());
    yield* Deferred.succeed(finishCleanup, undefined);
    const result = callResult(yield* Fiber.join(call));
    const data = replyData(result.structuredContent);
    assert.isTrue(interrupted);
    assert.isFalse(written);
    {
      assert.isTrue(result.isError);
      assert.strictEqual(data.saved, false);
      assert.include(String(data.message), "Not saved");
      assert.include(String(data.message), "Safe to retry");
    }
    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS);
    assert.isFalse(written);
  }),
);

it.effect.each(["card_update", "evaluator_start", "discussion_post"])(
  "%s after an external boundary is ambiguous and an error",
  (tool) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const call = yield* Effect.forkChild(
        SavedReply.protect(
          locks
            .board(
              "a",
              locks.outside(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            )
            .pipe(Effect.as(reply)),
          tool,
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
      const result = callResult(yield* Fiber.join(call));
      const data = replyData(result.structuredContent);
      {
        assert.isTrue(result.isError);
        assert.isNull(data.saved);
        assert.include(String(data.message), "may have been saved");
        assert.include(
          String(data.message),
          tool === "discussion_post" ? "discussion_read" : "card_get",
        );
      }
    }),
);

it.effect("commit state reached during interrupt cleanup is observed", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const locks = yield* BoardLocks.make();
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => locks.board("a", locks.access("a", Effect.void, true))),
          Effect.as(reply),
        ),
        "card_update",
      ),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(call));
    const data = replyData(result.structuredContent);
    {
      assert.isTrue(result.isError);
      assert.isNull(data.saved);
    }
  }),
);

it.effect("a saved receipt survives slow encoding as a non-error reply", () =>
  Effect.gen(function* () {
    const saved = yield* Deferred.make<void>();
    const threadId = ThreadId.make("evaluator-1107");
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        SavedWrite.record({ kind: "evaluator", threadId }).pipe(
          Effect.andThen(Deferred.succeed(saved, undefined)),
          Effect.andThen(Effect.never),
        ),
        "evaluator_start",
      ),
    );
    yield* Deferred.await(saved);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(call));
    const data = replyData(result.structuredContent);
    {
      assert.isFalse(result.isError);
      assert.strictEqual(data.saved, true);
      assert.strictEqual(data.threadId, threadId);
      assert.include(String(data.message), "Saved");
    }
  }),
);

it.effect("a masked write finishes cancellation before the timeout reply", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let written = false;
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        locks
          .board(
            "a",
            locks.access(
              "a",
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(
                  Effect.sync(() => {
                    written = true;
                  }),
                ),
              ),
              true,
            ),
          )
          .pipe(Effect.as(reply)),
        "card_update",
      ),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    assert.isUndefined(call.pollUnsafe());
    yield* Deferred.succeed(finish, undefined);
    const result = callResult(yield* Fiber.join(call));
    const data = replyData(result.structuredContent);
    assert.isTrue(written);
    {
      assert.isTrue(result.isError);
      assert.isNull(data.saved);
    }
  }),
);
