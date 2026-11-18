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
    store.card(id).pipe(
      locks.dispatchRead,
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
    store.discussion(id).pipe(
      locks.dispatchRead,
      Effect.flatMap((row) =>
        row ? locks.access(row.boardId, effect, write, `discussion:${id}`) : effect,
      ),
    );
  const thread = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    store.threadLink(id).pipe(
      locks.dispatchRead,
      Effect.flatMap((row) => (row ? locks.access(row.boardId, effect) : effect)),
    );
  return {
    ...store,
    boards: locks.observe(store.boards),
    boardThreadIds: (id) => locks.access(id, store.boardThreadIds(id)),
    purgeBoard: (id) => locks.access(id, store.purgeBoard(id), true),
    pendingBoardPurges: locks.observe(store.pendingBoardPurges),
    finishBoardPurgeThread: (id, threadId) =>
      locks.access(id, store.finishBoardPurgeThread(id, threadId), true),
    board: (id) => locks.access(id, store.board(id), false, "board"),
    putBoard: (row) => locks.access(row.id, store.putBoard(row), true, "board"),
    putBoardWithPools: (row, pools, application) =>
      locks.access(row.id, store.putBoardWithPools(row, pools, application), true, "board"),
    cards: (id) => locks.access(id, store.cards(id)),
    schedulingCards: (id) => locks.access(id, store.schedulingCards(id)),
    claimCards: (id, seeds) => locks.access(id, store.claimCards(id, seeds)),
    dispatchCards: (id) => locks.access(id, store.dispatchCards(id)),
    tickCards: (id, live) => locks.access(id, store.tickCards(id, live)),
    goalStoryCards: (id) => locks.access(id, store.goalStoryCards(id)),
    openCards: (id) => locks.access(id, store.openCards(id)),
    summaryCards: (id) => locks.access(id, store.summaryCards(id)),
    card: (id) => card(id, store.card(id)),
    cardByNumber: (id, number) => locks.access(id, store.cardByNumber(id, number)),
    poolThreadIds: (id, pool) => locks.access(id, store.poolThreadIds(id, pool)),
    cardsByThread: (id) => thread(id, store.cardsByThread(id)),
    nextCardNumber: (id) => locks.access(id, store.nextCardNumber(id)),
    putCard: (row) => locks.access(row.boardId, store.putCard(row), true, `card:${row.id}`),
    updateCard: (row, before) =>
      locks.access(before.boardId, store.updateCard(row, before), true, `card:${row.id}`),
    addCardEvent: (row, applicationId, snapshot) =>
      snapshot?.id === row.cardId
        ? locks.access(
            snapshot.boardId,
            store.addCardEvent(row, applicationId, snapshot),
            true,
            `card:${row.cardId}`,
          )
        : card(row.cardId, store.addCardEvent(row, applicationId), true),
    pendingInstructionApplications: (cardId, boardId, field, askId) =>
      card(cardId, store.pendingInstructionApplications(cardId, boardId, field, askId)),
    cardEvents: (id) => card(id, store.cardEvents(id)),
    boardEvents: (id, since, until) => locks.access(id, store.boardEvents(id, since, until)),
    evaluatorStepEvents: (id) => locks.access(id, store.evaluatorStepEvents(id)),
    activityHistory: (id, window) => locks.access(id, store.activityHistory(id, window)),
    slotHistory: (filter) => locks.access(filter.boardId, store.slotHistory(filter)),
    lastTransitions: (id, cardIds, beforeId) =>
      locks.access(id, store.lastTransitions(id, cardIds, beforeId)),
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
    settlingDiscussions: (id) => locks.access(id, store.settlingDiscussions(id)),
    openDiscussions: (id) => locks.access(id, store.openDiscussions(id)),
    discussion: (id) => discussion(id, store.discussion(id)),
    latestSystemDiscussion: (id, component) =>
      locks.access(id, store.latestSystemDiscussion(id, component)),
    discussionByEvaluator: (id) => thread(id, store.discussionByEvaluator(id)),
    discussionBoardIdsByEvaluator: (id) => thread(id, store.discussionBoardIdsByEvaluator(id)),
    putDiscussion: (row) =>
      locks.access(row.boardId, store.putDiscussion(row), true, `discussion:${row.id}`),
    messages: (id, options) => discussion(id, store.messages(id, options)),
    ownerWait: (id, includeScripts, atSeq) =>
      discussion(id, store.ownerWait(id, includeScripts, atSeq)),
    allMessages: (id) => discussion(id, store.allMessages(id)),
    message: (id, seq) => discussion(id, store.message(id, seq)),
    putMessage: (row) => discussion(row.discussionId, store.putMessage(row), true),
    scripts: (id) => locks.access(id, store.scripts(id)),
    automations: (id) => locks.access(id, store.automations(id)),
    putAutomation: (row) => locks.access(row.boardId, store.putAutomation(row), true),
    wiki: (id, slugs) => locks.access(id, store.wiki(id, slugs)),
    wikiIndex: (id, slugs) => locks.access(id, store.wikiIndex(id, slugs)),
    putWiki: (row) => locks.access(row.boardId, store.putWiki(row), true),
    threadLink: (id) => thread(id, store.threadLink(id)),
    threadLinksByIds: (ids) => locks.observe(store.threadLinksByIds(ids)),
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
