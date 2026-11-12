/** The Needs-you feed stays cheap on a big board: it never decodes the cards that hold no matching ask. */
import { assert, it } from "@effect/vitest";
import { needsYouFromFeed, needsYouItems } from "@t3tools/client-runtime/ardud/kanban/needsYou";
import { kanbanSchedule, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { readAskFeed } from "./askFeed.ts";

const AT = "2026-11-10T10:00:00.000Z";
const CARDS = 3_700;
const OPEN_EVERY = 100;

const cardJson = (number: number, boardId: string) => {
  const id = `card-${boardId}-${number}`;
  const open = number % OPEN_EVERY === 0;
  const closed = number % 3 === 0;
  return JSON.stringify({
    id,
    boardId,
    number,
    title: `Card ${number}`,
    description: "d".repeat(500),
    // A prompt that mentions the marker in prose must not count as an ask.
    prompt: `${"p".repeat(8_000)} "closedAt":null`,
    subtasks: [],
    subtaskSeq: 0,
    // The card after an asking card is unfinished and waits on it; other odd cards are done.
    stage: open
      ? "needs_owner"
      : number % 2 === 0 || number % OPEN_EVERY === 1
        ? "todo"
        : "verified",
    priority: 3,
    goalId: null,
    projects: [],
    model: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
    models: [],
    projectId: null,
    links: [],
    blockedBy: number % OPEN_EVERY === 1 && number > 1 ? [`card-${boardId}-${number - 1}`] : [],
    stalled: null,
    question: null,
    asks: [
      ...(closed
        ? [
            {
              id: "q1",
              text: "Old?",
              blocking: false,
              by: { _tag: "owner" },
              at: "2026-11-01T10:00:00.000Z",
              seq: null,
              closedAt: number % 30 === 0 ? "2026-11-10T09:30:00.000Z" : "2026-11-02T10:00:00.000Z",
            },
          ]
        : []),
      ...(open
        ? [
            {
              id: closed ? "q2" : "q1",
              text: "Go?",
              blocking: true,
              by: { _tag: "owner" },
              at: AT,
              seq: null,
              closedAt: null,
              kind: "action",
              action: { summary: "Deploy" },
              batchKey: "deploy-go",
            },
          ]
        : []),
    ],
    reviewChain: null,
    reviewStep: 0,
    reviewRound: 0,
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    workThreadId: null,
    reviewThreadId: null,
    discussionId: null,
    wakeNote: null,
    nudgedAt: null,
    settledAt: null,
    createdBy: { _tag: "owner" },
    createdAt: AT,
    updatedAt: AT,
    movedAt: AT,
  });
};

it.effect("reads the open asks of a 3,700-card board without decoding the board", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* KanbanStore.KanbanStore;
    for (const boardId of ["board-big", "board-other"]) {
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, ${boardId.slice(6)}, ${`{"name":"${boardId}"}`})`;
    }
    yield* sql.withTransaction(
      Effect.forEach(
        Array.from({ length: CARDS }, (_, index) => index + 1),
        (number) => {
          const json = cardJson(number, "board-big");
          const stage = (JSON.parse(json) as { stage: string }).stage;
          return sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
            VALUES (${`card-board-big-${number}`}, 'board-big', ${number}, ${stage}, NULL, ${json})`;
        },
        { discard: true },
      ),
    );
    yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
      VALUES ('card-board-other-100', 'board-other', 100, 'needs_owner', NULL, ${cardJson(100, "board-other")})`;

    const timed = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const started = performance.now();
        const value = yield* effect;
        return { value, ms: performance.now() - started };
      });

    const open = yield* timed(readAskFeed(sql, { boardId: "board-big" as never }, AT));
    assert.strictEqual(open.value.open.length, CARDS / OPEN_EVERY);
    assert.deepStrictEqual(open.value.closed, []);
    const first = open.value.open[0]!;
    assert.deepStrictEqual(
      [first.cardRef, first.boardName, first.kind, first.blocks, first.ask.batchKey, first.stage],
      ["big:100", "board-big", "action", 1, "deploy-go", "needs_owner"],
    );
    // Card 3700 has no card after it.
    assert.strictEqual(open.value.open.at(-1)!.blocks, 0);

    const all = yield* timed(readAskFeed(sql, {}, AT));
    assert.strictEqual(all.value.open.length, CARDS / OPEN_EVERY + 1);
    assert.strictEqual(all.value.open.at(-1)!.cardRef, "other:100");

    const history = yield* timed(
      readAskFeed(
        sql,
        { boardId: "board-big" as never, closedSince: "2026-11-10T09:00:00.000Z" },
        AT,
      ),
    );
    assert.strictEqual(history.value.open.length, CARDS / OPEN_EVERY);
    assert.strictEqual(history.value.closed.length, Math.floor(CARDS / 30));
    assert.isTrue(history.value.closed.every((item) => item.waitsOn === null));

    // Measured at about 35 ms open and 75 ms with the closed window (in-memory SQLite, M-series
    // Mac), the same with the whole-chain count as with the direct one it replaced (21-run
    // medians on a busy machine: 67 to 81 ms against 75 ms). The bounds are generous: they
    // catch a read that goes back to decoding the board.
    assert.isBelow(open.ms, 1_000);
    assert.isBelow(history.ms, 2_000);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "what a card unblocks is the whole chain, and the feed, the selector and the scheduler agree",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* KanbanStore.KanbanStore;
      const boardId = "board-chain";
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, 'chain', '{"name":"Chain"}')`;
      const id = (number: number) => `card-${boardId}-${number}`;
      const ask = {
        id: "q1",
        text: "Go?",
        blocking: true,
        by: { _tag: "owner" },
        at: AT,
        seq: null,
        closedAt: null,
      };
      // Card 7 of the generator has no asks and waits on nothing.
      const plain = JSON.parse(cardJson(7, boardId)) as Record<string, unknown>;
      const made = (number: number, patch: Record<string, unknown>) => ({
        ...plain,
        id: id(number),
        number,
        title: `Card ${number}`,
        prompt: "p",
        stage: "todo",
        ...patch,
      });
      const WAITERS = 400;
      const cards = [
        // A holds an ask; B waits on A; 400 cards wait on B.
        made(1, { stage: "needs_owner", asks: [ask] }),
        made(2, { blockedBy: [id(1)] }),
        ...Array.from({ length: WAITERS }, (_, index) => made(index + 3, { blockedBy: [id(2)] })),
        // Not counted: a backlog card nobody is going to do, and a finished one.
        made(403, { priority: 5, blockedBy: [id(1)] }),
        made(404, { stage: "verified", blockedBy: [id(1)] }),
        // Another asker that nothing waits on.
        made(405, { stage: "needs_owner", asks: [ask] }),
      ];
      yield* sql.withTransaction(
        Effect.forEach(
          cards,
          (card) =>
            sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
              VALUES (${card.id}, ${boardId}, ${card.number}, ${card.stage as string}, NULL, ${JSON.stringify(card)})`,
          { discard: true },
        ),
      );

      const started = performance.now();
      const feed = yield* readAskFeed(sql, { boardId: boardId as never }, AT);
      const ms = performance.now() - started;
      assert.deepStrictEqual(
        feed.open.map((item) => [item.cardRef, item.blocks]),
        [
          ["chain:1", WAITERS + 1],
          ["chain:405", 0],
        ],
      );

      const typed = cards as unknown as ReadonlyArray<KanbanCard>;
      const now = Date.parse(AT);
      const selector = needsYouItems(
        { cards: new Map(typed.map((card) => [card.id, card])) } as never,
        now,
      );
      const fromFeed = needsYouFromFeed(feed.open, now);
      const schedule = kanbanSchedule(typed, { nowMs: now });
      for (const list of [selector, fromFeed]) {
        assert.deepStrictEqual(
          list.items.map((item) => [item.cardNumber, item.unblocks]),
          [
            [1, WAITERS + 1],
            [405, 0],
          ],
        );
      }
      assert.strictEqual(schedule.get(id(1))?.holds, WAITERS + 1);
      assert.strictEqual(schedule.get(id(405))?.holds, 0);
      assert.isBelow(ms, 1_000);
    }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
