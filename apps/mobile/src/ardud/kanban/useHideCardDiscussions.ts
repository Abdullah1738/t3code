import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Remembered "Hide card discussions" filter for the Discussions list. */
export function useHideCardDiscussions() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hideCards =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.kanbanHideCardDiscussions === true;

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggleHideCards = () => {
    if (!AsyncResult.isSuccess(preferencesResult)) return;
    savePreferences({
      transform: (current) => ({
        kanbanHideCardDiscussions: current.kanbanHideCardDiscussions !== true,
      }),
    });
  };

  return { hideCards, toggleHideCards } as const;
}
