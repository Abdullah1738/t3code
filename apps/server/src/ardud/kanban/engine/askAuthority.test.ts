/** Who may act on an ask: only the owner's own session over HTTP, only the card's board's evaluators for a handed one. */
import { assert, it } from "@effect/vitest";
import { kanbanAskWaitsOn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  askOf,
  makeFake,
  makeHttp,
  makeHttpAs,
  testLayer,
  workingCard,
  type HttpCaller,
} from "./askFlows.testkit.ts";

// The HTTP routes run on the real clock, not the test one.
// @effect-diagnostics-next-line globalDate:off
const realTimeIn = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(Date.now() + ms));

const approval = {
  question: "Deploy the fee change to production?",
  blocking: true,
  kind: "action",
  action: { summary: "Deploy fee change v2 to production" },
} as const;

it.effect(
  "a component's or an unmarked session can't answer, hand over, snooze or reply on an ask as the owner",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card, worker, threadId } = yield* workingCard();
          yield* kanban.askOwner(card.id, approval, worker, "cardThread");
          const heard = (yield* fake.heard(threadId)).length;
          const evaluators = (yield* fake.evaluators).length;
          const before = askOf((yield* kanban.card(card.id)).card);

          const writes: ReadonlyArray<readonly [string, unknown]> = [
            ["/cards/toy:1/asks/q1/answer", { verdict: "approved", revision: 0 }],
            [
              "/asks/answer",
              { verdict: "approved", items: [{ card: "toy:1", askId: "q1", revision: 0 }] },
            ],
            ["/cards/toy:1/asks/q1/hand", {}],
            ["/cards/toy:1/asks/q1/hand", { always: true, text: "You decide these." }],
            ["/cards/toy:1/asks/q1/hand", { action: "take" }],
            ["/cards/toy:1/asks/q1/snooze", { until: realTimeIn(86_400_000) }],
            [
              "/asks/snooze",
              { until: realTimeIn(86_400_000), items: [{ card: "toy:1", askId: "q1" }] },
            ],
            ["/cards/toy:1/asks/q1/reply", { text: "Go ahead." }],
          ];
          const callers: ReadonlyArray<HttpCaller> = [
            { _tag: "component", component: "telegram-bridge" },
            { _tag: "component", component: "crw" },
            { _tag: "unmarked" },
          ];
          for (const caller of callers) {
            const http = yield* makeHttpAs(caller);
            for (const [path, body] of writes) {
              const refused = yield* http.post(path, body);
              assert.strictEqual(refused.status, 403, `${caller._tag} ${path}`);
              assert.strictEqual(refused.body.error.code, "denied");
              assert.include(refused.body.error.message, "Only the owner answers");
              assert.include(refused.body.error.message, "paired by the owner");
              if (caller._tag === "component") {
                assert.include(
                  refused.body.error.message,
                  `the ${caller.component} component's session`,
                );
              }
            }
            // It can still read the list and the ask.
            assert.strictEqual((yield* http.get("/asks")).status, 200);
            assert.strictEqual((yield* http.get("/cards/toy:1/asks/q1")).status, 200);
          }
          // Nothing moved: the ask is as it was, and nobody was told or started.
          const after = (yield* kanban.card(card.id)).card;
          assert.deepStrictEqual(askOf(after), before);
          assert.strictEqual(after.stage, "needs_owner");
          assert.strictEqual(kanbanAskWaitsOn(askOf(after)), "owner");
          assert.strictEqual((yield* fake.heard(threadId)).length, heard);
          assert.strictEqual((yield* fake.evaluators).length, evaluators);

          // The owner's own session does all of it.
          const mine = yield* makeHttp;
          const snoozed = yield* mine.post("/cards/toy:1/asks/q1/snooze", { until: null });
          assert.strictEqual(snoozed.status, 200);
          const answered = yield* mine.post("/cards/toy:1/asks/q1/answer", {
            verdict: "approved",
            revision: 0,
          });
          assert.strictEqual(answered.status, 200);
          assert.strictEqual(answered.body.ask.answer.verdict, "approved");
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);
