import { assert, it } from "@effect/vitest";
import { KanbanCardId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import type * as Tracer from "effect/Tracer";
import { McpSchema } from "effect/ai";

import * as KanbanStore from "../store/KanbanStore.ts";
import * as SavedReply from "../tools/savedReply.ts";
import { makeFake, owner, testLayer, toyBoard } from "./askFlows.testkit.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as LockedStore from "./lockedStore.ts";
import * as SavedWrite from "./savedWrite.ts";

it.effect.each(["thread links", "home card"] as const)(
  "#1747 dispatch planning bounds a raw $name SELECT and admits a same-board update",
  (name) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      return yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const target = yield* kanban.createCard(
          board.id,
          { title: "Reused work", prompt: "Work" },
          owner,
        );
        const other = yield* kanban.createCard(
          board.id,
          { title: "Other", prompt: "Other" },
          owner,
        );
        const { board: healthy } = yield* toyBoard("healthy");
        const healthyCard = yield* kanban.createCard(
          healthy.id,
          { title: "Healthy", prompt: "Healthy" },
          owner,
        );
        const store = yield* KanbanStore.KanbanStore;
        const homeThread = ThreadId.make("home-thread");
        yield* store.putCard({ ...target, workThreadId: homeThread });
        yield* store.putThreadLink({
          threadId: homeThread,
          boardId: board.id,
          cardId: KanbanCardId.make("finished-home"),
          role: "work",
          purpose: null,
          discussionId: null,
          model: board.defaultCardModel,
          startedAt: board.createdAt,
          endedAt: board.createdAt,
          paused: null,
        });
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let attempts = 0;
        const stall: Statement.Transformer = (statement, _sql, _fiber, span) => {
          let current: Tracer.AnySpan | undefined = span;
          while (current?._tag === "Span" && current.name !== "KanbanService.workThreadHomes")
            current = Option.getOrUndefined(current.parent);
          const query = statement.compile()[0];
          if (
            current?._tag !== "Span" ||
            !(
              name === "thread links"
                ? /FROM ardud_kanban_threads WHERE thread_id IN/
                : /FROM ardud_kanban_cards WHERE id =/
            ).test(query)
          )
            return Effect.succeed(statement);
          attempts++;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(statement),
          );
        };
        const dispatch = yield* kanban.dispatchNow.pipe(
          Effect.provideService(Statement.CurrentTransformer, stall),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* kanban.editCard(healthyCard.id, { description: "Foreground saved" }, owner);
        const written = yield* Deferred.make<void>();
        const writer = yield* kanban
          .editCard(other.id, { description: "Same-board saved" }, owner)
          .pipe(
            Effect.tap(() => Deferred.succeed(written, undefined)),
            Effect.forkChild,
          );
        yield* TestClock.adjust(1_999);
        assert.isUndefined(dispatch.pollUnsafe());
        assert.isFalse(yield* Deferred.isDone(written));
        yield* TestClock.adjust(1);
        assert.isDefined(dispatch.pollUnsafe());
        assert.isTrue(Exit.isFailure(yield* Fiber.join(dispatch)));
        yield* Fiber.join(writer);
        assert.equal(attempts, 1);
        assert.isFalse(yield* Deferred.isDone(resume));
        assert.equal((yield* kanban.card(other.id)).card.description, "Same-board saved");
        assert.equal((yield* kanban.card(healthyCard.id)).card.description, "Foreground saved");
        assert.equal((yield* kanban.card(target.id)).card.stage, "todo");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

const decodeResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({ saved: Schema.NullOr(Schema.Boolean), message: Schema.String }),
);

it.effect("#1747 saveCard bestEffort SELECT inherits the held gate's read deadline", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    return yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Before", prompt: "Work" }, owner);
      const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      let attempts = 0;
      const stall: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const parents = new Set<string>();
        let current: Tracer.AnySpan | undefined = span;
        while (current?._tag === "Span") {
          parents.add(current.name);
          current = Option.getOrUndefined(current.parent);
        }
        if (
          !parents.has("KanbanService.saveCard") ||
          !parents.has("KanbanSavedWrite.bestEffort") ||
          !/FROM ardud_kanban_cards WHERE id =/.test(statement.compile()[0])
        )
          return Effect.succeed(statement);
        attempts++;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(statement),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        );
      };
      const pending = yield* SavedReply.protect(
        kanban
          .flagCard(card.id, "Blocked", owner)
          .pipe(Effect.as(new McpSchema.CallToolResult({ content: [] }))),
        "card_flag",
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, stall),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const writer = yield* kanban
        .editCard(other.id, { description: "Gate released" }, owner)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(1_999);
      assert.isUndefined(pending.pollUnsafe());
      assert.isFalse(yield* Deferred.isDone(cancelled));
      yield* TestClock.adjust(1);
      assert.isTrue(yield* Deferred.isDone(cancelled));
      const result = decodeReply(decodeResult(yield* Fiber.join(pending)).structuredContent);
      // The flag event committed before the optional pre-read; the card receipt did not.
      assert.isNull(result.saved);
      assert.match(result.message, /^Read timed out\./);
      yield* Fiber.join(writer);
      assert.equal(attempts, 1);
      assert.equal((yield* kanban.card(other.id)).card.description, "Gate released");
      assert.isNull((yield* kanban.card(card.id)).card.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["interrupt", "reply"] as const)(
  "#1747 editCard preserves its masked service SELECT through %s cancellation",
  (cancel) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      return yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const card = yield* kanban.createCard(board.id, { title: "Before", prompt: "Work" }, owner);
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let latched = false;
        let readerAdmissions = 0;
        const stall: Statement.Transformer = (statement, _sql, _fiber, span) => {
          let current: Tracer.AnySpan | undefined = span;
          while (current?._tag === "Span" && current.name !== "KanbanService.saveCard")
            current = Option.getOrUndefined(current.parent);
          if (
            current?._tag !== "Span" ||
            !/FROM ardud_kanban_cards WHERE id =/.test(statement.compile()[0])
          )
            return Effect.succeed(statement);
          latched = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(statement),
          );
        };
        const pending = yield* SavedReply.protect(
          kanban
            .editCard(card.id, { description: "Saved through service mask" }, owner)
            .pipe(Effect.as(new McpSchema.CallToolResult({ content: [] }))),
          "card_update",
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, stall),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
          Effect.provideService(NodeSqliteClient.ReaderWaitStartedObserver, () => {
            if (latched) readerAdmissions++;
            return undefined;
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const interrupt =
          cancel === "interrupt" ? yield* Effect.forkChild(Fiber.interrupt(pending)) : undefined;
        yield* TestClock.adjust(cancel === "reply" ? SavedReply.REPLY_BUDGET_MS : 3_000);
        assert.isUndefined(pending.pollUnsafe());
        assert.equal(readerAdmissions, 0);
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.await(pending);
        if (interrupt !== undefined) yield* Fiber.join(interrupt);
        if (cancel === "interrupt") assert.isTrue(Exit.isFailure(result));
        else {
          assert.isTrue(Exit.isSuccess(result));
          if (Exit.isSuccess(result)) {
            const data = decodeReply(decodeResult(result.value).structuredContent);
            assert.isTrue(data.saved);
            assert.notInclude(data.message, "Safe to retry");
          }
        }
        assert.equal((yield* kanban.card(card.id)).card.description, "Saved through service mask");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(
  (["putCard", "migration", "writer transaction"] as const).flatMap((form) =>
    (["interrupt", "reply"] as const).map((cancel) => ({ form, cancel })),
  ),
)("#1747 $form keeps its nested SELECT masked through $cancel cancellation", ({ form, cancel }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    return yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { title: "Before", prompt: "Work" }, owner);
      const next = { ...card, description: "Saved after nested SELECT" };
      const raw = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const locks = yield* BoardLocks.make();
      const wrapped = LockedStore.wrap(raw, locks);
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let readerAdmissions = 0;
      const stall: Statement.Transformer = (statement) =>
        /FROM ardud_kanban_cards WHERE id =/.test(statement.compile()[0])
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as(statement),
            )
          : Effect.succeed(statement);
      const mutation =
        form === "putCard"
          ? raw.putCard(next)
          : form === "migration"
            ? wrapped.migrateBoardSelections({
                board,
                pools: [],
                oldPoolKeys: [],
                cards: [next],
                threadLinks: [],
              })
            : sql.withTransaction(
                Effect.gen(function* () {
                  yield* raw.putCard(next);
                  assert.equal((yield* raw.card(card.id))?.description, next.description);
                }),
              );
      const pending = yield* SavedReply.protect(
        locks.board(
          board.id,
          SavedWrite.committing.pipe(
            Effect.andThen(mutation),
            Effect.as(new McpSchema.CallToolResult({ content: [] })),
            Effect.uninterruptible,
          ),
        ),
        "card_update",
      ).pipe(
        Effect.provideService(
          KanbanStore.cardWrites,
          form === "writer transaction" ? undefined : () => {},
        ),
        Effect.provideService(Statement.CurrentTransformer, stall),
        Effect.provideService(NodeSqliteClient.ReaderWaitStartedObserver, () => {
          readerAdmissions++;
          return undefined;
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const interrupt =
        cancel === "interrupt" ? yield* Effect.forkChild(Fiber.interrupt(pending)) : undefined;
      yield* TestClock.adjust(cancel === "reply" ? SavedReply.REPLY_BUDGET_MS : 3_000);
      assert.isUndefined(pending.pollUnsafe());
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.await(pending);
      if (interrupt !== undefined) yield* Fiber.join(interrupt);
      if (cancel === "interrupt") assert.isTrue(Exit.isFailure(result));
      else {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result)) {
          const data = decodeReply(decodeResult(result.value).structuredContent);
          assert.isNull(data.saved);
          assert.include(data.message, "before retrying");
          assert.notInclude(data.message, "Safe to retry");
        }
      }
      assert.equal(readerAdmissions, 0);
      assert.equal((yield* raw.card(card.id))?.description, next.description);
      assert.deepEqual(yield* locks.holders, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
