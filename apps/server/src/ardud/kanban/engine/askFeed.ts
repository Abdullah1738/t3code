/**
 * Every open ask across boards (or on one), for the Needs-you page, in bounded
 * reader statements. It never decodes a board's cards: SQLite picks the cards that
 * hold a matching ask through partial indexes on the stored JSON, trimmed to
 * the few card fields the page shows plus their matching asks.
 */
import {
  KANBAN_DONE_STAGES,
  kanbanAskBackFromSnooze,
  kanbanAskExpired,
  kanbanAskKind,
  kanbanAskRevision,
  kanbanAskSnoozed,
  kanbanAskWaitsOn,
  kanbanBlocking,
  KanbanCard,
  KanbanMessage,
  KanbanOwnerAsk,
  type KanbanAskFeed,
  type KanbanAskFeedItem,
  type KanbanBlockingCard,
  type KanbanBoardId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { ASK_LIMITS } from "./asks.ts";
import { stubMessageAt } from "./messagePages.ts";

/** At most this many closed asks come back for a history window, newest first. */
export const CLOSED_ASKS_MAX = 200;
/** At most this many of an ask's newest messages, plus the one that asked it. */
export const ASK_MESSAGES_MAX = 50;

const FeedCard = Schema.Struct({
  id: KanbanCard.fields.id,
  boardId: KanbanCard.fields.boardId,
  number: KanbanCard.fields.number,
  title: Schema.String,
  stage: KanbanCard.fields.stage,
  priority: KanbanCard.fields.priority,
  discussionId: KanbanCard.fields.discussionId,
  settledAt: KanbanCard.fields.settledAt,
  asks: Schema.Array(KanbanOwnerAsk),
});
type FeedCard = typeof FeedCard.Type;
const decodeCard = Schema.decodeUnknownEffect(Schema.fromJsonString(FeedCard));
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(KanbanMessage));

interface JsonRow {
  readonly json: string;
}

export interface AskFeedInput {
  readonly boardId?: KanbanBoardId | undefined;
  /** ISO time: also return asks closed at or after it. */
  readonly closedSince?: string | undefined;
}

// The expression index makes even a discussion made entirely of ask replies bounded.
const readAskMessages = Effect.fn("KanbanAskFeed.messages")(function* (
  sql: SqlClient.SqlClient,
  cards: ReadonlyArray<FeedCard>,
  history: boolean,
) {
  const discussions = new Set<string>();
  const askedPairs = new Map<string, readonly [string, number]>();
  const askPairs: Array<readonly [string, string]> = [];
  for (const card of cards) {
    if (card.discussionId === null) continue;
    discussions.add(card.discussionId);
    for (const ask of card.asks) {
      askPairs.push([card.discussionId, ask.id]);
      for (const seq of [ask.seq, ask.firstSeq]) {
        if (seq !== null && seq !== undefined)
          askedPairs.set(`${card.discussionId}:${seq}`, [card.discussionId, seq]);
      }
    }
  }
  yield* Effect.annotateCurrentSpan({
    discussions: discussions.size,
    askedPairs: askedPairs.size,
    history,
    rowsReturned: 0,
  });
  if (discussions.size === 0) return [];
  // @effect-diagnostics-next-line preferSchemaOverJson:off -- SQL table-valued input.
  const askedList = JSON.stringify([...askedPairs.values()]);
  // @effect-diagnostics-next-line preferSchemaOverJson:off -- SQL table-valued input.
  const askList = JSON.stringify(askPairs);
  const rows = yield* sql<JsonRow>`
    SELECT m.discussion_id, m.seq, m.json
    FROM json_each(${askedList}) wanted
    CROSS JOIN ardud_kanban_messages m
    WHERE m.discussion_id = json_extract(wanted.value, '$[0]')
      AND m.seq = json_extract(wanted.value, '$[1]')
    UNION
    SELECT m.discussion_id, m.seq, m.json
    FROM json_each(${askList}) wanted
    CROSS JOIN ardud_kanban_messages m
    WHERE m.discussion_id = json_extract(wanted.value, '$[0]')
      AND m.seq IN (
        SELECT seq FROM ardud_kanban_messages INDEXED BY ardud_kanban_messages_ask_marked
        WHERE discussion_id = json_extract(wanted.value, '$[0]')
          AND json_extract(json, '$.askId') = json_extract(wanted.value, '$[1]')
          AND instr(json, '"askId":"') > 0
        ORDER BY seq LIMIT 1
      )
    UNION
    SELECT m.discussion_id, m.seq, m.json
    FROM json_each(${askList}) wanted
    CROSS JOIN ardud_kanban_messages m
    WHERE m.discussion_id = json_extract(wanted.value, '$[0]')
      AND m.seq IN (
        SELECT seq FROM ardud_kanban_messages INDEXED BY ardud_kanban_messages_ask_marked
        WHERE discussion_id = json_extract(wanted.value, '$[0]')
          AND json_extract(json, '$.askId') = json_extract(wanted.value, '$[1]')
          AND instr(json, '"askId":"') > 0
        ORDER BY seq DESC LIMIT ${ASK_MESSAGES_MAX}
      )
    ORDER BY m.discussion_id, m.seq
  `;
  yield* Effect.annotateCurrentSpan("rowsReturned", rows.length);
  return rows;
});

