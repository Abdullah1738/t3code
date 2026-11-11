/**
 * Who may act as the owner on a card or an ask: only the owner's own session,
 * on every HTTP route and WS RPC through which his words or his pick reach
 * one. A component credential, a hand-issued token and a device paired from a
 * Mac-made link all hold the operate scope, and none of them is him.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import { KANBAN_WS_METHODS as M, kanbanAskWaitsOn, type KanbanError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { NOT_OWNER_DEVICE_MESSAGE } from "../ownerGate.ts";
import { makeKanbanWsHandlers } from "../ws.ts";
import {
  askOf,
  makeFake,
  makeHttp,
  makeHttpAs,
  sessionOf,
  testLayer,
  workingCard,
  type HttpCaller,
} from "./askFlows.testkit.ts";
import type { KanbanScriptsShape } from "./ScriptService.ts";

// The HTTP routes run on the real clock, not the test one.
// @effect-diagnostics-next-line globalDate:off
const realTimeIn = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(Date.now() + ms));

const approval = {
  question: "Deploy the fee change to production?",
  blocking: true,
  kind: "action",
  action: { summary: "Deploy fee change v2 to production" },
} as const;

/** Everyone with the operate scope who is not the owner. */
const NOT_THE_OWNER: ReadonlyArray<HttpCaller> = [
  { _tag: "component", component: "telegram-bridge" },
  { _tag: "component", component: "crw" },
  // `t3 auth session issue`, the old shared control token.
  { _tag: "unmarked" },
  // His own phone, paired from a link made on the Mac.
  { _tag: "paired" },
];

/** What a refusal says to each of them: a paired device is told how to become his. */
const assertRefusal = (
  caller: HttpCaller,
  refusal: { readonly code: string; readonly reason?: string | undefined; readonly text: string },
  where: string,
) => {
  assert.strictEqual(refusal.code, "denied", where);
  if (caller._tag === "paired") {
    assert.strictEqual(refusal.reason, "not_owner_device", where);
    assert.strictEqual(refusal.text, NOT_OWNER_DEVICE_MESSAGE, where);
    return;
  }
  assert.isUndefined(refusal.reason, where);
  assert.include(refusal.text, "Only the owner does this", where);
  if (caller._tag === "component") {
    assert.include(refusal.text, `the ${caller.component} component's session`, where);
  }
};

