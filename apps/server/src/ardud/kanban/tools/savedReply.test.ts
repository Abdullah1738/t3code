import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
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

const captureTrace = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

it.effect("an ungranted admission identifies the stage and an unsaved write", () =>
  Effect.gen(function* () {
    const { spans, tracer } = captureTrace();
    const locks = yield* BoardLocks.make();
    const held = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      locks.board("a", Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
    );
    yield* Deferred.await(held);
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        // Isolate the reply deadline; the normal admission budget is tested in boardLocks.test.
        locks
          .board("a", Effect.succeed(reply))
          .pipe(Effect.provideService(BoardLocks.writeWaitMs, SavedReply.REPLY_BUDGET_MS * 2)),
        "card_update",
      ).pipe(Effect.withTracer(tracer)),
    );
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(call));
    assert.strictEqual(replyData(result.structuredContent).saved, false);
    const span = spans.find((span) => span.name === "KanbanTools.savedReply")!;
    assert.strictEqual(span.attributes.get("kanban.reply.stage_at_timeout"), "admission");
    assert.strictEqual(span.attributes.get("kanban.reply.saved"), false);
    assert.strictEqual(
      span.attributes.get("kanban.reply.stage_ms.admission"),
      SavedReply.REPLY_BUDGET_MS,
    );
    assert.strictEqual(span.attributes.get("kanban.reply.budget_ms"), 25_000);
    assert.strictEqual(span.attributes.get("kanban.reply.timer_lateness_ms"), 0);
    yield* Fiber.interrupt(holder);
  }),
);

it.effect("a stalled commit is ambiguous and keeps the commit stage at timeout", () =>
  Effect.gen(function* () {
    const { spans, tracer } = captureTrace();
    const entered = yield* Deferred.make<void>();
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        SavedWrite.committing.pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
        "card_update",
      ).pipe(Effect.withTracer(tracer)),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(call));
    assert.isTrue(result.isError);
    assert.isNull(replyData(result.structuredContent).saved);
    const span = spans.find((span) => span.name === "KanbanTools.savedReply")!;
    assert.strictEqual(span.attributes.get("kanban.reply.stage_at_timeout"), "commit");
    assert.strictEqual(span.attributes.get("kanban.reply.saved"), null);
    assert.strictEqual(span.attributes.get("kanban.reply.commit_started"), true);
    assert.strictEqual(span.attributes.get("kanban.reply.timed_out"), true);
    assert.strictEqual(span.attributes.get("kanban.reply.elapsed_ms"), 25_000);
  }),
);

it.effect("work restored to a registration span links back to savedReply", () =>
  Effect.gen(function* () {
    const { spans, tracer } = captureTrace();
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const registration = yield* Effect.makeSpan("registration");
      const handler = Effect.fn("KanbanTools.withCaller")(function* () {
        yield* SavedWrite.linkReply();
        return yield* SavedWrite.stage(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          "read",
        );
      });
      const call = yield* Effect.forkChild(
        SavedReply.protect(handler().pipe(Effect.withParentSpan(registration)), "card_update"),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
      yield* Fiber.join(call);
      const saved = spans.find((span) => span.name === "KanbanTools.savedReply")!;
      const work = spans.find((span) => span.name === "KanbanTools.withCaller")!;
      const read = spans.find((span) => span.name === "KanbanSavedWrite.stage")!;
      assert.isTrue(work.links.some((link) => link.span.spanId === saved.spanId));
      assert.isTrue(saved.links.some((link) => link.span.spanId === work.spanId));
      assert.strictEqual(
        read.parent._tag === "Some" ? read.parent.value.spanId : undefined,
        work.spanId,
      );
      assert.strictEqual(saved.attributes.get("kanban.reply.stage_at_timeout"), "read");
    }).pipe(Effect.withTracer(tracer));
  }),
);

it.effect("a clock jump records timer lateness before cancellation cleanup", () =>
  TestClock.testClockWith((clock) =>
    Effect.gen(function* () {
      const { spans, tracer } = captureTrace();
      const entered = yield* Deferred.make<void>();
      const fire = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const call = yield* Effect.forkChild(
        SavedReply.protect(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            ),
          ),
          "card_update",
        ).pipe(
          Effect.withTracer(tracer),
          Effect.provideService(Clock.Clock, {
            ...clock,
            // Hold the due callback while TestClock jumps, as a busy event loop would.
            sleep: (duration) => clock.sleep(duration).pipe(Effect.andThen(Deferred.await(fire))),
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(46_000);
      yield* Deferred.succeed(fire, undefined);
      yield* Deferred.await(cleaning);
      yield* TestClock.adjust(10_000);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(call);
      const span = spans.find((span) => span.name === "KanbanTools.savedReply")!;
      assert.strictEqual(span.attributes.get("kanban.reply.timer_lateness_ms"), 21_000);
      assert.strictEqual(span.attributes.get("kanban.reply.elapsed_ms"), 56_000);
      assert.strictEqual(span.attributes.get("kanban.reply.stage_at_timeout"), "caller");
    }),
  ),
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

it.effect.each([...SavedReply.TOOLS])(
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
