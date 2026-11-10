/**
 * Every open ask across boards (or on one), for the Needs-you page, in one
 * cheap read. It never decodes a board's cards: SQLite picks the cards that
 * hold a matching ask with a substring test on the stored JSON (no JSON parse
 * for the rest), and only those come back, trimmed to the few card fields the
 * page shows plus their matching asks.
 */
import {
  kanbanAskBackFromSnooze,
  kanbanAskExpired,
  kanbanAskKind,
  kanbanAskRevision,
  kanbanAskSnoozed,
  kanbanAskWaitsOn,
  KanbanCard,
  KanbanMessage,
  KanbanOwnerAsk,
  type KanbanAskFeed,
  type KanbanAskFeedItem,
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

// Stored JSON is compact (JSON.stringify, SQLite's json_set), and only asks have
// `closedAt`, so these find a card with an open (or a closed) ask without parsing it.
const OPEN_MARK = '"closedAt":null';
const CLOSED_MARK = '"closedAt":"';
const ASK_MESSAGE_MARK = '"askId":"';

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

export const readAskFeed = Effect.fn("KanbanAskFeed.read")(function* (
  sql: SqlClient.SqlClient,
  input: AskFeedInput,
  at: string,
) {
  const since = input.closedSince ?? null;
  const cardRows = yield* sql<JsonRow>`
    SELECT json_object(
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
    FROM ardud_kanban_cards c
    WHERE ${input.boardId === undefined ? sql`1 = 1` : sql`c.board_id = ${input.boardId}`}
      AND (instr(c.json, ${OPEN_MARK}) > 0
        OR (${since} IS NOT NULL AND instr(c.json, ${CLOSED_MARK}) > 0))
    ORDER BY c.board_id, c.number
  `;
  const cards: Array<FeedCard> = [];
  for (const row of cardRows) {
    const card = yield* decodeCard(row.json);
    if (card.asks.length > 0) cards.push(card);
  }

  const boardRows =
    cards.length === 0
      ? []
      : yield* sql<{ id: string; slug: string; name: string | null }>`
          SELECT id, slug, json_extract(json, '$.name') AS name FROM ardud_kanban_boards
        `;
  const boards = new Map(boardRows.map((row) => [row.id, row]));

  // What each card with an open ask holds up: one pass over the unfinished
  // cards that wait on anything, reading only their `blockedBy`.
  const holders = new Set(
    cards
      .filter((card) => card.settledAt === null && card.asks.some((ask) => ask.closedAt === null))
      .map((card) => card.id as string),
  );
  const blocks = new Map<string, number>();
  if (holders.size > 0) {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const boardIds = JSON.stringify([...new Set(cards.map((card) => card.boardId))]);
    const waiting = yield* sql<{ blockedBy: string | null }>`
      SELECT json_extract(json, '$.blockedBy') AS blockedBy
      FROM ardud_kanban_cards
      WHERE board_id IN (SELECT value FROM json_each(${boardIds}))
        AND stage NOT IN ('completed', 'deployed', 'verified')
        AND instr(json, '"blockedBy":[]') = 0
        AND json_extract(json, '$.settledAt') IS NULL
    `;
    for (const row of waiting) {
      if (row.blockedBy === null) continue;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const ids = JSON.parse(row.blockedBy) as ReadonlyArray<unknown>;
      for (const id of new Set(ids)) {
        if (typeof id === "string" && holders.has(id)) blocks.set(id, (blocks.get(id) ?? 0) + 1);
      }
    }
  }

  // Each ask's own discussion: the message that asked it, and every message posted on it.
  const discussionIds = [
    ...new Set(cards.flatMap((card) => (card.discussionId === null ? [] : [card.discussionId]))),
  ];
  const messages = new Map<string, Array<KanbanMessage>>();
  if (discussionIds.length > 0) {
    const asked = cards.flatMap((card) =>
      card.discussionId === null
        ? []
        : card.asks.flatMap((ask) =>
            [ask.seq, ask.firstSeq].flatMap((seq) =>
              seq === null || seq === undefined ? [] : [[card.discussionId, seq]],
            ),
          ),
    );
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const idList = JSON.stringify(discussionIds);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const askedList = JSON.stringify(asked);
    const rows = yield* sql<JsonRow>`
      SELECT m.json FROM ardud_kanban_messages m
      WHERE m.discussion_id IN (SELECT value FROM json_each(${idList}))
        AND (instr(m.json, ${ASK_MESSAGE_MARK}) > 0
          OR EXISTS (
            SELECT 1 FROM json_each(${askedList}) AS wanted
            WHERE json_extract(wanted.value, '$[0]') = m.discussion_id
              AND json_extract(wanted.value, '$[1]') = m.seq
          ))
      ORDER BY m.discussion_id, m.seq
    `;
    for (const row of rows) {
      // A list read: a page or long text comes as a stub, whole on the single-ask read.
      const message = stubMessageAt(yield* decodeMessage(row.json), ASK_LIMITS.inlineBytes);
      const list = messages.get(message.discussionId) ?? [];
      list.push(message);
      messages.set(message.discussionId, list);
    }
  }

  const nowMs = Date.parse(at);
  const open: Array<KanbanAskFeedItem> = [];
  const closed: Array<KanbanAskFeedItem> = [];
  for (const card of cards) {
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
