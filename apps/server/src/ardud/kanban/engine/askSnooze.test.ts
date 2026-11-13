/** Snoozing an ask: the owner puts it away, and it comes back by time, an edit or a reply. */
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  kanbanAskBackFromSnooze,
  kanbanAskSnoozed,
  kanbanAskTurns,
  kanbanAskWaitsOn,
  kanbanCardNeedsOwner,
  type KanbanActor,
  type KanbanAskFeed,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  askOf,
  makeFake,
  makeHttp,
  owner,
  testLayer,
  toyBoard,
  workingCard,
} from "./askFlows.testkit.ts";

const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-main") };
// The test clock starts at the epoch.
const IN_A_DAY = "1970-01-02T00:00:00.000Z";
const DAY_MS = 86_400_000;
// The HTTP routes run on the real clock, not the test one.
// @effect-diagnostics-next-line globalDate:off
const realTimeIn = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(Date.now() + ms));

it.effect("a snoozed ask stays open and holds its card, leaves his count, and nobody is told", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker, threadId } = yield* workingCard();
        const http = yield* makeHttp;
        yield* kanban.askOwner(
          card.id,
          { question: "Which fee tier?", blocking: true },
          worker,
          "cardThread",
        );
        const heard = (yield* fake.heard(threadId)).length;
        const threads = (yield* fake.evaluators).length;

        const until = realTimeIn(DAY_MS);
        const snoozed = yield* http.post("/cards/toy:1/asks/q1/snooze", { until });
        assert.strictEqual(snoozed.status, 200);
        assert.strictEqual(snoozed.body.ask.snoozedUntil, until);
        assert.strictEqual(snoozed.body.card.stage, "needs_owner");

        const stored = (yield* kanban.card(card.id)).card;
        const ask = askOf(stored);
        // Open, blocking, still his turn; only out of his list and count for now.
        assert.deepStrictEqual(
          [ask.closedAt, ask.blocking, stored.stage, kanbanAskWaitsOn(ask)],
          [null, true, "needs_owner", "owner"],
        );
        assert.isTrue(kanbanAskSnoozed(ask, 0));
        assert.isFalse(kanbanCardNeedsOwner(stored, 0));
        assert.deepStrictEqual(kanbanAskTurns(stored, 0), {
          owner: 0,
          agent: 0,
          evaluator: 0,
          expired: 0,
          snoozed: 1,
          notices: 0,
        });
        const feed = (yield* http.get("/asks")).body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(
          feed.open.map((item) => [item.ask.id, item.waitsOn, item.snoozed, item.backFromSnoozeAt]),
          [["q1", "owner", true, null]],
        );
        // No thread heard anything, and none was started.
        assert.strictEqual((yield* fake.heard(threadId)).length, heard);
        assert.strictEqual((yield* fake.evaluators).length, threads);
        yield* kanban.dispatchNow;
        assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);

        // He can still answer it while it is snoozed; the marks go with the answer.
        const answered = yield* kanban.answerAsk(
          card.id,
          "q1",
          { verdict: "answered", text: "Tier 2." },
          owner,
        );
        assert.isUndefined(askOf(answered.card).snoozedUntil);
        assert.strictEqual(answered.card.stage, "todo");
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("it comes back when its time passes, marked as back until he acts on it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false },
        evaluator,
        "evaluator",
      );
      yield* kanban.snoozeAsk(card.id, "q1", IN_A_DAY, owner);
      const item = () =>
        kanban.askFeed({}).pipe(
          Effect.map((feed) => {
            const entry = feed.open[0]!;
            return [entry.snoozed, entry.backFromSnoozeAt];
          }),
        );
      assert.deepStrictEqual(yield* item(), [true, null]);
      yield* TestClock.adjust(DAY_MS - 1);
      assert.deepStrictEqual(yield* item(), [true, null]);
      yield* TestClock.adjust(1);
      // Nothing was written: the time alone brings it back.
      assert.deepStrictEqual(yield* item(), [false, IN_A_DAY]);
      const stored = (yield* kanban.card(card.id)).card;
      assert.strictEqual(askOf(stored).snoozedUntil, IN_A_DAY);
      assert.isTrue(kanbanCardNeedsOwner(stored, DAY_MS));
      assert.strictEqual(kanbanAskTurns(stored, DAY_MS).owner, 1);

      // Snoozing it again puts it away again; taking the snooze off leaves no mark.
      yield* kanban.snoozeAsk(card.id, "q1", "1970-01-05T00:00:00.000Z", owner);
      assert.deepStrictEqual(yield* item(), [true, null]);
      const cleared = yield* kanban.snoozeAsk(card.id, "q1", null, owner);
      assert.isUndefined(askOf(cleared).snoozedUntil);
      assert.deepStrictEqual(yield* item(), [false, null]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an edit by its asker brings it back at once, with a new revision", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard();
      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false },
        evaluator,
        "evaluator",
      );
      yield* kanban.snoozeAsk(card.id, "q1", IN_A_DAY, owner);
      yield* TestClock.adjust(3_600_000);
      const edited = yield* kanban.editAsk(
        card.id,
        "q1",
        { context: "CI went green an hour ago.", revisionNote: "CI is green now" },
        evaluator,
        "evaluator",
      );
      const ask = askOf(edited);
      assert.strictEqual(ask.revision, 1);
      assert.isUndefined(ask.snoozedUntil);
      assert.strictEqual(ask.backFromSnoozeAt, "1970-01-01T01:00:00.000Z");
      assert.isFalse(kanbanAskSnoozed(ask, 3_600_000));
      assert.strictEqual(kanbanAskBackFromSnooze(ask, 3_600_000), "1970-01-01T01:00:00.000Z");
      assert.isTrue(kanbanCardNeedsOwner(edited, 3_600_000));
      const entry = (yield* kanban.askFeed({})).open[0]!;
      assert.deepStrictEqual(
        [entry.snoozed, entry.backFromSnoozeAt, entry.revision],
        [false, "1970-01-01T01:00:00.000Z", 1],
      );
      // His reply on it is him acting on it: the mark goes.
      yield* kanban.replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "Which CI?" }], "owner");
      const after = askOf((yield* kanban.card(card.id)).card);
      assert.isUndefined(after.backFromSnoozeAt);
      assert.strictEqual(kanbanAskWaitsOn(after), "agent");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a reply by an agent in its discussion brings it back; an edit after the time leaves the time",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        yield* kanban.askOwner(
          card.id,
          { question: "Round or square?", blocking: false },
          worker,
          "cardThread",
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Which blue?", blocking: false },
          worker,
          "cardThread",
        );
        yield* kanban.snoozeAsk(card.id, "q1", IN_A_DAY, owner);
        yield* kanban.snoozeAsk(card.id, "q2", IN_A_DAY, owner);
        yield* TestClock.adjust(60_000);
        const message = yield* kanban.replyOnAsk(
          card.id,
          "q1",
          worker,
          [{ _tag: "md", text: "Round tested better with users." }],
          "cardThread",
        );
        const stored = (yield* kanban.card(card.id)).card;
        assert.isUndefined(askOf(stored, "q1").snoozedUntil);
        assert.strictEqual(askOf(stored, "q1").backFromSnoozeAt, message.createdAt);
        // Only the ask replied on comes back.
        assert.strictEqual(askOf(stored, "q2").snoozedUntil, IN_A_DAY);
        assert.deepStrictEqual(
          [kanbanAskTurns(stored, 60_000).owner, kanbanAskTurns(stored, 60_000).snoozed],
          [1, 1],
        );

        // q2 runs out by time; an edit after that keeps the time it came back.
        yield* TestClock.adjust(DAY_MS);
        const edited = yield* kanban.editAsk(
          card.id,
          "q2",
          { title: "Brand blue" },
          worker,
          "cardThread",
        );
        assert.strictEqual(askOf(edited, "q2").snoozedUntil, IN_A_DAY);
        assert.strictEqual(kanbanAskBackFromSnooze(askOf(edited, "q2"), DAY_MS + 60_000), IN_A_DAY);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("only the owner snoozes, only an ask that is his turn, and only to a later time", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, card, worker } = yield* workingCard();
        const http = yield* makeHttp;
        yield* kanban.askOwner(
          card.id,
          { question: "One?", blocking: false },
          worker,
          "cardThread",
        );
        const byAgent = yield* Effect.flip(kanban.snoozeAsk(card.id, "q1", IN_A_DAY, worker));
        assert.deepStrictEqual(
          [byAgent.code, byAgent.detail],
          ["denied", "only the owner snoozes an ask"],
        );
        const byEvaluator = yield* Effect.flip(
          kanban.snoozeAsk(card.id, "q1", IN_A_DAY, evaluator),
        );
        assert.strictEqual(byEvaluator.code, "denied");

        const url = "/cards/toy:1/asks/q1/snooze";
        const past = yield* http.post(url, { until: "1969-12-31T00:00:00.000Z" });
        assert.deepStrictEqual(
          [past.status, past.body.error.message],
          [400, "until is in the past: snooze to a later time"],
        );
        assert.strictEqual((yield* http.post(url, { until: "soon" })).status, 400);
        assert.include(
          (yield* http.post(url, { until: realTimeIn(400 * DAY_MS) })).body.error.message,
          "more than a year away",
        );
        assert.strictEqual(
          (yield* http.post("/cards/toy:1/asks/q9/snooze", { until: realTimeIn(DAY_MS) })).status,
          404,
        );
        assert.strictEqual((yield* http.post(url, {})).status, 400);

        // Not while it waits on its asker, nor while the evaluator has it.
        yield* kanban.replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "Meaning?" }], "owner");
        assert.include(
          (yield* http.post(url, { until: IN_A_DAY })).body.error.message,
          "waits on its asker",
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Two?", blocking: false },
          worker,
          "cardThread",
        );
        yield* kanban.snoozeAsk(card.id, "q2", IN_A_DAY, owner);
        // Handing a snoozed ask over is acting on it: the snooze goes.
        const handed = yield* kanban.handAsk(card.id, "q2", "hand", owner);
        assert.isUndefined(askOf(handed, "q2").snoozedUntil);
        assert.include(
          (yield* http.post("/cards/toy:1/asks/q2/snooze", { until: IN_A_DAY })).body.error.message,
          "is with the evaluator",
        );
        // A closed ask conflicts.
        yield* kanban.askOwner(
          card.id,
          { question: "Three?", blocking: false },
          worker,
          "cardThread",
        );
        yield* kanban.answerAsk(card.id, "q3", { verdict: "answered", text: "Yes" }, owner);
        assert.strictEqual(
          (yield* http.post("/cards/toy:1/asks/q3/snooze", { until: IN_A_DAY })).status,
          409,
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("several asks are snoozed in one call, and one that can't be doesn't hold the rest", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard();
        const http = yield* makeHttp;
        for (const title of ["A", "B"]) {
          const card = yield* kanban.createCard(board.id, { prompt: title, title }, owner);
          yield* kanban.askOwner(
            card.id,
            { question: `${title}?`, blocking: false },
            evaluator,
            "evaluator",
          );
        }
        const batch = yield* http.post("/asks/snooze", {
          until: realTimeIn(DAY_MS),
          items: [
            { card: "toy:1", askId: "q1" },
            { card: "toy:2", askId: "q7" },
            { card: "toy:2", askId: "q1" },
          ],
        });
        assert.strictEqual(batch.status, 200);
        assert.strictEqual(batch.body.snoozed, 2);
        assert.deepStrictEqual(
          batch.body.results.map((result: Record<string, any>) => [
            result.card,
            result.ok,
            result.error?.code,
          ]),
          [
            ["toy:1", true, undefined],
            ["toy:2", false, "not-found"],
            ["toy:2", true, undefined],
          ],
        );
        const feed = (yield* http.get("/asks")).body as unknown as KanbanAskFeed;
        assert.deepStrictEqual(
          feed.open.map((item) => item.snoozed),
          [true, true],
        );
        const back = yield* http.post("/asks/snooze", {
          until: null,
          items: [{ card: "toy:1", askId: "q1" }],
        });
        assert.strictEqual(back.body.snoozed, 1);
        assert.strictEqual(
          (yield* http.post("/asks/snooze", { until: null, items: [] })).status,
          400,
        );
      }),
    ).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
