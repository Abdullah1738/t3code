import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AnalyticsEvent, KanbanBoardId, KanbanCardId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import { McpSchema } from "effect/ai";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
import * as SavedReply from "./savedReply.ts";
import { McpCall, callOutcome } from "../../analytics/McpCall.ts";

const reply = new McpSchema.CallToolResult({ content: [] });
const callResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const ledgerEvent = Schema.decodeUnknownSync(AnalyticsEvent);
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

it.live.each([...SavedReply.TOOLS])("%s saves while the background reader is held", (tool) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "saved-write-reader-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE board_write_probe (reason TEXT NOT NULL)`;
      yield* sql`INSERT INTO board_write_probe VALUES ('old reason')`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          sql`SELECT reason FROM board_write_probe`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      yield* Effect.gen(function* () {
        const result = yield* SavedReply.protect(
          Effect.gen(function* () {
            // Caller and thread-link lookups opt into readOnly before the mutation.
            const previous = yield* SavedWrite.stage(
              sql<{ reason: string }>`SELECT reason FROM board_write_probe`.pipe(
                NodeSqliteClient.readOnly,
              ),
              "read",
            );
            assert.strictEqual(previous[0]?.reason, "old reason");
            yield* SavedWrite.committing;
            yield* sql`UPDATE board_write_probe SET reason = 'new reason'`;
            return reply;
          }),
          tool,
        ).pipe(Effect.timeout("5 seconds"));
        assert.isFalse(callResult(result).isError === true);
        assert.isFalse(yield* Deferred.isDone(release));
        assert.isUndefined(holder.pollUnsafe());
        assert.deepStrictEqual(yield* sql`SELECT reason FROM board_write_probe`, [
          { reason: "new reason" },
        ]);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: path.join(directory, "boards.sqlite"),
          readerWorker: true,
          foregroundReaderSlots: 1,
          backgroundReaderSlots: 1,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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
    assert.strictEqual(callState.replyPhases?.admission, 25_000);
    assert.strictEqual(callState.replyPhases?.mutate, 0);
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
        if (tool === "evaluator_start" || tool === "report_bug") {
          assert.isFalse(data.saved);
          assert.match(data.message, /[Rr]etry with the same arguments/);
        } else {
          assert.isNull(data.saved);
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
    saved: false,
    text: "Nothing was saved",
  },
  {
    name: "evaluator",
    lookup: {
      kind: "evaluator",
      boardId: KanbanBoardId.make("board-a"),
      keyPrefix: "bug-report:pending:",
    },
    saved: false,
    text: "Nothing was saved",
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

it.effect.each(
  ["evaluator_start", "report_bug"].flatMap((tool) =>
    ["none", "evaluator", "evaluatorQueue"].map((receipt) => ({ tool, receipt })),
  ),
)("$tool timeout after preparation counts only its $receipt request receipt", ({ tool, receipt }) =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const receipts: SavedWrite.Saved[] = [];
    const state: McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      readerLane: "foreground",
      phase: "handler",
      saved: false,
      boardWrite: true,
      boardAdmitted: true,
    };
    const saved: SavedWrite.Saved = {
      kind: "evaluator",
      threadId: ThreadId.make("private-preparatory-thread"),
    };
    const pending = yield* SavedReply.protect(
      Effect.gen(function* () {
        yield* locks.board(
          "a",
          locks.access("a", SavedWrite.record(saved), true).pipe(SavedWrite.preparatory),
        );
        assert.strictEqual(state.saved, false);
        assert.isEmpty(receipts);
        if (receipt !== "none")
          yield* SavedWrite.record(
            receipt === "evaluatorQueue"
              ? { kind: "evaluatorQueue", key: "private-request-key", queueId: 1642 }
              : saved,
          );
        yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      }),
      tool,
    ).pipe(
      Effect.provideService(McpCall, state),
      Effect.provideService(SavedWrite.observer, (saved) => receipts.push(saved)),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(pending));
    const expected = receipt !== "none";
    assert.strictEqual(replyData(result.structuredContent).saved, expected);
    const row = callOutcome(Exit.succeed(result), state);
    assert.strictEqual(row.saved, expected);
    assert.strictEqual(state.refusedAt, expected ? "post_write" : "in_write");
    assert.lengthOf(receipts, expected ? 1 : 0);
    assert.notInclude(JSON.stringify(row), "private");
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
      assert.include(String(data.message), "launched as evaluator-1107");
      assert.include(String(data.message), "Do not retry");
    }
  }),
);

