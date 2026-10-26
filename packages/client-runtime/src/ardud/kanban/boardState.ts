import type {
  KanbanBoard,
  KanbanBoardSnapshot,
  KanbanCard,
  KanbanChange,
  KanbanDiscussion,
  KanbanGoal,
  KanbanGroup,
  KanbanMessage,
  KanbanPool,
  KanbanThreadState,
  KanbanWatchEvent,
} from "@t3tools/contracts";

/**
 * The board as the client holds it: the server snapshot plus every change
 * since. Discussions are not in the snapshot; the store reads the list after
 * every snapshot, and live changes replace entries in between.
 */
export interface KanbanBoardState {
  readonly board: KanbanBoard;
  readonly cards: ReadonlyMap<string, KanbanCard>;
  readonly goals: ReadonlyMap<string, KanbanGoal>;
  readonly pools: ReadonlyArray<KanbanPool>;
  readonly groups: ReadonlyArray<KanbanGroup>;
  readonly threads: ReadonlyMap<string, KanbanThreadState>;
  readonly discussions: ReadonlyMap<string, KanbanDiscussion>;
  /** Unread messages for the owner, per discussion. */
  readonly unread: ReadonlyMap<string, number>;
  /** The newest message seen per discussion, for list previews. */
  readonly lastMessages: ReadonlyMap<string, KanbanMessage>;
  /** False until the discussion list has been read. */
  readonly discussionsLoaded: boolean;
}

const byId = <T, K extends string>(items: ReadonlyArray<T>, key: (item: T) => K) =>
  new Map<string, T>(items.map((item) => [key(item), item]));

export function boardStateFromSnapshot(
  snapshot: KanbanBoardSnapshot,
  previous?: KanbanBoardState,
): KanbanBoardState {
  return {
    board: snapshot.board,
    cards: byId(snapshot.cards, (card) => card.id),
    goals: byId(snapshot.goals, (goal) => goal.id),
    pools: snapshot.pools,
    groups: snapshot.groups,
    threads: byId(snapshot.threads, (thread) => thread.threadId),
    // A reconnect replays the snapshot; held discussions stay until the store
    // has read the list again.
    discussions: previous?.discussions ?? new Map(),
    unread: new Map(snapshot.unread.map((entry) => [entry.discussionId, entry.count])),
    lastMessages: previous?.lastMessages ?? new Map(),
    discussionsLoaded: previous?.discussionsLoaded ?? false,
  };
}

const OWNER = "owner";

export function ownerReadSeq(discussion: KanbanDiscussion): number {
  return discussion.participants.find((entry) => entry.actor._tag === OWNER)?.lastReadSeq ?? 0;
}

const unreadOf = (discussion: KanbanDiscussion) =>
  Math.max(0, discussion.lastSeq - ownerReadSeq(discussion));

const withEntry = <T>(map: ReadonlyMap<string, T>, key: string, value: T) => {
  const next = new Map(map);
  next.set(key, value);
  return next;
};

export function applyKanbanChange(state: KanbanBoardState, change: KanbanChange): KanbanBoardState {
  switch (change._tag) {
    case "card":
      return { ...state, cards: withEntry(state.cards, change.card.id, change.card) };
    case "cardRemoved": {
      if (!state.cards.has(change.cardId)) return state;
      const cards = new Map(state.cards);
      cards.delete(change.cardId);
      return { ...state, cards };
    }
    case "goal":
      return { ...state, goals: withEntry(state.goals, change.goal.id, change.goal) };
    case "pools":
      return { ...state, pools: change.pools };
    case "board":
      return { ...state, board: change.board };
    case "groups":
      return { ...state, groups: change.groups };
    case "thread":
      return {
        ...state,
        threads: withEntry(state.threads, change.thread.threadId, change.thread),
      };
    case "discussion":
      return {
        ...state,
        discussions: withEntry(state.discussions, change.discussion.id, change.discussion),
        unread: withEntry(state.unread, change.discussion.id, unreadOf(change.discussion)),
      };
    case "message": {
      const current = state.lastMessages.get(change.message.discussionId);
      if (current !== undefined && current.seq >= change.message.seq) return state;
      return {
        ...state,
        lastMessages: withEntry(state.lastMessages, change.message.discussionId, change.message),
      };
    }
    case "script":
    case "scriptRun":
      return state;
  }
}

export function applyKanbanWatchEvent(
  state: KanbanBoardState | undefined,
  event: KanbanWatchEvent,
): KanbanBoardState | undefined {
  if (event._tag === "snapshot") return boardStateFromSnapshot(event.snapshot, state);
  // Changes before the first snapshot cannot happen; the server sends it first.
  return state === undefined ? state : applyKanbanChange(state, event.change);
}

/**
 * Replaces the held discussions with a list read from the server. `fresher`
 * names discussions a live change brought after the read started; those
 * entries are newer than the list's, so they stay.
 */
export function withDiscussionList(
  state: KanbanBoardState,
  discussions: ReadonlyArray<KanbanDiscussion>,
  fresher: ReadonlySet<string> = new Set(),
): KanbanBoardState {
  const merged = new Map<string, KanbanDiscussion>();
  const unread = new Map(state.unread);
  for (const discussion of discussions) {
    const held = state.discussions.get(discussion.id);
    const kept = held !== undefined && fresher.has(discussion.id) ? held : discussion;
    merged.set(discussion.id, kept);
    unread.set(discussion.id, unreadOf(kept));
  }
  for (const id of fresher) {
    const held = state.discussions.get(id);
    if (held !== undefined && !merged.has(id)) merged.set(id, held);
  }
  return { ...state, discussions: merged, unread, discussionsLoaded: true };
}

/**
 * Adds discussions the client learned about outside the list (one it just
 * created) and newest messages read for previews. Held entries win.
 */
export function withDiscussions(
  state: KanbanBoardState,
  discussions: ReadonlyArray<KanbanDiscussion>,
  lastMessages: ReadonlyArray<KanbanMessage>,
): KanbanBoardState {
  const merged = new Map(state.discussions);
  const unread = new Map(state.unread);
  for (const discussion of discussions) {
    if (merged.has(discussion.id)) continue;
    merged.set(discussion.id, discussion);
    unread.set(discussion.id, unreadOf(discussion));
  }
  const previews = new Map(state.lastMessages);
  for (const message of lastMessages) {
    const current = previews.get(message.discussionId);
    if (current === undefined || current.seq < message.seq) {
      previews.set(message.discussionId, message);
    }
  }
  return { ...state, discussions: merged, unread, lastMessages: previews };
}

/** The owner read a discussion up to `seq`: clears its unread count at once. */
export function withOwnerRead(
  state: KanbanBoardState,
  discussionId: string,
  seq: number,
): KanbanBoardState {
  const discussion = state.discussions.get(discussionId);
  const remaining = discussion === undefined ? 0 : Math.max(0, discussion.lastSeq - seq);
  if ((state.unread.get(discussionId) ?? 0) <= remaining) return state;
  return { ...state, unread: withEntry(state.unread, discussionId, remaining) };
}
