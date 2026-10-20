import type { MissionId } from "@t3tools/contracts";
import {
  createKeyedSnapshotStores,
  type MissionViewsState,
} from "@t3tools/client-runtime/ardud/missions";
import { useSyncExternalStore } from "react";

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
