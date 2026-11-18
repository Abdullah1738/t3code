import { assert, it } from "@effect/vitest";
import type { KanbanCard, KanbanDiscussion } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

import * as KanbanStore from "../store/KanbanStore.ts";
import { makeFake, owner, testLayer, workingCard } from "./askFlows.testkit.ts";
import { KanbanThreads } from "./threads.ts";

const inEffectRoute = Effect.gen(function* () {
  let span: Tracer.AnySpan | undefined = Option.getOrUndefined(
    yield* Effect.option(Effect.currentSpan),
  );
  while (span?._tag === "Span") {
    if (span.name === "KanbanService.runEffectRoute") return true;
    span = Option.getOrUndefined(span.parent);
  }
  return false;
});

const answer = Effect.fn("test.effectRouteAnswer")(function* (
  blocked: boolean,
  row: "card" | "discussion",
  readNumber: number,
  editDiscussion: boolean,
) {
  const fake = yield* makeFake;
  const entered = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  let armed = false;
  let reads = 0;
  let lastRouteTitle: string | undefined;
  const sendTitles: Array<string | undefined> = [];
  const checkedThreads = Layer.effect(
    KanbanThreads,
    Effect.map(KanbanThreads, (real) => ({
      ...real,
      send: (input: Parameters<typeof real.send>[0]) =>
        Effect.gen(function* () {
          if (armed && editDiscussion && input.text.includes("Which API?")) {
            sendTitles.push(lastRouteTitle);
          }
          return yield* real.send(input);
        }),
    })),
  ).pipe(Layer.provide(fake.layer));
  const slowStore = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) => ({
      ...real,
      card: (id: KanbanCard["id"]) =>
        Effect.gen(function* () {
          const snapshot = yield* real.card(id);
          if (armed && row === "card" && (yield* inEffectRoute) && ++reads === readNumber) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
          }
          return snapshot;
        }),
      discussion: (id: KanbanDiscussion["id"]) =>
        Effect.gen(function* () {
          const snapshot = yield* real.discussion(id);
          if (armed && (yield* inEffectRoute)) {
            if (row === "discussion" && ++reads === readNumber) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            lastRouteTitle = snapshot?.title;
          }
          return snapshot;
        }),
    })),
  ).pipe(Layer.provide(KanbanStore.layer));
  return yield* Effect.gen(function* () {
    const { kanban, board, card, worker, threadId } = yield* workingCard();
    const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
    const asked = yield* kanban.askOwner(
      card.id,
      { question: "Which API?", blocking: false },
      worker,
      "cardThread",
    );
    const discussion = yield* kanban.cardDiscussion(card.id);
    const edit = editDiscussion
      ? kanban.updateDiscussion(discussion.id, { title: "Current discussion" }, owner)
      : kanban.editCard(other.id, { description: "Concurrent edit" }, owner);
    if (!blocked) yield* edit;
    armed = blocked;
    const dropping = yield* Effect.forkChild(
      kanban.changeAsk(card.id, asked.asks.at(-1)!.id, "drop", owner, "owner"),
    );
    if (blocked) {
      yield* Deferred.await(entered);
      // This commits while the route's reader is latched, without a timer or polling.
      yield* edit;
      assert.isUndefined(dropping.pollUnsafe());
      yield* Deferred.succeed(resume, undefined);
    }
    yield* Fiber.join(dropping);
    // Assert outside route retries: a stale send cannot disappear into a retry.
    if (blocked && editDiscussion) assert.deepEqual(sendTitles, ["Current discussion"]);
    const result = (yield* kanban.card(card.id)).card;
    const current = yield* kanban.discussion(discussion.id);
    return {
      stage: result.stage,
      role: result.activeRole,
      askClosed: result.asks.at(-1)!.closedAt !== null,
      title: current.title,
      messages: (yield* fake.heard(threadId)).filter((text) => text.includes("Which API?")),
      events: (yield* kanban.card(card.id)).events.map(({ kind, fromStage, toStage }) => ({
        kind,
        fromStage,
        toStage,
      })),
      other: (yield* kanban.card(other.id)).card.description,
    };
  }).pipe(Effect.provide(testLayer(checkedThreads, slowStore)));
});

it.effect.each([
  { row: "discussion" as const, readNumber: 2 },
  { row: "discussion" as const, readNumber: 4 },
  { row: "card" as const, readNumber: 2 },
])("tellAnswered releases $row read $readNumber for card_update", ({ row, readNumber }) =>
  Effect.gen(function* () {
    const baseline = yield* answer(false, row, readNumber, false);
    const concurrent = yield* answer(true, row, readNumber, false);
    assert.deepEqual(concurrent, baseline);
    assert.isTrue(concurrent.askClosed);
    assert.lengthOf(concurrent.messages, 1);
  }),
);

it.effect("tellAnswered re-reads a discussion changed while its snapshot was outside", () =>
  Effect.gen(function* () {
    const baseline = yield* answer(false, "discussion", 2, true);
    const concurrent = yield* answer(true, "discussion", 2, true);
    assert.deepEqual(concurrent, baseline);
    assert.equal(concurrent.title, "Current discussion");
  }),
);
