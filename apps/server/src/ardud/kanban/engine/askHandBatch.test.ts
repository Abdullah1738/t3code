/**
 * Handing several asks to the evaluator in one request: each is handed on its
 * own, and "every time" starts one evaluator for the lot, told his words once.
 */
import { assert, it } from "@effect/vitest";
import { kanbanAskWaitsOn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { NOT_OWNER_DEVICE_MESSAGE } from "../ownerGate.ts";
import {
  FAIL_LAUNCH,
  askOf,
  makeFake,
  makeHttp,
  makeHttpAs,
  owner,
  testLayer,
  workingCard,
} from "./askFlows.testkit.ts";

/** Two working cards on one board, each with an open ask. */
const twoAsks = Effect.gen(function* () {
  const { kanban, board, card, worker, threadId } = yield* workingCard("Bump deps");
  const second = yield* kanban.createCard(board.id, { prompt: "Bump CI", title: "Bump CI" }, owner);
  yield* kanban.dispatchNow;
  const secondThread = (yield* kanban.card(second.id)).card.activeThreadId!;
  yield* kanban.askOwner(
    card.id,
    { question: "Merge the lockfile bump?", blocking: false, title: "Lockfile bump" },
    worker,
    "cardThread",
  );
  yield* kanban.askOwner(
    second.id,
    { question: "Merge the runner image bump?", blocking: true },
    { _tag: "thread", threadId: secondThread },
    "cardThread",
  );
  return { kanban, board, card, second, threadId, secondThread };
});

const ITEMS = [
  { card: "toy:1", askId: "q1" },
  { card: "toy:2", askId: "q1" },
];

it.effect("every time, for several asks: one evaluator hears his words and the list", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, second, threadId, secondThread } = yield* twoAsks;
        const http = yield* makeHttp;
        const words = "Dependency bumps with green CI: just decide them.";
        const hand = yield* http.post("/asks/hand", {
          // The third is not an ask: it is reported, and the other two are handed.
          items: [...ITEMS, { card: "toy:1", askId: "q9" }],
          always: true,
          text: words,
        });
        assert.strictEqual(hand.status, 200);
        assert.strictEqual(hand.body.handed, 2);
        assert.deepStrictEqual(hand.body.results.slice(0, 2), [
          { card: "toy:1", askId: "q1", ok: true },
          { card: "toy:2", askId: "q1", ok: true },
        ]);
        assert.deepStrictEqual(
          [hand.body.results[2].ok, hand.body.results[2].error.code],
          [false, "not-found"],
        );

        // One evaluator for the lot.
        assert.lengthOf(hand.body.evaluators, 1);
        const evaluator = hand.body.evaluators[0];
        assert.deepStrictEqual(
          [evaluator.board, evaluator.started, evaluator.error, evaluator.asks],
          ["toy", true, null, ITEMS],
        );
        const started = evaluator.threadId as string;
        const everyTime = (yield* fake.evaluators).filter((entry) =>
          entry.messages.join("\n").includes("His words:"),
        );
        assert.deepStrictEqual(
          everyTime.map((entry) => entry.threadId),
          [started],
        );
        const told = everyTime[0]!.messages.join("\n");
        assert.include(
          told,
          "The owner handed 2 asks to the evaluator and said to do that every time for asks like them.",
        );
        assert.include(told, `His words:\n${words}`);
        assert.include(
          told,
          [
            `- q1 on card toy:1 ("Bump deps"), kind question, asked by the card's thread (${threadId}).`,
            "  Title: Lockfile bump",
            "  Question: Merge the lockfile bump?",
            `- q1 on card toy:2 ("Bump CI"), kind question, asked by the card's thread (${secondThread}).`,
            "  Question: Merge the runner image bump?",
          ].join("\n"),
        );

        // Each ask is with the evaluator, marked, and names the thread that was told.
        for (const id of [card.id, second.id]) {
          const ask = askOf((yield* kanban.card(id)).card);
          assert.strictEqual(kanbanAskWaitsOn(ask), "evaluator");
          assert.deepStrictEqual([ask.handedAlways, ask.handedThreadId], [true, started]);
        }
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("without every time, the asks are handed and no evaluator is started for the lot", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, second } = yield* twoAsks;
        const http = yield* makeHttp;
        const hand = yield* http.post("/asks/hand", { items: ITEMS });
        assert.strictEqual(hand.status, 200);
        assert.strictEqual(hand.body.handed, 2);
        assert.isUndefined(hand.body.evaluators);
        for (const id of [card.id, second.id]) {
          const ask = askOf((yield* kanban.card(id)).card);
          assert.strictEqual(kanbanAskWaitsOn(ask), "evaluator");
          assert.isUndefined(ask.handedAlways);
        }
        assert.isEmpty(
          (yield* fake.evaluators).filter((entry) =>
            entry.messages.join("\n").includes("every time"),
          ),
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the hand-overs stand when the evaluator can't be started, and a bad request hands nothing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, second } = yield* twoAsks;
        const http = yield* makeHttp;
        const waits = Effect.gen(function* () {
          return [
            kanbanAskWaitsOn(askOf((yield* kanban.card(card.id)).card)),
            kanbanAskWaitsOn(askOf((yield* kanban.card(second.id)).card)),
          ];
        });

        // Refused whole, before anything is handed.
        const empty = yield* http.post("/asks/hand", { items: [] });
        assert.deepStrictEqual([empty.status, empty.body.error.code], [400, "invalid"]);
        const many = yield* http.post("/asks/hand", {
          items: Array.from({ length: 51 }, () => ITEMS[0]),
        });
        assert.deepStrictEqual([many.status, many.body.error.code], [400, "invalid"]);
        const long = yield* http.post("/asks/hand", {
          items: ITEMS,
          always: true,
          text: "x".repeat(10_000),
        });
        assert.deepStrictEqual([long.status, long.body.error.code], [400, "invalid"]);
        const paired = yield* (yield* makeHttpAs({ _tag: "paired" })).post("/asks/hand", {
          items: ITEMS,
        });
        assert.deepStrictEqual(
          [paired.status, paired.body.error.reason, paired.body.error.message],
          [403, "not_owner_device", NOT_OWNER_DEVICE_MESSAGE],
        );
        assert.deepStrictEqual(yield* waits, ["owner", "owner"]);

        const hand = yield* http.post("/asks/hand", {
          items: ITEMS,
          always: true,
          text: `Decide these yourself ${FAIL_LAUNCH}`,
        });
        assert.strictEqual(hand.status, 200);
        assert.strictEqual(hand.body.handed, 2);
        assert.lengthOf(hand.body.evaluators, 1);
        assert.deepStrictEqual(
          [hand.body.evaluators[0].started, hand.body.evaluators[0].threadId],
          [false, null],
        );
        assert.isString(hand.body.evaluators[0].error);
        assert.deepStrictEqual(yield* waits, ["evaluator", "evaluator"]);
        const stored = askOf((yield* kanban.card(card.id)).card);
        assert.strictEqual(stored.handedAlways, true);
        assert.isUndefined(stored.handedThreadId);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
