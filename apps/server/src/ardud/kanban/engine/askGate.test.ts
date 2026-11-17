import { assert, it } from "@effect/vitest";
import { MessageId, RunId, type ModelSelection, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { makeFake, owner, testLayer, workingCard } from "./askFlows.testkit.ts";
import { KanbanThreads } from "./threads.ts";
import * as SavedWrite from "./savedWrite.ts";

it.effect.each([
  "ask",
  "make blocking",
  "review findings",
  "review clear",
  "move to review",
  "stalled flag",
] as const)(
  "%s releases the board gate during a blocked wake read and saves once after a concurrent write",
  (action) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const base = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let blocked: ThreadId | undefined;
      let reads = 0;
      const slow = Layer.succeed(KanbanThreads, {
        ...base,
        queuedRuns: (id) =>
          id !== blocked
            ? base.queuedRuns(id)
            : Effect.gen(function* () {
                reads += 1;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
                return [];
              }),
      });
      yield* Effect.gen(function* () {
        const { kanban, board, card, worker, threadId } = yield* workingCard();
        const reviewing = action.startsWith("review");
        let target = threadId;
        if (reviewing) {
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
          yield* kanban.turnEnded(threadId);
          yield* kanban.dispatchNow;
          target = (yield* kanban.card(card.id)).card.activeThreadId!;
          assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
        }
        const other = yield* kanban.createCard(
          board.id,
          { title: "Other", prompt: "Other" },
          owner,
        );
        if (action === "make blocking")
          yield* kanban.askOwner(
            card.id,
            { question: "Continue?", blocking: false },
            worker,
            "cardThread",
          );
        blocked = target;
        const asking = yield* Effect.forkChild(
          reviewing
            ? kanban
                .reviewResult(
                  target,
                  action === "review clear" ? "clear" : "findings",
                  ["Fix queue ordering"],
                  "abc1234",
                )
                .pipe(Effect.map((result) => result.card))
            : action === "move to review"
              ? kanban.moveCard(card.id, "needs_review", "cardThread", worker)
              : action === "stalled flag"
                ? kanban.flagCard(card.id, "Waiting for tooling", worker)
                : action === "ask"
                  ? kanban.askOwner(
                      card.id,
                      { question: "Continue?", blocking: true },
                      worker,
                      "cardThread",
                    )
                  : kanban.changeAsk(card.id, "q1", "block", worker, "cardThread"),
        );
        yield* Deferred.await(entered);
        const saved = yield* kanban.editCard(
          other.id,
          { description: "Saved while ask waits" },
          owner,
        );
        assert.equal(saved.description, "Saved while ask waits");
        assert.isUndefined(asking.pollUnsafe());
        assert.equal((yield* kanban.card(card.id)).card.stage, reviewing ? "in_review" : "working");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(asking);
        const result = yield* kanban.card(card.id);
        if (reviewing) {
          assert.equal(result.card.stage, action === "review clear" ? "completed" : "todo");
          assert.lengthOf(
            result.events.filter((event) => event.kind === "review"),
            1,
          );
          assert.lengthOf(result.card.asks, 0);
        } else if (action === "move to review") {
          assert.equal(result.card.stage, "needs_review");
          assert.isNull(result.card.activeThreadId);
          assert.lengthOf(result.card.asks, 0);
          assert.lengthOf(
            result.events.filter((event) => event.toStage === "needs_review"),
            1,
          );
        } else if (action === "stalled flag") {
          assert.equal(result.card.stage, "todo");
          assert.isNull(result.card.activeThreadId);
          assert.equal(result.card.stalled?.reason, "Waiting for tooling");
          assert.lengthOf(
            result.events.filter((event) => event.kind === "flagged"),
            1,
          );
        } else {
          assert.equal(result.card.stage, "needs_owner");
          assert.lengthOf(result.card.asks, 1);
          assert.isTrue(result.card.asks[0]!.blocking);
          assert.isNotNull(result.card.asks[0]!.seq);
          assert.lengthOf(
            result.events.filter((event) => event.toStage === "needs_owner"),
            1,
          );
        }
        assert.equal(reads, 1);
      }).pipe(
        Effect.provide(testLayer(slow)),
        Effect.ensuring(Deferred.succeed(resume, undefined)),
      );
    }),
);

