import { assert, it } from "@effect/vitest";
import { ThreadId, AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Analytics from "../../analytics/Analytics.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { askOf, makeFake, owner, testLayer, workingCard } from "./askFlows.testkit.ts";
import * as Rules from "./rules.ts";

const decodeAnalytics = Schema.decodeUnknownEffect(AnalyticsEvent);

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
        yield* kanban.dispatchNow;
        assert.equal((yield* fake.heard(threadId)).length, heard.length);
        const reviewed = yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        assert.equal(reviewed.stage, "needs_review");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([
  "ended",
  "missing",
  "replaced link",
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
