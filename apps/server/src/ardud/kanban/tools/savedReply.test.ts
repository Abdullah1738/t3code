import { assert, it } from "@effect/vitest";
import { KanbanBoardId, KanbanCardId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { McpSchema } from "effect/ai";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
import * as SavedReply from "./savedReply.ts";
import { McpCall } from "../../analytics/McpCall.ts";

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

it.effect("a completed follow-up read does not replace a foreground admission stage", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const { spans, tracer } = captureTrace();
    const locks = yield* BoardLocks.make();
    const held = yield* Deferred.make<void>();
    const readStarted = yield* Deferred.make<void>();
    const finishRead = yield* Deferred.make<void>();
    const readDone = yield* Deferred.make<void>();
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    const callState: McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      readerLane: "foreground",
      phase: "handler",
      saved: "unknown",
    };
    const holder = yield* Effect.forkChild(
      locks.board("a", Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
    );
    yield* Deferred.await(held);
    const call = yield* Effect.forkChild(
      SavedReply.protect(
        SavedWrite.mutating(
          Effect.gen(function* () {
            yield* SavedWrite.stage(
              Deferred.succeed(readStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishRead)),
              ),
              "read",
            ).pipe(Effect.andThen(Deferred.succeed(readDone, undefined)), Effect.forkIn(scope));
            yield* Deferred.await(readStarted);
            return yield* locks.board("a", Effect.succeed(reply));
          }),
        ).pipe(Effect.provideService(BoardLocks.writeWaitMs, 60_000)),
        "card_edit",
      ).pipe(
        Effect.withTracer(tracer),
        Effect.provideService(McpCall, callState),
        Effect.provideService(References.MinimumLogLevel, "Warn"),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
    yield* TestClock.adjust(1_000);
    yield* Deferred.succeed(finishRead, undefined);
    yield* Deferred.await(readDone);
    yield* TestClock.adjust(24_000);
    yield* Fiber.join(call);
    const span = spans.find((span) => span.name === "KanbanTools.savedReply")!;
    yield* Fiber.interrupt(holder);
    assert.strictEqual(span.attributes.get("kanban.reply.stage_at_timeout"), "admission");
    assert.strictEqual(span.attributes.get("kanban.reply.stage_ms.admission"), 25_000);
    assert.strictEqual(span.attributes.get("kanban.reply.stage_ms.mutate"), 0);
    assert.strictEqual(callState.replyStage, "admission");
    assert.deepInclude(warnings, [
      "kanban saved write reply unavailable",
      {
        timedOut: true,
        saved: false,
        commitStarted: false,
        ...Object.fromEntries(
          [...span.attributes].filter(
            ([key]) => key.startsWith("kanban.reply.") && !key.startsWith("kanban.reply.stage_ms."),
          ),
        ),
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect.each(["read", "commit"] as const)(
  "a detached %s cannot replace admission and keeps existing commit evidence",
  (name) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const { spans, tracer } = captureTrace();
      const locks = yield* BoardLocks.make();
      const held = yield* Deferred.make<void>();
      const begin = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        locks.board("a", Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
      );
      yield* Deferred.await(held);
      const call = yield* Effect.forkChild(
        SavedReply.protect(
          SavedWrite.mutating(
            Effect.gen(function* () {
              const stalled = Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
              );
              yield* Deferred.await(begin).pipe(
                Effect.andThen(
                  SavedWrite.stage(
                    name === "commit"
                      ? SavedWrite.committing.pipe(Effect.andThen(stalled))
                      : stalled,
                    name,
                  ),
                ),
                SavedWrite.background,
                Effect.andThen(Deferred.succeed(done, undefined)),
                Effect.forkIn(scope),
              );
              return yield* locks.board("a", Effect.succeed(reply));
            }),
          ).pipe(Effect.provideService(BoardLocks.writeWaitMs, 60_000)),
          "card_update",
        ).pipe(Effect.withTracer(tracer)),
      );
      yield* TestClock.adjust(1_000);
      yield* Deferred.succeed(begin, undefined);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(24_000);
      const result = callResult(yield* Fiber.join(call));
      const span = spans.find((span) => span.name === "KanbanTools.savedReply")!;
      assert.strictEqual(span.attributes.get("kanban.reply.stage_at_timeout"), "admission");
      assert.strictEqual(span.attributes.get("kanban.reply.stage_ms.admission"), 25_000);
      assert.strictEqual(span.attributes.get("kanban.reply.commit_started"), name === "commit");
      assert.strictEqual(
        replyData(result.structuredContent).saved,
        name === "commit" ? null : false,
      );
      const attributes = Object.fromEntries(span.attributes);
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(done);
      assert.deepStrictEqual(Object.fromEntries(span.attributes), attributes);
      yield* Fiber.interrupt(holder);
    }).pipe(Effect.scoped),
);

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
      if (tool === "report_bug")
        assert.include(String(data.message), "retry with the same arguments");
      else {
        assert.include(String(data.message), "Not saved");
        assert.include(String(data.message), "Safe to retry");
      }
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
          (tool === "report_bug"
            ? SavedWrite.locateReport({
                kind: "evaluator",
                boardId: KanbanBoardId.make("a"),
                keyPrefix: "bug-report:pending:",
              })
            : Effect.void
          ).pipe(
            Effect.andThen(
              locks
                .board(
                  "a",
                  locks.outside(
                    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                  ),
                )
                .pipe(Effect.as(reply)),
            ),
          ),
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
        if (tool === "report_bug")
          assert.include(String(data.message), "Retry with the same arguments");
        else {
          assert.include(String(data.message), "may have been saved");
          assert.include(
            String(data.message),
            tool === "discussion_post" ? "discussion_read" : "card_get",
          );
        }
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

it.effect.each([
  { name: "unprepared", lookup: undefined, saved: false, text: "Nothing was saved" },
  {
    name: "card",
    lookup: {
      kind: "card",
      boardId: KanbanBoardId.make("board-a"),
      cardId: KanbanCardId.make("card-a"),
      number: 1480,
    },
    saved: null,
    text: "card #1480 (card-a) on board board-a",
  },
  {
    name: "evaluator",
    lookup: {
      kind: "evaluator",
      boardId: KanbanBoardId.make("board-a"),
      keyPrefix: "bug-report:pending:",
    },
    saved: null,
    text: "evaluator key prefix bug-report:pending: on board board-a",
  },
] as const)(
  "report_bug timeout with $name recovery target reports a proven or named outcome",
  ({ lookup, saved, text }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const call = yield* SavedReply.protect(
        (lookup === undefined ? Effect.void : SavedWrite.locateReport(lookup)).pipe(
          Effect.andThen(SavedWrite.committing),
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
        "report_bug",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
      const result = callResult(yield* Fiber.join(call));
      const data = replyData(result.structuredContent);
      assert.isTrue(result.isError);
      assert.strictEqual(data.saved, saved);
      assert.include(data.message, text);
      assert.match(data.message, /[Rr]etry with the same arguments/);
      if (lookup !== undefined) assert.deepInclude(result.structuredContent, { lookup });
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

it.effect("report_bug returns its saved evaluator queue after a reply failure", () =>
  Effect.gen(function* () {
    const result = callResult(
      yield* SavedReply.protect(
        SavedWrite.record({ kind: "evaluatorQueue", key: "report-1480", queueId: 1480 }).pipe(
          Effect.andThen(Effect.die(new BoardLocks.BoardStateChanged(true))),
        ),
        "report_bug",
      ),
    );
    assert.isFalse(result.isError);
    assert.deepInclude(result.structuredContent, {
      saved: true,
      queued: true,
      queueId: 1480,
      evaluatorKey: "report-1480",
    });
    assert.notInclude(JSON.stringify(result), BoardLocks.MAY_HAVE_APPLIED);
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
