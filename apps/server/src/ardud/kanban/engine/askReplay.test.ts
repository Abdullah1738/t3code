/**
 * Cutover with an owner reply in flight: the previous build committed his
 * reply and its route row, and stopped before the route ran. This build
 * replays the row on start.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { kanbanAskIsFreeText, type KanbanActor, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as KanbanStore from "../store/KanbanStore.ts";
import { askOf, fileTestLayer, makeFake, owner, toyBoard } from "./askFlows.testkit.ts";
import { ownerMessageText } from "./briefs.ts";
import * as KanbanService from "./KanbanService.ts";

const REPLY = "Tier 2, as before.";
const OLD_KEYS = ["id", "text", "blocking", "by", "at", "seq", "closedAt"];

/** Owner routes run on their own fiber, in real time. */
const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("condition not reached"));
  });

/** The board store, with message reads that never return while `cut.on`: the route drain stops at its first read. */
const cutStore = (cut: { on: boolean }) =>
  Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) =>
      KanbanStore.KanbanStore.of({
        ...real,
        message: (discussionId, seq) =>
          Effect.suspend(() => (cut.on ? Effect.never : real.message(discussionId, seq))),
      }),
    ),
  ).pipe(Layer.provide(KanbanStore.layer));

/** Rewrites the asks and messages into what the previous build stored. */
const asThePreviousBuildStoredIt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', json_extract(ask.value, '$.id'),
        'text', json_extract(ask.value, '$.text'),
        'blocking', json(CASE WHEN json_extract(ask.value, '$.blocking') THEN 'true' ELSE 'false' END),
        'by', json(json_extract(ask.value, '$.by')),
        'at', json_extract(ask.value, '$.at'),
        'seq', json_extract(ask.value, '$.seq'),
        'closedAt', json_extract(ask.value, '$.closedAt')
      ))
      FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
    ), '[]')))
  `;
  yield* sql`UPDATE ardud_kanban_messages SET json = json_remove(json, '$.askId')`;
});

const routes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ json: string; done_at: string | null }>`
    SELECT json, done_at FROM ardud_kanban_owner_routes ORDER BY id`;
});

const deferred = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred" as const)));

/**
 * What the row held when the previous build stopped: nothing yet, or the
 * askers its first attempt had fixed (that build listed every open ask).
 */
for (const [name, askers] of [
  ["before its route ran", null],
  ["after its first attempt had fixed its askers", { ids: ["q1"], needsOwner: true }],
] as const) {
  it.live(
    `an owner reply saved by the previous build ${name} still closes its old ask, once, after the upgrade`,
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ask-replay-" });
        const dbPath = path.join(directory, "state.sqlite");
        const fake = yield* makeFake;
        const cut = { on: false };

        // The previous build: a worker's blocking question, his reply committed with its
        // route row, and the process gone before the route did anything.
        const before = yield* Effect.gen(function* () {
          const { kanban, board } = yield* toyBoard();
          const sql = yield* SqlClient.SqlClient;
          const card = yield* kanban.createCard(board.id, { prompt: "Fees", title: "Fees" }, owner);
          yield* kanban.dispatchNow;
          const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
          const worker: KanbanActor = { _tag: "thread", threadId };
          yield* kanban.askOwner(
            card.id,
            { question: "Which fee tier?", blocking: true },
            worker,
            "cardThread",
          );
          yield* asThePreviousBuildStoredIt;
          const discussion = yield* kanban.cardDiscussion(card.id);
          cut.on = true;
          const posted = yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: REPLY }]);
          assert.strictEqual(posted.author._tag, "owner");
          if (askers !== null) {
            const recorded = JSON.stringify(askers);
            yield* sql`
              UPDATE ardud_kanban_owner_routes SET json = json_set(json, '$.askers', json(${recorded}))`;
          }
          // Saved and not delivered: the ask is as the previous build left it.
          const saved = yield* routes;
          assert.lengthOf(saved, 1);
          assert.isNull(saved[0]!.done_at);
          const payload = JSON.parse(saved[0]!.json) as Record<string, unknown>;
          assert.deepStrictEqual(
            [payload.kind, payload.seq, payload.askers ?? null],
            ["post", posted.seq, askers],
          );
          const rows = yield* sql<{ json: string }>`
            SELECT json FROM ardud_kanban_cards WHERE id = ${card.id}`;
          const stored = JSON.parse(rows[0]!.json) as KanbanCard;
          assert.deepStrictEqual(Object.keys(stored.asks[0]!), OLD_KEYS);
          assert.deepStrictEqual([stored.asks[0]!.closedAt, stored.stage], [null, "needs_owner"]);
          return {
            cardId: card.id,
            threadId,
            discussionId: discussion.id,
            heard: (yield* fake.heard(threadId)).length,
          };
        }).pipe(Effect.provide(deferred(fileTestLayer(fake.layer, dbPath, cutStore(cut)))));

        // This build starts on that database and replays the row.
        cut.on = false;
        const wake = ownerMessageText("#1 Fees", before.discussionId, REPLY);
        const closedAt = yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.ready;
          yield* eventually(routes, (rows) => rows.every((row) => row.done_at !== null));
          const after = (yield* kanban.card(before.cardId)).card;
          const ask = askOf(after);
          assert.isTrue(kanbanAskIsFreeText(ask));
          assert.isNotNull(ask.closedAt);
          assert.deepStrictEqual(
            [ask.answer?.verdict, ask.answer?.by._tag, after.stage],
            ["answered", "owner", "todo"],
          );
          // The wake text it had before the upgrade, with nothing added.
          assert.strictEqual(after.wakeNote, wake);
          yield* kanban.dispatchNow;
          const told = (yield* fake.heard(before.threadId)).slice(before.heard);
          assert.lengthOf(
            told.filter((text) => text.includes(REPLY)),
            1,
          );
          return ask.closedAt;
        }).pipe(Effect.provide(deferred(fileTestLayer(fake.layer, dbPath))));

        // Another start finds nothing left to replay: closed once, told once.
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.ready;
          yield* Effect.sleep("200 millis");
          const detail = yield* kanban.card(before.cardId);
          assert.strictEqual(askOf(detail.card).closedAt, closedAt);
          assert.lengthOf(
            detail.events.filter((event) => event.body === "Owner replied"),
            1,
          );
          assert.lengthOf(yield* routes, 1);
          const told = (yield* fake.heard(before.threadId)).slice(before.heard);
          assert.lengthOf(
            told.filter((text) => text.includes(REPLY)),
            1,
          );
          const evaluators = (yield* fake.evaluators).flatMap((entry) => entry.messages);
          assert.isAtMost(evaluators.filter((text) => text.includes(REPLY)).length, 1);
        }).pipe(Effect.provide(deferred(fileTestLayer(fake.layer, dbPath))));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
