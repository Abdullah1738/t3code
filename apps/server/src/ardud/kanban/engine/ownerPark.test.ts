import { assert, it } from "@effect/vitest";
import { ThreadId, AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Analytics from "../../analytics/Analytics.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import {
  askOf,
  makeFake,
  owner,
  testLayer,
  workingCard,
  fileTestLayer,
  filesLayer,
} from "./askFlows.testkit.ts";
import * as KanbanService from "./KanbanService.ts";
import { KanbanThreadError, KanbanThreads } from "./threads.ts";
import { modelSelectionOf } from "./defaults.ts";
import * as Rules from "./rules.ts";

const decodeAnalytics = Schema.decodeUnknownEffect(AnalyticsEvent);

it.effect.each(
  (["await", "deferred", "inline"] as const).flatMap((mode) =>
    (["post text", "post choice", "pick"] as const).flatMap((reply) =>
      (reply === "pick"
        ? (["none", "worker"] as const)
        : (["none", "worker", "evaluator"] as const)
      ).map((failure) => ({ mode, reply, failure })),
    ),
  ),
)(
  "a restored multi-ask $reply has one notification owner in $mode mode ($failure failure)",
  ({ mode, reply, failure }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const workerSent = yield* Deferred.make<void>();
      const evaluatorSent = yield* Deferred.make<void>();
      const marker = "Owner multi-ask retry 1615";
      let workerId: ThreadId | undefined;
      let evaluatorId: ThreadId | undefined;
      let injected = 0;
      const external = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            send: (input) =>
              Effect.gen(function* () {
                const relevant = input.text.includes(marker);
                if (
                  injected === 0 &&
                  relevant &&
                  ((failure === "worker" && input.threadId === workerId) ||
                    (failure === "evaluator" && input.threadId === evaluatorId))
                ) {
                  injected++;
                  return yield* new KanbanThreadError({
                    operation: "send",
                    detail: "Retry a multi-ask recipient once",
                  });
                }
                if (!input.isStale?.()) yield* real.send(input);
                if (!relevant) return;
                if (input.threadId === workerId) yield* Deferred.succeed(workerSent, undefined);
                if (input.threadId === evaluatorId)
                  yield* Deferred.succeed(evaluatorSent, undefined);
              }),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        workerId = threadId;
        evaluatorId = yield* kanban.startEvaluator(board.id, {
          kind: "request",
          text: `Review card #${card.number}`,
        });
        yield* Ref.update(fake.threads, (all) =>
          new Map(all).set(evaluatorId!, { ...all.get(evaluatorId!)!, state: "running" }),
        );
        yield* kanban.askOwner(
          card.id,
          {
            question: "Also tell the evaluator?",
            blocking: false,
            ...(reply === "post choice" ? { options: ["First", "Second"] } : {}),
          },
          { _tag: "evaluator", threadId: evaluatorId },
          "evaluator",
        );
        yield* kanban.askOwner(
          card.id,
          {
            question: "Continue worker?",
            blocking: true,
            ...(reply === "pick" ? { options: [marker, "No"] } : {}),
          },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const ask = askOf((yield* kanban.card(card.id)).card, "q2");
        if (reply === "pick")
          yield* kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner);
        else yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: marker }]);
        yield* Deferred.await(workerSent);
        if (reply !== "pick") yield* Deferred.await(evaluatorSent);
        yield* kanban.dispatchNow;
        const restored = (yield* kanban.card(card.id)).card;
        assert.equal(restored.stage, "working");
        assert.equal(restored.activeThreadId, threadId);
        assert.isNotNull(askOf(restored, "q2").closedAt);
        assert.equal(askOf(restored, "q1").closedAt === null, reply !== "post text");
        assert.equal(injected, failure === "none" ? 0 : 1);
        assert.equal(
          (yield* fake.heard(threadId)).filter((text) => text.includes(marker)).length,
          1,
        );
        assert.equal(
          (yield* fake.heard(evaluatorId)).filter((text) => text.includes(marker)).length,
          reply === "pick" ? 0 : 1,
        );
      }).pipe(
        Effect.provide(
          testLayer(external).pipe(
            Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, mode)),
          ),
        ),
      );
    }),
);

