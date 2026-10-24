import type { MissionId } from "@t3tools/contracts";
import {
  createKeyedSnapshotStores,
  createViewLongTexts,
  viewLongTextKey,
  type MissionViewsState,
  type SnapshotStore,
  type ViewLongTextRequest,
  type ViewLongTextState,
} from "@t3tools/client-runtime/ardud/missions";
import { useEffect, useSyncExternalStore } from "react";

import { MISSION_FEED_KEEP_ALIVE_MS, missionsSource } from "./missionsStore";

// The mission's views: its layout, card templates, placed sections with the
// server's rows, and its images. One subscription per mission.

const viewStores = createKeyedSnapshotStores<MissionId, MissionViewsState | null>(
  (id, emit) => missionsSource().subscribeViews(id, emit),
  { keepAliveMs: MISSION_FEED_KEEP_ALIVE_MS },
);

/** The views feed of one mission, for screens that open a board's feeds together. */
export function missionViewsStore(missionId: MissionId): SnapshotStore<MissionViewsState | null> {
  return viewStores(missionId);
}

const NONE = { get: () => undefined, subscribe: () => () => {} };

/** Undefined while loading, null when the mission has no views. */
export function useMissionViews(missionId: MissionId | null): MissionViewsState | null | undefined {
  const store = missionId === null ? NONE : viewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

// --- views additions ---
const longTexts = createViewLongTexts((input) => missionsSource().loadLongText(input));

/** A long row value (a report's text), loaded once its block shows; undefined until asked. */
export function useViewLongText(input: ViewLongTextRequest | null): ViewLongTextState | undefined {
  const key = input === null ? null : viewLongTextKey(input);
  const state = useSyncExternalStore(longTexts.subscribe, () =>
    key === null ? undefined : longTexts.get(key),
  );
  // Held while shown, so a value on screen never drops out of the store.
  useEffect(() => (input === null ? undefined : longTexts.hold(input)), [input]);
  return state;
}

export function retryViewLongText(input: ViewLongTextRequest): void {
  longTexts.request(input, { retry: true });
}
// --- end views additions ---
