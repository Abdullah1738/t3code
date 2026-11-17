import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../../analytics/Analytics.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  makeHttpAs,
  owner,
  testLayer,
  toyBoard,
  workingCard,
} from "./askFlows.testkit.ts";

it.effect(
  "persists first-seen once per ask per surface and answers once across routes without text",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const events: AnalyticsEvent[] = [];
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* workingCard("private title");
        const asked = yield* kanban.askOwner(
          card.id,
          { question: "private question", blocking: false, options: ["private option"] },
          owner,
          "owner",
        );
        assert.equal(askOf(asked).timing?.openAsksAtCreation, 0);
        const other = yield* kanban.createCard(
          card.boardId,
          { title: "private other", prompt: "" },
          owner,
        );
        const second = yield* kanban.askOwner(
          other.id,
          { question: "private other question", blocking: false },
          owner,
          "owner",
        );
        assert.equal(askOf(second).timing?.openAsksAtCreation, 1);
        const http = yield* makeHttp;
        const path = `/cards/${card.id}/asks/q1`;
        assert.equal((yield* http.post(`${path}/notified`, { channel: "telegram" })).status, 200);
        yield* TestClock.adjust("1 minute");
        assert.equal((yield* http.post(`${path}/seen`, { surface: "web" })).status, 200);
        const first = askOf((yield* kanban.card(card.id)).card).timing?.firstSeen?.web;
        yield* TestClock.adjust("1 minute");
        yield* http.post(`${path}/seen`, { surface: "web" });
        yield* http.post(`${path}/seen`, { surface: "mobile" });
        const seen = askOf((yield* kanban.card(card.id)).card);
        assert.equal(seen.timing?.firstSeen?.web, first);
        assert.isDefined(seen.timing?.firstSeen?.mobile);
        assert.equal(events.filter((event) => event.kind === "ask.seen").length, 2);
        const response = yield* http.post(`${path}/answer`, {
          verdict: "picked",
          optionIds: ["o1"],
          revision: 0,
        });
        assert.equal(response.status, 200);
        yield* http.post(`${path}/answer`, { verdict: "picked", optionIds: ["o1"], revision: 0 });
        yield* http.post(`${path}/seen`, { surface: "desktop" });
        const answered = events.filter((event) => event.kind === "ask.answered");
        assert.equal(answered.length, 1);
        assert.equal(answered[0]?.props?.answeredVia, "single");
        assert.equal(events.filter((event) => event.kind === "ask.seen").length, 2);
        assert.isFalse(
          JSON.stringify(events.filter((event) => event.kind.startsWith("ask."))).includes(
            "private",
          ),
        );
        const component = yield* makeHttpAs({ _tag: "component", component: "telegram-bridge" });
        assert.equal(
          (yield* component.post(`/cards/${other.id}/asks/q1/seen`, { surface: "web" })).status,
          403,
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

it.effect("records batch and free-text answers through the shared server path", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card } = yield* workingCard();
      yield* kanban.askOwner(card.id, { question: "first", blocking: false }, owner, "owner");
      const http = yield* makeHttp;
      const answered = yield* http.post(`/cards/${card.id}/asks/q1/answer`, {
        verdict: "answered",
        text: "words",
        revision: 0,
      });
      assert.equal(answered.status, 200);
      assert.equal(askOf((yield* kanban.card(card.id)).card).timing?.answeredVia, "free_text");
      yield* kanban.askOwner(
        card.id,
        { question: "second", blocking: false, options: ["Yes", "No"] },
        owner,
        "owner",
      );
      const batch = yield* http.post("/asks/answer", {
        verdict: "picked",
        optionIds: ["o1"],
        items: [{ card: card.id, askId: "q2", revision: 0 }],
      });
      assert.equal(batch.status, 200);
      assert.equal(askOf((yield* kanban.card(card.id)).card, "q2").timing?.answeredVia, "batch");
      yield* kanban.askOwner(card.id, { question: "third", blocking: false }, owner, "owner");
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "a free-text answer" }]);
      assert.equal(
        askOf((yield* kanban.card(card.id)).card, "q3").timing?.answeredVia,
        "free_text",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["pick", "batch", "free_text", "drop_owner", "drop_worker"] as const)(
  "preserves move actors while adding ask timing metadata: %s",
  (route) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const events: AnalyticsEvent[] = [];
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          {
            question: "Continue?",
            blocking: true,
            ...(route === "free_text" ? {} : { options: ["Yes", "No"] }),
          },
          worker,
          "cardThread",
        );
        const entry = events.find(
          (event) =>
            event.kind === "kanban.card_move" &&
            event.cardId === card.id &&
            event.props?.to === "needs_owner",
        );
        assert.equal(entry?.props?.actor, "thread");
        if (route === "drop_owner" || route === "drop_worker")
          yield* kanban.changeAsk(
            card.id,
            "q1",
            "drop",
            route === "drop_worker" ? worker : owner,
            route === "drop_worker" ? "cardThread" : "owner",
          );
        else {
          const http = yield* makeHttp;
          const response = yield* route === "batch"
            ? http.post("/asks/answer", {
                verdict: "picked",
                optionIds: ["o1"],
                items: [{ card: card.id, askId: "q1", revision: 0 }],
              })
            : http.post(`/cards/${card.id}/asks/q1/answer`, {
                ...(route === "free_text"
                  ? { verdict: "answered", text: "Continue" }
                  : { verdict: "picked", optionIds: ["o1"] }),
                revision: 0,
              });
          assert.equal(response.status, 200);
        }
        const exit = events.find(
          (event) =>
            event.kind === "kanban.card_move" &&
            event.cardId === card.id &&
            event.props?.from === "needs_owner",
        );
        assert.equal(exit?.props?.actor, route === "drop_worker" ? "thread" : "owner");
        assert.equal((yield* kanban.card(card.id)).card.stage, "todo");
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

it.effect(
  "counts owner decisions and notices separately across boards from the same snapshot",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const events: AnalyticsEvent[] = [];
      yield* Effect.gen(function* () {
        const { kanban, card } = yield* workingCard();
        yield* kanban.askOwner(card.id, { question: "Decision", blocking: false }, owner, "owner");
        const { board: otherBoard } = yield* toyBoard("other");
        for (let index = 0; index < 2; index++) {
          const other = yield* kanban.createCard(
            otherBoard.id,
            { title: `Notice ${index}`, prompt: "" },
            owner,
          );
          yield* kanban.askOwner(
            other.id,
            { question: "Notice", kind: "notice", respond: { ack: true }, blocking: false },
            owner,
            "owner",
          );
        }
        const asked = yield* kanban.askOwner(
          card.id,
          { question: "Next decision", blocking: false },
          owner,
          "owner",
        );
        assert.deepStrictEqual(askOf(asked, "q2").timing, {
          kind: "input",
          openAsksAtCreation: 1,
          openNoticesAtCreation: 2,
        });
        const row = events.findLast(
          (event) => event.kind === "kanban.ask_opened" && event.cardId === card.id,
        );
        assert.equal(row?.props?.openAsksAtCreation, 1);
        assert.equal(row?.props?.openNoticesAtCreation, 2);
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