it.effect.each(
  (["await", "deferred", "inline"] as const).flatMap((mode) =>
    (["post", "pick", "answer", "drop", "wake"] as const).flatMap((reply) =>
      (["delivered", "stop", "reset", "pause"] as const).map((outcome) => ({
        mode,
        reply,
        outcome,
      })),
    ),
  ),
)(
  "a restored $reply has one guarded delivery in $mode mode ($outcome)",
  ({ mode, reply, outcome }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const transitioned = yield* Deferred.make<void>();
      const observed: Array<{ guarded: boolean; stale: boolean }> = [];
      let notification: string | undefined;
      let target: ThreadId | undefined;
      let revoking = false;
      const storeLayer = Layer.effect(
        KanbanStore.KanbanStore,
        Effect.map(KanbanStore.KanbanStore, (real) =>
          KanbanStore.KanbanStore.of({
            ...real,
            putCard: (card) =>
              real
                .putCard(card)
                .pipe(
                  Effect.tap(() =>
                    revoking && card.activeThreadId === null
                      ? Deferred.succeed(transitioned, undefined)
                      : Effect.void,
                  ),
                ),
          }),
        ),
      ).pipe(Layer.provide(KanbanStore.layer));
      const gated = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            send: (input) =>
              Effect.gen(function* () {
                if (
                  input.threadId !== target ||
                  notification === undefined ||
                  !input.text.includes(notification)
                )
                  return yield* real.send(input);
                const guarded = input.coalesce?.startsWith("owner:") === true;
                if (guarded) yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                const stale = input.isStale?.() === true;
                observed.push({ guarded, stale });
                if (!stale) yield* real.send(input);
                if (guarded) yield* Deferred.succeed(finished, undefined);
              }),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        target = threadId;
        const marker = "Owner route matrix 1615";
        yield* kanban.askOwner(
          card.id,
          {
            question: "Continue?",
            blocking: true,
            ...(reply === "pick" ? { options: [marker, "No"] } : {}),
          },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const ask = askOf((yield* kanban.card(card.id)).card);
        notification = reply === "drop" ? `Abdullah dropped ${ask.id}.` : marker;
        const close =
          reply === "post"
            ? Effect.asVoid(kanban.post(discussion.id, owner, [{ _tag: "md", text: marker }]))
            : reply === "pick"
              ? Effect.asVoid(
                  kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner),
                )
              : reply === "answer"
                ? Effect.asVoid(
                    kanban.answerAsk(
                      card.id,
                      ask.id,
                      { verdict: "answered", text: marker, revision: 0 },
                      owner,
                    ),
                  )
                : reply === "drop"
                  ? Effect.asVoid(kanban.changeAsk(card.id, ask.id, "drop", owner, "owner"))
                  : Effect.asVoid(kanban.cardThread(card.id, "wake", marker, owner));
        const request = yield* Effect.forkChild(close);
        yield* Deferred.await(entered);
        assert.equal((yield* kanban.card(card.id)).card.stage, "working");
        revoking = outcome === "stop" || outcome === "reset";
        const revocation =
          outcome === "stop" || outcome === "reset"
            ? yield* Effect.forkChild(
                kanban.cardThread(card.id, outcome, "Discard pending reply", owner),
              )
            : undefined;
        if (outcome === "pause")
          yield* kanban.pauseBoard(board.id, { reason: "Discard pending reply", keep: [] }, owner);
        if (revocation !== undefined) {
          // Await mode waits for the lane drain after committing Stop/Reset.
          yield* Deferred.await(transitioned);
        }
        yield* Deferred.succeed(release, undefined);
        if (revocation !== undefined) yield* Fiber.join(revocation);
        yield* Fiber.join(request);
        yield* Deferred.await(finished);
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Delivery drain barrier" }]);
        yield* kanban.dispatchNow;
        assert.deepEqual(observed, [{ guarded: true, stale: outcome !== "delivered" }]);
        assert.equal(
          (yield* fake.heard(threadId)).filter((text) => text.includes(notification!)).length,
          outcome === "delivered" ? 1 : 0,
        );
      }).pipe(
        Effect.provide(
          testLayer(gated, storeLayer).pipe(
            Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, mode)),
          ),
        ),
      );
    }),
);