it.effect.each(["report_bug", "evaluator_start"])(
  "%s returns its saved evaluator queue after a reply failure",
  (tool) =>
    Effect.gen(function* () {
      const result = callResult(
        yield* SavedReply.protect(
          SavedWrite.record({ kind: "evaluatorQueue", key: "report-1480", queueId: 1480 }).pipe(
            Effect.andThen(Effect.die(new BoardLocks.BoardStateChanged(true))),
          ),
          tool,
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

it.effect("evaluator substeps include an interrupted receipt read outside the board lock", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const callState: McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      readerLane: "foreground",
      phase: "handler",
      saved: "unknown",
    };
    const call = yield* SavedReply.protect(
      SavedWrite.subSteps(
        "evaluator.submit",
        Effect.gen(function* () {
          yield* SavedWrite.record({ kind: "evaluatorQueue", key: "request", queueId: 1644 });
          return yield* Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.withSpan("ThreadLaunchService.messageReceipt"),
          );
        }),
        true,
      ),
      "evaluator_start",
    ).pipe(Effect.provideService(McpCall, callState), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS);
    const result = callResult(yield* Fiber.join(call));
    assert.deepInclude(result.structuredContent, { saved: true, queued: true, queueId: 1644 });
    assert.include(replyData(result.structuredContent).message, "launch may still finish");
    const ledger = ledgerEvent({
      ts: "2026-11-15T20:00:00.000Z",
      kind: "mcp.call",
      surface: "server",
      route: "mcp",
      ...callOutcome(Exit.succeed(result), callState),
    });
    assert.equal(ledger.saved, true);
    assert.deepEqual(ledger.props?.subSteps, [
      { subStep: "ThreadLaunchService.messageReceipt", ms: 25_000 },
    ]);
  }),
);

it.effect("evaluator substeps count a long board hold once alongside an outside receipt wait", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const held = yield* Deferred.make<void>();
    const releaseHold = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message }) => warnings.push(message));
    const state: McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      readerLane: "foreground",
      phase: "handler",
      saved: "unknown",
    };
    const pending = yield* SavedReply.protect(
      SavedWrite.subSteps(
        "evaluator.submit",
        Effect.gen(function* () {
          yield* locks.run(
            locks.board(
              "a",
              Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHold)),
                Effect.withSpan("KanbanService.evaluatorQueueWrite"),
              ),
            ),
          );
          yield* Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.withSpan("ThreadLaunchService.messageReceipt"),
          );
          return reply;
        }),
        true,
      ),
      "evaluator_start",
    ).pipe(
      Effect.exit,
      Effect.provideService(McpCall, state),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.forkChild,
    );
    yield* Deferred.await(held);
    yield* TestClock.adjust(6_000);
    yield* Deferred.succeed(releaseHold, undefined);
    yield* Deferred.await(reading);
    yield* TestClock.adjust(8_000);
    yield* Deferred.succeed(releaseRead, undefined);
    const result = yield* Fiber.join(pending);
    const steps = [
      { subStep: "ThreadLaunchService.messageReceipt", ms: 8_000 },
      { subStep: "KanbanService.evaluatorQueueWrite", ms: 6_000 },
    ];
    assert.deepEqual(callOutcome(result, state).props?.subSteps, steps);
    const holds = warnings.filter((message) =>
      String(message).includes('"event":"kanban board lock long hold"'),
    );
    assert.lengthOf(holds, 1);
    assert.deepEqual(JSON.parse(String(holds[0])).subSteps, [steps[1]]);
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

it.effect("a saved write stalled on acknowledgement has a dominant replyWait", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const state: McpCall["Service"] = {
      callerResolved: true,
      callerResolveMs: 0,
      readerLane: "foreground",
      phase: "handler",
      saved: "unknown",
    };
    const pending = yield* SavedReply.protect(
      SavedWrite.record({ kind: "evaluator", threadId: ThreadId.make("saved-ack") }).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Effect.never),
      ),
      "evaluator_start",
    ).pipe(Effect.provideService(McpCall, state), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(25000);
    yield* Fiber.join(pending);
    assert.strictEqual(state.replyStage, "ack");
    assert.deepEqual(state.writePhases, { lockWait: 0, read: 0, write: 0, replyWait: 25000 });
    assert.strictEqual(state.replyPhases?.ack, 25000);
  }),
);