it.effect.each(["ask", "make blocking"] as const)(
  "%s bounds wake cancellation before saving the transition",
  (action) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const base = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      const entered = yield* Deferred.make<void>();
      let blocked: ThreadId | undefined;
      let model: ModelSelection | undefined;
      const finishCancellation = yield* Deferred.make<void>();
      const slow = Layer.succeed(KanbanThreads, {
        ...base,
        queuedRuns: (id) =>
          Effect.succeed(
            id === blocked
              ? [
                  {
                    id: RunId.make("old-wake"),
                    threadId: id,
                    ordinal: 1,
                    providerInstanceId: model!.instanceId,
                    modelSelection: model!,
                    providerThreadId: null,
                    userMessageId: MessageId.make("kanban:wake:nudge:old"),
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "queued" as const,
                    requestedAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
                    startedAt: null,
                    completedAt: null,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                ]
              : [],
          ),
        cancelQueued: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finishCancellation)),
            Effect.as(true),
            Effect.uninterruptible,
          ),
      });
      yield* Effect.gen(function* () {
        const { kanban, board, card, worker, threadId } = yield* workingCard();
        model = board.defaultCardModel;
        const other = yield* kanban.createCard(
          board.id,
          { title: "Other", prompt: "Other" },
          owner,
        );
        if (action === "make blocking")
          yield* kanban.askOwner(
            card.id,
            { question: "Continue?", blocking: false },
            worker,
            "cardThread",
          );
        blocked = threadId;
        const asking = yield* Effect.forkChild(
          Effect.exit(
            action === "ask"
              ? kanban.askOwner(
                  card.id,
                  { question: "Continue?", blocking: true },
                  worker,
                  "cardThread",
                )
              : kanban.changeAsk(card.id, "q1", "block", worker, "cardThread"),
          ),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("5 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(asking)));
        const unchanged = yield* kanban.card(card.id);
        assert.equal(unchanged.card.stage, "working");
        assert.lengthOf(
          unchanged.events.filter((event) => event.toStage === "needs_owner"),
          0,
        );
        const saved = yield* kanban.editCard(other.id, { description: "Gate released" }, owner);
        assert.equal(saved.description, "Gate released");
        blocked = undefined;
        if (action === "ask")
          yield* kanban.askOwner(
            card.id,
            { question: "Continue?", blocking: true },
            worker,
            "cardThread",
          );
        else yield* kanban.changeAsk(card.id, "q1", "block", worker, "cardThread");
        const retried = yield* kanban.card(card.id);
        assert.lengthOf(retried.card.asks, 1);
        assert.equal(retried.card.stage, "needs_owner");
      }).pipe(
        Effect.ensuring(Deferred.succeed(finishCancellation, undefined)),
        Effect.provide(testLayer(slow)),
      );
    }),
);

it.effect.each(["answer", "drop", "create"] as const)(
  "%s keeps thread delivery outside the board gate",
  (action) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const base = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let block = false;
      const wait = Effect.gen(function* () {
        if (!block) return;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(resume);
      });
      const slow = Layer.succeed(KanbanThreads, {
        ...base,
        send: (input) => wait.pipe(Effect.andThen(base.send(input))),
        launch: (input) => wait.pipe(Effect.andThen(base.launch(input))),
      });
      yield* Effect.gen(function* () {
        const { kanban, board, card, worker } = yield* workingCard();
        const other = yield* kanban.createCard(
          board.id,
          { title: "Other", prompt: "Other" },
          owner,
        );
        if (action !== "create")
          yield* kanban.askOwner(
            card.id,
            { question: "Continue?", blocking: false },
            worker,
            "cardThread",
          );
        block = true;
        const pending = yield* Effect.forkChild(
          action === "create"
            ? kanban.createCard(
                board.id,
                {
                  title: "Question",
                  prompt: "Question",
                  stage: "needs_owner",
                  question: "Continue?",
                },
                worker,
              )
            : action === "answer"
              ? kanban
                  .answerAsk(card.id, "q1", { verdict: "answered", text: "Continue" }, owner)
                  .pipe(Effect.map((result) => result.card))
              : kanban.changeAsk(card.id, "q1", "drop", owner, "owner"),
        );
        if (action !== "create") yield* Deferred.await(entered);
        const saved = yield* kanban.editCard(
          other.id,
          { description: "Delivery still waits" },
          owner,
        );
        assert.equal(saved.description, "Delivery still waits");
        yield* Deferred.succeed(resume, undefined);
        const returned = yield* Fiber.join(pending);
        if (action === "create") assert.isFalse(yield* Deferred.isDone(entered));
        const result = (yield* kanban.card(returned.id)).card;
        assert.lengthOf(result.asks, 1);
        if (action === "create") {
          assert.equal(result.stage, "needs_owner");
          assert.isNotNull(result.asks[0]!.seq);
        } else assert.isNotNull(result.asks[0]!.closedAt);
        yield* Deferred.succeed(resume, undefined);
      }).pipe(
        Effect.provide(testLayer(slow)),
        Effect.ensuring(Deferred.succeed(resume, undefined)),
      );
    }),
);

it.effect.each(["clear", "findings"] as const)(
  "%s review verdict does not attribute outside wake cancellation to a gate hold",
  (verdict) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const base = yield* KanbanThreads.pipe(Effect.provide(fake.layer));
      let blocked: ThreadId | undefined;
      let model: ModelSelection | undefined;
      let steps: ReadonlyArray<SavedWrite.SubStep> | undefined;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const slow = Layer.succeed(KanbanThreads, {
        ...base,
        queuedRuns: (id) =>
          Effect.succeed(
            id === blocked
              ? [
                  {
                    id: RunId.make("old-wake"),
                    threadId: id,
                    ordinal: 1,
                    providerInstanceId: model!.instanceId,
                    modelSelection: model!,
                    providerThreadId: null,
                    userMessageId: MessageId.make("kanban:wake:nudge:old"),
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "queued" as const,
                    requestedAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
                    startedAt: null,
                    completedAt: null,
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                ]
              : [],
          ),
        cancelQueued: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as(true),
            Effect.uninterruptible,
          ),
      });
      yield* Effect.gen(function* () {
        const { kanban, card, worker, threadId, board } = yield* workingCard();
        model = board.defaultCardModel;
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.turnEnded(threadId);
        yield* kanban.dispatchNow;
        blocked = (yield* kanban.card(card.id)).card.activeThreadId!;
        assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
        const pending = yield* Effect.forkChild(
          kanban.reviewResult(blocked, verdict, ["Fix queue"], "abc1234").pipe(
            Effect.exit,
            Effect.provideService(SavedWrite.subStepReporter, (value) => {
              steps = value;
            }),
          ),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(5_000);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
        assert.isUndefined(steps);
        assert.equal((yield* kanban.card(card.id)).card.stage, "in_review");
      }).pipe(
        Effect.ensuring(Deferred.succeed(finish, undefined)),
        Effect.provide(testLayer(slow)),
      );
    }),
);