it.effect.each([
  { reply: "post", failure: "reply write" } as const,
  ...(["pick", "answer", "drop", "wake"] as const).map((reply) => ({
    reply,
    failure: "notification write" as const,
  })),
  ...(["post", "pick", "answer", "drop", "wake"] as const).flatMap((reply) =>
    (["slot write", "cancellation"] as const).map((failure) => ({ reply, failure })),
  ),
])("a restored $reply keeps its persisted slot after $failure", ({ reply, failure }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owner-rollback-1615-" });
    const fake = yield* makeFake;
    let armed = false;
    let injected = 0;
    let restoreAttempts = 0;
    const storeLayer = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.gen(function* () {
        const real = yield* KanbanStore.KanbanStore;
        const sql = yield* BoardsDatabase.client;
        return KanbanStore.KanbanStore.of({
          ...real,
          putCard: (card) =>
            real.putCard(card).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (!armed || card.stage !== "working" || card.ownerPark !== undefined) return;
                  if (failure === "cancellation") {
                    armed = false;
                    injected++;
                    yield* Effect.withFiber((fiber) => {
                      fiber.interruptUnsafe();
                      return Effect.void;
                    });
                  } else if (failure === "notification write") {
                    armed = false;
                    injected++;
                    yield* sql.unsafe(`
                  CREATE TEMP TRIGGER restored_notification_failure
                  BEFORE INSERT ON ardud_kanban_owner_routes
                  WHEN json_extract(NEW.json, '$.kind') = 'effect'
                    AND json_extract(NEW.json, '$.effect.kind') IN ('tellAnswered', 'ownerWake')
                  BEGIN SELECT RAISE(FAIL, 'injected restored notification failure'); END
                `);
                  } else if (failure === "slot write") {
                    armed = false;
                    injected++;
                    // The trigger rolls back with the failed transaction; normal retry can succeed.
                    yield* sql.unsafe(`
                  CREATE TEMP TRIGGER restored_slot_failure
                  BEFORE INSERT ON ardud_kanban_slot_events
                  WHEN NEW.why = 'restore' AND NEW.kind = 'take'
                  BEGIN SELECT RAISE(FAIL, 'injected restored slot failure'); END
                `);
                  }
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new KanbanStore.KanbanStoreError({
                    operation: "inject restored card failure",
                    cause,
                  }),
              ),
            ),
          addSlotEvent: (row) =>
            Effect.gen(function* () {
              if (row.why === "restore" && row.kind === "take") restoreAttempts++;
              yield* real.addSlotEvent(row);
              if (
                !armed ||
                failure !== "reply write" ||
                row.why !== "restore" ||
                row.kind !== "take"
              )
                return;
              armed = false;
              injected++;
              yield* sql.unsafe(`
              CREATE TEMP TRIGGER restored_reply_failure
              BEFORE UPDATE OF json ON ardud_kanban_owner_routes
              WHEN json_extract(NEW.json, '$.restoredReply') IS NOT NULL
              BEGIN SELECT RAISE(FAIL, 'injected restored reply failure'); END
            `);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new KanbanStore.KanbanStoreError({
                    operation: "inject restored slot failure",
                    cause,
                  }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(KanbanStore.layer));
    yield* Effect.gen(function* () {
      const { kanban, board, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        {
          question: "Continue?",
          blocking: true,
          ...(reply === "pick" ? { options: ["Owner rollback 1615", "No"] } : {}),
        },
        worker,
        "cardThread",
      );
      yield* kanban.tick;
      const store = yield* KanbanStore.KanbanStore;
      assert.equal(
        (yield* store.openSlots(board.id)).filter((row) => row.threadId === threadId).length,
        0,
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      armed = true;
      const ask = askOf((yield* kanban.card(card.id)).card);
      const close =
        reply === "post"
          ? Effect.asVoid(
              kanban.post(discussion.id, owner, [{ _tag: "md", text: "Owner rollback 1615" }]),
            )
          : reply === "pick"
            ? Effect.asVoid(
                kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner),
              )
            : reply === "answer"
              ? Effect.asVoid(
                  kanban.answerAsk(
                    card.id,
                    ask.id,
                    { verdict: "answered", text: "Owner rollback 1615", revision: 0 },
                    owner,
                  ),
                )
              : reply === "drop"
                ? Effect.asVoid(kanban.changeAsk(card.id, ask.id, "drop", owner, "owner"))
                : Effect.asVoid(kanban.cardThread(card.id, "wake", "Owner rollback 1615", owner));
      const first = yield* close.pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      if (reply !== "post" && failure !== "cancellation") {
        assert.equal(first._tag, "Failure");
        assert.equal((yield* kanban.card(card.id)).card.stage, "needs_owner");
        assert.equal(
          (yield* store.openSlots(board.id)).filter((row) => row.threadId === threadId).length,
          0,
        );
        yield* close;
      }
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Retry drain barrier" }]);
      assert.equal(injected, 1);
      const restored = (yield* kanban.card(card.id)).card;
      assert.equal(restored.stage, "working");
      assert.equal(restored.activeThreadId, threadId);
      assert.equal(
        (yield* store.openSlots(board.id)).filter((row) => row.threadId === threadId).length,
        1,
      );
      assert.equal(restoreAttempts, failure === "cancellation" ? 1 : 2);
      yield* kanban.dispatchNow;
      const notification = reply === "drop" ? `Abdullah dropped ${ask.id}.` : "Owner rollback 1615";
      assert.equal(
        (yield* fake.heard(threadId)).filter((text) => text.includes(notification)).length,
        1,
      );
      yield* kanban.cardThread(card.id, "stop", "Release restored slot", owner);
      assert.equal(
        (yield* store.openSlots(board.id)).filter((row) => row.threadId === threadId).length,
        0,
      );
    }).pipe(Effect.provide(fileTestLayer(fake.layer, `${directory}/state.sqlite`, storeLayer)));
  }).pipe(Effect.provide(filesLayer)),
);

it.effect.each(
  (["post", "pick"] as const).flatMap((reply) =>
    (["delivered", "stop", "reset"] as const).map((outcome) => ({ reply, outcome })),
  ),
)("a restored $reply retry retains its guard ($outcome)", ({ reply, outcome }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let attempts = 0;
    const gated = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (real) =>
        KanbanThreads.of({
          ...real,
          send: (input) =>
            Effect.gen(function* () {
              if (!input.text.includes("Owner retry 1615")) return yield* real.send(input);
              attempts += 1;
              if (attempts === 1)
                return yield* new KanbanThreadError({ operation: "send", detail: "Retry once" });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (!input.isStale?.()) yield* real.send(input);
              yield* Deferred.succeed(finished, undefined);
            }),
          interrupt: (...args) =>
            real
              .interrupt(...args)
              .pipe(Effect.tap(() => Deferred.succeed(interrupted, undefined))),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        {
          question: "Continue?",
          blocking: true,
          ...(reply === "pick" ? { options: ["Owner retry 1615", "No"] } : {}),
        },
        worker,
        "cardThread",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      if (reply === "post")
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Owner retry 1615" }]);
      else {
        const ask = askOf((yield* kanban.card(card.id)).card);
        yield* kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner);
      }
      yield* Deferred.await(entered);
      assert.equal((yield* kanban.card(card.id)).card.stage, "working");
      if (outcome !== "delivered")
        yield* kanban.cardThread(card.id, outcome, "Discard retry", owner);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      if (outcome !== "delivered") yield* Deferred.await(interrupted);
      assert.equal(
        (yield* fake.heard(threadId)).filter((text) => text.includes("Owner retry 1615")).length,
        outcome === "delivered" ? 1 : 0,
      );
      assert.equal(attempts, 2);
    }).pipe(
      Effect.provide(
        testLayer(gated).pipe(
          Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
        ),
      ),
    );
  }),
);

it.effect.each(
  (["post", "pick"] as const).flatMap((reply) =>
    (["delivered", "stop", "reset"] as const).map((outcome) => ({ reply, outcome })),
  ),
)("a restored $reply retry retains its guard across restart ($outcome)", ({ reply, outcome }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owner-retry-1615-" });
    const db = `${directory}/state.sqlite`;
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    let attempts = 0;
    const cut = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (real) =>
        KanbanThreads.of({
          ...real,
          send: (input) =>
            Effect.gen(function* () {
              if (!input.text.includes("Owner saved retry 1615")) return yield* real.send(input);
              attempts += 1;
              if (attempts === 1)
                return yield* new KanbanThreadError({ operation: "send", detail: "Retry once" });
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    const prior = yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          {
            question: "Continue?",
            blocking: true,
            ...(reply === "pick" ? { options: ["Owner saved retry 1615", "No"] } : {}),
          },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        if (reply === "post")
          yield* kanban.post(discussion.id, owner, [
            { _tag: "md", text: "Owner saved retry 1615" },
          ]);
        else {
          const ask = askOf((yield* kanban.card(card.id)).card);
          yield* kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner);
        }
        yield* Deferred.await(entered);
        if (outcome !== "delivered")
          yield* kanban.cardThread(card.id, outcome, "Discard saved retry", owner);
        return { threadId, discussionId: discussion.id };
      }).pipe(
        Effect.provide(
          fileTestLayer(cut, db).pipe(
            Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
          ),
        ),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        yield* kanban.post(prior.discussionId, owner, [{ _tag: "md", text: "Replay barrier" }]);
        assert.equal(
          (yield* fake.heard(prior.threadId)).filter((text) =>
            text.includes("Owner saved retry 1615"),
          ).length,
          outcome === "delivered" ? 1 : 0,
        );
      }).pipe(Effect.provide(fileTestLayer(fake.layer, db))),
    );
  }).pipe(Effect.provide(filesLayer)),
);

