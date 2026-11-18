import { assert, it } from "@effect/vitest";
import {
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanScriptId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as SavedReply from "../tools/savedReply.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as LockedStore from "./lockedStore.ts";
import * as SavedWrite from "./savedWrite.ts";

const TestLayer = KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const boardId = KanbanBoardId.make("budget-board");
const cardId = KanbanCardId.make("missing-card");
const discussionId = KanbanDiscussionId.make("missing-discussion");
const at = "2026-11-16T18:58:30.000Z";
const reads: ReadonlyArray<{
  name: string;
  table?: string;
  read: (
    store: KanbanStore.KanbanStoreShape,
  ) => Effect.Effect<unknown, KanbanStore.KanbanStoreError>;
}> = [
  { name: "card locator", read: (s: KanbanStore.KanbanStoreShape) => s.card(cardId) },
  {
    name: "unwrapped script",
    read: (s: KanbanStore.KanbanStoreShape) => s.script(KanbanScriptId.make("missing")),
  },
  { name: "next number", read: (s: KanbanStore.KanbanStoreShape) => s.nextCardNumber(boardId) },
  {
    name: "one thread link",
    read: (s: KanbanStore.KanbanStoreShape) => s.threadLinksByIds(["missing"]),
  },
  {
    name: "multiple thread links",
    read: (s: KanbanStore.KanbanStoreShape) => s.threadLinksByIds(["missing", "other"]),
  },
  {
    name: "missing discussion messages",
    table: "ardud_kanban_messages",
    read: (s: KanbanStore.KanbanStoreShape) => s.messages(discussionId),
  },
  { name: "board collection", read: (s: KanbanStore.KanbanStoreShape) => s.boards },
];

it.effect.each(
  reads.flatMap((read) =>
    [false, true].flatMap((wrapped) =>
      (["direct", "bestEffort", "timeoutOption", "raceFirst"] as const).map((boundary) => ({
        ...read,
        wrapped,
        boundary,
      })),
    ),
  ),
)(
  "#1747 held SELECT budget covers $name (wrapped=$wrapped, boundary=$boundary)",
  ({ read, wrapped, table, boundary }) =>
    Effect.gen(function* () {
      const raw = yield* KanbanStore.KanbanStore;
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let queries = 0;
      const stall: Statement.Transformer = (statement) => {
        if (table !== undefined && !statement.compile()[0].includes(table))
          return Effect.succeed(statement);
        queries++;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(statement),
        );
      };
      const selected = read(wrapped ? LockedStore.wrap(raw, locks) : raw);
      const bounded =
        boundary === "bestEffort"
          ? SavedWrite.bestEffort(selected, null)
          : boundary === "timeoutOption"
            ? selected.pipe(Effect.timeoutOption("5 seconds"))
            : boundary === "raceFirst"
              ? selected.pipe(Effect.raceFirst(Deferred.await(resume)))
              : selected;
      const pending = yield* locks
        .run(locks.access(boardId, Effect.void).pipe(Effect.andThen(bounded)))
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, stall),
          Effect.exit,
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      const written = yield* Deferred.make<void>();
      const writer = yield* locks
        .board(boardId, Deferred.succeed(written, undefined))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(1_999);
      assert.isUndefined(pending.pollUnsafe());
      assert.isFalse(yield* Deferred.isDone(written));
      yield* TestClock.adjust(1);
      assert.isDefined(pending.pollUnsafe());
      const result = yield* Fiber.join(pending);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.instanceOf(Cause.squash(result.cause), BoardLocks.DispatchReadBudgetExceeded);
      yield* Fiber.join(writer);
      assert.equal(queries, 1);
      assert.deepEqual(yield* locks.holders, []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(reads)("#1747 an outside SELECT retains its lifetime: $name", ({ read }) =>
  Effect.gen(function* () {
    const raw = yield* KanbanStore.KanbanStore;
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const stall: Statement.Transformer = (statement) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.as(statement),
      );
    const pending = yield* locks
      .run(
        locks
          .access(boardId, Effect.void)
          .pipe(Effect.andThen(locks.outside(read(raw), undefined, true))),
      )
      .pipe(Effect.provideService(Statement.CurrentTransformer, stall), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(3_000);
    assert.isUndefined(pending.pollUnsafe());
    yield* locks.board(boardId, Effect.void);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(pending);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("#1747 a caught read cutoff blocks writes after cleanup crosses bestEffort", () =>
  Effect.gen(function* () {
    const raw = yield* KanbanStore.KanbanStore;
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const finishCleanup = yield* Deferred.make<void>();
    let writes = 0;
    const stall: Statement.Transformer = (statement) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.as(statement),
        Effect.ensuring(
          Deferred.succeed(cancelled, undefined).pipe(
            Effect.andThen(Deferred.await(finishCleanup)),
          ),
        ),
      );
    const pending = yield* locks
      .board(
        boardId,
        SavedWrite.bestEffort(raw.card(cardId), null).pipe(
          Effect.andThen(
            locks.access(
              boardId,
              Effect.sync(() => {
                writes++;
              }),
              true,
            ),
          ),
        ),
      )
      .pipe(
        Effect.provideService(Statement.CurrentTransformer, stall),
        Effect.exit,
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(2_000);
    yield* Deferred.await(cancelled);
    yield* TestClock.adjust(3_001);
    assert.isUndefined(pending.pollUnsafe());
    yield* Deferred.succeed(finishCleanup, undefined);
    const result = yield* Fiber.join(pending);
    assert.equal(writes, 0);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result))
      assert.instanceOf(Cause.squash(result.cause), BoardLocks.DispatchReadBudgetExceeded);
    assert.deepEqual(yield* locks.holders, []);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["fresh", "independent", "background"] as const)(
  "#1747 $0 reads do not inherit another operation's deadline",
  (boundary) =>
    Effect.gen(function* () {
      const raw = yield* KanbanStore.KanbanStore;
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resumeRead = yield* Deferred.make<void>();
      const resumeOwner = yield* Deferred.make<void>();
      const started = yield* Deferred.make<Fiber.Fiber<unknown, KanbanStore.KanbanStoreError>>();
      const stall: Statement.Transformer = (statement) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resumeRead)),
          Effect.as(statement),
        );
      const owner = yield* locks
        .board(
          boardId,
          Effect.gen(function* () {
            const read = raw.card(cardId);
            const detached =
              boundary === "background" ? SavedWrite.background(read) : locks[boundary](read);
            const child = yield* detached.pipe(
              Effect.provideService(Statement.CurrentTransformer, stall),
              Effect.forkChild,
            );
            yield* Deferred.succeed(started, child);
            yield* Deferred.await(resumeOwner);
            yield* Fiber.join(child);
          }),
        )
        .pipe(Effect.forkChild);
      const child = yield* Deferred.await(started);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(3_000);
      assert.isUndefined(child.pollUnsafe());
      yield* Deferred.succeed(resumeRead, undefined);
      yield* Deferred.succeed(resumeOwner, undefined);
      yield* Fiber.join(owner);
      assert.deepEqual(yield* locks.holders, []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect.each([false, true])(
  "#1747 empty thread ids need no SELECT after the budget (wrapped=%s)",
  (wrapped) =>
    Effect.gen(function* () {
      const raw = yield* KanbanStore.KanbanStore;
      const locks = yield* BoardLocks.make();
      yield* locks.board(
        boardId,
        Effect.gen(function* () {
          yield* TestClock.adjust(3_000);
          assert.deepEqual(
            yield* (wrapped ? LockedStore.wrap(raw, locks) : raw).threadLinksByIds([]),
            [],
          );
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
);

const mutations = [
  {
    name: "addCardEvent",
    table: "ardud_kanban_card_events",
    mutate: (s: KanbanStore.KanbanStoreShape) =>
      s
        .addCardEvent({
          cardId,
          at,
          actor: { _tag: "owner" },
          kind: "comment",
          fromStage: null,
          toStage: null,
          body: "Saved",
          head: null,
        })
        .pipe(Effect.asVoid),
  },
  {
    name: "addThreadCard",
    table: "ardud_kanban_thread_cards",
    mutate: (s: KanbanStore.KanbanStoreShape) => s.addThreadCard("thread", cardId, at),
  },
  {
    name: "putMessage",
    table: "ardud_kanban_messages",
    mutate: (s: KanbanStore.KanbanStoreShape) =>
      s.putMessage({
        discussionId,
        seq: 1,
        author: { _tag: "owner" },
        authorName: "Owner",
        blocks: [{ _tag: "md", text: "Saved" }],
        answers: [],
        createdAt: at,
      }),
  },
];
const decodeResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({ saved: Schema.NullOr(Schema.Boolean), message: Schema.String }),
);

it.effect.each(
  mutations.flatMap((mutation) =>
    (["interrupt", "reply"] as const).map((cancel) => ({ ...mutation, cancel })),
  ),
)(
  "#1747 missing locator keeps $name masked through $cancel cancellation",
  ({ mutate, table, cancel }) =>
    Effect.gen(function* () {
      const raw = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let finished = false;
      const stall: Statement.Transformer = (statement) =>
        /^\s*INSERT\b/.test(statement.compile()[0])
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as(statement),
            )
          : Effect.succeed(statement);
      const pending = yield* SavedReply.protect(
        locks.board(
          boardId,
          SavedWrite.committing.pipe(
            Effect.andThen(mutate(LockedStore.wrap(raw, locks))),
            Effect.tap(() =>
              Effect.sync(() => {
                finished = true;
              }),
            ),
            Effect.as(new McpSchema.CallToolResult({ content: [] })),
            Effect.uninterruptible,
          ),
        ),
        "card_update",
      ).pipe(Effect.provideService(Statement.CurrentTransformer, stall), Effect.forkChild);
      yield* Deferred.await(entered);
      const interrupt =
        cancel === "interrupt" ? yield* Effect.forkChild(Fiber.interrupt(pending)) : undefined;
      yield* TestClock.adjust(cancel === "reply" ? SavedReply.REPLY_BUDGET_MS : 3_000);
      assert.isUndefined(pending.pollUnsafe());
      assert.isFalse(finished);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.await(pending);
      if (interrupt !== undefined) yield* Fiber.join(interrupt);
      if (cancel === "interrupt") assert.isTrue(Exit.isFailure(result));
      else {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result)) {
          const data = decodeReply(decodeResult(result.value).structuredContent);
          assert.deepInclude(data, { saved: null });
          assert.include(String(data?.message), "before retrying");
          assert.notInclude(String(data?.message), "Read timed out");
          assert.notInclude(String(data?.message), "Safe to retry");
        }
      }
      assert.isTrue(finished);
      assert.deepEqual(yield* sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`), [{ n: 1 }]);
    }).pipe(Effect.provide(TestLayer)),
);
