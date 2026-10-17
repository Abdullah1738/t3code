import { useSyncExternalStore } from "react";

import type {
  DraftNote,
  Lane,
  MissionId,
  MissionInbox,
  MissionListSnapshot,
  RoomId,
  RoomPage,
  Rule,
  SuggestionStats,
} from "@t3tools/contracts";
import {
  createFixtureMissionsSource,
  createKeyedSnapshotStores,
  createSnapshotStore,
  type MissionForkEntry,
  type MissionInboxHistory,
  type MissionOverviewSnapshot,
  type MissionRoomEntry,
  type MissionsSource,
} from "@t3tools/client-runtime/ardud/missions";

// The web client's one missions source. The fixture is built from real Crpko
// coordinator data; swap this line for the server RPC source when it lands.
export const missionsSource: MissionsSource = createFixtureMissionsSource({ surface: "web" });

// One subscription per screen-level store, shared by every component that
// reads it. Rows never subscribe on their own.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource.subscribeList(emit),
);
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverviewSnapshot | null>(
  (id, emit) => missionsSource.subscribeOverview(id, emit),
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>((id, emit) =>
  missionsSource.subscribeLanes(id, emit),
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInbox>((id, emit) =>
  missionsSource.subscribeInbox(id, emit),
);
const historyStores = createKeyedSnapshotStores<MissionId | null, MissionInboxHistory>((id, emit) =>
  missionsSource.subscribeInboxHistory(id, emit),
);
const draftNoteStores = createKeyedSnapshotStores<MissionId | null, ReadonlyArray<DraftNote>>(
  (id, emit) => missionsSource.subscribeDraftNotes(id, emit),
);
const statsStore = createSnapshotStore<ReadonlyArray<SuggestionStats>>((emit) =>
  missionsSource.subscribeSuggestionStats(emit),
);
const forkStores = createKeyedSnapshotStores<MissionId | null, ReadonlyArray<MissionForkEntry>>(
  (id, emit) => missionsSource.subscribeForks(id, emit),
);
const ruleStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Rule>>((id, emit) =>
  missionsSource.subscribeRules(id, emit),
);
const roomListStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionRoomEntry>>(
  (id, emit) => missionsSource.subscribeRooms(id, emit),
);
const roomStores = createKeyedSnapshotStores<RoomId, RoomPage | null>((id, emit) =>
  missionsSource.subscribeRoom(id, emit),
);

/** `undefined` until the source has answered once. */
export function useMissionList(): MissionListSnapshot | undefined {
  return useSyncExternalStore(listStore.subscribe, listStore.get);
}

/** `undefined` while loading, `null` when the mission does not exist. */
export function useMissionOverview(
  missionId: MissionId,
): MissionOverviewSnapshot | null | undefined {
  const store = overviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionLanes(missionId: MissionId): ReadonlyArray<Lane> | undefined {
  const store = laneStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Inbox for one mission, or across every mission when `missionId` is null. */
export function useMissionInbox(missionId: MissionId | null): MissionInbox | undefined {
  const store = inboxStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** What the owner decided in the last day, newest first. */
export function useMissionInboxHistory(
  missionId: MissionId | null,
): MissionInboxHistory | undefined {
  const store = historyStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Draft notes that apply to the mission, including global ones. */
export function useDraftNotes(missionId: MissionId | null): ReadonlyArray<DraftNote> | undefined {
  const store = draftNoteStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useSuggestionStats(): ReadonlyArray<SuggestionStats> | undefined {
  return useSyncExternalStore(statsStore.subscribe, statsStore.get);
}

/** Forks of the master, newest first. */
export function useMissionForks(
  missionId: MissionId | null,
): ReadonlyArray<MissionForkEntry> | undefined {
  const store = forkStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRules(missionId: MissionId): ReadonlyArray<Rule> | undefined {
  const store = ruleStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRooms(missionId: MissionId): ReadonlyArray<MissionRoomEntry> | undefined {
  const store = roomListStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The newest page of one room; older pages load through the source. */
export function useRoomPage(roomId: RoomId | null): RoomPage | null | undefined {
  const store = roomStores(roomId ?? NO_ROOM);
  const page = useSyncExternalStore(store.subscribe, store.get);
  return roomId === null ? null : page;
}

const NO_ROOM = "" as RoomId;

/** A mission error's detail, or a plain fallback for anything else. */
export function missionErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Something went wrong. Try again.";
}