it.effect.each(
  (["answer", "drop", "wake"] as const).flatMap((close) =>
    (["excluded", "kept", "shared excluded"] as const).map((hold) => ({ close, hold })),
  ),
)("a board pause ($hold) gates restoration on $close", ({ close, hold }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board, card, threadId, worker } = yield* workingCard();
      if (hold === "shared excluded")
        yield* kanban.createForThread(threadId, { title: "Held sibling", prompt: "Held sibling" });
      yield* kanban.askOwner(
        card.id,
        { question: "Paused owner resume 1615", blocking: true },
        worker,
        "cardThread",
      );
      yield* Ref.update(fake.threads, (all) =>
        new Map(all).set(threadId, {
          ...all.get(threadId)!,
          state: "idle",
          latestStatus: "completed",
        }),
      );
      yield* kanban.pauseBoard(
        board.id,
        { reason: "Owner pause", keep: hold === "excluded" ? [] : [card.id] },
        owner,
      );
      const before = (yield* fake.heard(threadId)).length;
      if (close === "answer")
        yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Paused owner resume 1615", revision: 0 },
          owner,
        );
      else if (close === "drop") yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      else yield* kanban.cardThread(card.id, "wake", "Paused owner resume 1615", owner);
      const result = (yield* kanban.card(card.id)).card;
      assert.equal(result.stage, hold === "kept" ? "working" : "todo");
      assert.equal(result.activeThreadId, hold === "kept" ? threadId : null);
      assert.equal((yield* fake.heard(threadId)).length, before + (hold === "kept" ? 1 : 0));
      assert.isNotNull(askOf(result).closedAt);
      yield* kanban.dispatchNow;
      assert.equal((yield* kanban.card(card.id)).card.stage, result.stage);
      assert.equal((yield* fake.heard(threadId)).length, before + (hold === "kept" ? 1 : 0));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(
  (["ask", "change"] as const).flatMap((creation) =>
    (["answer", "drop", "wake"] as const).map((close) => ({ creation, close })),
  ),
)(
  "$creation blocking park restores the same worker on $close without assignment",
  ({ creation, close }) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        const attached = (yield* kanban.card(card.id)).card;
        yield* Ref.update(fake.threads, (all) =>
          new Map(all).set(threadId, {
            ...all.get(threadId)!,
            state: "running",
            runStatus: "running",
            runStartedAt: null,
          }),
        );
        const assignments = (yield* fake.heard(threadId)).length;
        yield* kanban.askOwner(
          card.id,
          { question: "Choose?", blocking: creation === "ask", options: ["Yes", "No"] },
          worker,
          "cardThread",
        );
        if (creation === "change")
          yield* kanban.changeAsk(card.id, "q1", "block", worker, "cardThread");
        const parked = (yield* kanban.card(card.id)).card;
        assert.equal(parked.stage, "needs_owner");
        assert.equal(parked.activeThreadId, null);
        assert.equal(parked.ownerPark?.stage, "working");
        assert.equal(parked.ownerPark?.threadId, threadId);
        if (close === "answer")
          yield* kanban.answerAsk(
            card.id,
            "q1",
            { verdict: "picked", optionIds: ["o1"], revision: 0 },
            owner,
          );
        else if (close === "drop") yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
        else yield* kanban.cardThread(card.id, "wake", "Continue", owner);
        const restored = (yield* kanban.card(card.id)).card;
        assert.equal(restored.stage, "working");
        assert.equal(restored.activeThreadId, threadId);
        assert.equal(restored.activeRole, "work");
        assert.equal(restored.activePool, attached.activePool);
        assert.equal(restored.ownerPark, undefined);
        assert.isNotNull(askOf(restored).closedAt);
        assert.isTrue(Rules.poolThreads([restored]).get(attached.activePool!)?.has(threadId));
        const store = yield* KanbanStore.KanbanStore;
        assert.isTrue(
          (yield* store.openSlots(board.id)).some((slot) => slot.threadId === threadId),
        );
        const heard = yield* fake.heard(threadId);
        assert.equal(heard.length, assignments + 1);
        const heardCount = heard.length;
        yield* kanban.dispatchNow;
        assert.equal((yield* fake.heard(threadId)).length, heardCount);
        const reviewed = yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        assert.equal(reviewed.stage, "needs_review");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([
  "ended",
  "missing",
  "replaced link",
  "model missing",
  "archived",
  "interrupted",
  "cancelled",
  "failed",
  "reset",
  "stop",
] as const)("a %s parked worker is not restored on answer", (invalidation) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        { question: "Choose?", blocking: true },
        worker,
        "cardThread",
      );
      const store = yield* KanbanStore.KanbanStore;
      if (invalidation === "ended") {
        const link = (yield* store.threadLink(threadId))!;
        yield* store.putThreadLink({ ...link, endedAt: link.startedAt });
      } else if (invalidation === "missing")
        yield* Ref.update(fake.threads, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
      else if (invalidation === "replaced link") {
        // A replaced card link is not the recorded attachment even if its id is reused.
        const link = (yield* store.threadLink(threadId))!;
        yield* store.putThreadLink({ ...link, startedAt: "2030-01-01T00:00:00.000Z" });
      } else if (invalidation === "model missing") {
        yield* Ref.update(fake.threads, (all) =>
          new Map(all).set(threadId, { ...all.get(threadId)!, modelMissing: true }),
        );
      } else if (
        invalidation === "archived" ||
        invalidation === "interrupted" ||
        invalidation === "cancelled" ||
        invalidation === "failed"
      ) {
        yield* Ref.update(fake.threads, (all) =>
          new Map(all).set(threadId, {
            ...all.get(threadId)!,
            archived: invalidation === "archived",
            ...(invalidation === "archived" ? {} : { runStatus: invalidation }),
          }),
        );
      } else yield* kanban.cardThread(card.id, invalidation, "Stop parked work", owner);
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "Yes", revision: 0 },
        owner,
      );
      assert.equal(result.card.stage, "todo");
      assert.equal(result.card.activeThreadId, null);
      assert.equal(result.card.ownerPark, undefined);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an unattached worker's To Do blocking ask stays To Do (#1414)", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* workingCard();
      yield* kanban.moveCard(card.id, "todo", "owner", owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Choose?", blocking: true },
        worker,
        "cardThread",
      );
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "Yes", revision: 0 },
        owner,
      );
      assert.equal(result.card.stage, "todo");
      assert.equal(result.card.activeThreadId, null);
      const denied = yield* kanban
        .moveCard(card.id, "working", "cardThread", worker)
        .pipe(Effect.flip);
      assert.include(denied.detail, "card_claim");
      const claimed = yield* kanban.claimCard(
        ThreadId.make(worker._tag === "thread" ? worker.threadId : ""),
        card.id,
      );
      assert.equal(claimed.card.stage, "working");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "Needs Review returns to Needs Review and only the last blocking answer restores work",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "First?", blocking: true },
          worker,
          "cardThread",
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Second?", blocking: true },
          worker,
          "cardThread",
        );
        yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
        assert.equal((yield* kanban.card(card.id)).card.stage, "needs_owner");
        yield* kanban.changeAsk(card.id, "q2", "drop", owner, "owner");
        assert.equal((yield* kanban.card(card.id)).card.stage, "working");
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.askOwner(card.id, { question: "Review?", blocking: true }, owner, "owner");
        const result = yield* kanban.answerAsk(
          card.id,
          "q3",
          { verdict: "answered", text: "Yes", revision: 0 },
          owner,
        );
        assert.equal(result.card.stage, "needs_review");
        assert.equal(result.card.activeThreadId, null);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "restoring over cap holds the slot and writes a row; skipped live To Do writes its reason once",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const events: AnalyticsEvent[] = [];
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Choose?", blocking: true },
          worker,
          "cardThread",
        );
        yield* kanban.setPool(board.id, board.defaultCardModel, 0);
        const result = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Yes", revision: 0 },
          owner,
        );
        assert.equal(result.card.stage, "working");
        assert.equal(result.card.activeThreadId, threadId);
        const over = events.find((event) => event.kind === "kanban.owner_restore_over_cap");
        assert.deepInclude(over?.props, { slots: 0, used: 1 });
        assert.isTrue(
          (yield* kanban.card(card.id)).events.some((event) =>
            event.body?.includes("over pool cap"),
          ),
        );
        yield* kanban.moveCard(card.id, "todo", "owner", owner);
        yield* kanban.dispatchNow;
        yield* kanban.dispatchNow;
        const skips = events.filter(
          (event) => event.kind === "kanban.dispatch_skipped" && event.cardId === card.id,
        );
        assert.equal(skips.length, 1);
        assert.equal(skips[0]?.props?.reason, "pool_full");
        for (const event of [...skips, over!]) yield* decodeAnalytics(event);
      }).pipe(
        Effect.provide(
          testLayer(fake.layer).pipe(
            Layer.provide(
              Layer.mock(Analytics.Analytics)({
                record: (event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
              }),
            ),
          ),
        ),
      );
    }),
);