export const readAskFeed = Effect.fn("KanbanAskFeed.read")(function* (
  sql: SqlClient.SqlClient,
  input: AskFeedInput,
  at: string,
) {
  const since = input.closedSince ?? null;
  const cards: Array<FeedCard> = [];
  let boardAfter = input.boardId ?? "";
  let numberAfter = 0;
  while (true) {
    const after =
      input.boardId === undefined
        ? sql`(board_id, number) > (${boardAfter}, ${numberAfter})`
        : sql`board_id = ${input.boardId} AND number > ${numberAfter}`;
    const liveBoard = sql`board_id IN (
      SELECT id FROM ardud_kanban_boards WHERE json_extract(json, '$.archivedAt') IS NULL
    )`;
    // Literal predicates match the partial indexes in kanbanDDL. UNION merges
    // their ordered ranges and deduplicates cards that have both kinds of ask.
    // Pin each range so SQLite cannot choose the full board/number index.
    const cardRows = yield* sql<{ boardId: string; number: number; json: string }>`
      WITH page AS MATERIALIZED (
        SELECT id, board_id, number FROM ardud_kanban_cards INDEXED BY ardud_kanban_cards_open_asks
        WHERE instr(json, '"closedAt":null') > 0 AND ${after} AND ${liveBoard}
        ${
          since === null
            ? sql``
            : sql`UNION
                SELECT id, board_id, number FROM ardud_kanban_cards INDEXED BY ardud_kanban_cards_closed_asks
                WHERE instr(json, '"closedAt":"') > 0 AND ${after} AND ${liveBoard}`
        }
        ORDER BY board_id, number LIMIT 64
      )
      SELECT c.board_id AS boardId, c.number, json_object(
        'id', c.id,
        'boardId', c.board_id,
        'number', c.number,
        'title', substr(json_extract(c.json, '$.title'), 1, 512),
        'stage', c.stage,
        'priority', json_extract(c.json, '$.priority'),
        'discussionId', json_extract(c.json, '$.discussionId'),
        'settledAt', json_extract(c.json, '$.settledAt'),
        'asks', json(COALESCE((
          SELECT json_group_array(json(ask.value))
          FROM json_each(c.json, '$.asks') AS ask
          WHERE json_extract(ask.value, '$.closedAt') IS NULL
            OR (${since} IS NOT NULL AND json_extract(ask.value, '$.closedAt') >= ${since})
        ), '[]'))
      ) AS json
      FROM page p JOIN ardud_kanban_cards c ON c.id = p.id
      ORDER BY c.board_id, c.number
    `;
    for (const row of cardRows) {
      const card = yield* decodeCard(row.json);
      if (card.asks.length > 0) cards.push(card);
    }
    if (cardRows.length < 64) break;
    boardAfter = cardRows.at(-1)!.boardId;
    numberAfter = cardRows.at(-1)!.number;
  }

  const boardRows =
    cards.length === 0
      ? []
      : yield* sql<{ id: string; slug: string; name: string | null }>`
          SELECT id, slug, json_extract(json, '$.name') AS name FROM ardud_kanban_boards
        `;
  const boards = new Map(boardRows.map((row) => [row.id, row]));

  // What each card with an open ask holds up, counted the way the dispatcher
  // schedules (the whole chain, backlog waiters left out): one read of the
  // open cards' few graph fields and one walk of the graph per board, however
  // many asks there are.
  const holders = cards.filter(
    (card) => card.settledAt === null && card.asks.some((ask) => ask.closedAt === null),
  );
  const blocks = new Map<string, number>();
  if (holders.length > 0) {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const boardIds = JSON.stringify([...new Set(holders.map((card) => card.boardId))]);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const done = JSON.stringify([...KANBAN_DONE_STAGES]);
    const open = yield* sql<{
      id: string;
      boardId: string;
      stage: string;
      priority: number;
      blockedBy: string | null;
    }>`
      SELECT id, board_id AS boardId, stage,
        json_extract(json, '$.priority') AS priority,
        json_extract(json, '$.blockedBy') AS blockedBy
      FROM ardud_kanban_cards
      WHERE board_id IN (SELECT value FROM json_each(${boardIds}))
        AND stage NOT IN (SELECT value FROM json_each(${done}))
        AND json_extract(json, '$.settledAt') IS NULL
    `;
    const byBoard = new Map<string, Array<KanbanBlockingCard>>();
    for (const row of open) {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const parsed: unknown = JSON.parse(row.blockedBy ?? "[]");
      const ids: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [];
      const board = byBoard.get(row.boardId) ?? [];
      if (board.length === 0) byBoard.set(row.boardId, board);
      board.push({
        id: row.id,
        stage: row.stage,
        settledAt: null,
        priority: row.priority,
        blockedBy: ids.filter((id) => typeof id === "string"),
      } as unknown as KanbanBlockingCard);
    }
    for (const board of byBoard.values()) {
      const blocking = kanbanBlocking(board);
      for (const card of holders) {
        const held = blocking.get(card.id);
        if (held !== undefined) blocks.set(card.id, held.holds);
      }
    }
  }

  // Apply the existing history cap before reading any discussion messages. Stable
  // sorting preserves card/ask order when several asks closed at the same instant.
  const newestClosed = cards
    .flatMap((card) => card.asks.filter((ask) => ask.closedAt !== null))
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, CLOSED_ASKS_MAX);
  const keptClosed = new Set(newestClosed);
  const selectedCards = cards.flatMap((card) => {
    const asks = card.asks.filter((ask) =>
      ask.closedAt === null ? card.settledAt === null : keptClosed.has(ask),
    );
    return asks.length === 0 ? [] : [{ ...card, asks }];
  });
  const messages = new Map<string, Array<KanbanMessage>>();
  const rows = yield* readAskMessages(sql, selectedCards, since !== null);
  for (const row of rows) {
    // A list read: a page or long text comes as a stub, whole on the single-ask read.
    const message = stubMessageAt(yield* decodeMessage(row.json), ASK_LIMITS.inlineBytes);
    const list = messages.get(message.discussionId) ?? [];
    list.push(message);
    messages.set(message.discussionId, list);
  }

  const nowMs = Date.parse(at);
  const open: Array<KanbanAskFeedItem> = [];
  const closed: Array<KanbanAskFeedItem> = [];
  for (const card of selectedCards) {
    const board = boards.get(card.boardId);
    const slug = board?.slug ?? card.boardId;
    const thread = card.discussionId === null ? [] : (messages.get(card.discussionId) ?? []);
    for (const ask of card.asks) {
      if (ask.closedAt === null && card.settledAt !== null) continue;
      const own = thread.filter(
        // An ask from before messages carried `askId` is found by the seq it was asked
        // at, which an edit keeps as `firstSeq`.
        (message) =>
          message.askId === ask.id ||
          (message.askId === undefined &&
            (message.seq === ask.seq || message.seq === ask.firstSeq)),
      );
      const item: KanbanAskFeedItem = {
        boardId: card.boardId,
        boardSlug: slug,
        boardName: board?.name ?? slug,
        cardId: card.id,
        cardNumber: card.number,
        cardRef: `${slug}:${card.number}`,
        cardTitle: card.title,
        stage: card.stage,
        priority: card.priority,
        discussionId: card.discussionId,
        blocks: blocks.get(card.id) ?? 0,
        ask,
        kind: kanbanAskKind(ask),
        revision: kanbanAskRevision(ask),
        waitsOn: kanbanAskWaitsOn(ask),
        expired: ask.closedAt === null && kanbanAskExpired(ask, nowMs),
        snoozed: kanbanAskSnoozed(ask, nowMs),
        backFromSnoozeAt: kanbanAskBackFromSnooze(
          ask,
          nowMs,
        ) as KanbanAskFeedItem["backFromSnoozeAt"],
        messages:
          own.length > ASK_MESSAGES_MAX + 1 ? [own[0]!, ...own.slice(-ASK_MESSAGES_MAX)] : own,
      };
      (ask.closedAt === null ? open : closed).push(item);
    }
  }
  closed.sort((a, b) => (b.ask.closedAt ?? "").localeCompare(a.ask.closedAt ?? ""));
  return {
    at: at as KanbanAskFeed["at"],
    open,
    closed: closed.slice(0, CLOSED_ASKS_MAX),
  } satisfies KanbanAskFeed;
});
