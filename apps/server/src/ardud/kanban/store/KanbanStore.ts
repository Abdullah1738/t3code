import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import {
  KanbanAutomation,
  KanbanBoard,
  KanbanCard,
  KanbanCardEvent,
  KanbanDiscussion,
  KanbanGoal,
  KanbanGroup,
  KanbanMessage,
  KanbanPool,
  KanbanScript,
  KanbanScriptRun,
  KanbanThreadLink,
  KanbanWikiPage,
  type KanbanActor,
  type KanbanBoardId,
  KanbanCardId,
  type KanbanDiscussionId,
  type KanbanScriptId,
  type KanbanStage,
} from "@t3tools/contracts";

import { SummaryCard } from "./summaryCard.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { kanbanDDL } from "../../persistence/kanbanSchema.ts";

export class KanbanStoreError extends Schema.TaggedError<KanbanStoreError>()("KanbanStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Missions board storage failed during ${this.operation}.`;
  }
}

const codec = <S extends Schema.Top>(schema: S) => {
  const json = Schema.fromJsonString(schema);
  return {
    decode: Schema.decodeUnknownEffect(json),
    encode: Schema.encodeEffect(json),
  };
};

const Board = codec(KanbanBoard);
const Card = codec(KanbanCard);
const Summary = codec(SummaryCard);
const CardEvent = codec(
  KanbanCardEvent.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(fields.id) })),
);
const Goal = codec(KanbanGoal);
const Pool = codec(KanbanPool);
const Groups = codec(Schema.Array(KanbanGroup));
const Discussion = codec(KanbanDiscussion);
const Message = codec(KanbanMessage);
const Script = codec(KanbanScript);
const ScriptRun = codec(
  KanbanScriptRun.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(fields.id) })),
);
const Automation = codec(KanbanAutomation);
const Wiki = codec(KanbanWikiPage);
const ThreadLink = codec(KanbanThreadLink);

const decodeTurn = Effect.callback<void>((resume) => {
  const immediate = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(immediate));
});

interface JsonRow {
  readonly json: string;
}
interface IdJsonRow extends JsonRow {
  readonly id: number;
}

export type NewCardEvent = Omit<KanbanCardEvent, "id">;
export type NewScriptRun = Omit<KanbanScriptRun, "id">;

export interface KanbanStoreShape {
  readonly boards: Effect.Effect<ReadonlyArray<KanbanBoard>, KanbanStoreError>;
  readonly putBoard: (board: KanbanBoard) => Effect.Effect<void, KanbanStoreError>;
  /** The board and any new pools in one transaction: all of it commits, or none of it does. */
  readonly putBoardWithPools: (
    board: KanbanBoard,
    pools: ReadonlyArray<KanbanPool>,
  ) => Effect.Effect<void, KanbanStoreError>;