it.effect("a full pool admits a parked worker beyond capacity with one slot per thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const events: AnalyticsEvent[] = [];
    yield* Effect.gen(function* () {
      const { kanban, board, card, threadId, worker } = yield* workingCard();
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.askOwner(
        card.id,
        { question: "Choose?", blocking: true },
        worker,
        "cardThread",
      );
      yield* kanban.tick;
      const other = yield* kanban.createCard(
        board.id,
        { title: "Other work", prompt: "Other work" },
        owner,
      );
      yield* kanban.dispatchNow;
      assert.equal((yield* kanban.card(other.id)).card.stage, "working");
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "Yes", revision: 0 },
        owner,
      );
      assert.equal(result.card.activeThreadId, threadId);
      const store = yield* KanbanStore.KanbanStore;
      const slots = yield* store.openSlots(board.id);
      assert.equal(slots.length, 2);
      assert.equal(slots.filter((slot) => slot.threadId === threadId).length, 1);
      assert.equal(slots.find((slot) => slot.threadId === threadId)?.why, "restore");
      assert.deepInclude(
        events.find((event) => event.kind === "kanban.owner_restore_over_cap")?.props,
        { slots: 1, used: 2 },
      );
    }).pipe(
      Effect.provide(
        testLayer(fake.layer).pipe(
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("an owner-made blocking park restores a live worker and delivers the answer", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, threadId } = yield* workingCard();
      yield* kanban.askOwner(card.id, { question: "Choose?", blocking: true }, owner, "owner");
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "Yes", revision: 0 },
        owner,
      );
      assert.equal(result.card.stage, "working");
      assert.equal(result.card.activeThreadId, threadId);
      assert.isTrue((yield* fake.heard(threadId)).some((text) => text.includes("Yes")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reviewer cannot park itself and an owner park still reruns an unfinished review", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker } = yield* workingCard();
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.dispatchNow;
      const reviewing = (yield* kanban.card(card.id)).card;
      assert.equal(reviewing.stage, "in_review");
      const denied = yield* kanban
        .askOwner(
          card.id,
          { question: "Review?", blocking: true },
          { _tag: "thread", threadId: reviewing.activeThreadId! },
          "cardThread",
        )
        .pipe(Effect.flip);
      assert.include(denied.detail, "in_review");
      yield* kanban.askOwner(card.id, { question: "Review?", blocking: true }, owner, "owner");
      const result = yield* kanban.answerAsk(
        card.id,
        "q1",
        { verdict: "answered", text: "Yes", revision: 0 },
        owner,
      );
      assert.equal(result.card.stage, "needs_review");
      assert.equal(result.card.activeThreadId, null);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the running-thread wake guard logs its skip without sending an assignment (#1552)", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const events: AnalyticsEvent[] = [];
    yield* Effect.gen(function* () {
      const { kanban, card, threadId } = yield* workingCard();
      // A legacy park has no saved attachment: retain the old dispatcher path.
      const store = yield* KanbanStore.KanbanStore;
      const attached = (yield* kanban.card(card.id)).card;
      yield* store.putCard({
        ...attached,
        stage: "todo",
        activeThreadId: null,
        activeRole: null,
        activePool: null,
        wakeNote: "Owner answer",
        ownerPark: undefined,
      });
      yield* Ref.update(fake.threads, (all) =>
        new Map(all).set(threadId, {
          ...all.get(threadId)!,
          state: "running",
          runStatus: "running",
          runStartedAt: null,
        }),
      );
      const before = (yield* fake.heard(threadId)).length;
      yield* kanban.dispatchNow;
      yield* kanban.dispatchNow;
      assert.equal((yield* kanban.card(card.id)).card.stage, "todo");
      assert.equal((yield* fake.heard(threadId)).length, before);
      const skips = events.filter(
        (event) => event.kind === "kanban.dispatch_skipped" && event.cardId === card.id,
      );
      assert.equal(skips.length, 1);
      assert.equal(skips[0]?.props?.reason, "thread_running");
    }).pipe(
      Effect.provide(
        testLayer(fake.layer).pipe(
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect.each(["working", "in_review", "needs_review", "todo"] as const)(
  "a wake on an unattached %s card without an owner park keeps the existing return stage",
  (stage) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* workingCard();
        const attached = (yield* kanban.card(card.id)).card;
        const store = yield* KanbanStore.KanbanStore;
        yield* store.putCard({
          ...attached,
          stage,
          activeThreadId: null,
          activeRole: null,
          activePool: null,
        });
        const woken = yield* kanban.cardThread(card.id, "wake", "Continue", owner);
        assert.equal(woken.stage, stage === "needs_review" ? "needs_review" : "todo");
        assert.equal(woken.activeThreadId, null);
        assert.equal(woken.activeRole, null);
        assert.equal(woken.activePool, null);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
  "a terminal %s run with a cleared active run restores only a successful idle worker",
  (status) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Choose?", blocking: true },
          worker,
          "cardThread",
        );
        // Production's shell clears activeRunId/status after termination; the executed run persists.
        yield* Ref.update(fake.threads, (all) =>
          new Map(all).set(threadId, { ...all.get(threadId)!, latestStatus: status }),
        );
        const view = yield* (yield* KanbanThreads).view(threadId);
        assert.isNull(view?.runId);
        assert.isNull(view?.runStatus);
        const result = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Yes", revision: 0 },
          owner,
        );
        assert.equal(result.card.stage, status === "completed" ? "working" : "todo");
        assert.equal(result.card.activeThreadId, status === "completed" ? threadId : null);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "restoring after a sibling model switch keeps the shared model, options and pool on later wakes",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        const sibling = yield* kanban.createForThread(threadId, {
          title: "Sibling",
          prompt: "Sibling",
        });
        yield* kanban.askOwner(
          card.id,
          { question: "Choose?", blocking: true },
          worker,
          "cardThread",
        );
        const switched = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
        yield* kanban.setPool(board.id, switched, 2);
        yield* kanban.editCard(sibling.card.id, { model: switched }, owner);
        const result = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Yes", revision: 0 },
          owner,
        );
        assert.deepEqual(result.card.model, switched);
        assert.equal(result.card.activePool, Rules.poolKey(switched));
        yield* kanban.cardThread(card.id, "wake", "Continue on this model", owner);
        assert.deepEqual((yield* Ref.get(fake.threads)).get(threadId)?.model, switched);
        const slots = yield* (yield* KanbanStore.KanbanStore).openSlots(board.id);
        assert.equal(slots.filter((slot) => slot.threadId === threadId).length, 1);
        assert.equal(
          slots.find((slot) => slot.threadId === threadId)?.poolKey,
          Rules.poolKey(switched),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["answer", "drop", "wake", "post", "pick"] as const)(
  "restored %s serializes with a sibling's unfinished model switch",
  (close) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const switched = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      let gated = true;
      const layer = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            setModel: (threadId, model) =>
              real.setModel(threadId, model).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (!gated) return Effect.void;
                    gated = false;
                    return Deferred.succeed(switched, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    );
                  }),
                ),
              ),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        const sibling = yield* kanban.createForThread(threadId, {
          title: "Sibling",
          prompt: "Sibling",
        });
        yield* kanban.askOwner(
          card.id,
          {
            question: "Continue?",
            blocking: true,
            ...(close === "pick" ? { options: ["Yes", "No"] } : {}),
          },
          worker,
          "cardThread",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        const ask = askOf((yield* kanban.card(card.id)).card);
        const model = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
        yield* kanban.setPool(board.id, model, 2);
        const editing = yield* Effect.forkChild(
          kanban.editCard(sibling.card.id, { model }, owner).pipe(Effect.result),
        );
        yield* Deferred.await(switched);
        assert.deepEqual((yield* Ref.get(fake.threads)).get(threadId)?.model, model);
        assert.deepEqual((yield* kanban.card(sibling.card.id)).card.model, card.model);
        const restoring = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Deferred.succeed(closing, undefined);
            if (close === "answer")
              yield* kanban.answerAsk(
                card.id,
                ask.id,
                { verdict: "answered", text: "Yes", revision: 0 },
                owner,
              );
            else if (close === "drop")
              yield* kanban.changeAsk(card.id, ask.id, "drop", owner, "owner");
            else if (close === "wake") yield* kanban.cardThread(card.id, "wake", "Continue", owner);
            else if (close === "post")
              yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Yes" }]);
            else
              yield* kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner);
          }),
        );
        yield* Deferred.await(closing);
        yield* Effect.yieldNow;
        assert.isUndefined(restoring.pollUnsafe());
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(editing);
        yield* Fiber.join(restoring);
        const restored = (yield* kanban.card(card.id)).card;
        const carried = (yield* kanban.card(sibling.card.id)).card;
        const current = (yield* Ref.get(fake.threads)).get(threadId)?.model;
        assert.equal(restored.stage, "working");
        assert.equal(restored.activeThreadId, threadId);
        assert.deepEqual(restored.model, current);
        assert.deepEqual(carried.model, current);
        assert.equal(restored.activePool, carried.activePool);
        assert.equal(restored.activePool, Rules.poolKey(restored.model));
        for (const target of [card.id, sibling.card.id]) {
          yield* kanban.cardThread(target, "wake", "Continue with the shared model", owner);
          assert.deepEqual((yield* Ref.get(fake.threads)).get(threadId)?.model, current);
        }
        const slots = yield* (yield* KanbanStore.KanbanStore).openSlots(board.id);
        assert.equal(slots.filter((slot) => slot.threadId === threadId).length, 1);
        assert.equal(
          slots.find((slot) => slot.threadId === threadId)?.poolKey,
          restored.activePool,
        );
      }).pipe(Effect.provide(testLayer(layer)));
    }),
);

