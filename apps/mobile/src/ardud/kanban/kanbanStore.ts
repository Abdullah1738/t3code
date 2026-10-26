import type { KanbanBoard, KanbanCardDetail, KanbanMessage } from "@t3tools/contracts";
import {
  createAtomKanbanTransport,
  createKanbanClient,
  type KanbanBoardState,
  type KanbanClient,
} from "@t3tools/client-runtime/ardud/kanban";
import type { SnapshotStore } from "@t3tools/client-runtime/ardud/missions";
import { useMemo, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { type FeedState, missionsEnvironmentIdAtom } from "../missions/missionsStore";

// Leaving a card or discussion and coming back finds its feed still open.
const KEEP_ALIVE_MS = 2 * 60_000;

let client: KanbanClient | null = null;

/** The phone's one board client, over the same paired server as Missions. */
export function kanbanClient(): KanbanClient {
  client ??= createKanbanClient(
    createAtomKanbanTransport({
      runtime: connectionAtomRuntime,
      registry: appAtomRegistry,
      environmentId: missionsEnvironmentIdAtom,
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
 * Boards on the paired server, archived ones left out. The client keeps the
 * list fresh: it retries until the server answers and reads it again on board
 * snapshots and every few minutes.
 */
export function useKanbanBoards(): ReadonlyArray<KanbanBoard> | undefined {
  const boards = useStore(kanbanClient().boards);
  return useMemo(() => boards?.filter((board) => board.archivedAt === null), [boards]);
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
