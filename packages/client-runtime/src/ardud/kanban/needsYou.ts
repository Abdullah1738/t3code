/**
 * The owner's list of asks ("Needs you"): every open ask, ranked, with the
 * ones that are not his turn set apart and same-shaped asks grouped so they
 * can be answered together. Pure: built from the board state the client holds,
 * or from the server's ask feed.
 */
import {
  KANBAN_DONE_STAGES,
  kanbanAskExpired,
  kanbanAskKind,
  kanbanAskRevision,
  kanbanAskWaitsOn,
  kanbanOpenAsks,
  type KanbanAskFeedItem,
  type KanbanAskKind,
  type KanbanCard,
  type KanbanOwnerAsk,
  type KanbanStage,
} from "@t3tools/contracts";

import type { KanbanBoardState } from "./boardState.ts";

export interface NeedsYouItem {
  /** `<cardId>:<askId>`, stable across revisions. */
  readonly key: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly cardNumber: number;
  readonly cardTitle: string;
  readonly stage: KanbanStage;
  readonly priority: number;
  readonly ask: KanbanOwnerAsk;
  readonly kind: KanbanAskKind;
  readonly revision: number;
  readonly blocking: boolean;
  /** Unfinished cards that wait on this ask's card. */
  readonly unblocks: number;
  readonly ageMs: number;
  /** Past its `expiresAt`: it can't be answered until its asker renews it. */
  readonly expired: boolean;
  /** Its asker edited it after it was first asked. */
  readonly updated: boolean;
}

/** One row of the ranked list: a single ask, or the asks that share a batch key on a board. */
export type NeedsYouEntry =
  | { readonly _tag: "ask"; readonly item: NeedsYouItem }
  | {
      readonly _tag: "batch";
      readonly boardId: string;
      readonly batchKey: string;
      /** Ranked like the list; the batch sits where its first item would. */
      readonly items: ReadonlyArray<NeedsYouItem>;
    };

export interface NeedsYou {
  /** Asks that are his turn, ranked, with batches folded into one entry. */
  readonly entries: ReadonlyArray<NeedsYouEntry>;
  /** The same asks, ranked, one by one. */
  readonly items: ReadonlyArray<NeedsYouItem>;
  /** He asked a clarifying question: these wait on their asker. */
  readonly waitingOnAgent: ReadonlyArray<NeedsYouItem>;
  /** He handed these to the evaluator. */
  readonly withEvaluator: ReadonlyArray<NeedsYouItem>;
  /** His turn, but stale: shown, not answerable. */
  readonly expired: ReadonlyArray<NeedsYouItem>;
  /** How many asks are his turn and answerable. */
  readonly count: number;
  /** Of those, how many hold their card. */
  readonly blocking: number;
}

/**
 * The order asks are shown in: one that holds its card first, then the one
 * whose card holds up the most other cards, then the one waiting longest.
 */
export const compareNeedsYou = (a: NeedsYouItem, b: NeedsYouItem): number =>
  Number(b.blocking) - Number(a.blocking) ||
  b.unblocks - a.unblocks ||
  b.ageMs - a.ageMs ||
  a.boardId.localeCompare(b.boardId) ||
  a.cardNumber - b.cardNumber ||
  a.ask.id.localeCompare(b.ask.id, undefined, { numeric: true });

const itemOf = (
  card: Pick<KanbanCard, "id" | "boardId" | "number" | "title" | "stage" | "priority">,
  ask: KanbanOwnerAsk,
  unblocks: number,
  nowMs: number,
): NeedsYouItem => ({
  key: `${card.id}:${ask.id}`,
  boardId: card.boardId,
  cardId: card.id,
  cardNumber: card.number,
  cardTitle: card.title,
  stage: card.stage,
  priority: card.priority,
  ask,
  kind: kanbanAskKind(ask),
  revision: kanbanAskRevision(ask),
  blocking: ask.blocking,
  unblocks,
  ageMs: Math.max(0, nowMs - Date.parse(ask.at)),
  expired: kanbanAskExpired(ask, nowMs),
  updated: kanbanAskRevision(ask) > 0,
});

/** Splits open asks by whose turn it is and ranks each list. */
export function rankNeedsYou(all: ReadonlyArray<NeedsYouItem>): NeedsYou {
  const mine: Array<NeedsYouItem> = [];
  const waitingOnAgent: Array<NeedsYouItem> = [];
  const withEvaluator: Array<NeedsYouItem> = [];
  const expired: Array<NeedsYouItem> = [];
  for (const item of all) {
    const turn = kanbanAskWaitsOn(item.ask);
    if (turn === null) continue;
    if (turn === "agent") waitingOnAgent.push(item);
    else if (turn === "evaluator") withEvaluator.push(item);
    else if (item.expired) expired.push(item);
    else mine.push(item);
  }
  for (const list of [mine, waitingOnAgent, withEvaluator, expired]) list.sort(compareNeedsYou);

  // Asks with the same key on a board fold into one entry, placed at its best item.
  const batches = new Map<string, Array<NeedsYouItem>>();
  for (const item of mine) {
    if (item.ask.batchKey === undefined) continue;
    const key = `${item.boardId}\u0000${item.ask.batchKey}`;
    const list = batches.get(key) ?? [];
    list.push(item);
    batches.set(key, list);
  }
  const entries: Array<NeedsYouEntry> = [];
  const placed = new Set<string>();
  for (const item of mine) {
    const key =
      item.ask.batchKey === undefined ? null : `${item.boardId}\u0000${item.ask.batchKey}`;
    const batch = key === null ? undefined : batches.get(key);
    if (key === null || batch === undefined || batch.length < 2) {
      entries.push({ _tag: "ask", item });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    entries.push({
      _tag: "batch",
      boardId: item.boardId,
      batchKey: item.ask.batchKey!,
      items: batch,
    });
  }
  return {
    entries,
    items: mine,
    waitingOnAgent,
    withEvaluator,
    expired,
    count: mine.length,
    blocking: mine.filter((item) => item.blocking).length,
  };
}

/** The owner's asks on one board, from the state the client holds. */
export function needsYouItems(state: KanbanBoardState, nowMs: number): NeedsYou {
  const unblocks = new Map<string, number>();
  for (const card of state.cards.values()) {
    if (card.settledAt !== null || KANBAN_DONE_STAGES.has(card.stage)) continue;
    for (const id of new Set(card.blockedBy)) unblocks.set(id, (unblocks.get(id) ?? 0) + 1);
  }
  const items: Array<NeedsYouItem> = [];
  for (const card of state.cards.values()) {
    if (card.settledAt !== null) continue;
    for (const ask of kanbanOpenAsks(card)) {
      items.push(itemOf(card, ask, unblocks.get(card.id) ?? 0, nowMs));
    }
  }
  return rankNeedsYou(items);
}

/** The same list across boards, from the server's ask feed (`GET /api/ardud/kanban/asks`). */
export function needsYouFromFeed(open: ReadonlyArray<KanbanAskFeedItem>, nowMs: number): NeedsYou {
  return rankNeedsYou(
    open.map((entry) =>
      itemOf(
        {
          id: entry.cardId,
          boardId: entry.boardId,
          number: entry.cardNumber,
          title: entry.cardTitle,
          stage: entry.stage,
          priority: entry.priority,
        },
        entry.ask,
        entry.blocks,
        nowMs,
      ),
    ),
  );
}