it.effect.each(["answer", "drop", "wake"] as const)(
  "cancelling restored %s releases its model lock for another close and model edit",
  (close) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      let target: ThreadId | null = null;
      const gated = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            latestRun: (...args) =>
              args[0] === target
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : real.latestRun(...args),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, board, card, threadId, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Continue?", blocking: true },
          worker,
          "cardThread",
        );
        const closing =
          close === "answer"
            ? kanban.answerAsk(
                card.id,
                "q1",
                { verdict: "answered", text: "Yes", revision: 0 },
                owner,
              )
            : close === "drop"
              ? kanban.changeAsk(card.id, "q1", "drop", owner, "owner")
              : kanban.cardThread(card.id, "wake", "Continue", owner);
        target = threadId;
        const cancelled = yield* Effect.forkChild(closing);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(cancelled);
        target = null;
        yield* closing;
        const restored = (yield* kanban.card(card.id)).card;
        assert.equal(restored.stage, "working");
        assert.equal(restored.activeThreadId, threadId);
        const model = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
        yield* kanban.setPool(board.id, model, 2);
        yield* kanban.editCard(card.id, { model }, owner);
        yield* kanban.cardThread(card.id, "wake", "Use the updated model", owner);
        assert.deepEqual((yield* Ref.get(fake.threads)).get(threadId)?.model, model);
      }).pipe(Effect.provide(testLayer(gated)));
    }),
);