  readonly cards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly feedCards: (
    boardId: KanbanBoardId,
    page?: { readonly after: number; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  /** Only the fields the board list's badges read, for every card on the board, in number order. */
  readonly summaryCards: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<SummaryCard>, KanbanStoreError>;
  readonly card: (cardId: KanbanCardId) => Effect.Effect<KanbanCard | null, KanbanStoreError>;
  readonly cardByNumber: (
    boardId: KanbanBoardId,
    number: number,
  ) => Effect.Effect<KanbanCard | null, KanbanStoreError>;
  /** Cards a thread is running now; one work thread may carry several. */
  readonly cardsByThread: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly cardsInStage: (
    stage: KanbanStage,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanStoreError>;
  readonly nextCardNumber: (boardId: KanbanBoardId) => Effect.Effect<number, KanbanStoreError>;
  readonly putCard: (card: KanbanCard) => Effect.Effect<void, KanbanStoreError>;
  readonly addCardEvent: (event: NewCardEvent) => Effect.Effect<KanbanCardEvent, KanbanStoreError>;
  readonly cardEvents: (
    cardId: KanbanCardId,
  ) => Effect.Effect<ReadonlyArray<KanbanCardEvent>, KanbanStoreError>;

  readonly goals: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGoal>, KanbanStoreError>;
  readonly feedGoals: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGoal>, KanbanStoreError>;
  readonly putGoal: (goal: KanbanGoal) => Effect.Effect<void, KanbanStoreError>;

  readonly pools: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanStoreError>;
  readonly putPool: (
    boardId: KanbanBoardId,
    pool: KanbanPool,
  ) => Effect.Effect<void, KanbanStoreError>;
  readonly removePool: (
    boardId: KanbanBoardId,
    key: string,
  ) => Effect.Effect<void, KanbanStoreError>;
  /**
   * Gives each pool in `pools` (keyed by its old key) a new key and record in place, and
   * writes the cards, in one transaction: a failure leaves the board as it was.
   */
  readonly rekeyBoard: (
    boardId: KanbanBoardId,
    pools: ReadonlyArray<{ readonly from: string; readonly pool: KanbanPool }>,
    cards: ReadonlyArray<KanbanCard>,
  ) => Effect.Effect<void, KanbanStoreError>;
  /**
   * Writes a board migration: the board record, its pools (old keys removed, new ones put),
   * the cards and the open thread links, in one transaction. A failure leaves the board
   * untouched. Unlike rekeyBoard, it also rewrites models, not only keys.
   */
  readonly migrateBoardSelections: (input: {
    readonly board: KanbanBoard;
    readonly pools: ReadonlyArray<KanbanPool>;
    readonly oldPoolKeys: ReadonlyArray<string>;
    readonly cards: ReadonlyArray<KanbanCard>;
    readonly threadLinks: ReadonlyArray<KanbanThreadLink>;
  }) => Effect.Effect<void, KanbanStoreError>;

  readonly groups: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanGroup>, KanbanStoreError>;
  readonly putGroups: (
    boardId: KanbanBoardId,
    groups: ReadonlyArray<KanbanGroup>,
  ) => Effect.Effect<void, KanbanStoreError>;

  readonly discussions: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanDiscussion>, KanbanStoreError>;
  readonly discussion: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<KanbanDiscussion | null, KanbanStoreError>;
  readonly discussionByEvaluator: (
    threadId: string,
  ) => Effect.Effect<KanbanDiscussion | null, KanbanStoreError>;
  readonly putDiscussion: (discussion: KanbanDiscussion) => Effect.Effect<void, KanbanStoreError>;
  /** The newest `limit` (default 200) after `afterSeq` and before `beforeSeq`, oldest first. */
  readonly messages: (
    id: KanbanDiscussionId,
    options?: { readonly afterSeq?: number; readonly beforeSeq?: number; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanStoreError>;
  /**
   * The owner's latest message and whether an evaluator spoke after it, without decoding the
   * history. Null when the owner never wrote.
   */
  readonly ownerWait: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<
    { readonly seq: number; readonly createdAt: string; readonly answered: boolean } | null,
    KanbanStoreError
  >;
  /** Every message of a discussion, oldest first. */
  readonly allMessages: (
    id: KanbanDiscussionId,
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanStoreError>;
  readonly message: (
    id: KanbanDiscussionId,
    seq: number,
  ) => Effect.Effect<KanbanMessage | null, KanbanStoreError>;
  readonly putMessage: (message: KanbanMessage) => Effect.Effect<void, KanbanStoreError>;

  readonly scripts: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanScript>, KanbanStoreError>;
  readonly allScripts: Effect.Effect<ReadonlyArray<KanbanScript>, KanbanStoreError>;
  readonly script: (id: KanbanScriptId) => Effect.Effect<KanbanScript | null, KanbanStoreError>;
  readonly putScript: (script: KanbanScript) => Effect.Effect<void, KanbanStoreError>;
  readonly addScriptRun: (run: NewScriptRun) => Effect.Effect<KanbanScriptRun, KanbanStoreError>;
  readonly putScriptRun: (run: KanbanScriptRun) => Effect.Effect<void, KanbanStoreError>;
  readonly scriptRuns: (
    id: KanbanScriptId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<KanbanScriptRun>, KanbanStoreError>;

  readonly automations: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanAutomation>, KanbanStoreError>;
  readonly putAutomation: (automation: KanbanAutomation) => Effect.Effect<void, KanbanStoreError>;

  readonly wiki: (
    boardId: KanbanBoardId,
  ) => Effect.Effect<ReadonlyArray<KanbanWikiPage>, KanbanStoreError>;
  readonly putWiki: (page: KanbanWikiPage) => Effect.Effect<void, KanbanStoreError>;

  /** Threads the board started; a thread belongs to at most one board. */
  readonly threadLink: (
    threadId: string,
  ) => Effect.Effect<KanbanThreadLink | null, KanbanStoreError>;
  readonly threadLinks: (
    filter:
      | { readonly cardId: KanbanCardId }
      | { readonly boardId: KanbanBoardId; readonly open: boolean },
  ) => Effect.Effect<ReadonlyArray<KanbanThreadLink>, KanbanStoreError>;
  readonly putThreadLink: (link: KanbanThreadLink) => Effect.Effect<void, KanbanStoreError>;
  /** Records that a work thread carries a card (idempotent). */
  readonly addThreadCard: (
    threadId: string,
    cardId: KanbanCardId,
    at: string,
  ) => Effect.Effect<void, KanbanStoreError>;
  /** Cards a work thread has carried, in the order it took them. */
  readonly threadCards: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<KanbanCardId>, KanbanStoreError>;
}

export class KanbanStore extends Context.Service<KanbanStore, KanbanStoreShape>()(
  "t3/ardud/kanban/store/KanbanStore",
) {}

export const actorKey = (actor: KanbanActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "thread":
    case "evaluator":
      return `${actor._tag}:${actor.threadId}`;
    case "script":
      return `script:${actor.scriptId}`;
    case "system":
      return `system:${actor.component}`;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* BoardsDatabase.client;
  const fail = (operation: string) => (cause: unknown) =>
    new KanbanStoreError({ operation, cause });

  yield* BoardsDatabase.initialize(
    Effect.forEach(kanbanDDL, (statement) => sql.unsafe(statement), { discard: true }),
  ).pipe(Effect.mapError(fail("create tables")));

  // Decoding runs after the reader released its slot. Yield every 32 rows so
  // simultaneous board snapshots do not starve timers (M1a 9411874c11).
  const decodeAll = <A, E>(
    rows: ReadonlyArray<JsonRow>,
    decode: (json: string) => Effect.Effect<A, E>,
  ) =>
    Effect.forEach(rows, (row, index) =>
      index > 0 && index % 32 === 0
        ? decodeTurn.pipe(Effect.andThen(decode(row.json)))
        : decode(row.json),
    );

  const first = <A>(items: ReadonlyArray<A>): A | null => items[0] ?? null;

  const run = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(fail(operation)));

  // Reads inside a write transaction stay on the writer for read-your-writes.
  const runRead = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    run(operation, NodeSqliteClient.readOnly(effect));

  const boards = runRead(
    "read boards",
    Effect.flatMap(sql<JsonRow>`SELECT json FROM ardud_kanban_boards ORDER BY rowid`, (rows) =>
      decodeAll(rows, Board.decode),
    ),
  );
  const putBoard = (board: KanbanBoard) =>
    run(
      "write board",
      Effect.gen(function* () {
        const json = yield* Board.encode(board);
        yield* sql`
          INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${board.id}, ${board.slug}, ${json})
          ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
        `;
      }),
    );

  const putBoardWithPools = (board: KanbanBoard, pools: ReadonlyArray<KanbanPool>) =>
    run(
      "write board with pools",
      sql.withTransaction(
        Effect.gen(function* () {
          const json = yield* Board.encode(board);
          yield* sql`
            INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${board.id}, ${board.slug}, ${json})
            ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
          `;
          for (const pool of pools) {
            const poolJson = yield* Pool.encode(pool);
            yield* sql`
              INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${board.id}, ${pool.key}, ${poolJson})
              ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
            `;
          }
        }),
      ),
    );

  const cards = (boardId: KanbanBoardId) =>
    runRead(
      "read cards",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_cards WHERE board_id = ${boardId} ORDER BY number`,
        (rows) => decodeAll(rows, Card.decode),
      ),
    );
  const feedCards: KanbanStoreShape["feedCards"] = (boardId, page) =>
    runRead(
      "read feed cards",
      Effect.flatMap(
        sql<JsonRow>`
          SELECT json_set(json,
            '$.prompt', '', '$.description', '', '$.wakeNote', CASE WHEN json_extract(json, '$.wakeNote') IS NULL THEN NULL ELSE 'pending' END,
            '$.title', substr(json_extract(json, '$.title'), 1, 512),
            '$.question', substr(json_extract(json, '$.question'), 1, 512),
            '$.stalled.reason', substr(json_extract(json, '$.stalled.reason'), 1, 512),
            '$.asks', json(COALESCE((
              SELECT json_group_array(json_set(ask.value, '$.text', substr(json_extract(ask.value, '$.text'), 1, 512)))
              FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
              WHERE json_extract(ask.value, '$.closedAt') IS NULL
            ), '[]')),
            '$.subtasks', json(COALESCE((
              SELECT json_group_array(json_set(task.value,
                '$.text', substr(json_extract(task.value, '$.text'), 1, 128), '$.note', NULL))
              FROM json_each(ardud_kanban_cards.json, '$.subtasks') AS task
            ), '[]'))
          ) AS json
          FROM ardud_kanban_cards
          WHERE board_id = ${boardId} AND number > ${page?.after ?? 0}
          ORDER BY number LIMIT ${page?.limit ?? -1}
        `,
        (rows) => decodeAll(rows, Card.decode),
      ),
    );
  const summaryCards = (boardId: KanbanBoardId) =>
    runRead(
      "read summary cards",
      Effect.flatMap(
        sql<JsonRow>`
          SELECT json_object(
            'id', id,
            'stage', stage,
            'settledAt', json_extract(json, '$.settledAt'),
            'activeThreadId', active_thread_id,
            'asks', json(COALESCE((
              SELECT json_group_array(json_object('closedAt', json_extract(ask.value, '$.closedAt')))
              FROM json_each(ardud_kanban_cards.json, '$.asks') AS ask
            ), '[]'))
          ) AS json
          FROM ardud_kanban_cards
          WHERE board_id = ${boardId}
          ORDER BY number
        `,
        (rows) => decodeAll(rows, Summary.decode),
      ),
    );
  const card = (cardId: KanbanCardId) =>
    runRead(
      "read card",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_cards WHERE id = ${cardId}`,
        (rows) => Effect.map(decodeAll(rows, Card.decode), first),
      ),
    );
  const cardByNumber = (boardId: KanbanBoardId, number: number) =>
    runRead(
      "read card by number",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_cards WHERE board_id = ${boardId} AND number = ${number}`,
        (rows) => Effect.map(decodeAll(rows, Card.decode), first),
      ),
    );
  const cardsByThread = (threadId: string) =>
    runRead(
      "read cards by thread",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_cards WHERE active_thread_id = ${threadId} ORDER BY number`,
        (rows) => decodeAll(rows, Card.decode),
      ),
    );
  const cardsInStage = (stage: KanbanStage) =>
    runRead(
      "read cards in stage",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_cards WHERE stage = ${stage} ORDER BY board_id, number`,
        (rows) => decodeAll(rows, Card.decode),
      ),
    );
  const nextCardNumber = (boardId: KanbanBoardId) =>
    run(
      "next card number",
      Effect.map(
        sql<{ readonly next: number }>`
          SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ardud_kanban_cards WHERE board_id = ${boardId}
        `,
        (rows) => Number(rows[0]?.next ?? 1),
      ),
    );
  const putCard = (value: KanbanCard) =>
    run(
      "write card",
      Effect.gen(function* () {
        const json = yield* Card.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
          VALUES (${value.id}, ${value.boardId}, ${value.number}, ${value.stage}, ${value.activeThreadId}, ${json})
          ON CONFLICT (id) DO UPDATE SET
            stage = excluded.stage,
            active_thread_id = excluded.active_thread_id,
            json = excluded.json
        `;
      }),
    );
  const addCardEvent = (event: NewCardEvent) =>
    run(
      "write card event",
      Effect.gen(function* () {
        const json = yield* CardEvent.encode(event);
        const rows = yield* sql<{ readonly id: number }>`
          INSERT INTO ardud_kanban_card_events (card_id, json) VALUES (${event.cardId}, ${json})
          RETURNING id
        `;
        return { ...event, id: Number(rows[0]?.id ?? 0) } as KanbanCardEvent;
      }),
    );
  const cardEvents = (cardId: KanbanCardId) =>
    runRead(
      "read card events",
      Effect.flatMap(
        sql<IdJsonRow>`SELECT id, json FROM ardud_kanban_card_events WHERE card_id = ${cardId} ORDER BY id`,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              CardEvent.decode(row.json),
              (event) => ({ ...event, id: Number(row.id) }) as KanbanCardEvent,
            ),
          ),
      ),
    );

