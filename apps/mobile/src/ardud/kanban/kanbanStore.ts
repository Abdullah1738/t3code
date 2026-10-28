import type {
  KanbanBoardSummary,
  KanbanCardDetail,
  KanbanMessage,
  KanbanThreadRow,
} from "@t3tools/contracts";
import {
  boardThreadIds,
  createAtomKanbanTransport,
  createKanbanClient,
  type KanbanBoardState,
  type KanbanClient,
} from "@t3tools/client-runtime/ardud/kanban";
import type { SnapshotStore } from "@t3tools/client-runtime/ardud/common";
import { useMemo, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { type FeedState, pairedEnvironmentIdAtom } from "../common/environment";

// Leaving a card or discussion and coming back finds its feed still open.
const KEEP_ALIVE_MS = 2 * 60_000;

let client: KanbanClient | null = null;

/** The phone's one board client, over the paired server. */
export function kanbanClient(): KanbanClient {
  client ??= createKanbanClient(
    createAtomKanbanTransport({
      runtime: connectionAtomRuntime,
      registry: appAtomRegistry,
      environmentId: pairedEnvironmentIdAtom,
    }),
    { keepAliveMs: KEEP_ALIVE_MS },
  );
  return client;
}

const NONE: SnapshotStore<never> = {
  get: () => undefined,
  subscribe: () => () => {},
  failure: () => undefined,
  retry: () => {},
};

function useStore<T>(store: SnapshotStore<T>): T | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}

function useFeed(store: SnapshotStore<unknown>): FeedState {
  const failure = useSyncExternalStore(store.subscribe, store.failure);
  return useMemo(() => ({ failure, retry: store.retry }), [failure, store]);
}

/**
 * Boards on the paired server with their list counts, archived ones left out.
 * The server streams the list, so it stays current without board feeds.
 */
export function useKanbanBoards(): ReadonlyArray<KanbanBoardSummary> | undefined {
  const boards = useStore(kanbanClient().boards);
  return useMemo(() => boards?.filter((summary) => summary.board.archivedAt === null), [boards]);
}

/** Every thread a board started, cards and evaluators alike, kept current by the list. */
export function useKanbanBoardThreads(
  boardId: string,
): ReadonlyArray<KanbanThreadRow> | undefined {
  return useStore(kanbanClient().threads(boardId));
}

/**
 * The board that started a thread, with the card or discussion that owns the
 * run, or undefined for threads a board did not start.
 */
export function useKanbanBoardRunOf(threadId: string):
  | {
      readonly boardId: string;
      readonly boardName: string;
      readonly cardId: string | null;
      readonly discussionId: string | null;
    }
  | undefined {
  const boards = useStore(kanbanClient().boards);
  const entry = useMemo(
    () => boards?.find((board) => board.threadIds.includes(threadId as never)),
    [boards, threadId],
  );
  const owner = useKanbanThreadOwner(entry === undefined ? "" : threadId);
  if (entry === undefined) return undefined;
  return {
    boardId: entry.board.id,
    boardName: entry.board.name,
    cardId: owner?.cardId ?? null,
    discussionId: owner?.discussionId ?? null,
  };
}

// Stands in for a board's thread rows when there is no board yet, so the hook
// keeps its call order and reads nothing.
/**
 * The owning card or discussion of a board's thread, from that board's thread
 * rows. An empty board id reads nothing: the caller has no board yet.
 */
export function useKanbanThreadOwner(
  threadId: string,
): { readonly cardId: string | null; readonly discussionId: string | null } | undefined {
  // Read by thread id, not from the capped Threads list, so an old run still links back.
  const link = useStore(threadId === "" ? NO_OWNER : kanbanClient().owner(threadId));
  if (link === undefined || link === null) return undefined;
  return { cardId: link.cardId, discussionId: link.discussionId };
}

const NO_OWNER: SnapshotStore<null> = {
  get: () => undefined,
  subscribe: () => () => {},
  failure: () => undefined,
  retry: () => {},
};

/** Threads the boards started, archived boards too, for thread lists to leave out. */
export function useKanbanBoardThreadIds(): ReadonlySet<string> {
  const boards = useStore(kanbanClient().boards);
  return useMemo(() => boardThreadIds(boards), [boards]);
}

export function useKanbanBoard(boardId: string): KanbanBoardState | undefined {
  return useStore(kanbanClient().board(boardId));
}

export function useKanbanBoardFeed(boardId: string): FeedState {
  return useFeed(kanbanClient().board(boardId));
}

/** A discussion's messages, oldest first; nothing while `discussionId` is null. */
export function useKanbanMessages(
  boardId: string,
  discussionId: string | null,
): ReadonlyArray<KanbanMessage> | undefined {
  return useStore(discussionId === null ? NONE : kanbanClient().messages(boardId, discussionId));
}

export function useKanbanMessagesFeed(boardId: string, discussionId: string | null): FeedState {
  return useFeed(discussionId === null ? NONE : kanbanClient().messages(boardId, discussionId));
}

/** A card's events and threads. */
export function useKanbanCard(boardId: string, cardId: string): KanbanCardDetail | undefined {
  return useStore(kanbanClient().card(boardId, cardId));
}

export function useKanbanCardFeed(boardId: string, cardId: string): FeedState {
  return useFeed(kanbanClient().card(boardId, cardId));
}
