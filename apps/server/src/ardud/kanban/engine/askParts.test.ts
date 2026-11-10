/**
 * Response parts end to end on the board service and its HTTP routes: values
 * and files the owner fills in, notices, asks addressed to the evaluator, and
 * "hand it to the evaluator every time".
 */
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  kanbanAskIsNotice,
  kanbanAskWaitsOn,
  kanbanCardNeedsOwner,
  type KanbanActor,
  type KanbanAskFeed,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import {
  FAIL_LAUNCH,
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  toyBoard,
  workingCard,
  writePending,
} from "./askFlows.testkit.ts";

const evaluatorActor: KanbanActor = {
  _tag: "evaluator",
  threadId: ThreadId.make("evaluator-main"),
};

it.effect(
  "hand it to the evaluator every time: his words reach a new evaluator, nothing is a rule",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { kanban, card, worker, threadId } = yield* workingCard("Bump deps");
          const http = yield* makeHttp;
          yield* kanban.askOwner(
            card.id,
            {
              question: "Merge the lockfile bump?",
              blocking: false,
              title: "Lockfile bump",
              action: { summary: "Merge PR #7" },
            },
            worker,
            "cardThread",
          );
          const words = "Dependency bumps with green CI: just decide them, don't send them to me.";
          const hand = yield* http.post("/cards/toy:1/asks/q1/hand", { always: true, text: words });
          assert.strictEqual(hand.status, 200);
          assert.strictEqual(hand.body.evaluator.started, true);
          const started = hand.body.evaluator.threadId as string;
          assert.isString(hand.body.ask.handedAt);
          assert.strictEqual(hand.body.ask.handedAlways, true);
          assert.strictEqual(hand.body.ask.handedThreadId, started);

          // The card's evaluator has this one ask; the new evaluator has his words and the kind of ask.
          const told = (yield* fake.heard(started)).join("\n");
          assert.include(told, `His words:\n${words}`);
          assert.include(
            told,
            `The ask: q1 on card toy:1 ("Bump deps"), kind action, asked by the card's thread (${threadId}).`,
          );
          assert.include(told, "Title: Lockfile bump\nQuestion: Merge the lockfile bump?");
          assert.include(
            told,
            "He wants asks like this one handled by the evaluator from now on and not sent to him; how to make that happen is your call.",
          );
          const evaluators = yield* fake.evaluators;
          const cardEvaluator = evaluators.find((entry) => entry.threadId !== started)!;
          assert.include(cardEvaluator.messages.join("\n"), "The owner handed you q1 on card #1");

          // Nothing is stored as a rule: the board and the worker's brief are as they were.
          const board = (yield* kanban.boards)[0]!;
          assert.notInclude(JSON.stringify(board), "Dependency bumps");
          assert.notInclude((yield* fake.heard(threadId)).join("\n"), "Dependency bumps");

          // Once the evaluator decides it, History can show how it was handed.
          const decided = yield* kanban.answerAsk(
            card.id,
            "q1",
            { verdict: "approved" },
            { _tag: "evaluator", threadId: cardEvaluator.threadId },
          );
          const answer = askOf(decided.card).answer!;
          assert.deepStrictEqual(
            [answer.verdict, answer.decision, answer.always, answer.evaluatorThreadId],
            ["handed", "approved", true, started],
          );
          assert.isUndefined(askOf(decided.card).handedAlways);
          assert.isUndefined(askOf(decided.card).handedThreadId);

          // Taking one back clears the mark with it.
          yield* kanban.askOwner(
            card.id,
            { question: "And this one?", blocking: false },
            worker,
            "cardThread",
          );
          yield* http.post("/cards/toy:1/asks/q2/hand", { always: true });
          const second = (yield* fake.evaluators).at(-1)!;
          assert.include(second.messages.join("\n"), "He added no words of his own.");
          const taken = yield* http.post("/cards/toy:1/asks/q2/hand", { action: "take_back" });
          assert.isUndefined(taken.body.ask.handedAlways);
          assert.isUndefined(taken.body.ask.handedThreadId);
        }),
      ).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("the hand-over stands when the every-time evaluator can't be started", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
        yield* kanban.askOwner(
          card.id,
          { question: "Ship tonight?", blocking: true },
          evaluatorActor,
          "evaluator",
        );
        const hand = yield* http.post("/cards/toy:1/asks/q1/hand", {
          always: true,
          text: `Decide these yourself ${FAIL_LAUNCH}`,
        });
        assert.strictEqual(hand.status, 200);
        assert.deepStrictEqual(
          [hand.body.evaluator.started, hand.body.evaluator.threadId],
          [false, null],
        );
        assert.isString(hand.body.evaluator.error);
        const stored = askOf((yield* kanban.card(card.id)).card);
        assert.strictEqual(kanbanAskWaitsOn(stored), "evaluator");
        assert.strictEqual(stored.handedAlways, true);
        assert.isUndefined(stored.handedThreadId);
        // Still holding its card, and off the owner's count.
        assert.strictEqual((yield* kanban.card(card.id)).card.stage, "needs_owner");

        assert.strictEqual(
          (yield* http.post("/cards/toy:1/asks/q1/hand", { always: true, text: "x" })).status,
          400,
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an ask addressed to the evaluator starts out with it, and can be given to the owner",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        const asked = yield* kanban.askOwner(
          card.id,
          {
            question: "Rebase or merge?",
            blocking: false,
            options: ["Rebase", "Merge"],
            to: "evaluator",
          },
          worker,
          "cardThread",
        );
        const ask = askOf(asked);
        assert.strictEqual(ask.to, "evaluator");
        assert.strictEqual(kanbanAskWaitsOn(ask), "evaluator");
        assert.isFalse(kanbanCardNeedsOwner(asked, Date.parse("2030-01-01")));
        const evaluator = (yield* fake.evaluators)[0]!;
        const told = evaluator.messages.join("\n");
        assert.include(told, "q1 on card #1 was asked to you, the evaluator, not to the owner");
        assert.include(told, "It takes the verdict picked or answered.");

        // Only a card's thread addresses the evaluator; nobody else is a valid addressee.
        const fromEvaluator = yield* Effect.flip(
          kanban.askOwner(
            card.id,
            { question: "Me?", blocking: false, to: "evaluator" },
            evaluatorActor,
            "evaluator",
          ),
        );
        assert.include(fromEvaluator.detail, "only a card's thread asks the evaluator");
        const other = yield* Effect.flip(
          kanban.askOwner(
            card.id,
            { question: "Who?", blocking: false, to: "moni" },
            worker,
            "cardThread",
          ),
        );
        assert.include(other.detail, 'goes to "owner" (the default) or "evaluator"');

        // The evaluator can't decide: it gives the ask to the owner, whose it then is.
        const returned = yield* kanban.handAsk(card.id, "q1", "return", {
          _tag: "evaluator",
          threadId: evaluator.threadId,
        });
        assert.isUndefined(askOf(returned).to);
        assert.strictEqual(kanbanAskWaitsOn(askOf(returned)), "owner");
        const answered = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "picked", optionIds: ["o1"] },
          owner,
        );
        assert.strictEqual(askOf(answered.card).answer?.verdict, "picked");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an action with a field and a file over HTTP: checked, kept, and told to the asker", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard("Deploy");
        const http = yield* makeHttp;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* kanban.askOwner(
          card.id,
          {
            question: "Deploy build 42?",
            blocking: true,
            title: "Deploy build 42",
            action: { summary: "Deploy build 42", command: "make deploy" },
            respond: {
              verdict: { approve: "Deploy", reject: "Don't deploy" },
              fields: [
                {
                  id: "when",
                  label: "When",
                  type: "select",
                  required: true,
                  options: ["Now", "Tonight"],
                },
                { id: "max", label: "Max error rate", type: "number", unit: "%", min: 0, max: 5 },
                { id: "runbook", label: "Runbook", type: "file", accepts: ["application/pdf"] },
              ],
            },
          },
          worker,
          "cardThread",
        );
        // The response parts travel on the ask to every reader.
        const feed = (yield* http.get("/asks")).body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(
          feed.open[0]!.ask.respond?.fields?.map((field) => [field.id, field.type]),
          [
            ["when", "select"],
            ["max", "number"],
            ["runbook", "file"],
          ],
        );

        const answerUrl = "/cards/toy:1/asks/q1/answer";
        const missing = yield* http.post(answerUrl, { verdict: "approved" });
        assert.strictEqual(missing.status, 400);
        assert.include(missing.body.error.message, 'field "when" (When) is required');
        const range = yield* http.post(answerUrl, {
          verdict: "approved",
          values: { when: "o1", max: 9 },
        });
        assert.strictEqual(range.status, 400);
        assert.include(range.body.error.message, 'field "max" (Max error rate) is above 5 %');
        const option = yield* http.post(answerUrl, { verdict: "approved", values: { when: "o7" } });
        assert.include(option.body.error.message, 'field "when" (When) takes one of o1, o2');
        const verdict = yield* http.post(answerUrl, { verdict: "done", values: { when: "o1" } });
        assert.strictEqual(verdict.status, 400);
        assert.include(
          verdict.body.error.message,
          'takes approved, rejected, answered (got "done")',
        );
        // A file the board can't keep refuses the whole answer and changes nothing.
        const ghost = yield* http.post(answerUrl, {
          verdict: "approved",
          values: {
            when: "o1",
            runbook: [
              {
                type: "file",
                id: "pending-nope.pdf",
                name: "x.pdf",
                mimeType: "application/pdf",
                sizeBytes: 1,
              },
            ],
          },
        });
        assert.strictEqual(ghost.status, 400);
        assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);

        const pending = yield* writePending("runbook.pdf", "application/pdf", "%PDF-1.7 steps");
        const done = yield* http.post(answerUrl, {
          verdict: "approved",
          note: "Watch the dashboards.",
          values: { when: "o2", max: 2.5, runbook: [pending] },
        });
        assert.strictEqual(done.status, 200);
        const answer = done.body.ask.answer;
        assert.deepStrictEqual(
          [answer.verdict, answer.values.when, answer.values.max],
          ["approved", "o2", 2.5],
        );
        const kept = answer.values.runbook[0];
        assert.notStrictEqual(kept.id, pending.id);
        const path = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: kept,
        })!;
        assert.strictEqual(yield* fs.readFileString(path), "%PDF-1.7 steps");
        assert.strictEqual(
          (yield* kanban.card(card.id)).card.wakeNote,
          [
            'The owner APPROVED q1 on card #1: "Deploy build 42". He chose "Deploy".',
            "Owner's note, read this before you act:\nWatch the dashboards.",
            `When: Tonight\nMax error rate: 2.5 %\nRunbook: runbook.pdf (${path})`,
          ].join("\n\n"),
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a task and a notice over HTTP, and a notice never counts or blocks", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker, threadId } = yield* workingCard();
        const http = yield* makeHttp;
        yield* kanban.askOwner(
          card.id,
          {
            question: "Can you test the build on your phone?",
            blocking: false,
            kind: "task",
            respond: { task: { steps: ["Install build 42", "Open Settings"] } },
          },
          worker,
          "cardThread",
        );
        const blockingNotice = yield* Effect.flip(
          kanban.askOwner(
            card.id,
            { question: "Build 42 is live.", blocking: true, kind: "notice" },
            worker,
            "cardThread",
          ),
        );
        assert.include(blockingNotice.detail, "a notice can't block");
        const noticed = yield* kanban.askOwner(
          card.id,
          { question: "Build 42 is live.", blocking: false, kind: "notice" },
          worker,
          "cardThread",
        );
        assert.isTrue(kanbanAskIsNotice(askOf(noticed, "q2")));

        const cant = yield* http.post("/cards/toy:1/asks/q1/answer", {
          verdict: "cant",
          note: "The build won't install.",
        });
        assert.strictEqual(cant.status, 200);
        assert.strictEqual(cant.body.ask.answer.verdict, "cant");
        const heard = (yield* fake.heard(threadId)).join("\n");
        assert.include(heard, "The owner COULD NOT DO q1 on card #1");
        assert.include(heard, "The build won't install.");

        // Only the notice is open now: the card is not the owner's to act on.
        const only = (yield* kanban.card(card.id)).card;
        assert.isFalse(kanbanCardNeedsOwner(only, Date.parse("2030-01-01")));
        const seen = yield* http.post("/cards/toy:1/asks/q2/answer", { verdict: "acknowledged" });
        assert.strictEqual(seen.status, 200);
        assert.strictEqual(seen.body.ask.answer.verdict, "acknowledged");
        assert.include(
          (yield* fake.heard(threadId)).join("\n"),
          "The owner has SEEN q2 on card #1",
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a batch takes only asks that take the same thing back", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
        const asks: ReadonlyArray<Parameters<typeof kanban.askOwner>[1]> = [
          { question: "Deploy A?", blocking: false, action: { summary: "Deploy A" } },
          { question: "Does it pass?", blocking: false, kind: "signoff" },
          { question: "Post it?", blocking: false, draft: { text: "Hello." } },
          {
            question: "Budget?",
            blocking: false,
            respond: { fields: [{ label: "Budget", type: "number", required: true }] },
          },
          { question: "Which?", blocking: false, options: ["A", "B"] },
        ];
        for (const ask of asks) yield* kanban.askOwner(card.id, ask, evaluatorActor, "evaluator");
        const batch = yield* http.post("/asks/answer", {
          verdict: "approved",
          items: ["q1", "q2", "q3", "q4", "q5", "q9"].map((askId) => ({ card: "toy:1", askId })),
        });
        assert.strictEqual(batch.status, 200);
        assert.deepStrictEqual(
          batch.body.results.map((result: Record<string, any>) => [
            result.askId,
            result.ok,
            result.error?.code,
          ]),
          [
            ["q1", true, undefined],
            ["q2", true, undefined],
            ["q3", false, "invalid"],
            ["q4", false, "invalid"],
            ["q5", false, "invalid"],
            ["q9", false, "not-found"],
          ],
        );
        assert.include(batch.body.results[2].error.message, "answer it on its own");
        assert.include(
          batch.body.results[4].error.message,
          "doesn't take the same answer as the first ask in the batch",
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a secret is never taken through an ask, and its value is stored nowhere", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker, threadId } = yield* workingCard();
        const http = yield* makeHttp;
        const sql = yield* SqlClient.SqlClient;
        const refused = yield* Effect.flip(
          kanban.askOwner(
            card.id,
            {
              question: "What is the Stripe key?",
              blocking: false,
              respond: { fields: [{ label: "Stripe key", type: "secret" }] },
            },
            worker,
            "cardThread",
          ),
        );
        assert.include(refused.detail, "request_secret");
        assert.strictEqual((yield* kanban.card(card.id)).card.asks.length, 0);

        // An ask that carries a secret field anyway (as a later build might store one).
        yield* kanban.askOwner(
          card.id,
          { question: "What is the Stripe key?", blocking: false },
          worker,
          "cardThread",
        );
        const respond = JSON.stringify({
          fields: [{ id: "key", label: "Stripe key", type: "secret", required: true }],
        });
        yield* sql`
          UPDATE ardud_kanban_cards
          SET json = json_set(json, '$.asks[0].respond', json(${respond}))
          WHERE id = ${card.id}
        `;
        const value = "sk_live_NEVER_STORE_THIS_4242";
        const answered = yield* http.post("/cards/toy:1/asks/q1/answer", {
          verdict: "answered",
          values: { key: value },
        });
        assert.strictEqual(answered.status, 400);
        assert.include(answered.body.error.message, "request_secret");
        assert.notInclude(JSON.stringify(answered.body), value);

        // Not on the card, in a message, an event, a route, the feed or anything a thread heard.
        const tables = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ardud_kanban_%'
        `;
        assert.isAbove(tables.length, 5);
        for (const table of tables) {
          const rows = yield* sql.unsafe(`SELECT * FROM ${table.name}`);
          assert.notInclude(JSON.stringify(rows), value, table.name);
        }
        assert.notInclude(JSON.stringify(yield* kanban.askFeed({})), value);
        assert.notInclude(JSON.stringify(yield* kanban.card(card.id)), value);
        assert.notInclude((yield* fake.heard(threadId)).join("\n"), value);
        assert.isNull(askOf((yield* kanban.card(card.id)).card).closedAt);
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