  const goals = (boardId: KanbanBoardId) =>
    runRead(
      "read goals",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_goals WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Goal.decode),
      ),
    );
  const putGoal = (goal: KanbanGoal) =>
    run(
      "write goal",
      Effect.gen(function* () {
        const json = yield* Goal.encode(goal);
        yield* sql`
          INSERT INTO ardud_kanban_goals (id, board_id, json) VALUES (${goal.id}, ${goal.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const pools = (boardId: KanbanBoardId) =>
    runRead(
      "read pools",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_pools WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Pool.decode),
      ),
    );
  const putPool = (boardId: KanbanBoardId, pool: KanbanPool) =>
    run(
      "write pool",
      Effect.gen(function* () {
        const json = yield* Pool.encode(pool);
        yield* sql`
          INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${boardId}, ${pool.key}, ${json})
          ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
        `;
      }),
    );
  const rekeyBoard = (
    boardId: KanbanBoardId,
    pools: ReadonlyArray<{ readonly from: string; readonly pool: KanbanPool }>,
    cards: ReadonlyArray<KanbanCard>,
  ) =>
    run(
      "rekey board",
      sql.withTransaction(
        Effect.gen(function* () {
          for (const { from, pool } of pools) {
            const json = yield* Pool.encode(pool);
            yield* sql`
              UPDATE ardud_kanban_pools SET key = ${pool.key}, json = ${json}
              WHERE board_id = ${boardId} AND key = ${from}
            `;
          }
          for (const card of cards) {
            const json = yield* Card.encode(card);
            yield* sql`UPDATE ardud_kanban_cards SET json = ${json} WHERE id = ${card.id}`;
          }
        }),
      ),
    );
  const migrateBoardSelections = (input: {
    readonly board: KanbanBoard;
    readonly pools: ReadonlyArray<KanbanPool>;
    readonly oldPoolKeys: ReadonlyArray<string>;
    readonly cards: ReadonlyArray<KanbanCard>;
    readonly threadLinks: ReadonlyArray<KanbanThreadLink>;
  }) =>
    run(
      "migrate board selections",
      sql.withTransaction(
        Effect.gen(function* () {
          const boardJson = yield* Board.encode(input.board);
          yield* sql`
            INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${input.board.id}, ${input.board.slug}, ${boardJson})
            ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, json = excluded.json
          `;
          // The board reads its pools in insertion order (ORDER BY rowid), so a migrated pool keeps its row
          // and its place: a key change is an in-place UPDATE, never a delete and re-insert. Only a key
          // that leaves the board is deleted. `oldPoolKeys` and `pools` are paired by position.
          // Re-keyed pools move first, so their rows are never deleted in the way; the removal pass that
          // follows only sees keys that genuinely left the board.
          const survivingKeys = new Set(input.pools.map((pool) => pool.key));
          for (const [index, pool] of input.pools.entries()) {
            const poolJson = yield* Pool.encode(pool);
            const oldKey = input.oldPoolKeys[index];
            if (oldKey !== undefined && oldKey !== pool.key) {
              yield* sql`
                UPDATE ardud_kanban_pools SET key = ${pool.key}, json = ${poolJson}
                WHERE board_id = ${input.board.id} AND key = ${oldKey}
              `;
              continue;
            }
            yield* sql`
              INSERT INTO ardud_kanban_pools (board_id, key, json) VALUES (${input.board.id}, ${pool.key}, ${poolJson})
              ON CONFLICT (board_id, key) DO UPDATE SET json = excluded.json
            `;
          }
          for (const key of input.oldPoolKeys) {
            if (survivingKeys.has(key)) continue;
            yield* sql`DELETE FROM ardud_kanban_pools WHERE board_id = ${input.board.id} AND key = ${key}`;
          }
          for (const card of input.cards) {
            const json = yield* Card.encode(card);
            yield* sql`
              UPDATE ardud_kanban_cards SET json = ${json}, active_thread_id = ${card.activeThreadId}, stage = ${card.stage}
              WHERE id = ${card.id}
            `;
          }
          for (const link of input.threadLinks) {
            const json = yield* ThreadLink.encode(link);
            yield* sql`UPDATE ardud_kanban_threads SET json = ${json} WHERE thread_id = ${link.threadId}`;
          }
        }),
      ),
    );
  const removePool = (boardId: KanbanBoardId, key: string) =>
    run(
      "remove pool",
      Effect.asVoid(
        sql`DELETE FROM ardud_kanban_pools WHERE board_id = ${boardId} AND key = ${key}`,
      ),
    );

  const groups = (boardId: KanbanBoardId) =>
    runRead(
      "read groups",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_groups WHERE board_id = ${boardId}`,
        (rows) => (rows[0] ? Groups.decode(rows[0].json) : Effect.succeed([])),
      ),
    );
  const putGroups = (boardId: KanbanBoardId, value: ReadonlyArray<KanbanGroup>) =>
    run(
      "write groups",
      Effect.gen(function* () {
        const json = yield* Groups.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_groups (board_id, json) VALUES (${boardId}, ${json})
          ON CONFLICT (board_id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const discussions = (boardId: KanbanBoardId) =>
    runRead(
      "read discussions",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_discussions WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Discussion.decode),
      ),
    );
  const discussion = (id: KanbanDiscussionId) =>
    runRead(
      "read discussion",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_discussions WHERE id = ${id}`,
        (rows) => Effect.map(decodeAll(rows, Discussion.decode), first),
      ),
    );
  const discussionByEvaluator = (threadId: string) =>
    runRead(
      "read discussion by evaluator",
      Effect.flatMap(
        sql<JsonRow>`
          SELECT json FROM ardud_kanban_discussions WHERE evaluator_thread_id = ${threadId} LIMIT 1
        `,
        (rows) => Effect.map(decodeAll(rows, Discussion.decode), first),
      ),
    );
  const putDiscussion = (value: KanbanDiscussion) =>
    run(
      "write discussion",
      Effect.gen(function* () {
        const json = yield* Discussion.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_discussions (id, board_id, card_id, evaluator_thread_id, json)
          VALUES (${value.id}, ${value.boardId}, ${value.cardId}, ${value.evaluatorThreadId}, ${json})
          ON CONFLICT (id) DO UPDATE SET
            card_id = excluded.card_id,
            evaluator_thread_id = excluded.evaluator_thread_id,
            json = excluded.json
        `;
      }),
    );
  const messages = (
    id: KanbanDiscussionId,
    options?: { readonly afterSeq?: number; readonly beforeSeq?: number; readonly limit?: number },
  ) =>
    runRead(
      "read messages",
      Effect.flatMap(
        sql<JsonRow>`
          SELECT json FROM (
            SELECT seq, json FROM ardud_kanban_messages
            WHERE discussion_id = ${id} AND seq > ${options?.afterSeq ?? 0}
              AND seq < ${options?.beforeSeq ?? Number.MAX_SAFE_INTEGER}
            ORDER BY seq DESC LIMIT ${options?.limit ?? 200}
          ) ORDER BY seq
        `,
        (rows) => decodeAll(rows, Message.decode),
      ),
    );
  // Walks the discussion's primary key newest first; json_extract stays in SQLite, so a
  // multi-MB history is never decoded.
  const ownerWait = (id: KanbanDiscussionId) =>
    runRead(
      "read owner wait",
      Effect.map(
        sql<{ readonly seq: number; readonly createdAt: string; readonly answered: number }>`
          SELECT m.seq AS seq,
            json_extract(m.json, '$.createdAt') AS createdAt,
            EXISTS (
              SELECT 1 FROM ardud_kanban_messages e
              WHERE e.discussion_id = m.discussion_id AND e.seq > m.seq
                AND json_extract(e.json, '$.author._tag') = 'evaluator'
            ) AS answered
          FROM ardud_kanban_messages m
          WHERE m.discussion_id = ${id} AND json_extract(m.json, '$.author._tag') = 'owner'
          ORDER BY m.seq DESC LIMIT 1
        `,
        (rows) => {
          const row = rows[0];
          return row
            ? {
                seq: Number(row.seq),
                createdAt: String(row.createdAt),
                answered: Number(row.answered) === 1,
              }
            : null;
        },
      ),
    );
  const allMessages = (id: KanbanDiscussionId) =>
    runRead(
      "read all messages",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_messages WHERE discussion_id = ${id} ORDER BY seq`,
        (rows) => decodeAll(rows, Message.decode),
      ),
    );
  const message = (id: KanbanDiscussionId, seq: number) =>
    runRead(
      "read message",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_messages WHERE discussion_id = ${id} AND seq = ${seq}`,
        (rows) => Effect.map(decodeAll(rows, Message.decode), first),
      ),
    );
  const putMessage = (value: KanbanMessage) =>
    run(
      "write message",
      Effect.gen(function* () {
        const json = yield* Message.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_messages (discussion_id, seq, json)
          VALUES (${value.discussionId}, ${value.seq}, ${json})
          ON CONFLICT (discussion_id, seq) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const scripts = (boardId: KanbanBoardId) =>
    runRead(
      "read scripts",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_scripts WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Script.decode),
      ),
    );
  const allScripts = runRead(
    "read all scripts",
    Effect.flatMap(sql<JsonRow>`SELECT json FROM ardud_kanban_scripts ORDER BY rowid`, (rows) =>
      decodeAll(rows, Script.decode),
    ),
  );
  const script = (id: KanbanScriptId) =>
    runRead(
      "read script",
      Effect.flatMap(sql<JsonRow>`SELECT json FROM ardud_kanban_scripts WHERE id = ${id}`, (rows) =>
        Effect.map(decodeAll(rows, Script.decode), first),
      ),
    );
  const putScript = (value: KanbanScript) =>
    run(
      "write script",
      Effect.gen(function* () {
        const json = yield* Script.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_scripts (id, board_id, json) VALUES (${value.id}, ${value.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );
  const addScriptRun = (value: NewScriptRun) =>
    run(
      "write script run",
      Effect.gen(function* () {
        const json = yield* ScriptRun.encode(value);
        const rows = yield* sql<{ readonly id: number }>`
          INSERT INTO ardud_kanban_script_runs (script_id, json) VALUES (${value.scriptId}, ${json})
          RETURNING id
        `;
        return { ...value, id: Number(rows[0]?.id ?? 0) } as KanbanScriptRun;
      }),
    );
  const putScriptRun = (value: KanbanScriptRun) =>
    run(
      "update script run",
      Effect.gen(function* () {
        const { id, ...rest } = value;
        const json = yield* ScriptRun.encode(rest);
        yield* sql`UPDATE ardud_kanban_script_runs SET json = ${json} WHERE id = ${id}`;
      }),
    );
  const scriptRuns = (id: KanbanScriptId, limit: number) =>
    runRead(
      "read script runs",
      Effect.flatMap(
        sql<IdJsonRow>`
          SELECT id, json FROM ardud_kanban_script_runs WHERE script_id = ${id} ORDER BY id DESC LIMIT ${limit}
        `,
        (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(
              ScriptRun.decode(row.json),
              (value) => ({ ...value, id: Number(row.id) }) as KanbanScriptRun,
            ),
          ),
      ),
    );

  const automations = (boardId: KanbanBoardId) =>
    runRead(
      "read automations",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_automations WHERE board_id = ${boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, Automation.decode),
      ),
    );
  const putAutomation = (value: KanbanAutomation) =>
    run(
      "write automation",
      Effect.gen(function* () {
        const json = yield* Automation.encode(value);
        yield* sql`
          INSERT INTO ardud_kanban_automations (id, board_id, json) VALUES (${value.id}, ${value.boardId}, ${json})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const wiki = (boardId: KanbanBoardId) =>
    runRead(
      "read wiki",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_wiki WHERE board_id = ${boardId} ORDER BY slug`,
        (rows) => decodeAll(rows, Wiki.decode),
      ),
    );
  const putWiki = (page: KanbanWikiPage) =>
    run(
      "write wiki",
      Effect.gen(function* () {
        const json = yield* Wiki.encode(page);
        yield* sql`
          INSERT INTO ardud_kanban_wiki (board_id, slug, json) VALUES (${page.boardId}, ${page.slug}, ${json})
          ON CONFLICT (board_id, slug) DO UPDATE SET json = excluded.json
        `;
      }),
    );

  const threadLink = (threadId: string) =>
    runRead(
      "read thread link",
      Effect.flatMap(
        sql<JsonRow>`SELECT json FROM ardud_kanban_threads WHERE thread_id = ${threadId}`,
        (rows) => Effect.map(decodeAll(rows, ThreadLink.decode), first),
      ),
    );
  const threadLinks: KanbanStoreShape["threadLinks"] = (filter) =>
    runRead(
      "read thread links",
      Effect.flatMap(
        "cardId" in filter
          ? sql<JsonRow>`
              SELECT json FROM ardud_kanban_threads
              WHERE card_id = ${filter.cardId}
                OR thread_id IN (
                  SELECT thread_id FROM ardud_kanban_thread_cards WHERE card_id = ${filter.cardId}
                )
              ORDER BY rowid
            `
          : filter.open
            ? sql<JsonRow>`SELECT json FROM ardud_kanban_threads WHERE board_id = ${filter.boardId} AND ended = 0 ORDER BY rowid`
            : sql<JsonRow>`SELECT json FROM ardud_kanban_threads WHERE board_id = ${filter.boardId} ORDER BY rowid`,
        (rows) => decodeAll(rows, ThreadLink.decode),
      ),
    );
  const putThreadLink = (link: KanbanThreadLink) =>
    run(
      "write thread link",
      Effect.gen(function* () {
        const json = yield* ThreadLink.encode(link);
        const ended = link.endedAt === null ? 0 : 1;
        yield* sql`
          INSERT INTO ardud_kanban_threads (thread_id, board_id, card_id, ended, json)
          VALUES (${link.threadId}, ${link.boardId}, ${link.cardId}, ${ended}, ${json})
          ON CONFLICT (thread_id) DO UPDATE SET
            card_id = excluded.card_id, ended = excluded.ended, json = excluded.json
        `;
      }),
    );

  const addThreadCard = (threadId: string, cardId: KanbanCardId, at: string) =>
    run(
      "write thread card",
      sql`
        INSERT INTO ardud_kanban_thread_cards (thread_id, card_id, joined_at)
        VALUES (${threadId}, ${cardId}, ${at})
        ON CONFLICT (thread_id, card_id) DO NOTHING
      `.pipe(Effect.asVoid),
    );
  const threadCards = (threadId: string) =>
    runRead(
      "read thread cards",
      Effect.map(
        sql<{ readonly card_id: string }>`
          SELECT card_id FROM ardud_kanban_thread_cards WHERE thread_id = ${threadId}
          ORDER BY joined_at, rowid
        `,
        (rows) => rows.map((row) => KanbanCardId.make(row.card_id)),
      ),
    );

  return KanbanStore.of({
    boards,
    putBoard,
    putBoardWithPools,
    cards,
    summaryCards,
    feedCards,
    feedGoals: (boardId) =>
      runRead(
        "read feed goals",
        Effect.flatMap(
          sql<JsonRow>`SELECT json_set(json, '$.story', json(COALESCE((
        SELECT json_group_array(json(entry)) FROM (
          SELECT json_object('at', json_extract(story.value, '$.at'), 'text', substr(json_extract(story.value, '$.text'), 1, 512)) AS entry
          FROM (SELECT value FROM json_each(ardud_kanban_goals.json, '$.story') ORDER BY CAST(key AS INTEGER) DESC LIMIT 20) AS story
          ORDER BY json_extract(story.value, '$.at')
        )
      ), '[]'))) AS json FROM ardud_kanban_goals WHERE board_id = ${boardId} ORDER BY rowid`,
          (rows) => decodeAll(rows, Goal.decode),
        ),
      ),
    card,
    cardByNumber,
    cardsByThread,
    cardsInStage,
    nextCardNumber,
    putCard,
    addCardEvent,
    cardEvents,
    goals,
    putGoal,
    pools,
    putPool,
    removePool,
    rekeyBoard,
    migrateBoardSelections,
    groups,
    putGroups,
    discussions,
    discussion,
    discussionByEvaluator,
    putDiscussion,
    messages,
    ownerWait,
    allMessages,
    message,
    putMessage,
    scripts,
    allScripts,
    script,
    putScript,
    addScriptRun,
    putScriptRun,
    scriptRuns,
    automations,
    putAutomation,
    wiki,
    putWiki,
    threadLink,
    threadLinks,
    putThreadLink,
    addThreadCard,
    threadCards,
  });
});

export const layer = Layer.effect(KanbanStore, make);