it.effect.each(["card_create", "card_wait", "wiki_read"])(
  "%s records timing without changing its reader lane or adding a deadline",
  (tool) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const pending = yield* SavedReply.protect(
        Effect.gen(function* () {
          assert.strictEqual(yield* NodeSqliteClient.ReaderLane, "background");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return reply;
        }),
        tool,
      ).pipe(
        Effect.provideService(NodeSqliteClient.ReaderLane, "background"),
        Effect.tap(() => Deferred.succeed(finished, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(SavedReply.REPLY_BUDGET_MS * 2);
      assert.isFalse(yield* Deferred.isDone(finished));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
    }),
);

// Named operation spans already surround the waits; diagnostics partition nested
// time instead of reporting the same hold once for every ancestor.
it.effect.each(["complete", "timeout", "fail", "fast"] as const)(
  "%s saved write attributes its board hold to the awaited sub-step",
  (ending) =>
    Effect.gen(function* () {
      const { spans, tracer } = captureTrace();
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message }) => warnings.push(message));
      const callState: McpCall["Service"] = {
        callerResolved: true,
        callerResolveMs: 0,
        readerLane: "foreground",
        phase: "handler",
        saved: false,
      };
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const locks = yield* BoardLocks.make();
      const wait = Effect.fn("KanbanService.awaitQueue")(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(finish).pipe(Effect.withSpan("sql.transaction"));
        if (ending === "fail") return yield* Effect.fail("unavailable");
      });
      const pending = yield* Effect.forkChild(
        SavedReply.protect(
          SavedWrite.mutating(
            SavedWrite.subSteps(
              "card.move",
              locks.board(
                "a",
                wait().pipe(Effect.withSpan("KanbanService.prepareTransition"), Effect.as(reply)),
              ),
            ),
          ),
          "card_move",
        ).pipe(
          Effect.provideService(BoardLocks.operationName, "card.move"),
          Effect.exit,
          Effect.withTracer(tracer),
          Effect.provideService(McpCall, callState),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
      yield* Deferred.await(entered);
      const ms = ending === "timeout" ? 25_000 : ending === "fast" ? 4_999 : 5_000;
      yield* TestClock.adjust(ms);
      if (ending !== "timeout") yield* Deferred.succeed(finish, undefined);
      const result = yield* Fiber.join(pending);
      const holds = warnings.filter((message) =>
        String(message).includes('"event":"kanban board lock long hold"'),
      );
      if (ending === "fast") {
        assert.lengthOf(holds, 0);
        assert.isUndefined(callState.replySubSteps);
      } else {
        const steps = [{ subStep: "KanbanService.awaitQueue", ms }];
        assert.lengthOf(holds, 1);
        assert.deepInclude(JSON.parse(String(holds[0])), {
          event: "kanban board lock long hold",
          "board.observed_at_ms": ms,
          "board.id": "a",
          "board.holder": "card.move",
          "board.card_id": null,
          "board.lock": "gate",
          "board.mode": "exclusive",
          "board.acquired_at_ms": 0,
          "board.held_ms": ms,
          "board.waiters": 0,
          subSteps: steps,
        });
        assert.deepEqual(callState.replySubSteps, steps);
        const ledger = ledgerEvent({
          ts: "2026-11-15T08:10:15.231Z",
          kind: "mcp.call",
          surface: "server",
          route: "mcp",
          ...callOutcome(result, callState),
        });
        assert.deepEqual(ledger.props?.subSteps, steps);
        assert.deepEqual(
          spans
            .find((span) => span.name === "KanbanTools.savedReply")!
            .attributes.get("kanban.reply.sub_steps"),
          steps,
        );
      }
    }),
);

