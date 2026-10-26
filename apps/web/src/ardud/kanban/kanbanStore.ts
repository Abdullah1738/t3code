import { useSyncExternalStore } from "react";

import type {
  KanbanBoardSummary,
  KanbanCardDetail,
  KanbanMessage,
  KanbanWikiPage,
} from "@t3tools/contracts";
import {
  createAtomKanbanTransport,
  createKanbanClient,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { FeedFailure, SnapshotStore } from "@t3tools/client-runtime/ardud/missions";

import { toastManager } from "../../components/ui/toast";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

export const kanban = createKanbanClient(
  createAtomKanbanTransport({
    runtime: connectionAtomRuntime,
    registry: appAtomRegistry,
    environmentId: primaryEnvironmentIdAtom,
  }),
  { keepAliveMs: 2 * 60_000 },
);

function useStore<T>(store: SnapshotStore<T>): T | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Every board with its list counts; no board feed opens for them. */
export function useBoards(): ReadonlyArray<KanbanBoardSummary> | undefined {
  return useStore(kanban.boards);
}

export function useBoardState(boardId: string): KanbanBoardState | undefined {
  return useStore(kanban.board(boardId));
}

export function useMessages(
  boardId: string,
  discussionId: string,
): ReadonlyArray<KanbanMessage> | undefined {
  return useStore(kanban.messages(boardId, discussionId));
}

export function useCardDetail(boardId: string, cardId: string): KanbanCardDetail | undefined {
  return useStore(kanban.card(boardId, cardId));
}

export function useWiki(boardId: string): ReadonlyArray<KanbanWikiPage> | undefined {
  return useStore(kanban.wiki(boardId));
}

export interface FeedState {
  readonly failure: FeedFailure | undefined;
  readonly retry: () => void;
}

export function useFeed(store: SnapshotStore<unknown>): FeedState {
  const failure = useSyncExternalStore(store.subscribe, store.failure);
  return { failure, retry: store.retry };
}

export function kanbanErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Something went wrong. Try again.";
}

export async function runAction(title: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    toastManager.add({ type: "error", title, description: kanbanErrorMessage(error) });
    return false;
  }
}
