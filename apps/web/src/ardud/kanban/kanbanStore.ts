import { paintActionValue } from "@t3tools/client-runtime/ardud/kanban";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";

import type {
  KanbanBoardSummary,
  KanbanCardDetail,
  KanbanMessage,
  KanbanScript,
  KanbanScriptRun,
  KanbanThreadRow,
  KanbanWikiPage,
} from "@t3tools/contracts";
import {
  boardThreadIds,
  createAtomKanbanTransport,
  createKanbanClient,
  type KanbanRequestTag,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { FeedFailure, SnapshotStore } from "@t3tools/client-runtime/ardud/common";

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
  // Reopening after the feed closed waits on a new board snapshot (seconds on a busy
  // server, ~11 MB), so a board or discussion stays live for ten minutes after leaving it.
  { keepAliveMs: 10 * 60_000 },
);

function useStore<T>(store: SnapshotStore<T>): T | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}

// Two frames cross a browser paint opportunity; cleanup cancels stale commits.
function usePaint(value: unknown, phase: "board-painted" | "discussion-painted") {
  useEffect(() => paintActionValue(value, phase, (callback) => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(callback); });
    return () => cancelAnimationFrame(frame);
  }), [value, phase]);
  useEffect(() => paintActionValue(value, "authoritative-paint", (callback) => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(callback); });
    return () => cancelAnimationFrame(frame);
  }), [value]);
}

/** Every board with its list counts; no board feed opens for them. */
export function useBoards(): ReadonlyArray<KanbanBoardSummary> | undefined {
  return useStore(kanban.boards);
}

/** Threads the boards started, archived boards too, for thread lists to leave out. */
export function useBoardThreadIds(): ReadonlySet<string> {
  return boardThreadIds(useStore(kanban.boards));
}

/** The board that started a thread, or undefined for threads a board did not start. */
export function useBoardRunOf(threadId: string):
  | {
      readonly boardId: string;
      readonly boardName: string;
    }
  | undefined {
  const boards = useStore(kanban.boards);
  if (boards === undefined) return undefined;
  for (const entry of boards) {
    if (entry.threadIds.includes(threadId as never)) {
      return { boardId: entry.board.id, boardName: entry.board.name };
    }
  }
  return undefined;
}

/**
 * The owning card or discussion of a board-run thread, read from the board's
 * thread rows so the bar can link back to the record that owns the run.
 */
export function useBoardRunRecord(
  threadId: string,
): { readonly cardId: string | null; readonly discussionId: string | null } | undefined {
  // Read by thread id, not from the capped Threads list, so an old run still links back.
  const link = useStore(threadId === "" ? NO_OWNER : kanban.owner(threadId));
  if (link === undefined || link === null) return undefined;
  return { cardId: link.cardId, discussionId: link.discussionId };
}

const NO_OWNER: SnapshotStore<null> = {
  get: () => undefined,
  subscribe: () => () => {},
  failure: () => undefined,
  retry: () => {},
};

export function useBoardState(boardId: string): KanbanBoardState | undefined {
  const value = useStore(kanban.board(boardId));
  usePaint(value, "board-painted");
  return value;
}

export function useMessages(
  boardId: string,
  discussionId: string,
): ReadonlyArray<KanbanMessage> | undefined {
  const value = useStore(kanban.messages(boardId, discussionId));
  usePaint(value, "discussion-painted");
  return value;
}

export function useCardDetail(boardId: string, cardId: string): KanbanCardDetail | undefined {
  return useStore(kanban.card(boardId, cardId));
}

export function useWiki(boardId: string): ReadonlyArray<KanbanWikiPage> | undefined {
  return useStore(kanban.wiki(boardId));
}

export function useBoardThreads(boardId: string): ReadonlyArray<KanbanThreadRow> | undefined {
  return useStore(kanban.threads(boardId));
}

/**
 * Whether this connection's grants allow a kanban write. The server still
 * checks every call; this only decides whether the control is offered.
 */
export function useKanbanPermission(tag: KanbanRequestTag): boolean {
  return useAtomValue(kanban.permission(tag));
}

export function useScripts(boardId: string): ReadonlyArray<KanbanScript> | undefined {
  return useStore(kanban.scripts(boardId));
}

/** A script's runs with the read's failure and retry, so a failed read can say so. */
export function useScriptRunsFeed(
  boardId: string,
  scriptId: string,
): { readonly runs: ReadonlyArray<KanbanScriptRun> | undefined; readonly feed: FeedState } {
  const store = kanban.scriptRuns(boardId, scriptId);
  return { runs: useStore(store), feed: useFeed(store) };
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