it.effect("saved-write sub-steps exclude waits after releasing the board permit", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message }) => warnings.push(message));
    const pending = yield* Effect.forkChild(
      SavedReply.protect(
        SavedWrite.subSteps(
          "card.move",
          locks.board(
            "a",
            locks
              .outside(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
                undefined,
                true,
              )
              .pipe(Effect.as(reply)),
          ),
        ),
        "card_move",
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(6_000);
    yield* locks.board("a", Effect.void);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(pending);
    assert.isFalse(
      warnings.some((message) => String(message).includes('"event":"kanban board lock long hold"')),
    );
  }),
);

it.effect("sub-step details keep only the three slowest steps and ignore detached work", () =>
  Effect.gen(function* () {
    const { spans, tracer } = captureTrace();
    const locks = yield* BoardLocks.make();
    const entered = yield* Effect.forEach([1, 2, 3, 4], () => Deferred.make<void>());
    const resume = yield* Effect.forEach([1, 2, 3, 4], () => Deferred.make<void>());
    const detached = yield* Deferred.make<void>();
    const finishDetached = yield* Deferred.make<void>();
    const scope = yield* Scope.Scope;
    const pending = yield* Effect.forkChild(
      SavedReply.protect(
        SavedWrite.subSteps(
          "card.move",
          locks.board(
            "a",
            Effect.gen(function* () {
              yield* Deferred.succeed(detached, undefined).pipe(
                Effect.andThen(Deferred.await(finishDetached)),
                Effect.withSpan("unrelated.background"),
                SavedWrite.background,
                Effect.forkIn(scope),
              );
              yield* Deferred.await(detached);
              for (let index = 0; index < 4; index += 1) {
                yield* Deferred.succeed(entered[index]!, undefined).pipe(
                  Effect.andThen(Deferred.await(resume[index]!)),
                  Effect.withSpan(`move.step${index}`),
                );
              }
              return reply;
            }),
          ),
        ),
        "card_move",
      ).pipe(Effect.withTracer(tracer)),
    );
    for (let index = 0; index < 4; index += 1) {
      yield* Deferred.await(entered[index]!);
      yield* TestClock.adjust((index + 1) * 1_000);
      yield* Deferred.succeed(resume[index]!, undefined);
    }
    yield* Fiber.join(pending);
    yield* Deferred.succeed(finishDetached, undefined);
    assert.deepEqual(
      spans
        .find((span) => span.name === "KanbanTools.savedReply")!
        .attributes.get("kanban.reply.sub_steps"),
      [
        { subStep: "move.step3", ms: 4_000 },
        { subStep: "move.step2", ms: 3_000 },
        { subStep: "move.step1", ms: 2_000 },
      ],
    );
  }).pipe(Effect.scoped),
);

it.effect("parallel saved-write fibers attribute only their own board hold", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message }) => warnings.push(message));
    const enteredA = yield* Deferred.make<void>();
    const enteredB = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const pending = yield* Effect.forkChild(
      SavedWrite.subSteps(
        "card.move",
        Effect.all(
          [
            locks.board(
              "a",
              Deferred.succeed(enteredA, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.withSpan("move.awaitA"),
              ),
            ),
            locks.board(
              "b",
              Deferred.succeed(enteredB, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.withSpan("move.awaitB"),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    );
    yield* Deferred.await(enteredA);
    yield* Deferred.await(enteredB);
    yield* TestClock.adjust(6_000);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(pending);
    const holds = warnings
      .filter((message) => String(message).includes('"event":"kanban board lock long hold"'))
      .map((message) => JSON.parse(String(message)) as Record<string, unknown>);
    assert.lengthOf(holds, 2);
    for (const board of ["a", "b"])
      assert.deepEqual(holds.find((fields) => fields["board.id"] === board)!.subSteps, [
        { subStep: `move.await${board.toUpperCase()}`, ms: 6_000 },
      ]);
  }),
);

it.effect("long-hold sub-step names stay within analytics metadata labels", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let steps: ReadonlyArray<SavedWrite.SubStep> | undefined;
    const pending = yield* Effect.forkChild(
      SavedWrite.subSteps(
        "card.move",
        locks.board(
          "a",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.withSpan("private words"),
          ),
        ),
      ).pipe(
        Effect.provideService(SavedWrite.subStepReporter, (value) => {
          steps = value;
        }),
      ),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(5_000);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(pending);
    assert.deepEqual(steps, [{ subStep: "unknown", ms: 5_000 }]);
  }),
);
