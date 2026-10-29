import type { BoardFilter } from "@t3tools/client-runtime/ardud/kanban";
import { useSyncExternalStore } from "react";

// The board publishes the filter it shows so the card screens (pane and
// pushed iPhone screen) step through the same cards. Module state: one
// phone, one set of boards.
const filters = new Map<string, BoardFilter>();
const listeners = new Set<() => void>();
const DEFAULT_FILTER: BoardFilter = { settled: "hide" };

export function boardFilterFor(boardId: string): BoardFilter {
  return filters.get(boardId) ?? DEFAULT_FILTER;
}

export function publishBoardFilter(boardId: string, filter: BoardFilter): void {
  // The board passes a new object every render; equal filters must not wake listeners.
  if (JSON.stringify(boardFilterFor(boardId)) === JSON.stringify(filter)) return;
  filters.set(boardId, filter);
  for (const listener of listeners) listener();
}

export function subscribeBoardFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoardFilter(boardId: string): BoardFilter {
  return useSyncExternalStore(subscribeBoardFilters, () => boardFilterFor(boardId));
}
