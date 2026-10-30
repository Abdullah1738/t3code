import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export type DiscussionShelf = "snoozed" | "settled";

/**
 * Whether a board's Snoozed and Settled discussion shelves are open. Stored
 * per board so each board remembers its own shelves, like the thread list.
 */
export function useDiscussionShelves(boardId: string) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const shelves = loaded ? preferencesResult.value.kanbanDiscussionShelves?.[boardId] : undefined;
  const open = { snoozed: shelves?.snoozed === true, settled: shelves?.settled === true };

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggle = (shelf: DiscussionShelf) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const all = current.kanbanDiscussionShelves ?? {};
        const board = all[boardId] ?? {};
        return {
          kanbanDiscussionShelves: {
            ...all,
            [boardId]: { ...board, [shelf]: board[shelf] !== true },
          },
        };
      },
    });
  };

  return { loaded, open, toggle } as const;
}