it.effect.each(
  (["answer", "drop", "wake", "post", "pick"] as const).flatMap((close) =>
    (["excluded", "kept", "shared excluded"] as const).map((hold) => ({ close, hold })),
  ),
)("a pause during restored $close revokes held owner notes ($hold)", ({ close, hold }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const marker = "Pause race 1615";
    const gated = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (real) =>
        KanbanThreads.of({
          ...real,
          send: (input) =>
            Effect.gen(function* () {
              if (!input.text.includes(marker)) return yield* real.send(input);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (!input.isStale?.()) yield* real.send(input);
              yield* Deferred.succeed(finished, undefined);
            }),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board, card, threadId, worker } = yield* workingCard();
      if (hold === "shared excluded")
        yield* kanban.createForThread(threadId, { title: "Held sibling", prompt: "Held sibling" });
      yield* kanban.askOwner(
        card.id,
        {
          question: marker,
          blocking: true,
          ...(close === "pick" ? { options: [marker, "No"] } : {}),
        },
        worker,
        "cardThread",
      );
      yield* Ref.update(fake.threads, (all) =>
        new Map(all).set(threadId, {
          ...all.get(threadId)!,
          state: "idle",
          latestStatus: "completed",
        }),
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      const ask = askOf((yield* kanban.card(card.id)).card);
      if (close === "answer")
        yield* kanban.answerAsk(
          card.id,
          ask.id,
          { verdict: "answered", text: marker, revision: 0 },
          owner,
        );
      else if (close === "drop") yield* kanban.changeAsk(card.id, ask.id, "drop", owner, "owner");
      else if (close === "wake") yield* kanban.cardThread(card.id, "wake", marker, owner);
      else if (close === "post")
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: marker }]);
      else yield* kanban.answer(discussion.id, ask.seq!, ask.id, [ask.options![0]!.id], owner);
      yield* Deferred.await(entered);
      assert.equal((yield* kanban.card(card.id)).card.stage, "working");
      yield* kanban.pauseBoard(
        board.id,
        {
          reason: "Hold work",
          keep: hold === "excluded" ? [] : [card.id],
        },
        owner,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      assert.equal(
        (yield* fake.heard(threadId)).filter((text) => text.includes(marker)).length,
        hold === "kept" ? 1 : 0,
      );
    }).pipe(
      Effect.provide(
        testLayer(gated).pipe(
          Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
        ),
      ),
    );
  }),
);

