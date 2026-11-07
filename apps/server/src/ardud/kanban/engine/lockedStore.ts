import * as Effect from "effect/Effect";

import type { KanbanStoreShape } from "../store/KanbanStore.ts";
import type * as BoardLocks from "./boardLocks.ts";

/** Keeps every existing store call on the owning board without changing persistence or its DB. */
export const wrap = (
  store: KanbanStoreShape,
  locks: Effect.Success<ReturnType<typeof BoardLocks.make>>,
): KanbanStoreShape => {
  const card = <A, E, R>(
    id: Parameters<KanbanStoreShape["card"]>[0],
    effect: Effect.Effect<A, E, R>,
    write = false,
    collection = false,
  ) =>
    store
      .card(id)
      .pipe(
        Effect.flatMap((row) =>
          row
            ? locks.access(row.boardId, effect, write, collection ? undefined : `card:${id}`)
            : effect,
        ),
      );
  const discussion = <A, E, R>(
    id: Parameters<KanbanStoreShape["discussion"]>[0],
    effect: Effect.Effect<A, E, R>,
    write = false,
  ) =>
    store
      .discussion(id)
      .pipe(
        Effect.flatMap((row) =>
          row ? locks.access(row.boardId, effect, write, `discussion:${id}`) : effect,
        ),
      );
  const thread = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    store
      .threadLink(id)
      .pipe(Effect.flatMap((row) => (row ? locks.access(row.boardId, effect) : effect)));
  return {
    ...store,
    boards: locks.observe(store.boards),
    putBoard: (row) => locks.access(row.id, store.putBoard(row), true, "board"),
    putBoardWithPools: (row, pools) =>
      locks.access(row.id, store.putBoardWithPools(row, pools), true, "board"),
    cards: (id) => locks.access(id, store.cards(id)),
    summaryCards: (id) => locks.access(id, store.summaryCards(id)),
    card: (id) => card(id, store.card(id)),
    cardByNumber: (id, number) => locks.access(id, store.cardByNumber(id, number)),
    cardsByThread: (id) => thread(id, store.cardsByThread(id)),
    nextCardNumber: (id) => locks.access(id, store.nextCardNumber(id)),
    putCard: (row) => locks.access(row.boardId, store.putCard(row), true, `card:${row.id}`),
    addCardEvent: (row) => card(row.cardId, store.addCardEvent(row), true),
    cardEvents: (id) => card(id, store.cardEvents(id)),
    goals: (id) => locks.access(id, store.goals(id)),
    putGoal: (row) => locks.access(row.boardId, store.putGoal(row), true),
    pools: (id) => locks.access(id, store.pools(id)),
    putPool: (id, row) => locks.access(id, store.putPool(id, row), true),
    removePool: (id, key) => locks.access(id, store.removePool(id, key), true),
    rekeyBoard: (id, pools, cards) => locks.access(id, store.rekeyBoard(id, pools, cards), true),
    migrateBoardSelections: (input) =>
      locks.access(input.board.id, store.migrateBoardSelections(input), true),
    groups: (id) => locks.access(id, store.groups(id)),
    putGroups: (id, rows) => locks.access(id, store.putGroups(id, rows), true),
    discussions: (id) => locks.access(id, store.discussions(id)),
    discussion: (id) => discussion(id, store.discussion(id)),
    discussionByEvaluator: (id) => thread(id, store.discussionByEvaluator(id)),
    putDiscussion: (row) =>
      locks.access(row.boardId, store.putDiscussion(row), true, `discussion:${row.id}`),
    messages: (id, options) => discussion(id, store.messages(id, options)),
    ownerWait: (id) => discussion(id, store.ownerWait(id)),
    allMessages: (id) => discussion(id, store.allMessages(id)),
    message: (id, seq) => discussion(id, store.message(id, seq)),
    putMessage: (row) => discussion(row.discussionId, store.putMessage(row), true),
    scripts: (id) => locks.access(id, store.scripts(id)),
    automations: (id) => locks.access(id, store.automations(id)),
    putAutomation: (row) => locks.access(row.boardId, store.putAutomation(row), true),
    wiki: (id) => locks.access(id, store.wiki(id)),
    putWiki: (row) => locks.access(row.boardId, store.putWiki(row), true),
    threadLink: (id) => thread(id, store.threadLink(id)),
    threadLinks: (filter) =>
      "boardId" in filter
        ? locks.access(filter.boardId, store.threadLinks(filter))
        : card(filter.cardId, store.threadLinks(filter), false, true),
    putThreadLink: (row) =>
      locks.access(row.boardId, store.putThreadLink(row), true, `thread:${row.threadId}`),
    addThreadCard: (id, cardId, at) => card(cardId, store.addThreadCard(id, cardId, at), true),
    threadCards: (id) => thread(id, store.threadCards(id)),
  };
};
