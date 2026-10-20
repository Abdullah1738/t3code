import { useSyncExternalStore } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  createKeyedSnapshotStores,
  type MissionTimelineWindow,
  type MissionWorkSnapshot,
  type WorkQuery,
} from "@t3tools/client-runtime/ardud/missions";

import { missionsSource, useFeedState, type FeedState } from "./missionsStore";

// Feeds the Desk pages read beyond the shared store: work items by query and
// the paged timeline. Same one-subscription-per-key rule as missionsStore.

const workStores = createKeyedSnapshotStores<string, MissionWorkSnapshot>((key, emit, fail) => {
  const [missionId, query] = JSON.parse(key) as [MissionId, WorkQuery];
  return missionsSource.subscribeWork(missionId, emit, query, fail);
});

const timelineStores = createKeyedSnapshotStores<MissionId, MissionTimelineWindow>(
  (missionId, emit, fail) => missionsSource.subscribeTimelineWindow(missionId, emit, fail),
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

/** Whether the `useWorkFeed` read for this query failed, and how to retry it. */
export function useWorkFeedState(missionId: MissionId, query: WorkQuery): FeedState {
  return useFeedState(workStores(JSON.stringify([missionId, query])));
}

/** Whether the timeline's first page failed, and how to retry it. */
export function useTimelineWindowFeed(missionId: MissionId): FeedState {
  return useFeedState(timelineStores(missionId));
}

export function loadOlderTimeline(missionId: MissionId): Promise<void> {
  return missionsSource.loadOlderTimeline(missionId);
}