it.effect.each(
  (["stop", "reset"] as const).flatMap((action) =>
    (["answer", "drop", "wake"] as const).map((close) => ({ action, close })),
  ),
)("$action during restored $close revokes the in-flight owner note", ({ action, close }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const gated = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (real) =>
        KanbanThreads.of({
          ...real,
          send: (input) =>
            input.text.includes("Owner resume revocation 1615")
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.suspend(() => (input.isStale?.() ? Effect.void : real.send(input))),
                  ),
                )
              : real.send(input),
          interrupt: (...args) =>
            real
              .interrupt(...args)
              .pipe(Effect.tap(() => Deferred.succeed(interrupted, undefined))),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, card, threadId, worker } = yield* workingCard();
      yield* kanban.askOwner(
        card.id,
        { question: "Owner resume revocation 1615", blocking: true },
        worker,
        "cardThread",
      );
      if (close === "answer")
        yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Owner resume revocation 1615", revision: 0 },
          owner,
        );
      else if (close === "drop") yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      else yield* kanban.cardThread(card.id, "wake", "Owner resume revocation 1615", owner);
      yield* Deferred.await(entered);
      yield* kanban.cardThread(card.id, action, "Discard this attachment", owner);
      assert.equal((yield* kanban.card(card.id)).card.activeThreadId, null);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(interrupted);
      assert.isFalse(
        (yield* fake.heard(threadId)).some((text) => text.includes("Owner resume revocation 1615")),
      );
    }).pipe(
      Effect.provide(
        testLayer(gated).pipe(
          Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
        ),
      ),
    );
  }),
);

it.effect.each(
  (["stop", "reset"] as const).flatMap((action) =>
    (["answer", "drop", "wake"] as const).map((close) => ({ action, close })),
  ),
)(
  "a saved restored $close is obsolete after $action across service recreation",
  ({ action, close }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owner-wake-1615-" });
      const db = `${directory}/state.sqlite`;
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const cut = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            send: (input) =>
              input.text.includes("Saved owner resume 1615")
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : real.send(input),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      const prior = yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card, threadId, worker } = yield* workingCard();
          yield* kanban.askOwner(
            card.id,
            { question: "Saved owner resume 1615", blocking: true },
            worker,
            "cardThread",
          );
          if (close === "answer")
            yield* kanban.answerAsk(
              card.id,
              "q1",
              { verdict: "answered", text: "Saved owner resume 1615", revision: 0 },
              owner,
            );
          else if (close === "drop") yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
          else yield* kanban.cardThread(card.id, "wake", "Saved owner resume 1615", owner);
          yield* Deferred.await(entered);
          yield* kanban.cardThread(card.id, action, "Discard this attachment", owner);
          const discussionId = (yield* kanban.cardDiscussion(card.id)).id;
          return { cardId: card.id, threadId, discussionId };
        }).pipe(
          Effect.provide(
            fileTestLayer(cut, db).pipe(
              Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
            ),
          ),
        ),
      );
      const observed = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            interrupt: (...args) =>
              real
                .interrupt(...args)
                .pipe(Effect.tap(() => Deferred.succeed(interrupted, undefined))),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.post(prior.discussionId, owner, [{ _tag: "md", text: "Replay barrier" }]);
          yield* Deferred.await(interrupted);
          assert.isFalse(
            (yield* fake.heard(prior.threadId)).some((text) =>
              text.includes("Saved owner resume 1615"),
            ),
          );
        }).pipe(Effect.provide(fileTestLayer(observed, db))),
      );
    }).pipe(Effect.provide(filesLayer)),
);

it.effect.each(["answer", "wake"] as const)(
  "a sibling's queued drop note does not prevent restoration on %s",
  (close) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let dropPrefix: string | null = null;
      const gated = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            send: (input) =>
              Effect.gen(function* () {
                if (dropPrefix !== null && input.text.startsWith(dropPrefix)) {
                  dropPrefix = null;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                yield* real.send(input);
                if (input.text.includes("Owner resume 1615"))
                  yield* Deferred.succeed(delivered, undefined);
              }),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, card, threadId, worker } = yield* workingCard();
        const dropped = yield* kanban.createForThread(threadId, { title: "B", prompt: "B" });
        yield* kanban.createForThread(threadId, { title: "C", prompt: "C" });
        yield* kanban.askOwner(
          card.id,
          { question: "Continue?", blocking: true },
          worker,
          "cardThread",
        );
        dropPrefix = `Card #${dropped.card.number} `;
        yield* kanban.moveCard(dropped.card.id, "todo", "owner", owner);
        yield* Deferred.await(entered);
        if (close === "answer")
          yield* kanban.answerAsk(
            card.id,
            "q1",
            { verdict: "answered", text: "Owner resume 1615", revision: 0 },
            owner,
          );
        else yield* kanban.cardThread(card.id, "wake", "Owner resume 1615", owner);
        const restored = (yield* kanban.card(card.id)).card;
        assert.equal(restored.stage, "working");
        assert.equal(restored.activeThreadId, threadId);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(delivered);
        assert.equal(
          (yield* fake.heard(threadId)).filter((text) => text.includes("Owner resume 1615")).length,
          1,
        );
      }).pipe(
        Effect.provide(
          testLayer(gated).pipe(
            Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
          ),
        ),
      );
    }),
);
