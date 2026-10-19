import { useSyncExternalStore } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  createKeyedSnapshotStores,
  type MissionTimelineWindow,
  type MissionWorkSnapshot,
  type WorkQuery,
} from "@t3tools/client-runtime/ardud/missions";

import { missionsSource } from "./missionsStore";

// Feeds the Desk pages read beyond the shared store: work items by query and
// the paged timeline. Same one-subscription-per-key rule as missionsStore.

const workStores = createKeyedSnapshotStores<string, MissionWorkSnapshot>((key, emit) => {
  const [missionId, query] = JSON.parse(key) as [MissionId, WorkQuery];
  return missionsSource.subscribeWork(missionId, emit, query);
});

const timelineStores = createKeyedSnapshotStores<MissionId, MissionTimelineWindow>(
  (missionId, emit) => missionsSource.subscribeTimelineWindow(missionId, emit),
);

/** Work items matching `query`, most recently changed first. Pass a stable query. */
export function useWorkFeed(
  missionId: MissionId,
  query: WorkQuery,
): MissionWorkSnapshot | undefined {
  const store = workStores(JSON.stringify([missionId, query]));
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The loaded part of the mission's timeline, newest first. */
export function useTimelineWindow(missionId: MissionId): MissionTimelineWindow | undefined {
  const store = timelineStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function loadOlderTimeline(missionId: MissionId): Promise<void> {
  return missionsSource.loadOlderTimeline(missionId);
}
