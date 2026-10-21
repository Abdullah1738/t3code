import type { MissionId, ViewLongTextInput } from "@t3tools/contracts";
import {
  createKeyedSnapshotStores,
  createViewLongTexts,
  viewLongTextKey,
  type MissionViewsState,
  type ViewLongTextState,
} from "@t3tools/client-runtime/ardud/missions";
import { useEffect, useSyncExternalStore } from "react";

import { missionsSource } from "./missionsStore";

// The mission's views: its layout, card templates, placed sections with the
// server's rows, and its images. One subscription per mission.

const viewStores = createKeyedSnapshotStores<MissionId, MissionViewsState | null>((id, emit) =>
  missionsSource().subscribeViews(id, emit),
);

const NONE = { get: () => undefined, subscribe: () => () => {} };

/** Undefined while loading, null when the mission has no views. */
export function useMissionViews(missionId: MissionId | null): MissionViewsState | null | undefined {
  const store = missionId === null ? NONE : viewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

// --- views additions ---
const longTexts = createViewLongTexts((input) => missionsSource().loadLongText(input));

/** A long row value (a report's text), loaded once its block shows; undefined until asked. */
export function useViewLongText(input: ViewLongTextInput | null): ViewLongTextState | undefined {
  const key = input === null ? null : viewLongTextKey(input);
  const state = useSyncExternalStore(longTexts.subscribe, () =>
    key === null ? undefined : longTexts.get(key),
  );
  useEffect(() => {
    if (input !== null) longTexts.request(input);
  }, [input]);
  return state;
}

export function retryViewLongText(input: ViewLongTextInput): void {
  longTexts.request(input, { retry: true });
}
// --- end views additions ---