it.effect(
  "over HTTP, nobody but the owner's own session posts, picks, answers, hands over, snoozes or replies as him",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card, worker, threadId } = yield* workingCard();
          yield* kanban.askOwner(card.id, approval, worker, "cardThread");
          const discussion = yield* kanban.cardDiscussion(card.id);
          const heard = (yield* fake.heard(threadId)).length;
          const evaluators = (yield* fake.evaluators).length;
          const before = askOf((yield* kanban.card(card.id)).card);
          const pick = { seq: before.seq!, blockId: "q1", choice: ["approve"] };

          const writes: ReadonlyArray<readonly [string, unknown]> = [
            // The approval a credential holder could give by reading the ask's message.
            [`/discussions/${discussion.id}/answer`, pick],
            [`/discussions/${discussion.id}/messages`, { text: "Approved, go ahead." }],
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
          for (const caller of NOT_THE_OWNER) {
            const http = yield* makeHttpAs(caller);
            for (const [path, body] of writes) {
              const refused = yield* http.post(path, body);
              assert.strictEqual(refused.status, 403, `${caller._tag} ${path}`);
              assertRefusal(
                caller,
                {
                  code: refused.body.error.code,
                  reason: refused.body.error.reason,
                  text: refused.body.error.message,
                },
                `${caller._tag} ${path}`,
              );
            }
            // It can still read the list, the ask and the discussion.
            assert.strictEqual((yield* http.get("/asks")).status, 200);
            assert.strictEqual((yield* http.get("/cards/toy:1/asks/q1")).status, 200);
            assert.strictEqual(
              (yield* http.get(`/discussions/${discussion.id}/messages`)).status,
              200,
            );
          }
          // Nothing moved: the ask is as it was, nothing was posted, and nobody was told or started.
          const after = (yield* kanban.card(card.id)).card;
          assert.deepStrictEqual(askOf(after), before);
          assert.strictEqual(after.stage, "needs_owner");
          assert.strictEqual(kanbanAskWaitsOn(askOf(after)), "owner");
          assert.strictEqual((yield* kanban.cardDiscussion(card.id)).lastSeq, discussion.lastSeq);
          assert.deepStrictEqual((yield* kanban.message(discussion.id, pick.seq)).answers, []);
          assert.strictEqual((yield* fake.heard(threadId)).length, heard);
          assert.strictEqual((yield* fake.evaluators).length, evaluators);

          // The owner's own session does all of it.
          const mine = yield* makeHttp;
          const snoozed = yield* mine.post("/cards/toy:1/asks/q1/snooze", { until: null });
          assert.strictEqual(snoozed.status, 200);
          const posted = yield* mine.post(`/discussions/${discussion.id}/messages`, {
            text: "Looking at it.",
          });
          assert.strictEqual(posted.status, 200);
          assert.strictEqual(posted.body.author._tag, "owner");
          const picked = yield* mine.post(`/discussions/${discussion.id}/answer`, pick);
          assert.strictEqual(picked.status, 200);
          assert.strictEqual(
            askOf((yield* kanban.card(card.id)).card).answer?.verdict,
            "approved",
          );
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("over the socket, the same writes are refused with the board's typed denial", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker, threadId } = yield* workingCard();
      yield* kanban.askOwner(card.id, approval, worker, "cardThread");
      const discussion = yield* kanban.cardDiscussion(card.id);
      const heard = (yield* fake.heard(threadId)).length;
      const before = askOf((yield* kanban.card(card.id)).card);
      const pick = {
        discussionId: discussion.id,
        seq: before.seq!,
        blockId: "q1",
        choice: ["approve"],
      };
      const words = {
        discussionId: discussion.id,
        blocks: [{ _tag: "md" as const, text: "Approved, go ahead." }],
      };
      const drop = { cardId: card.id, askId: "q1", action: "drop" as const };

      for (const caller of NOT_THE_OWNER) {
        const ws = makeKanbanWsHandlers(kanban, {} as KanbanScriptsShape, sessionOf(caller));
        const refusals: ReadonlyArray<readonly [string, Effect.Effect<void, KanbanError>]> = [
          [M.answer, Effect.asVoid(ws[M.answer](pick))],
          [M.messagePost, Effect.asVoid(ws[M.messagePost](words))],
          [M.cardAsk, Effect.asVoid(ws[M.cardAsk](drop))],
        ];
        for (const [method, call] of refusals) {
          const refused = yield* call.pipe(Effect.flip);
          assert.strictEqual(refused._tag, "KanbanError", `${caller._tag} ${method}`);
          assertRefusal(
            caller,
            { code: refused.code, reason: refused.reason, text: refused.detail },
            `${caller._tag} ${method}`,
          );
        }
        // Reads are as before.
        assert.strictEqual((yield* ws[M.card]({ cardId: card.id })).card.id, card.id);
        assert.isNotEmpty(yield* ws[M.messages]({ discussionId: discussion.id, limit: 5 }));
      }
      const after = (yield* kanban.card(card.id)).card;
      assert.deepStrictEqual(askOf(after), before);
      assert.strictEqual((yield* kanban.cardDiscussion(card.id)).lastSeq, discussion.lastSeq);
      assert.strictEqual((yield* fake.heard(threadId)).length, heard);

      // The owner's app posts as him and his pick is his approval.
      const mine = makeKanbanWsHandlers(
        kanban,
        {} as KanbanScriptsShape,
        sessionOf({ _tag: "owner" }),
      );
      const posted = yield* mine[M.messagePost]({
        discussionId: discussion.id,
        blocks: [{ _tag: "md", text: "Looking at it." }],
      });
      assert.strictEqual(posted.author._tag, "owner");
      yield* mine[M.answer](pick);
      assert.strictEqual(askOf((yield* kanban.card(card.id)).card).answer?.verdict, "approved");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

/**
 * The engine calls through which the owner's words or pick reach a card or an
 * ask: `post` and `answer` end in `routeToOwnerAgent` or `answerChoice`, and
 * `changeAsk` closes an ask through `answerAsks`, as whoever the actor is.
 */
const OWNER_WORD_CALLS =
  /service\s*\.\s*(post|answer|answerAsk|replyOnAsk|handAsk|snoozeAsk|changeAsk)\(/;

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** Each `const name = read|write|ownerWrite(` handler of the HTTP routes, with its body. */
const httpHandlers = () => {
  const text = source("http.ts");
  const starts = [...text.matchAll(/\n {4}const (\w+) = (read|write|ownerWrite)\(/g)];
  const end = text.indexOf("const p = KANBAN_ROUTE_PREFIX");
  return starts.map((match, index) => ({
    name: match[1]!,
    wrapper: match[2]!,
    body: text.slice(match.index, starts[index + 1]?.index ?? end),
  }));
};

/** Each `[M.name]:` handler of the WS group, with its body. */
const wsHandlers = () => {
  const text = source("ws.ts");
  const table = text.slice(text.indexOf("  return {\n    [M."));
  const starts = [...table.matchAll(/\n {4}\[M\.(\w+)\]:/g)];
  return starts.map((match, index) => ({
    name: match[1]!,
    body: table.slice(match.index, starts[index + 1]?.index ?? table.length),
  }));
};

it("every route and RPC that carries the owner's words or pick has the owner check", () => {
  const http = httpHandlers();
  // The scan sees every route: a rename of the helpers must not empty it.
  assert.strictEqual(http.length, source("http.ts").match(/HttpRouter\.route\(/g)?.length);
  const httpOwnerWords = http.filter((handler) => OWNER_WORD_CALLS.test(handler.body));
  assert.deepStrictEqual(
    httpOwnerWords.map((handler) => handler.name),
    [
      "postMessage",
      "answer",
      "answerAsk",
      "answerAsks",
      "replyOnAsk",
      "handAsk",
      "snoozeAsk",
      "snoozeAsks",
    ],
  );
  assert.deepStrictEqual(
    httpOwnerWords.filter((handler) => handler.wrapper !== "ownerWrite").map((h) => h.name),
    [],
  );

  const ws = wsHandlers();
  assert.strictEqual(ws.length, Object.keys(M).length);
  const wsOwnerWords = ws.filter((handler) => OWNER_WORD_CALLS.test(handler.body));
  assert.deepStrictEqual(
    wsOwnerWords.map((handler) => handler.name),
    ["cardAsk", "messagePost", "answer"],
  );
  assert.deepStrictEqual(
    wsOwnerWords.filter((handler) => !handler.body.includes("asOwner(")).map((h) => h.name),
    [],
  );
});
